package com.globo.photobooth

import android.util.Log
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * Conversa com o servidor do totem usando o MESMO protocolo da página
 * web: os papéis, o pareamento por código, o disparo e o relay de
 * preview são idênticos. Nada muda no servidor por causa do app.
 */
class BoothClient(private val http: OkHttpClient = defaultHttp()) {

    data class ServerConfig(
        val socketPath: String,
        val transports: Array<String>,
        val directUpload: Boolean,
        val relayWidth: Int,
        val relayFps: Int,
        val relayQuality: Int,
        val platform: String,
        val stateDriver: String,
    ) {
        /**
         * Serverless sem estado compartilhado: a sessão criada numa
         * instância não existe na próxima, e o upload é recusado com
         * "sessão não encontrada". Detectar isso na largada evita
         * descobrir no meio do evento.
         */
        val misconfigured: String?
            get() = if (platform == "vercel" && stateDriver != "redis") {
                "O servidor está na Vercel sem Redis conectado. As fotos vão falhar ao enviar. " +
                    "Conecte um Redis ao projeto (Storage → Marketplace) e confira em /api/health."
            } else null
    }

    var baseUrl: String = ""
        private set

    var config: ServerConfig? = null
        private set

    private var socket: Socket? = null
    var sessionCode: String? = null
        private set

    /** Callbacks preenchidos pela ViewModel. */
    var onConnectionChange: ((Boolean) -> Unit)? = null
    var onCountdown: ((Int) -> Unit)? = null
    var onShoot: ((String, String) -> Unit)? = null
    var onRelayToggle: ((Boolean) -> Unit)? = null
    var onSettings: ((JSONObject) -> Unit)? = null
    var onControl: ((JSONObject) -> Unit)? = null

    /**
     * Se existe um totem aberto nesta sessão. Sem ele, o app conduz a
     * contagem e dispara sozinho; com ele, respeita o "camera-shoot" do
     * totem para a foto sair no zero da contagem que o público vê.
     */
    var hasDisplay: Boolean = false
        private set
    var onPresenceChange: ((Boolean) -> Unit)? = null

    /**
     * Prova de sessão assinada pelo servidor. É ela, e não o código, que
     * autoriza o upload: assim a foto sobe mesmo quando a função que
     * atende o pedido nunca viu esta sessão.
     */
    var sessionToken: String? = null
        private set

    /** Abre uma sessão sem depender de nenhuma tela — o app é o principal. */
    fun createSession(rawUrl: String): Result<String> = runCatching {
        val normalized = normalizeBaseUrl(rawUrl)
        val request = Request.Builder()
            .url("$normalized/api/session")
            .post("{}".toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("Servidor respondeu HTTP ${response.code}: $text")
            val json = JSONObject(text)
            sessionToken = json.optString("token").ifEmpty { null }
            json.optString("code").ifEmpty { error("Servidor não devolveu código") }
        }
    }

    /** URL absoluta a partir de um caminho relativo devolvido pela API. */
    fun absolute(pathOrUrl: String): String =
        if (pathOrUrl.startsWith("http")) pathOrUrl else "$baseUrl$pathOrUrl"

    /** QR gerado pelo próprio servidor — funciona sem internet no evento. */
    fun qrUrl(target: String, size: Int = 600): String =
        "$baseUrl/api/qr?size=$size&data=" + java.net.URLEncoder.encode(absolute(target), "UTF-8")

