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
    downloadToDownloads(
        context = context,
        source = pdfFile,
        mimeType = "application/pdf",
        failureLabel = "Could not download PDF.",
    )
}

fun downloadToDownloads(
    context: Context,
    source: File,
    mimeType: String,
    displayName: String = source.name,
    failureLabel: String = "Could not download file.",
): Boolean {
    if (!source.isFile || source.length() <= 0L) {
        Toast.makeText(context, "File is not available.", Toast.LENGTH_SHORT).show()
        return false
    }
    val result = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, displayName)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("Could not create download entry.")
            resolver.openOutputStream(uri)?.use { output ->
                source.inputStream().use { input -> input.copyTo(output) }
            } ?: error("Could not write file.")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            displayName
        } else {
            @Suppress("DEPRECATION")
            val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            if (!dir.exists()) {
                dir.mkdirs()
            }
            var target = File(dir, displayName)
            if (target.exists()) {
                val base = displayName.substringBeforeLast('.', displayName)
                val ext = displayName.substringAfterLast('.', "")
                var n = 1
                while (target.exists()) {
                    target = File(dir, if (ext.isEmpty()) "$base ($n)" else "$base ($n).$ext")
                    n++
                }
            }
            source.copyTo(target, overwrite = false)
            target.name
        }
    }
    return result.fold(
        onSuccess = { name ->
            Toast.makeText(context, "Saved $name to Downloads.", Toast.LENGTH_SHORT).show()
            true
        },
        onFailure = { error ->
            Toast.makeText(
                context,
                error.message ?: failureLabel,
                Toast.LENGTH_SHORT,
            ).show()
            false
        },
    )
}
