package com.globo.photobooth.ui

import androidx.activity.compose.BackHandler
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.globo.photobooth.BoothViewModel
import com.globo.photobooth.CameraController

@Composable
fun BoothApp(
    viewModel: BoothViewModel,
    hasCameraPermission: Boolean,
    onRequestPermission: () -> Unit,
) {
    val state by viewModel.state.collectAsState()

    // Abrir o app já é começar: o servidor é conhecido, não há o que
    // perguntar. A tela de configuração só aparece se isso falhar.
    LaunchedEffect(hasCameraPermission) {
        if (hasCameraPermission) viewModel.autoStart()
    }

    /* O voltar do aparelho fechava o app de qualquer tela. Aqui ele
       navega para trás: fecha o aviso de atualização, sai do resultado,
       cancela uma conexão travada — e só encerra quando não há mais
       nada de onde voltar. */
    BackHandler(enabled = state.update != null) { viewModel.dismissUpdate() }

    BackHandler(enabled = state.update == null && state.stage == BoothViewModel.Stage.RESULT) {
        viewModel.backToPreview()
    }

    BackHandler(enabled = state.update == null && state.stage == BoothViewModel.Stage.CONNECTING) {
        viewModel.cancelConnecting()
    }

    Surface(modifier = Modifier.fillMaxSize(), color = Fundo) {
        Box(Modifier.fillMaxSize()) {
            when {
                !hasCameraPermission -> PermissionScreen(onRequestPermission)
                state.stage == BoothViewModel.Stage.SETUP ||
                    state.stage == BoothViewModel.Stage.CONNECTING -> SetupScreen(viewModel, state)
                else -> BoothScreen(viewModel, state)
            }

            state.update?.let { release ->
                UpdateBanner(
                    release = release,
                    progress = state.updateProgress,
                    onInstall = { viewModel.installUpdate() },
                    onDismiss = { viewModel.dismissUpdate() },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}

/* ═══════════════════════════════════════════════════════════
   ATUALIZAÇÃO — o app se atualiza sozinho, sem loja
   ═══════════════════════════════════════════════════════════ */

@Composable
private fun UpdateBanner(
    release: com.globo.photobooth.AppUpdater.Release,
    progress: Float,
    onInstall: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val baixando = progress >= 0f

    Surface(
        modifier = modifier.fillMaxWidth().padding(12.dp),
        shape = RoundedCornerShape(14.dp),
        color = Superficie2,
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(
                "Nova versão disponível — ${release.versionName}",
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp,
                color = Color.White,
            )
            if (release.notes.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(release.notes, fontSize = 12.sp, color = Color.White.copy(alpha = .6f), maxLines = 2)
            }

            Spacer(Modifier.height(12.dp))

            if (baixando) {
                LinearProgressIndicator(
                    progress = { progress },
                    modifier = Modifier.fillMaxWidth(),
                    color = GloboAzul,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    "Baixando ${(progress * 100).toInt()}%…",
                    fontSize = 12.sp,
                    color = Color.White.copy(alpha = .6f),
                )
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onInstall, modifier = Modifier.weight(1f)) { Text("Atualizar") }
                    OutlinedButton(onClick = onDismiss) { Text("Depois") }
                }
            }
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
            "Este aparelho é a câmera do totem. Sem a permissão não há como capturar.",
            textAlign = TextAlign.Center,
            color = Color.White.copy(alpha = .7f),
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = onRequest) { Text("Permitir") }
    }
}

/* ═══════════════════════════════════════════════════════════
   INÍCIO — só o endereço do servidor; a sessão o app cria
   ═══════════════════════════════════════════════════════════ */

@Composable
private fun SetupScreen(viewModel: BoothViewModel, state: BoothViewModel.UiState) {
    var url by remember { mutableStateOf(state.serverUrl.ifEmpty { "http://192.168.0.10:3000" }) }
    val connecting = state.stage == BoothViewModel.Stage.CONNECTING

    Column(
        modifier = Modifier.fillMaxSize().padding(28.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Fotoboarding", fontSize = 32.sp, fontWeight = FontWeight.ExtraBold, color = GloboAzul)
        Spacer(Modifier.height(4.dp))
        Text(
            if (connecting) "Conectando…" else "Este aparelho é o totem.",
            color = Color.White.copy(alpha = .65f),
            textAlign = TextAlign.Center,
            lineHeight = 20.sp,
        )
        Spacer(Modifier.height(36.dp))

        if (connecting) {
            CircularProgressIndicator(color = GloboAzul)
        } else {
            // Só aparece quando a conexão automática falha, ou quando o
            // operador encerra a sessão de propósito.
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Endereço do servidor") },
                supportingText = { Text("Padrão: o servidor da Vercel. Troque só para usar um servidor local.") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )

            state.error?.let {
                Spacer(Modifier.height(16.dp))
                Text(it, color = GloboVermelho, textAlign = TextAlign.Center, fontSize = 13.sp)
            }

            Spacer(Modifier.height(28.dp))
            Button(
                onClick = { viewModel.start(url) },
                modifier = Modifier.fillMaxWidth().height(54.dp),
            ) {
                Text("Conectar", fontWeight = FontWeight.Bold)
            }
        }

        Spacer(Modifier.height(24.dp))
        Text(
            "versão ${state.appVersion}",
            fontSize = 11.sp,
            color = Color.White.copy(alpha = .35f),
        )
    }
}

/* ═══════════════════════════════════════════════════════════
   TOTEM — visor, contagem e resultado, tudo no aparelho
   ═══════════════════════════════════════════════════════════ */

@Composable
private fun BoothScreen(viewModel: BoothViewModel, state: BoothViewModel.UiState) {
    val lifecycleOwner = LocalLifecycleOwner.current
    var panel by remember { mutableStateOf(Panel.NONE) }

    // Painel aberto: voltar fecha o painel, não o app.
    BackHandler(enabled = panel != Panel.NONE && state.stage != BoothViewModel.Stage.RESULT) {
        panel = Panel.NONE
    }

    Column(Modifier.fillMaxSize()) {

        Box(Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {

            AndroidView(
                factory = { context ->
                    PreviewView(context).apply {
                        // FILL_CENTER preenche o quadro como o totem faz no
                        // recorte final; FIT_CENTER deixava tarjas pretas e
                        // um enquadramento que não batia com a foto.
                        scaleType = PreviewView.ScaleType.FILL_CENTER
                        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                        viewModel.bindCamera(lifecycleOwner, this)
                    }
                },
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        detectTapGestures { offset -> viewModel.focusAt(offset.x, offset.y) }
                    },
            )

            // Guia do recorte: o que está fora daqui o servidor corta.
            RatioGuide(state.aspectRatio)

            StatusRow(state, Modifier.align(Alignment.TopStart))

            if (state.countdown > 0) {
                Overlay(alpha = .35f) {
                    Text(
                        "${state.countdown}",
                        fontSize = 96.sp,
                        fontWeight = FontWeight.ExtraBold,
                        color = Color.White,
                    )
                }
            }

            if (state.stage == BoothViewModel.Stage.CAPTURING ||
                state.stage == BoothViewModel.Stage.UPLOADING
            ) {
                Overlay(alpha = .5f) {
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

            if (state.stage == BoothViewModel.Stage.RESULT) {
                ResultOverlay(state) { viewModel.backToPreview() }
            }
        }

        ControlPanel(viewModel, state, panel) { panel = if (panel == it) Panel.NONE else it }
    }
}

private enum class Panel { NONE, SETTINGS, SHARE }

@Composable
private fun BoxScope.Overlay(alpha: Float, content: @Composable () -> Unit) {
    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = alpha)),
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
private fun BoxScope.RatioGuide(aspectRatio: String) {
    val ratio = remember(aspectRatio) {
        val parts = aspectRatio.split(":").mapNotNull { it.toFloatOrNull() }
        if (parts.size == 2 && parts[1] != 0f) parts[0] / parts[1] else 0.75f
    }
    Box(
        Modifier
            .align(Alignment.Center)
            .fillMaxSize()
            .padding(8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .aspectRatio(ratio)
                .fillMaxSize()
                .background(Color.Transparent)
        )
    }
}

/* ═══════════════════════════════════════════════════════════
   RESULTADO — foto composta e QR, sem depender de outra tela
   ═══════════════════════════════════════════════════════════ */

@Composable
private fun ResultOverlay(state: BoothViewModel.UiState, onDismiss: () -> Unit) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Fundo.copy(alpha = .97f))
            .clickable(onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("Ficou ótima!", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = Color.White)
            Spacer(Modifier.height(14.dp))

            state.resultPhoto?.let { photo ->
                Image(
                    bitmap = photo.asImageBitmap(),
                    contentDescription = "Foto",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxWidth(.72f)
                        .heightIn(max = 320.dp)
                        .clip(RoundedCornerShape(12.dp)),
                )
            } ?: CircularProgressIndicator(color = GloboAzul)

            Spacer(Modifier.height(18.dp))

            state.resultQr?.let { qr ->
                Box(
                    Modifier
                        .background(Color.White, RoundedCornerShape(12.dp))
                        .padding(10.dp)
                ) {
                    Image(
                        bitmap = qr.asImageBitmap(),
                        contentDescription = "QR Code da foto",
                        modifier = Modifier.size(180.dp),
                    )
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "Aponte a câmera para baixar em alta resolução",
                    fontSize = 13.sp,
                    color = Color.White.copy(alpha = .7f),
                    textAlign = TextAlign.Center,
                )
            } ?: Text(
                state.message ?: "Gerando o QR…",
                color = Color.White.copy(alpha = .7f),
                fontSize = 13.sp,
            )

            Spacer(Modifier.height(12.dp))
            Text(
                state.resultInfo,
                fontSize = 11.sp,
                color = Color.White.copy(alpha = .45f),
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(20.dp))
            OutlinedButton(onClick = onDismiss) { Text("Próximo da fila") }
        }
    }
}

