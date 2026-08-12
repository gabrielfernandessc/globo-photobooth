package com.globo.photobooth

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import android.util.Size
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/**
 * A razão de existir do app nativo.
 *
 * O navegador entrega o que o Chrome escolhe expor: no S22, a foto
 * binada de ~12 MP, com 300–600 ms de atraso de obturador. Aqui o
 * CameraX pede a resolução PLENA do sensor (50 MP na principal do S22)
 * e, quando o modo permite, captura sem atraso nenhum.
 *
 * Dois modos, porque são mutuamente exclusivos no hardware:
 *   QUALITY  resolução máxima do sensor, com o atraso normal do still
 *   ZSL      zero shutter lag, na resolução binada
 */
class CameraController(private val context: Context) {

    enum class CaptureMode { QUALITY, ZSL }

    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var imageCapture: ImageCapture? = null
    private var analysis: ImageAnalysis? = null

    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val captureExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    /** Preenchido a cada frame quando o relay está ligado. */
    @Volatile var onAnalysisFrame: ((ImageProxy) -> Unit)? = null

    var captureMode: CaptureMode = CaptureMode.QUALITY
        private set

    var lensFacing: Int = CameraSelector.LENS_FACING_BACK
        private set

    val capabilities = Capabilities()

    class Capabilities {
        var hasTorch: Boolean = false
        var maxZoom: Float = 1f
        var minZoom: Float = 1f
        var photoResolution: Size? = null
        var sensorMegapixels: Double = 0.0
    }

    suspend fun bind(
        owner: LifecycleOwner,
        previewView: PreviewView,
        mode: CaptureMode = captureMode,
        facing: Int = lensFacing,
    ) {
        captureMode = mode
        lensFacing = facing

        val cameraProvider = provider ?: awaitProvider().also { provider = it }
        cameraProvider.unbindAll()

        val preview = Preview.Builder()
            .build()
            .apply { setSurfaceProvider(previewView.surfaceProvider) }

        imageCapture = buildImageCapture(mode)

        // Frames do preview relayado. STRATEGY_KEEP_ONLY_LATEST evita que
        // a fila cresça quando a rede está lenta — preview atrasado é
        // pior que preview com menos quadros.
        analysis = ImageAnalysis.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                    .build()
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
            .build()
            .apply {
                setAnalyzer(analysisExecutor) { proxy ->
                    val handler = onAnalysisFrame
                    if (handler == null) proxy.close() else handler(proxy)
                }
            }

        val selector = CameraSelector.Builder().requireLensFacing(facing).build()
        camera = cameraProvider.bindToLifecycle(owner, selector, preview, imageCapture, analysis)

        readCapabilities()
    }

    private fun buildImageCapture(mode: CaptureMode): ImageCapture {
        val builder = ImageCapture.Builder()
            // O CameraX comprime a 95 por padrão no modo qualidade. Como
            // esta é a foto que o convidado leva, e o servidor ainda vai
            // recodificar uma vez para aplicar a moldura, o JPEG sai
            // daqui no máximo — não há por que perder duas vezes.
            .setJpegQuality(100)

        if (mode == CaptureMode.ZSL) {
            builder.setCaptureMode(ImageCapture.CAPTURE_MODE_ZERO_SHUTTER_LAG)
        } else {
            builder.setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            // A chave dos 50 MP: sem isto o CameraX prefere manter a taxa
            // de captura e devolve o tamanho binado, igual ao navegador.
            builder.setResolutionSelector(
                ResolutionSelector.Builder()
                    .setAllowedResolutionMode(ResolutionSelector.PREFER_HIGHER_RESOLUTION_OVER_CAPTURE_RATE)
                    .setResolutionStrategy(ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY)
                    .build()
            )
        }

        return builder.build()
    }

