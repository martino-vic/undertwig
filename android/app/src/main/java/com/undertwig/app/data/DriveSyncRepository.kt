package com.undertwig.app.data

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Mirrors the website's Undertwig Drive layout:
 * `My Drive / Undertwig / <ProjectName> / …`
 */
class DriveSyncRepository(
    context: Context,
    private val projects: ProjectRepository,
) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    suspend fun uploadProject(
        accessToken: String,
        projectId: String,
        projectName: String,
    ) = withContext(Dispatchers.IO) {
        val name = projectName.trim()
        require(name.isNotEmpty()) { "Missing project name." }

        val rootId = ensureUndertwigFolder(accessToken)
        val projectFolderId = ensureChildFolder(accessToken, rootId, name)

        for (folder in projects.listFolders(projectId)) {
            ensurePathFolders(accessToken, projectFolderId, folder)
        }

        for (relativePath in projects.listFiles(projectId)) {
            val parentRel = relativePath.substringBeforeLast('/', missingDelimiterValue = "")
            val fileName = relativePath.substringAfterLast('/')
            val parentId = if (parentRel.isEmpty()) {
                projectFolderId
            } else {
                ensurePathFolders(accessToken, projectFolderId, parentRel)
            }
            val existing = findNamedChild(accessToken, parentId, fileName, mimeType = null)
            val file = projects.existingFile(projectId, relativePath)
                ?: error("Missing file: $relativePath")
            uploadFile(
                accessToken = accessToken,
                parentId = parentId,
                fileName = fileName,
                file = file,
                existingId = existing?.optString("id")?.takeIf { it.isNotBlank() },
            )
        }
    }

    private fun ensureUndertwigFolder(accessToken: String): String {
        val cached = prefs.getString(KEY_UNDERTWIG_FOLDER, null)
        if (!cached.isNullOrBlank() && isLiveFolder(accessToken, cached)) {
            return cached
        }
        val existing = driveSearch(
            accessToken,
            "name = '${escapeQuery(CLOUD_FOLDER_NAME)}' and " +
                "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            pageSize = 1,
        )
        val id = if (existing.length() > 0) {
            existing.getJSONObject(0).getString("id")
        } else {
            createFolder(accessToken, CLOUD_FOLDER_NAME, parentId = null)
        }
        prefs.edit().putString(KEY_UNDERTWIG_FOLDER, id).apply()
        return id
    }

    private fun ensureChildFolder(accessToken: String, parentId: String, name: String): String {
        val existing = findNamedChild(
            accessToken,
            parentId,
            name,
            mimeType = "application/vnd.google-apps.folder",
        )
        if (existing != null) {
            return existing.getString("id")
        }
        return createFolder(accessToken, name, parentId)
    }

    private fun ensurePathFolders(accessToken: String, rootFolderId: String, relativeDir: String): String {
        var parentId = rootFolderId
        for (part in relativeDir.split('/').filter { it.isNotEmpty() }) {
            parentId = ensureChildFolder(accessToken, parentId, part)
        }
        return parentId
    }

    private fun findNamedChild(
        accessToken: String,
        parentId: String,
        name: String,
        mimeType: String?,
    ): JSONObject? {
        val mimeClause = if (mimeType.isNullOrBlank()) {
            ""
        } else {
            " and mimeType = '${escapeQuery(mimeType)}'"
        }
        val files = driveSearch(
            accessToken,
            "name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents " +
                "and trashed = false$mimeClause",
            pageSize = 10,
        )
        return if (files.length() > 0) files.getJSONObject(0) else null
    }

    private fun isLiveFolder(accessToken: String, fileId: String): Boolean {
        return try {
            val meta = getJson(
                accessToken,
                "$DRIVE_API/files/${Uri.encode(fileId)}?supportsAllDrives=true&fields=id,trashed,mimeType",
            )
            !meta.optBoolean("trashed", false) &&
                meta.optString("mimeType") == "application/vnd.google-apps.folder"
        } catch (_: Exception) {
            false
        }
    }

    private fun createFolder(accessToken: String, name: String, parentId: String?): String {
        val metadata = JSONObject()
            .put("name", name)
            .put("mimeType", "application/vnd.google-apps.folder")
        if (!parentId.isNullOrBlank()) {
            metadata.put("parents", JSONArray().put(parentId))
        }
        val created = postJson(
            accessToken,
            "$DRIVE_API/files?supportsAllDrives=true&fields=id,name",
            metadata.toString(),
        )
        return created.getString("id")
    }

    private fun driveSearch(accessToken: String, query: String, pageSize: Int): JSONArray {
        val url =
            "$DRIVE_API/files?supportsAllDrives=true&includeItemsFromAllDrives=true" +
                "&fields=files(id,name,mimeType)" +
                "&q=${URLEncoder.encode(query, "UTF-8")}" +
                "&pageSize=$pageSize"
        val payload = getJson(accessToken, url)
        return payload.optJSONArray("files") ?: JSONArray()
    }

    private fun uploadFile(
        accessToken: String,
        parentId: String,
        fileName: String,
        file: File,
        existingId: String?,
    ) {
        val mime = mimeForPath(fileName)
        val metadata = JSONObject()
            .put("name", fileName)
            .put("mimeType", mime)
        if (existingId.isNullOrBlank()) {
            metadata.put("parents", JSONArray().put(parentId))
        }

        val boundary = "undertwig_${System.currentTimeMillis()}"
        val body = ByteArrayOutputStream()
        DataOutputStream(body).use { out ->
            out.writeBytes("--$boundary\r\n")
            out.writeBytes("Content-Type: application/json; charset=UTF-8\r\n\r\n")
            out.write(metadata.toString().toByteArray(StandardCharsets.UTF_8))
            out.writeBytes("\r\n--$boundary\r\n")
            out.writeBytes("Content-Type: $mime\r\n\r\n")
            out.write(file.readBytes())
            out.writeBytes("\r\n--$boundary--\r\n")
        }
        val bytes = body.toByteArray()

        val url = if (existingId.isNullOrBlank()) {
            "$DRIVE_UPLOAD/files?uploadType=multipart&supportsAllDrives=true&fields=id,name"
        } else {
            "$DRIVE_UPLOAD/files/${Uri.encode(existingId)}" +
                "?uploadType=multipart&supportsAllDrives=true&fields=id,name"
        }
        val method = if (existingId.isNullOrBlank()) "POST" else "PATCH"
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            doOutput = true
            connectTimeout = 30_000
            readTimeout = 120_000
            setRequestProperty("Authorization", "Bearer $accessToken")
            setRequestProperty("Content-Type", "multipart/related; boundary=$boundary")
            setRequestProperty("Content-Length", bytes.size.toString())
        }
        try {
            connection.outputStream.use { it.write(bytes) }
            val code = connection.responseCode
            if (code !in 200..299) {
                if (!existingId.isNullOrBlank() && code == 404) {
                    uploadFile(accessToken, parentId, fileName, file, existingId = null)
                    return
                }
                throw IllegalStateException(readError(connection, "Could not upload $fileName to Google Drive."))
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun getJson(accessToken: String, url: String): JSONObject {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 30_000
            readTimeout = 60_000
            setRequestProperty("Authorization", "Bearer $accessToken")
        }
        try {
            val code = connection.responseCode
            if (code !in 200..299) {
                throw IllegalStateException(readError(connection, "Google Drive request failed."))
            }
            return JSONObject(readBody(connection))
        } finally {
            connection.disconnect()
        }
    }

    private fun postJson(accessToken: String, url: String, jsonBody: String): JSONObject {
        val bytes = jsonBody.toByteArray(StandardCharsets.UTF_8)
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 30_000
            readTimeout = 60_000
            setRequestProperty("Authorization", "Bearer $accessToken")
            setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            setRequestProperty("Content-Length", bytes.size.toString())
        }
        try {
            connection.outputStream.use { it.write(bytes) }
            val code = connection.responseCode
            if (code !in 200..299) {
                throw IllegalStateException(readError(connection, "Could not create Drive folder."))
            }
            return JSONObject(readBody(connection))
        } finally {
            connection.disconnect()
        }
    }

    private fun readBody(connection: HttpURLConnection): String {
        val stream = if (connection.responseCode in 200..299) {
            connection.inputStream
        } else {
            connection.errorStream ?: connection.inputStream
        }
        return BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { it.readText() }
    }

    private fun readError(connection: HttpURLConnection, fallback: String): String {
        val raw = runCatching { readBody(connection) }.getOrNull().orEmpty()
        if (raw.isBlank()) return fallback
        return try {
            val err = JSONObject(raw).optJSONObject("error")
            err?.optString("message")?.takeIf { it.isNotBlank() } ?: fallback
        } catch (_: Exception) {
            fallback
        }
    }

    private fun escapeQuery(value: String): String = value.replace("\\", "\\\\").replace("'", "\\'")

    private fun mimeForPath(path: String): String {
        val lower = path.lowercase()
        return when {
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".gif") -> "image/gif"
            lower.endsWith(".pdf") -> "application/pdf"
            lower.endsWith(".tex") -> "text/x-tex"
            lower.endsWith(".bib") -> "text/plain"
            lower.endsWith(".json") -> "application/json"
            lower.endsWith(".md") || lower.endsWith(".txt") ||
                lower.endsWith(".csv") || lower.endsWith(".log") ||
                lower.endsWith(".sty") || lower.endsWith(".cls") ||
                lower.endsWith(".bst") -> "text/plain"
            else -> "application/octet-stream"
        }
    }

    companion object {
        private const val CLOUD_FOLDER_NAME = "Undertwig"
        private const val DRIVE_API = "https://www.googleapis.com/drive/v3"
        private const val DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3"
        private const val PREFS = "undertwig_drive"
        private const val KEY_UNDERTWIG_FOLDER = "undertwig_folder_id"
    }
}
