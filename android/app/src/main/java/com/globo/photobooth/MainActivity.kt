package com.globo.photobooth

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.globo.photobooth.ui.BoothApp
import com.globo.photobooth.ui.GloboTheme

class MainActivity : ComponentActivity() {

    private var hasCameraPermission by mutableStateOf(false)
    private var viewModel: BoothViewModel? = null

    /**
     * Alternar de app derruba o vínculo do CameraX e, com frequência, o
     * socket. Sem reatar os dois aqui, voltar ao Fotoboarding deixava a
     * tela preta e a sessão muda.
     */
    override fun onResume() {
        super.onResume()
        viewModel?.onResume()
    }

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> hasCameraPermission = granted }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // O aparelho fica horas apoiado servindo de câmera: a tela não
        // pode dormir no meio do evento.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        hasCameraPermission = ContextCompat.checkSelfPermission(
            this, Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasCameraPermission) requestPermission.launch(Manifest.permission.CAMERA)

        setContent {
            GloboTheme {
                val vm: BoothViewModel = viewModel()
                LaunchedEffect(vm) { viewModel = vm }
                BoothApp(
                    viewModel = vm,
                    hasCameraPermission = hasCameraPermission,
                    onRequestPermission = { requestPermission.launch(Manifest.permission.CAMERA) },
                )
            }
        }
    }
}
