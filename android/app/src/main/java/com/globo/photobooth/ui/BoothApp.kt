package com.globo.photobooth.ui

import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.globo.photobooth.BoothViewModel
import com.globo.photobooth.CameraController

@Composable
fun BoothApp(
    viewModel: BoothViewModel,
    hasCameraPermission: Boolean,
    onRequestPermission: () -> Unit,
) {
    val state by viewModel.state.collectAsState()

    Surface(modifier = Modifier.fillMaxSize(), color = Fundo) {
        when {
            !hasCameraPermission -> PermissionScreen(onRequestPermission)
            state.stage == BoothViewModel.Stage.SETUP ||
                state.stage == BoothViewModel.Stage.CONNECTING -> SetupScreen(viewModel, state)
            else -> CameraScreen(viewModel, state)
        }
    }
}

/* ═══════════════════════════════════════════════════════════
   PERMISSÃO
   ═══════════════════════════════════════════════════════════ */

@Composable
private fun PermissionScreen(onRequest: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Acesso à câmera", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            "Este aparelho vira a câmera do totem. Sem a permissão não há como capturar.",
            textAlign = TextAlign.Center,
            color = Color.White.copy(alpha = .7f),
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = onRequest) { Text("Permitir") }
    }
}

/* ═══════════════════════════════════════════════════════════
   PAREAMENTO
   ═══════════════════════════════════════════════════════════ */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SetupScreen(viewModel: BoothViewModel, state: BoothViewModel.UiState) {
    var url by remember { mutableStateOf(state.serverUrl.ifEmpty { "http://192.168.0.10:3000" }) }
    var code by remember { mutableStateOf(state.code) }
    val connecting = state.stage == BoothViewModel.Stage.CONNECTING

    Column(
        modifier = Modifier.fillMaxSize().padding(28.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Fotoboarding", fontSize = 30.sp, fontWeight = FontWeight.ExtraBold, color = GloboAzul)
        Text(
            "Este aparelho como câmera do totem",
            color = Color.White.copy(alpha = .65f),
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(32.dp))

        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Endereço do totem") },
            supportingText = { Text("O IP que aparece no console do servidor") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))

        OutlinedTextField(
            value = code,
            onValueChange = { if (it.length <= 4) code = it.uppercase() },
            label = { Text("Código da sessão") },
            supportingText = { Text("Os 4 caracteres na tela do totem") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
                imeAction = ImeAction.Done,
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        state.error?.let {
            Spacer(Modifier.height(16.dp))
            Text(it, color = GloboVermelho, textAlign = TextAlign.Center)
        }

        Spacer(Modifier.height(28.dp))
        Button(
            onClick = { viewModel.connect(url, code) },
            enabled = !connecting && code.length == 4,
            modifier = Modifier.fillMaxWidth().height(54.dp),
        ) {
            if (connecting) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(12.dp))
                Text("Conectando…")
            } else {
                Text("Conectar como câmera", fontWeight = FontWeight.Bold)
            }
        }
    }
}

/* ═══════════════════════════════════════════════════════════
   CÂMERA
   ═══════════════════════════════════════════════════════════ */

@Composable
private fun CameraScreen(viewModel: BoothViewModel, state: BoothViewModel.UiState) {
    val lifecycleOwner = LocalLifecycleOwner.current
    var showSettings by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize()) {

        Box(Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {
            AndroidView(
                factory = { context ->
                    PreviewView(context).apply {
                        scaleType = PreviewView.ScaleType.FIT_CENTER
                        viewModel.bindCamera(lifecycleOwner, this)
                    }
                },
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        detectTapGestures { offset -> viewModel.focusAt(offset.x, offset.y) }
                    },
            )

            StatusRow(state, Modifier.align(Alignment.TopStart))

            if (state.countdown > 0) {
                Box(
                    Modifier.fillMaxSize().background(Color.Black.copy(alpha = .35f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "${state.countdown}",
                        fontSize = 90.sp,
                        fontWeight = FontWeight.ExtraBold,
                        color = Color.White,
                    )
                }
            }

            if (state.stage == BoothViewModel.Stage.CAPTURING ||
                state.stage == BoothViewModel.Stage.UPLOADING
            ) {
                Box(
                    Modifier.fillMaxSize().background(Color.Black.copy(alpha = .45f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(color = GloboAzul)
                        Spacer(Modifier.height(12.dp))
                        Text(
                            if (state.stage == BoothViewModel.Stage.CAPTURING) "Capturando…"
                            else state.message ?: "Enviando…",
                            color = Color.White,
                        )
                    }
                }
            }
        }

        ControlPanel(viewModel, state, showSettings) { showSettings = !showSettings }
    }
}

@Composable
private fun StatusRow(state: BoothViewModel.UiState, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Chip(
            text = when {
                state.relaying -> "Transmitindo (servidor)"
                state.connected -> "Conectado"
                else -> "Reconectando…"
            },
            dot = if (state.connected) Color(0xFF4ADE80) else GloboAmarelo,
        )
        Chip(text = "${state.photoResolution}  ·  ${"%.1f".format(state.megapixels)} MP")
        Chip(text = state.code)
    }
}