    @SuppressLint("RestrictedApi")
    private fun readCapabilities() {
        val info = camera?.cameraInfo ?: return
        capabilities.hasTorch = info.hasFlashUnit()
        info.zoomState.value?.let {
            capabilities.minZoom = it.minZoomRatio
            capabilities.maxZoom = it.maxZoomRatio
        }
        imageCapture?.resolutionInfo?.resolution?.let {
            capabilities.photoResolution = it
            capabilities.sensorMegapixels = (it.width.toLong() * it.height) / 1_000_000.0
        }
        Log.i(TAG, "foto: ${capabilities.photoResolution} (${capabilities.sensorMegapixels} MP)")
    }

    /** JPEG em memória, sem passar por arquivo. */
    suspend fun capture(): ByteArray = suspendCoroutine { cont ->
        val capture = imageCapture ?: run {
            cont.resumeWithException(IllegalStateException("Câmera não está pronta"))
            return@suspendCoroutine
        }

        capture.takePicture(captureExecutor, object : ImageCapture.OnImageCapturedCallback() {
            override fun onCaptureSuccess(image: ImageProxy) {
                try {
                    val buffer = image.planes[0].buffer
                    val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
                    cont.resume(bytes)
                } catch (e: Throwable) {
                    cont.resumeWithException(e)
                } finally {
                    image.close()
                }
            }

            override fun onError(exception: ImageCaptureException) {
                cont.resumeWithException(exception)
            }
        })
    }

    /** Converte um frame de análise em JPEG pequeno para o relay. */
    fun frameToJpeg(proxy: ImageProxy, targetWidth: Int, quality: Int): RelayFrame? = try {
        val bitmap: Bitmap = proxy.toBitmap()
        val scale = targetWidth.toFloat() / bitmap.width
        val scaled = if (scale < 1f) {
            Bitmap.createScaledBitmap(bitmap, targetWidth, (bitmap.height * scale).toInt(), true)
        } else {
            bitmap
        }

        val rotated = if (proxy.imageInfo.rotationDegrees != 0) {
            val matrix = android.graphics.Matrix().apply {
                postRotate(proxy.imageInfo.rotationDegrees.toFloat())
            }
            Bitmap.createBitmap(scaled, 0, 0, scaled.width, scaled.height, matrix, true)
        } else {
            scaled
        }

        val out = ByteArrayOutputStream()
        rotated.compress(Bitmap.CompressFormat.JPEG, quality, out)
        RelayFrame(out.toByteArray(), rotated.width, rotated.height)
    } catch (e: Throwable) {
        Log.w(TAG, "falha ao montar frame do relay", e)
        null
    }

    data class RelayFrame(val jpeg: ByteArray, val width: Int, val height: Int)

    fun setTorch(on: Boolean) {
        camera?.cameraControl?.enableTorch(on)
    }

    fun setZoom(ratio: Float) {
        camera?.cameraControl?.setZoomRatio(ratio.coerceIn(capabilities.minZoom, capabilities.maxZoom))
    }

    fun setExposureIndex(index: Int) {
        camera?.cameraControl?.setExposureCompensationIndex(index)
    }

    fun exposureRange(): IntRange {
        val range = camera?.cameraInfo?.exposureState?.exposureCompensationRange ?: return 0..0
        return range.lower..range.upper
    }

    /** Toque no visor para focar num ponto. */
    fun focusAt(previewView: PreviewView, x: Float, y: Float) {
        val point = previewView.meteringPointFactory.createPoint(x, y)
        val action = FocusMeteringAction.Builder(point).build()
        camera?.cameraControl?.startFocusAndMetering(action)
    }

    fun autofocusCenter(previewView: PreviewView) {
        focusAt(previewView, previewView.width / 2f, previewView.height / 2f)
    }

    fun release() {
        provider?.unbindAll()
        analysisExecutor.shutdown()
        captureExecutor.shutdown()
    }

    private suspend fun awaitProvider(): ProcessCameraProvider = suspendCoroutine { cont ->
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try {
                cont.resume(future.get())
            } catch (e: Throwable) {
                cont.resumeWithException(e)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    companion object {
        private const val TAG = "CameraController"
    }
}
