package com.undertwig.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Brand = Color(0xFFB87333)
private val BrandLight = Color(0xFFD08A45)
private val BgDark = Color(0xFF0F1419)
private val PanelDark = Color(0xFF18212B)
private val TextDark = Color(0xFFE7ECF1)

private val DarkColors = darkColorScheme(
    primary = BrandLight,
    onPrimary = Color(0xFF1A1208),
    secondary = Brand,
    background = BgDark,
    surface = PanelDark,
    onBackground = TextDark,
    onSurface = TextDark,
)

private val LightColors = lightColorScheme(
    primary = Brand,
    onPrimary = Color.White,
    secondary = BrandLight,
    background = Color(0xFFF6F1EA),
    surface = Color(0xFFFFFBF6),
    onBackground = Color(0xFF1B242E),
    onSurface = Color(0xFF1B242E),
)

@Composable
fun UndertwigTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