@Composable
private fun Chip(text: String, dot: Color? = null) {
    Row(
        modifier = Modifier
            .background(Color.Black.copy(alpha = .55f), RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        dot?.let { Box(Modifier.size(7.dp).background(it, CircleShape)) }
        Text(text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
    }
}

@Composable
private fun ControlPanel(
    viewModel: BoothViewModel,
    state: BoothViewModel.UiState,
    showSettings: Boolean,
    onToggleSettings: () -> Unit,
) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val busy = state.stage != BoothViewModel.Stage.READY

    Column(
        Modifier
            .fillMaxWidth()
            .background(Fundo)
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            QuickButton("🔦", "Luz", state.torchOn, enabled = state.hasTorch) { viewModel.toggleTorch() }
            QuickButton("🔄", "Virar") { viewModel.flipLens(lifecycleOwner) }
            QuickButton("🪞", "Espelho", state.mirror) { viewModel.toggleMirror() }
            QuickButton("⚙️", "Ajustes", showSettings) { onToggleSettings() }
        }

        Spacer(Modifier.height(20.dp))

        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Button(
                onClick = { viewModel.requestCapture() },
                enabled = !busy && state.connected,
                shape = CircleShape,
                modifier = Modifier.size(78.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.White),
            ) {}
        }

        Spacer(Modifier.height(10.dp))
        Text(
            state.error
                ?: state.lastCapture?.let { "Última: $it  ·  ${state.photoCount} foto(s)" }
                ?: "Toque para disparar — o totem faz a contagem",
            fontSize = 12.sp,
            color = if (state.error != null) GloboVermelho else Color.White.copy(alpha = .6f),
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )

        if (showSettings) {
            Spacer(Modifier.height(20.dp))
            HorizontalDivider(color = Color.White.copy(alpha = .1f))
            Spacer(Modifier.height(16.dp))
            SettingsSection(viewModel, state, lifecycleOwner)
        }
    }
}

@Composable
private fun SettingsSection(
    viewModel: BoothViewModel,
    state: BoothViewModel.UiState,
    lifecycleOwner: androidx.lifecycle.LifecycleOwner,
) {
    Text("MODO DE CAPTURA", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Color.White.copy(alpha = .55f))
    Spacer(Modifier.height(8.dp))

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ModeChip(
            "Qualidade máxima",
            state.captureMode == CameraController.CaptureMode.QUALITY,
            Modifier.weight(1f),
        ) { viewModel.setCaptureMode(CameraController.CaptureMode.QUALITY, lifecycleOwner) }

        ModeChip(
            "Zero lag",
            state.captureMode == CameraController.CaptureMode.ZSL,
            Modifier.weight(1f),
        ) { viewModel.setCaptureMode(CameraController.CaptureMode.ZSL, lifecycleOwner) }
    }
    Spacer(Modifier.height(6.dp))
    Text(
        "Qualidade máxima usa a resolução plena do sensor. Zero lag dispara na hora, " +
            "mas na resolução reduzida — o hardware não faz os dois.",
        fontSize = 11.sp,
        color = Color.White.copy(alpha = .5f),
    )

    if (state.maxZoom > state.zoom) {
        Spacer(Modifier.height(20.dp))
        Text(
            "ZOOM  ${"%.1f".format(state.zoom)}x",
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            color = Color.White.copy(alpha = .55f),
        )
        Slider(
            value = state.zoom,
            onValueChange = { viewModel.setZoom(it) },
            valueRange = 1f..state.maxZoom,
        )
    }

    Spacer(Modifier.height(16.dp))
    Text(
        "Foto: ${state.photoResolution} (${"%.1f".format(state.megapixels)} MP)\n" +
            "Proporção do totem: ${state.aspectRatio}",
        fontSize = 12.sp,
        color = Color.White.copy(alpha = .6f),
    )

    Spacer(Modifier.height(20.dp))
    OutlinedButton(onClick = { viewModel.disconnect() }, modifier = Modifier.fillMaxWidth()) {
        Text("Desconectar deste totem")
    }
}

@Composable
private fun RowScope.QuickButton(
    icon: String,
    label: String,
    active: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .weight(1f)
            .background(
                if (active) GloboAzul.copy(alpha = .18f) else Superficie,
                RoundedCornerShape(12.dp),
            )
            .clickableIf(enabled, onClick)
            .padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(icon, fontSize = 18.sp)
        Spacer(Modifier.height(3.dp))
        Text(
            label,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = if (enabled) Color.White else Color.White.copy(alpha = .3f),
        )
    }
}

@Composable
private fun ModeChip(label: String, active: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .background(
                if (active) GloboAzul.copy(alpha = .18f) else Superficie,
                RoundedCornerShape(12.dp),
            )
            .clickableIf(true, onClick)
            .padding(vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = if (active) GloboAzul else Color.White.copy(alpha = .75f),
        )
    }
}

private fun Modifier.clickableIf(enabled: Boolean, onClick: () -> Unit): Modifier =
    if (enabled) this.then(Modifier.clickable(onClick = onClick)) else this
