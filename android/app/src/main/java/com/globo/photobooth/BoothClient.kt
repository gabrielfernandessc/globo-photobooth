package com.globo.photobooth

import android.util.Log
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import okhttp3.OkHttpClient
import okhttp3.Request
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
    )

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
            val ok = args.json()?.optBoolean("success", false) ?: false
            onConnectionChange?.invoke(ok)
        })
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
