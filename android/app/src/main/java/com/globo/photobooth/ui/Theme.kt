package com.globo.photobooth.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/* Guia de Marca Globo 2025 v2.0 */
val GloboAzul = Color(0xFF05A6FF)
val GloboAzulNoite = Color(0xFF003B71)
val GloboRoxo = Color(0xFF8800F8)
val GloboVermelho = Color(0xFFFF0C1F)
val GloboAmarelo = Color(0xFFFFD006)

val Fundo = Color(0xFF06121F)
val Superficie = Color(0xFF10202F)
val Superficie2 = Color(0xFF182B3D)

/**
 * Interface sempre escura, como na versão web: uma tela clara ao lado da
 * cena contamina a luz e atrapalha quem está enquadrando.
 */
private val scheme = darkColorScheme(
    primary = GloboAzul,
    onPrimary = Color(0xFF001527),
    secondary = GloboRoxo,
    background = Fundo,
    onBackground = Color.White,
    surface = Superficie,
    onSurface = Color.White,
    surfaceVariant = Superficie2,
    error = GloboVermelho,
)

@Composable
fun GloboTheme(content: @Composable () -> Unit) {
    @Suppress("UNUSED_EXPRESSION")
    isSystemInDarkTheme()
    MaterialTheme(colorScheme = scheme, content = content)
}
