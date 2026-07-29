package com.undertwig.app.ui

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PdfScreen(
    pdfFile: File,
    title: String,
    onBack: () -> Unit,
    /** Bumps when Convert overwrites main.pdf so preview reloads even if the path is unchanged. */
    contentRevision: Long = 0L,
) {
    // Path alone is not enough: Convert always writes the same main.pdf path.
    val contentKey =
        "${pdfFile.absolutePath}|${pdfFile.lastModified()}|${pdfFile.length()}|$contentRevision"
    var pages by remember(contentKey) { mutableStateOf<List<Bitmap>>(emptyList()) }

    DisposableEffect(contentKey) {
        val rendered = mutableListOf<Bitmap>()
        val pfd = ParcelFileDescriptor.open(pdfFile, ParcelFileDescriptor.MODE_READ_ONLY)
        val renderer = PdfRenderer(pfd)
        for (i in 0 until renderer.pageCount) {
            val page = renderer.openPage(i)
            val bitmap = Bitmap.createBitmap(
                page.width * 2,
                page.height * 2,
                Bitmap.Config.ARGB_8888,
            )
            // PdfRenderer draws ink on a transparent bitmap; without a white fill,
            // pages look like a dark veil over the theme background.
            bitmap.eraseColor(AndroidColor.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            page.close()
            rendered += bitmap
        }
        renderer.close()
        pfd.close()
        pages = rendered
        onDispose {
            rendered.forEach { it.recycle() }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(Color(0xFFE8E4DE))
                .verticalScroll(rememberScrollState()),
        ) {
            if (pages.isEmpty()) {
                Text("Opening PDF…", modifier = Modifier.padding(16.dp))
            } else {
                pages.forEach { bitmap ->
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = "PDF page",
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                        contentScale = ContentScale.FillWidth,
                    )
                }
            }
        }
    }
}
