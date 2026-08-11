package com.globo.photobooth

import android.app.Application
import androidx.camera.core.CameraSelector
import androidx.camera.view.PreviewView
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class BoothViewModel(app: Application) : AndroidViewModel(app) {

    enum class Stage { SETUP, CONNECTING, READY, COUNTDOWN, CAPTURING, UPLOADING }

    data class UiState(
        val stage: Stage = Stage.SETUP,
        val serverUrl: String = "",
        val code: String = "",
        val connected: Boolean = false,
        val message: String? = null,
        val error: String? = null,
        val countdown: Int = 0,
        val photoResolution: String = "—",
        val megapixels: Double = 0.0,
        val lastCapture: String? = null,
        val photoCount: Int = 0,
        val relaying: Boolean = false,
        val torchOn: Boolean = false,
        val zoom: Float = 1f,
        val maxZoom: Float = 1f,
        val hasTorch: Boolean = false,
        val captureMode: CameraController.CaptureMode = CameraController.CaptureMode.QUALITY,
        val mirror: Boolean = false,
        val aspectRatio: String = "3:4",
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    val camera = CameraController(app.applicationContext)
    private val client = BoothClient()
    private val uploader = PhotoUploader(client)

    private var relayJob: kotlinx.coroutines.Job? = null
    private var previewView: PreviewView? = null

    init {
        client.onConnectionChange = { ok ->
            _state.update {
                it.copy(
                    connected = ok,
                    stage = if (ok && it.stage == Stage.CONNECTING) Stage.READY else it.stage,
                    error = if (ok) null else it.error,
                )
            }
            if (ok) publishState()
        }
        client.onCountdown = { seconds -> runCountdown(seconds) }
        client.onShoot = { ratio, flash -> shoot(ratio, flash) }
        client.onRelayToggle = { enabled -> if (enabled) startRelay() else stopRelay() }
        client.onSettings = { settings ->
            settings.optString("aspectRatio").takeIf { it.isNotEmpty() }?.let { ratio ->
                _state.update { it.copy(aspectRatio = ratio) }
            }
        }
        client.onControl = { cmd -> applyRemoteControl(cmd) }
    }

    /* ═══ Pareamento ═══ */

    fun connect(serverUrl: String, code: String) {
        if (serverUrl.isBlank() || code.length != 4) {
            _state.update { it.copy(error = "Informe o endereço do totem e o código de 4 caracteres") }
            return
        }

        _state.update { it.copy(stage = Stage.CONNECTING, error = null, serverUrl = serverUrl, code = code.uppercase()) }

        viewModelScope.launch(Dispatchers.IO) {
            client.fetchConfig(serverUrl)
                .onSuccess {
                    client.connect(code)
                }
                .onFailure { e ->
                    _state.update {
                        it.copy(stage = Stage.SETUP, error = "Não achei o totem em $serverUrl — ${e.message}")
                    }
                }
        }
    }

    fun disconnect() {
        stopRelay()
        client.disconnect()
        _state.update { it.copy(stage = Stage.SETUP, connected = false) }
    }

    /* ═══ Câmera ═══ */

    fun bindCamera(owner: LifecycleOwner, view: PreviewView) {
        previewView = view
        viewModelScope.launch {
            runCatching { camera.bind(owner, view, _state.value.captureMode) }
                .onSuccess { publishCapabilities() }
                .onFailure { e -> _state.update { it.copy(error = "Falha ao abrir a câmera: ${e.message}") } }
        }
    }

    fun setCaptureMode(mode: CameraController.CaptureMode, owner: LifecycleOwner) {
        val view = previewView ?: return
        _state.update { it.copy(captureMode = mode) }
        viewModelScope.launch {
            runCatching { camera.bind(owner, view, mode) }.onSuccess { publishCapabilities() }
        }
    }

    fun flipLens(owner: LifecycleOwner) {
        val view = previewView ?: return
        val next = if (camera.lensFacing == CameraSelector.LENS_FACING_BACK) {
            CameraSelector.LENS_FACING_FRONT
        } else {
            CameraSelector.LENS_FACING_BACK
        }
        // Câmera frontal: o natural é a foto sair espelhada, como a pessoa se vê.
        _state.update { it.copy(mirror = next == CameraSelector.LENS_FACING_FRONT) }
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

    fun focusAt(x: Float, y: Float) {
        previewView?.let { camera.focusAt(it, x, y) }
    }

    fun toggleMirror() = _state.update { it.copy(mirror = !it.mirror) }

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

    /* ═══ Disparo ═══ */

    /** Pede ao totem que conduza a contagem, igual ao botão da página web. */
    fun requestCapture() {
        if (_state.value.stage != Stage.READY) return
        client.requestCapture()
    }

    private fun runCountdown(seconds: Int) {
        viewModelScope.launch {
            _state.update { it.copy(stage = Stage.COUNTDOWN) }
            for (i in seconds downTo 1) {
                _state.update { it.copy(countdown = i) }
                delay(1000)
            }
            _state.update { it.copy(countdown = 0) }
        }
    }

    private fun shoot(aspectRatio: String, flashMode: String) {
        viewModelScope.launch {
            _state.update { it.copy(stage = Stage.CAPTURING, aspectRatio = aspectRatio, error = null) }
            client.reportStatus("capturing")

            if (flashMode == "torch" || flashMode == "flash") camera.setTorch(true)

            val bytes = runCatching { camera.capture() }
                .onFailure { e ->
                    fail("Falha na captura: ${e.message}")
                    client.reportStatus("error", JSONObject().put("message", e.message ?: "captura"))
                }
                .getOrNull()

            if (flashMode == "torch" || flashMode == "flash") {
                if (!_state.value.torchOn) camera.setTorch(false)
            }
            if (bytes == null) return@launch

            _state.update { it.copy(stage = Stage.UPLOADING, message = "Enviando ${bytes.size / 1024 / 1024} MB…") }
            client.reportStatus("uploading", JSONObject().put("bytes", bytes.size).put("tier", "nativo"))

            runCatching {
                withContext(Dispatchers.IO) {
                    uploader.upload(bytes, aspectRatio, _state.value.mirror)
                }
            }.onSuccess { result ->
                _state.update {
                    it.copy(
                        stage = Stage.READY,
                        message = null,
                        photoCount = it.photoCount + 1,
                        lastCapture = "${result.finalWidth}×${result.finalHeight} · ${result.finalBytes / 1024 / 1024} MB",
                    )
                }
                client.reportStatus("done")
            }.onFailure { e ->
                fail("Falha no envio: ${e.message}")
                client.reportStatus("error", JSONObject().put("message", e.message ?: "envio"))
            }
        }
    }

    private fun fail(message: String) {
        _state.update { it.copy(stage = Stage.READY, message = null, error = message) }
    }

    /* ═══ Preview relayado ═══ */

    private fun startRelay() {
        if (relayJob != null) return
        val config = client.config ?: return
        _state.update { it.copy(relaying = true) }

        val intervalMs = (1000L / config.relayFps.coerceAtLeast(1))
        var lastSent = 0L

        camera.onAnalysisFrame = { proxy ->
            val now = System.currentTimeMillis()
            if (now - lastSent >= intervalMs && _state.value.stage != Stage.CAPTURING) {
                lastSent = now
                camera.frameToJpeg(proxy, config.relayWidth, config.relayQuality)?.let { frame ->
                    client.sendRelayFrame(frame.jpeg, frame.width, frame.height)
                }
            }
            proxy.close()
        }

        relayJob = viewModelScope.launch { /* mantém o estado ligado */ }
    }

    private fun stopRelay() {
        camera.onAnalysisFrame = null
        relayJob?.cancel()
        relayJob = null
        _state.update { it.copy(relaying = false) }
    }

    override fun onCleared() {
        stopRelay()
        client.disconnect()
        camera.release()
        super.onCleared()
    }
}
