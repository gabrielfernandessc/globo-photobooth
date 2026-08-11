package com.globo.photobooth

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Envia a foto pelo caminho que o servidor indicar em /api/config.
 *
 * multipart  servidor próprio: o arquivo vai inteiro, sem limite
 *            relevante. É o cenário do evento.
 * direto     Vercel: o corpo de uma função para em 4,5 MB, e uma foto de
 *            50 MP passa de 15 MB. O app pede um token, sobe direto para
 *            o Blob e depois avisa ao servidor só a URL.
 */
class PhotoUploader(
    private val client: BoothClient,
    private val http: OkHttpClient = BoothClient.defaultHttp(),
) {

    data class Result(val finalWidth: Int, val finalHeight: Int, val finalBytes: Long, val pageUrl: String)

    fun upload(jpeg: ByteArray, aspectRatio: String, mirror: Boolean): Result {
        val config = client.config ?: error("Configuração do servidor não carregada")
        return if (config.directUpload) uploadViaBlob(jpeg, aspectRatio, mirror)
        else uploadMultipart(jpeg, aspectRatio, mirror)
    }

    private fun uploadMultipart(jpeg: ByteArray, aspectRatio: String, mirror: Boolean): Result {
        val code = client.sessionCode ?: error("Sem sessão")

        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("photo", "capture.jpg", jpeg.toRequestBody(JPEG))
            .addFormDataPart("code", code)
            .addFormDataPart("aspectRatio", aspectRatio)
            .addFormDataPart("mirror", mirror.toString())
            .addFormDataPart("source", "android")
            .build()

        val request = Request.Builder().url("${client.baseUrl}/api/photo/capture").post(body).build()
        return http.newCall(request).execute().use { parseResult(it.body?.string(), it.code) }
    }

    private fun uploadViaBlob(jpeg: ByteArray, aspectRatio: String, mirror: Boolean): Result {
        val code = client.sessionCode ?: error("Sem sessão")
        val pathname = "capture/${code}_${System.currentTimeMillis()}.jpg"

        // 1. O servidor autoriza pela sessão e devolve um token de escrita.
        val tokenBody = JSONObject().apply {
            put("type", "blob.generate-client-token")
            put("payload", JSONObject().apply {
                put("pathname", pathname)
                put("callbackUrl", "${client.baseUrl}/api/blob/upload")
                put("clientPayload", code)
                put("multipart", false)
            })
        }
        val tokenRequest = Request.Builder()
            .url("${client.baseUrl}/api/blob/upload")
            .post(tokenBody.toString().toRequestBody(JSON))
            .build()

        val clientToken = http.newCall(tokenRequest).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("Token negado (HTTP ${response.code}): $text")
            JSONObject(text).optString("clientToken").ifEmpty { error("Servidor não devolveu token") }
        }

        // 2. Os bytes vão do aparelho direto para o Blob, sem passar pela função.
        val putRequest = Request.Builder()
            .url("$BLOB_ENDPOINT/$pathname")
            .header("authorization", "Bearer $clientToken")
            .header("x-content-type", "image/jpeg")
            .header("x-api-version", BLOB_API_VERSION)
            .put(jpeg.toRequestBody(JPEG))
            .build()

        val blobUrl = http.newCall(putRequest).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("Upload para o Blob falhou (HTTP ${response.code}): $text")
            JSONObject(text).optString("url").ifEmpty { error("Blob não devolveu url") }
        }

        // 3. O servidor baixa do Blob, compõe com a moldura e publica.
        val finalizeBody = JSONObject().apply {
            put("sourceUrl", blobUrl)
            put("code", code)
            put("aspectRatio", aspectRatio)
            put("mirror", mirror)
            put("source", "android")
        }
        val finalizeRequest = Request.Builder()
            .url("${client.baseUrl}/api/photo/capture-url")
            .post(finalizeBody.toString().toRequestBody(JSON))
            .build()

        return http.newCall(finalizeRequest).execute().use { parseResult(it.body?.string(), it.code) }
    }

    private fun parseResult(text: String?, status: Int): Result {
        val json = runCatching { JSONObject(text.orEmpty()) }.getOrNull()
            ?: error("Resposta inválida do servidor (HTTP $status)")

        if (!json.optBoolean("success", false)) {
            error(json.optString("error").ifEmpty { "Falha no envio (HTTP $status)" })
        }

        val data = json.optJSONObject("data") ?: error("Resposta sem dados")
        val meta = data.optJSONObject("meta")
        Log.i(TAG, "foto publicada: ${meta?.optInt("finalWidth")}x${meta?.optInt("finalHeight")}")

        return Result(
            finalWidth = meta?.optInt("finalWidth") ?: 0,
            finalHeight = meta?.optInt("finalHeight") ?: 0,
            finalBytes = meta?.optLong("finalBytes") ?: 0L,
            pageUrl = data.optString("pageUrl"),
        )
    }

    companion object {
        private const val TAG = "PhotoUploader"
        private const val BLOB_ENDPOINT = "https://blob.vercel-storage.com"
        private const val BLOB_API_VERSION = "7"
        private val JPEG = "image/jpeg".toMediaType()
        private val JSON = "application/json".toMediaType()
    }
}