    /**
     * Descobre onde o Socket.IO mora e como enviar a foto. O caminho e o
     * transporte mudam entre o servidor local e a Vercel, então nada
     * disso pode ficar fixo no app.
     */
    fun fetchConfig(rawUrl: String): Result<ServerConfig> = runCatching {
        val normalized = normalizeBaseUrl(rawUrl)
        val request = Request.Builder().url("$normalized/api/config").get().build()

        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Servidor respondeu HTTP ${response.code}")
            val json = JSONObject(response.body?.string().orEmpty())

            val transports = json.optJSONArray("transports")?.toStringArray() ?: arrayOf("websocket")
            val relay = json.optJSONObject("relay")

            val parsed = ServerConfig(
                socketPath = json.optString("socketPath", "/socket.io"),
                transports = transports,
                directUpload = json.optBoolean("directUpload", false),
                relayWidth = relay?.optInt("width", 640) ?: 640,
                relayFps = relay?.optInt("fps", 8) ?: 8,
                relayQuality = ((relay?.optDouble("quality", 0.5) ?: 0.5) * 100).toInt(),
                platform = json.optString("platform", "self-hosted"),
                stateDriver = json.optString("state", "memory"),
            )

            baseUrl = normalized
            config = parsed
            parsed
        }
    }

    /** Aceita "192.168.0.10:3000", "totem.local" ou a URL completa. */
    private fun normalizeBaseUrl(raw: String): String {
        val trimmed = raw.trim().trimEnd('/')
        val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            // Sem esquema, assume HTTP: o caso comum é o servidor na LAN,
            // onde o app não precisa de TLS.
            "http://$trimmed"
        }
        return withScheme
    }

    fun connect(code: String) {
        val current = config ?: error("Chame fetchConfig antes de conectar")
        disconnect()
        sessionCode = code.uppercase()

        val options = IO.Options().apply {
            path = current.socketPath
            transports = current.transports
            reconnection = true
            reconnectionDelay = 1000
            reconnectionDelayMax = 5000
            reconnectionAttempts = Int.MAX_VALUE
        }

        socket = IO.socket(URI.create(baseUrl), options).apply {
            on(Socket.EVENT_CONNECT) {
                Log.i(TAG, "socket conectado")
                joinAsCamera()
            }
            on(Socket.EVENT_DISCONNECT) { onConnectionChange?.invoke(false) }
            on(Socket.EVENT_CONNECT_ERROR) { args ->
                Log.w(TAG, "erro de conexão: ${args.firstOrNull()}")
                onConnectionChange?.invoke(false)
            }

            on("start-countdown") { args ->
                onCountdown?.invoke(args.json()?.optInt("timer", 3) ?: 3)
            }
            on("camera-shoot") { args ->
                val json = args.json()
                onShoot?.invoke(
                    json?.optString("aspectRatio", "3:4") ?: "3:4",
                    json?.optString("flashMode", "off") ?: "off",
                )
            }
            on("preview-relay") { args ->
                onRelayToggle?.invoke(args.json()?.optBoolean("enabled", false) ?: false)
            }
            on("display-ready") { onRelayToggle?.invoke(false) }

            on("presence") { args -> updatePresence(args.json()) }
            on("camera-disconnected") { /* é o próprio app; ignora */ }
            on("display-disconnected") { setDisplay(false) }
            on("settings-updated") { args -> args.json()?.let { onSettings?.invoke(it) } }
            on("camera-control") { args ->
                args.json()?.optJSONObject("cmd")?.let { onControl?.invoke(it) }
            }

            connect()
        }
    }

    private fun joinAsCamera() {
        val code = sessionCode ?: return
        val payload = JSONObject().apply {
            put("code", code)
            put("role", "camera")
            put("info", JSONObject().put("label", "${android.os.Build.MODEL} (app nativo)"))
        }
        // Ack explícito: emit é varargs no Java, e a conversão SAM com
        // lambda solta fica ambígua.
        socket?.emit("join-session", arrayOf<Any>(payload), Ack { args ->
            val snapshot = args.json()
            val ok = snapshot?.optBoolean("success", false) ?: false
            updatePresence(snapshot)
            onConnectionChange?.invoke(ok)
        })
    }

    private fun updatePresence(snapshot: JSONObject?) {
        if (snapshot == null || !snapshot.has("hasDisplay")) return
        setDisplay(snapshot.optBoolean("hasDisplay", false))
    }

    private fun setDisplay(present: Boolean) {
        if (hasDisplay == present) return
        hasDisplay = present
        onPresenceChange?.invoke(present)
    }

    /**
     * Voltar do segundo plano costuma derrubar o socket. O socket.io
     * reconecta sozinho na maioria dos casos, mas quando o Android mata
     * a conexão de vez é preciso forçar — senão o app volta "conectado"
     * na tela e mudo no protocolo.
     */
    fun reconnect() {
        val current = socket
        val code = sessionCode ?: return
        if (current == null) {
            connect(code)
        } else if (!current.connected()) {
            current.connect()
        } else {
            joinAsCamera()
        }
    }

    fun updateSettings(settings: JSONObject) {
        emitWithCode("update-settings") { put("settings", settings) }
    }

    fun reportState(state: JSONObject) {
        emitWithCode("camera-state") { put("state", state) }
    }

    fun reportStatus(status: String, detail: JSONObject? = null) {
        emitWithCode("camera-status") {
            put("status", status)
            detail?.let { put("detail", it) }
        }
    }

    /** Pede ao totem que conduza a contagem (mesmo fluxo do botão web). */
    fun requestCapture() = emitWithCode("trigger-capture") {}

    fun sendRelayFrame(jpeg: ByteArray, width: Int, height: Int) {
        emitWithCode("preview-frame") {
            put("data", jpeg)
            put("width", width)
            put("height", height)
        }
    }

    private inline fun emitWithCode(event: String, build: JSONObject.() -> Unit) {
        val code = sessionCode ?: return
        val socket = socket ?: return
        socket.emit(event, JSONObject().apply { put("code", code); build() })
    }

    fun disconnect() {
        socket?.off()
        socket?.disconnect()
        socket = null
    }

    // Emitter.Listener entrega Object... — em Kotlin, Array<out Any>.
    private fun Array<out Any>.json(): JSONObject? = firstOrNull() as? JSONObject

    private fun JSONArray.toStringArray(): Array<String> =
        Array(length()) { optString(it) }.filter { it.isNotEmpty() }.toTypedArray()

    companion object {
        private const val TAG = "BoothClient"

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS) // foto de 50 MP em rede fraca
            .build()
    }
}
