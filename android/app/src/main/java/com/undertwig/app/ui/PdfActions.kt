package com.undertwig.app.ui

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

fun sharePdf(context: Context, pdfFile: File) {
    if (!pdfFile.isFile || pdfFile.length() <= 0L) {
        Toast.makeText(context, "PDF is not available.", Toast.LENGTH_SHORT).show()
        return
    }
    val uri = runCatching {
        FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            pdfFile,
        )
    }.getOrElse { error ->
        Toast.makeText(context, error.message ?: "Could not share PDF.", Toast.LENGTH_SHORT).show()
        return
    }
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "application/pdf"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, pdfFile.name)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, "Share PDF"))
}

fun downloadPdf(context: Context, pdfFile: File) {
    if (!pdfFile.isFile || pdfFile.length() <= 0L) {
        Toast.makeText(context, "PDF is not available.", Toast.LENGTH_SHORT).show()
        return
    }
    val result = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, pdfFile.name)
                put(MediaStore.Downloads.MIME_TYPE, "application/pdf")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("Could not create download entry.")
            resolver.openOutputStream(uri)?.use { output ->
                pdfFile.inputStream().use { input -> input.copyTo(output) }
            } ?: error("Could not write PDF.")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            pdfFile.name
        } else {
            @Suppress("DEPRECATION")
            val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            if (!dir.exists()) {
                dir.mkdirs()
            }
            var target = File(dir, pdfFile.name)
            if (target.exists()) {
                val base = pdfFile.nameWithoutExtension
                val ext = pdfFile.extension.ifEmpty { "pdf" }
                var n = 1
                while (target.exists()) {
                    target = File(dir, "$base ($n).$ext")
                    n++
                }
            }
            pdfFile.copyTo(target, overwrite = false)
            target.name
        }
    }
    result.fold(
        onSuccess = { name ->
            Toast.makeText(context, "Saved $name to Downloads.", Toast.LENGTH_SHORT).show()
        },
        onFailure = { error ->
            Toast.makeText(
                context,
                error.message ?: "Could not download PDF.",
                Toast.LENGTH_SHORT,
            ).show()
        },
    )
}