/* ═══════════════════════════════════════════════════════════
   STATUS E CONTROLES
   ═══════════════════════════════════════════════════════════ */

@Composable
private fun StatusRow(state: BoothViewModel.UiState, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Chip(
            text = when {
                !state.connected -> "Reconectando…"
                state.hasDisplay -> "Com telão"
                else -> "Pronto"
            },
            dot = if (state.connected) Color(0xFF4ADE80) else GloboAmarelo,
        )
        Chip("${state.photoResolution} · ${"%.0f".format(state.megapixels)} MP")
        if (state.photoCount > 0) Chip("${state.photoCount} foto(s)")
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
    panel: Panel,
    onTogglePanel: (Panel) -> Unit,
) {
    val busy = state.stage == BoothViewModel.Stage.COUNTDOWN ||
        state.stage == BoothViewModel.Stage.CAPTURING ||
        state.stage == BoothViewModel.Stage.UPLOADING

    Column(
        Modifier
            .fillMaxWidth()
            .background(Fundo)
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            QuickButton("🔦", "Luz", state.torchOn, enabled = state.hasTorch) { viewModel.toggleTorch() }
            QuickButton("🔄", "Virar") { viewModel.flipLens() }
            QuickButton("📺", "Telão", panel == Panel.SHARE) { onTogglePanel(Panel.SHARE) }
            QuickButton("⚙️", "Ajustes", panel == Panel.SETTINGS) { onTogglePanel(Panel.SETTINGS) }
        }

        Spacer(Modifier.height(20.dp))

        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Button(
                onClick = { viewModel.requestCapture() },
                enabled = !busy && state.connected,
                shape = CircleShape,
                modifier = Modifier.size(80.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.White),
            ) {}
        }

        Spacer(Modifier.height(10.dp))
        Text(
            state.error ?: "Toque para tirar a foto · ${state.timerSeconds}s",
            fontSize = 12.sp,
            color = if (state.error != null) GloboVermelho else Color.White.copy(alpha = .6f),
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )

        when (panel) {
            Panel.SETTINGS -> {
                Spacer(Modifier.height(20.dp))
                HorizontalDivider(color = Color.White.copy(alpha = .1f))
                Spacer(Modifier.height(16.dp))
                SettingsSection(viewModel, state)
            }
            Panel.SHARE -> {
                Spacer(Modifier.height(20.dp))
                HorizontalDivider(color = Color.White.copy(alpha = .1f))
                Spacer(Modifier.height(16.dp))
                ShareSection(state)
            }
            Panel.NONE -> Unit
        }
    }
}

