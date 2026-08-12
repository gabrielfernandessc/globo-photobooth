package com.globo.photobooth

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File

/**
 * Atualização sem passar por loja.
 *
 * O app é distribuído por sideload, então não há Play Store para
 * empurrar versão. Em vez de refazer o download manual a cada ajuste, o
 * app pergunta ao servidor qual é a última versão publicada e, se for
 * mais nova, baixa o APK e abre o instalador do Android.
 *
 * O usuário ainda confirma a instalação — o Android não permite menos
 * que isso —, mas some a parte chata: achar o artefato, transferir para
 * o aparelho, procurar no gerenciador de arquivos.
 */
class AppUpdater(
    private val context: Context,
    private val http: OkHttpClient = BoothClient.defaultHttp(),
) {

    data class Release(
        val versionCode: Int,
        val versionName: String,
        val downloadUrl: String,
        val notes: String,
    )

    /** Devolve a release apenas se for mais nova que a instalada. */
    fun check(baseUrl: String): Release? = runCatching {
        val request = Request.Builder().url("$baseUrl/api/app/latest").get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return@use null
            val json = JSONObject(response.body?.string().orEmpty())

            val release = Release(
                versionCode = json.optInt("versionCode", 0),
                versionName = json.optString("versionName", "?"),
                downloadUrl = json.optString("downloadUrl"),
                notes = json.optString("notes"),
            )

            if (release.downloadUrl.isEmpty()) return@use null
            if (release.versionCode <= BuildConfig.VERSION_CODE) return@use null
            release
        }
    }.onFailure { Log.w(TAG, "checagem de atualização falhou", it) }.getOrNull()

    /** Baixa o APK e devolve o arquivo, reportando o progresso em 0..1. */
    fun download(release: Release, onProgress: (Float) -> Unit): File {
        val target = File(context.cacheDir, "update-${release.versionCode}.apk")
        if (target.exists()) target.delete()

        val request = Request.Builder().url(release.downloadUrl).get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Download falhou: HTTP ${response.code}")
            val body = response.body ?: error("Resposta sem corpo")
            val total = body.contentLength()

            body.byteStream().use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var read: Int
                    var done = 0L
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        done += read
                        if (total > 0) onProgress(done.toFloat() / total)
                    }
                }
            }
        }
        return target
    }

    /**
     * Entrega o APK ao instalador do sistema. O FileProvider é
     * obrigatório: desde o Android 7 não se pode passar file:// entre
     * aplicativos.
     */
    fun install(apk: File) {
        val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    companion object {
        private const val TAG = "AppUpdater"
    }
}
