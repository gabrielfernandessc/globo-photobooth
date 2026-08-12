package com.globo.photobooth

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.camera.core.CameraSelector
import androidx.camera.view.PreviewView
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject

/**
 * O app é a peça principal: abre a própria sessão, conduz a contagem,
 * captura, mostra o resultado e o QR. O /display.html virou opcional —
 * quando existe um telão, ele entra na mesma sessão e o app passa a
 * respeitar o disparo dele, para a foto sair no zero da contagem que o
 * público está vendo.
 */
class BoothViewModel(app: Application) : AndroidViewModel(app) {

    enum class Stage { SETUP, CONNECTING, READY, COUNTDOWN, CAPTURING, UPLOADING, RESULT }

    data class UiState(
        val stage: Stage = Stage.SETUP,
        val serverUrl: String = "",
        val code: String = "",
        val connected: Boolean = false,
        val hasDisplay: Boolean = false,
        val message: String? = null,
        val error: String? = null,
        val countdown: Int = 0,
        val photoResolution: String = "—",
        val megapixels: Double = 0.0,
        val photoCount: Int = 0,
        val relaying: Boolean = false,
        val torchOn: Boolean = false,
        val zoom: Float = 1f,
        val maxZoom: Float = 1f,
        val hasTorch: Boolean = false,
        val captureMode: CameraController.CaptureMode = CameraController.CaptureMode.QUALITY,
        val mirror: Boolean = false,
        val aspectRatio: String = "3:4",
        val timerSeconds: Int = 3,
        // Resultado
        val resultPhoto: Bitmap? = null,
        val resultQr: Bitmap? = null,
        val resultInfo: String = "",
        val resultPageUrl: String = "",
        val displayLink: String = "",
        val displayQr: Bitmap? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    val camera = CameraController(app.applicationContext)
    private val client = BoothClient()
    private val uploader = PhotoUploader(client)
    private val http = BoothClient.defaultHttp()

    private var countdownJob: Job? = null
    private var resultJob: Job? = null
    private var previewView: PreviewView? = null
    private var lifecycleOwner: LifecycleOwner? = null
    private var relayEnabled = false

    init {
        client.onConnectionChange = { ok ->
            _state.update {
                it.copy(
                    connected = ok,
                    stage = if (ok && it.stage == Stage.CONNECTING) Stage.READY else it.stage,
                )
            }
            if (ok) publishState()
        }
        client.onPresenceChange = { present -> _state.update { it.copy(hasDisplay = present) } }
        client.onCountdown = { seconds -> startCountdown(seconds, drivenByDisplay = client.hasDisplay) }
        client.onShoot = { ratio, flash -> shoot(ratio, flash) }
        client.onRelayToggle = { enabled -> if (enabled) startRelay() else stopRelay() }
        client.onSettings = { settings ->
            settings.optString("aspectRatio").takeIf { it.isNotEmpty() }?.let { ratio ->
                _state.update { it.copy(aspectRatio = ratio) }
            }
            settings.optInt("timer", 0).takeIf { it > 0 }?.let { timer ->
                _state.update { it.copy(timerSeconds = timer) }
            }
        }
        client.onControl = { cmd -> applyRemoteControl(cmd) }
    }

    /* ═══════════════════════════════════════════════════════
       INÍCIO — o app abre a sessão, não entra numa de fora
       ═══════════════════════════════════════════════════════ */

    fun start(serverUrl: String) {
        if (serverUrl.isBlank()) {
            _state.update { it.copy(error = "Informe o endereço do servidor") }
            return
        }
        _state.update { it.copy(stage = Stage.CONNECTING, error = null, serverUrl = serverUrl) }

        viewModelScope.launch(Dispatchers.IO) {
            client.fetchConfig(serverUrl)
                .onSuccess { cfg ->
                    // Avisa antes da primeira foto, não depois de falhar.
                    cfg.misconfigured?.let { warning -> _state.update { it.copy(error = warning) } }
                }
                .mapCatching { client.createSession(serverUrl).getOrThrow() }
                .onSuccess { code ->
                    _state.update { it.copy(code = code) }
                    client.connect(code)
                    loadDisplayLink(code)
                }
                .onFailure { e ->
                    _state.update {
                        it.copy(stage = Stage.SETUP, error = "Não consegui falar com $serverUrl — ${e.message}")
                    }
                }
        }
    }

    /** Link do telão opcional: quem quiser um monitor abre este endereço. */
    private suspend fun loadDisplayLink(code: String) {
        val link = client.absolute("/display.html?code=$code")
        val qr = fetchBitmap(client.qrUrl("/display.html?code=$code", size = 420))
        _state.update { it.copy(displayLink = link, displayQr = qr) }
    }

    fun disconnect() {
        stopRelay()
        client.disconnect()
        _state.update { it.copy(stage = Stage.SETUP, connected = false, code = "") }
    }

    /* ═══════════════════════════════════════════════════════
       CÂMERA
       ═══════════════════════════════════════════════════════ */

    fun bindCamera(owner: LifecycleOwner, view: PreviewView) {
        previewView = view
        lifecycleOwner = owner
        rebindCamera()
    }

    /**
     * Voltar do segundo plano desfaz o vínculo do CameraX e derruba o
     * socket. Reatar as duas coisas aqui é o que evita o app "morrer" ao
     * alternar de aplicativo no meio do evento.
     */
    fun onResume() {
        rebindCamera()
        val code = _state.value.code
        if (code.isNotEmpty() && !_state.value.connected) client.reconnect()
    }

    private fun rebindCamera() {
        val view = previewView ?: return
        val owner = lifecycleOwner ?: return
        viewModelScope.launch {
            runCatching { camera.bind(owner, view, _state.value.captureMode) }
                .onSuccess {
                    publishCapabilities()
                    if (relayEnabled) startRelay()
                }
                .onFailure { e -> _state.update { it.copy(error = "Falha ao abrir a câmera: ${e.message}") } }
        }
    }

    fun setCaptureMode(mode: CameraController.CaptureMode) {
        _state.update { it.copy(captureMode = mode) }
        rebindCamera()
    }

    fun flipLens() {
        val next = if (camera.lensFacing == CameraSelector.LENS_FACING_BACK) {
            CameraSelector.LENS_FACING_FRONT
        } else {
            CameraSelector.LENS_FACING_BACK
        }
        // Frontal: o natural é a foto sair espelhada, como a pessoa se vê.
        _state.update { it.copy(mirror = next == CameraSelector.LENS_FACING_FRONT) }
        val view = previewView ?: return
        val owner = lifecycleOwner ?: return
        viewModelScope.launch {
            runCatching { camera.bind(owner, view, _state.value.captureMode, next) }
                .onSuccess { publishCapabilities() }
        }
    }

    fun toggleTorch() {
        val next = !_state.value.torchOn
        camera.setTorch(next)
        _state.update { it.copy(torchOn = next) }
    }

    fun setZoom(ratio: Float) {
        camera.setZoom(ratio)
        _state.update { it.copy(zoom = ratio) }
    }

    fun focusAt(x: Float, y: Float) = previewView?.let { camera.focusAt(it, x, y) }

    fun toggleMirror() = _state.update { it.copy(mirror = !it.mirror) }

    fun setTimer(seconds: Int) {
        _state.update { it.copy(timerSeconds = seconds) }
        client.updateSettings(JSONObject().put("timer", seconds))
    }

    fun setAspectRatio(ratio: String) {
        _state.update { it.copy(aspectRatio = ratio) }
        client.updateSettings(JSONObject().put("aspectRatio", ratio))
    }

    private fun publishCapabilities() {
        val caps = camera.capabilities
        val resolution = caps.photoResolution
        _state.update {
            it.copy(
                hasTorch = caps.hasTorch,
                maxZoom = caps.maxZoom,
                zoom = caps.minZoom,
                photoResolution = resolution?.let { r -> "${r.width} × ${r.height}" } ?: "—",
                megapixels = caps.sensorMegapixels,
            )
        }
        publishState()
    }

    private fun publishState() {
        val caps = camera.capabilities
        val resolution = caps.photoResolution ?: return
        client.reportState(JSONObject().apply {
            put("label", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} (app)")
            put("photoWidth", resolution.width)
            put("photoHeight", resolution.height)
            put("streamWidth", 1280)
            put("streamHeight", 720)
            put("hasTorch", caps.hasTorch)
            put("hasZoom", caps.maxZoom > caps.minZoom)
            put("facingMode", if (camera.lensFacing == CameraSelector.LENS_FACING_FRONT) "user" else "environment")
        })
    }

    private fun applyRemoteControl(cmd: JSONObject) {
        if (cmd.has("torch")) {
            val on = cmd.optBoolean("torch")
            camera.setTorch(on)
            _state.update { it.copy(torchOn = on) }
        }
        if (cmd.optBoolean("autofocus")) previewView?.let { camera.autofocusCenter(it) }
        if (cmd.has("zoom")) setZoom(cmd.optDouble("zoom", 1.0).toFloat())
        if (cmd.has("mirror")) _state.update { it.copy(mirror = cmd.optBoolean("mirror")) }
    }

    /* ═══════════════════════════════════════════════════════
       DISPARO
       ═══════════════════════════════════════════════════════ */

    fun requestCapture() {
        val stage = _state.value.stage
        if (stage != Stage.READY && stage != Stage.RESULT) return

        if (client.hasDisplay) {
            // Com telão, quem conduz é ele: a contagem precisa bater com
            // o que o público está vendo na tela grande.
            client.requestCapture()
        } else {
            startCountdown(_state.value.timerSeconds, drivenByDisplay = false)
        }
    }

    private fun startCountdown(seconds: Int, drivenByDisplay: Boolean) {
        countdownJob?.cancel()
        resultJob?.cancel()
        countdownJob = viewModelScope.launch {
            _state.update { it.copy(stage = Stage.COUNTDOWN, error = null, resultPhoto = null, resultQr = null) }
            for (i in seconds downTo 1) {
                _state.update { it.copy(countdown = i) }
                delay(1000)
            }
            _state.update { it.copy(countdown = 0) }
            // Sem telão não vem "camera-shoot" de ninguém: o app dispara.
            if (!drivenByDisplay) shoot(_state.value.aspectRatio, currentFlashMode())
        }
    }

    private fun currentFlashMode(): String = if (_state.value.torchOn) "torch" else "off"

    private fun shoot(aspectRatio: String, flashMode: String) {
        viewModelScope.launch {
            _state.update { it.copy(stage = Stage.CAPTURING, aspectRatio = aspectRatio, error = null) }
            client.reportStatus("capturing")

            val usedTorch = flashMode == "torch" || flashMode == "flash"
            if (usedTorch && !_state.value.torchOn) camera.setTorch(true)

            val bytes = runCatching { camera.capture() }
                .onFailure { e ->
                    fail("Falha na captura: ${e.message}")
                    client.reportStatus("error", JSONObject().put("message", e.message ?: "captura"))
                }
                .getOrNull()

            if (usedTorch && !_state.value.torchOn) camera.setTorch(false)
            if (bytes == null) return@launch

            val mb = bytes.size / 1024.0 / 1024.0
            _state.update { it.copy(stage = Stage.UPLOADING, message = "Enviando %.1f MB…".format(mb)) }
            client.reportStatus("uploading", JSONObject().put("bytes", bytes.size).put("tier", "nativo"))

            runCatching {
                withContext(Dispatchers.IO) { uploader.upload(bytes, aspectRatio, _state.value.mirror) }
            }.onSuccess { result ->
                showResult(result, mb)
                client.reportStatus("done")
            }.onFailure { e ->
                fail("Falha no envio: ${e.message}")
                client.reportStatus("error", JSONObject().put("message", e.message ?: "envio"))
            }
        }
    }

    /** Foto composta e QR carregados aqui: o app mostra o resultado sozinho. */
    private suspend fun showResult(result: PhotoUploader.Result, uploadedMb: Double) {
        _state.update { it.copy(stage = Stage.RESULT, message = "Gerando o QR…") }

        val photo = fetchBitmap(client.absolute(result.imageUrl))
        val qr = fetchBitmap(client.qrUrl(result.pageUrl))

        _state.update {
            it.copy(
                stage = Stage.RESULT,
                message = null,
                photoCount = it.photoCount + 1,
                resultPhoto = photo,
                resultQr = qr,
                resultPageUrl = client.absolute(result.pageUrl),
                resultInfo = "${result.finalWidth} × ${result.finalHeight} · " +
                    "%.1f MB · enviado %.1f MB".format(result.finalBytes / 1024.0 / 1024.0, uploadedMb),
            )
        }

        // Volta ao visor sozinho, mas o operador pode adiantar tocando.
        resultJob?.cancel()
        resultJob = viewModelScope.launch {
            delay(RESULT_MS)
            backToPreview()
        }
    }

    fun backToPreview() {
        resultJob?.cancel()
        _state.update {
            it.copy(stage = Stage.READY, resultPhoto = null, resultQr = null, resultInfo = "", message = null)
        }
    }

    private fun fail(message: String) {
        _state.update { it.copy(stage = Stage.READY, message = null, error = message) }
    }

    private suspend fun fetchBitmap(url: String): Bitmap? = withContext(Dispatchers.IO) {
        runCatching {
            http.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
                if (!response.isSuccessful) return@use null
                response.body?.byteStream()?.let { BitmapFactory.decodeStream(it) }
            }
        }.getOrNull()
    }

    /* ═══════════════════════════════════════════════════════
       PREVIEW RELAYADO (só quando há telão sem rota direta)
       ═══════════════════════════════════════════════════════ */

    private fun startRelay() {
        val config = client.config ?: return
        relayEnabled = true
        _state.update { it.copy(relaying = true) }

        val intervalMs = 1000L / config.relayFps.coerceAtLeast(1)
        var lastSent = 0L

        camera.onAnalysisFrame = { proxy ->
            val now = System.currentTimeMillis()
            val busy = _state.value.stage == Stage.CAPTURING
            if (!busy && now - lastSent >= intervalMs) {
                lastSent = now
                camera.frameToJpeg(proxy, config.relayWidth, config.relayQuality)?.let { frame ->
                    client.sendRelayFrame(frame.jpeg, frame.width, frame.height)
                }
            }
            proxy.close()
        }
    }

    private fun stopRelay() {
        relayEnabled = false
        camera.onAnalysisFrame = null
        _state.update { it.copy(relaying = false) }
    }

    override fun onCleared() {
        stopRelay()
        client.disconnect()
        camera.release()
        super.onCleared()
    }

    companion object {
        private const val RESULT_MS = 15_000L
    }
}