/** Telão opcional: quem quiser um monitor abre este link. */
@Composable
private fun ShareSection(state: BoothViewModel.UiState) {
    Label("TELÃO OPCIONAL")
    Spacer(Modifier.height(6.dp))
    Text(
        "O app funciona sozinho. Se o evento tiver um monitor, abra este endereço nele " +
            "para exibir o preview e o resultado em tela grande.",
        fontSize = 12.sp,
        color = Color.White.copy(alpha = .6f),
        lineHeight = 17.sp,
    )
    Spacer(Modifier.height(14.dp))

    state.displayQr?.let { qr ->
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Box(Modifier.background(Color.White, RoundedCornerShape(12.dp)).padding(10.dp)) {
                Image(
                    bitmap = qr.asImageBitmap(),
                    contentDescription = "QR do telão",
                    modifier = Modifier.size(160.dp),
                )
            }
        }
        Spacer(Modifier.height(10.dp))
    }

    Text(
        state.displayLink,
        fontSize = 12.sp,
        color = GloboAzul,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(6.dp))
    Text(
        "Código da sessão: ${state.code}",
        fontSize = 12.sp,
        color = Color.White.copy(alpha = .55f),
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun SettingsSection(viewModel: BoothViewModel, state: BoothViewModel.UiState) {
    Label("MODO DE CAPTURA")
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ModeChip("Qualidade máxima", state.captureMode == CameraController.CaptureMode.QUALITY, Modifier.weight(1f)) {
            viewModel.setCaptureMode(CameraController.CaptureMode.QUALITY)
        }
        ModeChip("Zero lag", state.captureMode == CameraController.CaptureMode.ZSL, Modifier.weight(1f)) {
            viewModel.setCaptureMode(CameraController.CaptureMode.ZSL)
        }
    }
    Spacer(Modifier.height(6.dp))
    Text(
        "Qualidade máxima usa a resolução plena do sensor. Zero lag dispara na hora, " +
            "mas reduzido — o hardware não faz os dois.",
        fontSize = 11.sp,
        color = Color.White.copy(alpha = .5f),
    )

    Spacer(Modifier.height(20.dp))
    Label("TEMPO DA CONTAGEM")
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(3, 5, 10).forEach { seconds ->
            ModeChip("${seconds}s", state.timerSeconds == seconds, Modifier.weight(1f)) {
                viewModel.setTimer(seconds)
            }
        }
    }

    Spacer(Modifier.height(20.dp))
    Label("ORIENTAÇÃO DA FOTO")
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ModeChip("Em pé (3:4)", state.aspectRatio == "3:4", Modifier.weight(1f)) {
            viewModel.setAspectRatio("3:4")
        }
        ModeChip("Deitado (4:3)", state.aspectRatio == "4:3", Modifier.weight(1f)) {
            viewModel.setAspectRatio("4:3")
        }
    }

    if (state.maxZoom > 1f) {
        Spacer(Modifier.height(20.dp))
        Label("ZOOM  ${"%.1f".format(state.zoom)}x")
        Slider(
            value = state.zoom,
            onValueChange = { viewModel.setZoom(it) },
            valueRange = 1f..state.maxZoom,
        )
    }

    Spacer(Modifier.height(16.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Switch(checked = state.mirror, onCheckedChange = { viewModel.toggleMirror() })
        Spacer(Modifier.width(12.dp))
        Text("Espelhar a foto (modo selfie)", fontSize = 13.sp, color = Color.White)
    }

    Spacer(Modifier.height(20.dp))
    OutlinedButton(onClick = { viewModel.disconnect() }, modifier = Modifier.fillMaxWidth()) {
        Text("Encerrar sessão")
    }
}

@Composable
private fun Label(text: String) {
    Text(text, fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Color.White.copy(alpha = .55f))
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
