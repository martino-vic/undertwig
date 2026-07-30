package com.undertwig.app.data

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
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
import kotlin.coroutines.coroutineContext

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

        val summary = projects.listProjects().firstOrNull { it.id == projectId }
        val role = summary?.driveRole?.trim()?.lowercase().orEmpty()
        val linkedId = summary?.driveFolderId?.takeIf { it.isNotBlank() }

        val projectFolderId: String
        val savedRole: String
        if (role == "writer" || role == "reader") {
            // Invited projects must write into the owner's shared folder — never create
            // Undertwig/<name> under the invitee's own Drive.
            val sharedId = linkedId?.takeIf { isLiveFolder(accessToken, it) }
                ?: error(
                    "Missing shared project folder. Open the invited project from the home screen again.",
                )
            projectFolderId = sharedId
            savedRole = role
            projects.setDriveLink(
                projectId,
                projectFolderId,
                role = savedRole,
                ownerEmail = summary?.ownerEmail,
            )
        } else {
            val rootId = ensureUndertwigFolder(accessToken)
            projectFolderId = ensureChildFolder(accessToken, rootId, name)
            savedRole = "owner"
            projects.setDriveLink(projectId, projectFolderId, role = "owner")
        }

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

    /**
     * Download one project-relative file from the linked Drive folder into the local mirror.
     */
    suspend fun pullFile(
        accessToken: String,
        projectId: String,
        projectName: String,
        relativePath: String,
    ) = withContext(Dispatchers.IO) {
        val clean = relativePath.trim().trimStart('/').replace('\\', '/')
        require(clean.isNotEmpty()) { "Missing file path." }
        require(!clean.contains("..")) { "Invalid file path." }

        val folderId = resolveProjectFolderId(accessToken, projectId, projectName)
            ?: error(
                "This project is not linked to Google Drive yet. Save it once, or open it from Cloud first.",
            )

        val parts = clean.split('/').filter { it.isNotEmpty() }
        require(parts.isNotEmpty()) { "Missing file path." }
        var parentId = folderId
        for (i in 0 until parts.lastIndex) {
            val child = findNamedChild(
                accessToken,
                parentId,
                parts[i],
                mimeType = "application/vnd.google-apps.folder",
            ) ?: error("Drive folder “${parts.take(i + 1).joinToString("/")}” was not found.")
            parentId = child.getString("id")
        }
        val fileName = parts.last()
        val remote = findNamedChild(accessToken, parentId, fileName, mimeType = null)
            ?: error("“$clean” was not found on Google Drive.")
        val mime = remote.optString("mimeType")
        if (mime == "application/vnd.google-apps.folder" ||
            (mime.startsWith("application/vnd.google-apps.") && mime != "application/vnd.google-apps.folder")
        ) {
            error("“$clean” is not a downloadable file on Google Drive.")
        }
        val fileId = remote.optString("id").takeIf { it.isNotBlank() }
            ?: error("“$clean” is missing a Drive file id.")
        val bytes = downloadDriveFile(accessToken, fileId)
        projects.writeFileBytes(projectId, clean, bytes)
    }

    private fun resolveProjectFolderId(
        accessToken: String,
        projectId: String,
        projectName: String,
    ): String? {
        val linked = projects.listProjects()
            .firstOrNull { it.id == projectId }
            ?.driveFolderId
            ?.takeIf { it.isNotBlank() }
        if (!linked.isNullOrBlank() && isLiveFolder(accessToken, linked)) {
            return linked
        }
        val name = projectName.trim()
        if (name.isEmpty()) return null
        val rootId = runCatching { ensureUndertwigFolder(accessToken) }.getOrNull() ?: return null
        val child = findNamedChild(
            accessToken,
            rootId,
            name,
            mimeType = "application/vnd.google-apps.folder",
        ) ?: return null
        val id = child.optString("id").takeIf { it.isNotBlank() } ?: return null
        projects.setDriveLink(projectId, id, role = "owner")
        return id
    }

    /**
     * Owned projects = children of My Drive / Undertwig /.
     * Invited projects = folders shared with the user that live under someone else's Undertwig /
     * (or children of a shared Undertwig root).
     */
    suspend fun listCloudProjects(
        accessToken: String,
        userEmail: String?,
    ): Pair<List<DriveRemoteProject>, List<DriveRemoteProject>> = withContext(Dispatchers.IO) {
        val me = userEmail?.trim()?.lowercase().orEmpty()
        val owned = mutableListOf<DriveRemoteProject>()
        val invited = mutableListOf<DriveRemoteProject>()
        val invitedIds = mutableSetOf<String>()

        val rootId = runCatching { ensureUndertwigFolder(accessToken) }.getOrNull()
        val ownedIds = mutableSetOf<String>()
        if (rootId != null) {
            for (child in listChildren(accessToken, rootId)) {
                if (child.optString("mimeType") != "application/vnd.google-apps.folder") continue
                val id = child.optString("id").takeIf { it.isNotBlank() } ?: continue
                val name = child.optString("name").ifBlank { "Untitled" }
                ownedIds += id
                owned += DriveRemoteProject(
                    folderId = id,
                    name = name,
                    modifiedTimeMs = parseDriveTime(child.optString("modifiedTime")),
                    ownerEmail = firstOwnerEmail(child) ?: me.takeIf { it.isNotEmpty() },
                    ownedByMe = true,
                )
            }
        }

        val shared = driveSearch(
            accessToken,
            "sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            pageSize = 100,
        )
        for (i in 0 until shared.length()) {
            val child = shared.getJSONObject(i)
            val id = child.optString("id").takeIf { it.isNotBlank() } ?: continue
            if (id in ownedIds || id == rootId || id in invitedIds) continue
            val name = child.optString("name").ifBlank { "Untitled" }
            val owner = firstOwnerEmail(child)
            val ownedByMe = me.isNotEmpty() && owner?.equals(me, ignoreCase = true) == true
            if (ownedByMe) continue

            // Whole Undertwig folder shared with us → list its project children.
            if (name.equals(CLOUD_FOLDER_NAME, ignoreCase = true)) {
                for (project in listChildren(accessToken, id)) {
                    if (project.optString("mimeType") != "application/vnd.google-apps.folder") continue
                    val projectId = project.optString("id").takeIf { it.isNotBlank() } ?: continue
                    if (projectId in ownedIds || projectId in invitedIds) continue
                    invitedIds += projectId
                    invited += DriveRemoteProject(
                        folderId = projectId,
                        name = project.optString("name").ifBlank { "Untitled" },
                        modifiedTimeMs = parseDriveTime(project.optString("modifiedTime")),
                        ownerEmail = firstOwnerEmail(project) ?: owner,
                        ownedByMe = false,
                    )
                }
                continue
            }

            // Only Undertwig projects: parent folder named "Undertwig" (not owned by me).
            val meta = folderMetaWithParents(accessToken, id) ?: child
            if (!isUnderForeignUndertwig(accessToken, meta, me)) continue
            invitedIds += id
            invited += DriveRemoteProject(
                folderId = id,
                name = name,
                modifiedTimeMs = parseDriveTime(meta.optString("modifiedTime").ifBlank {
                    child.optString("modifiedTime")
                }),
                ownerEmail = firstOwnerEmail(meta) ?: owner,
                ownedByMe = false,
            )
        }

        // Invites opened via Undertwig (link/email) — confirmed even if parent isn't readable.
        for (remembered in loadRememberedInvitedProjects(accessToken)) {
            val id = remembered.folderId
            if (id in ownedIds || id == rootId || id in invitedIds) continue
            invitedIds += id
            invited += remembered
        }

        owned.sortedByDescending { it.modifiedTimeMs } to
            invited.sortedByDescending { it.modifiedTimeMs }
    }

    /**
     * True only when a parent folder is named Undertwig and is not owned by [me].
     * Unrelated shared Drive folders are excluded.
     */
    private fun isUnderForeignUndertwig(
        accessToken: String,
        folderMeta: JSONObject,
        me: String,
    ): Boolean {
        val parents = folderMeta.optJSONArray("parents") ?: return false
        for (i in 0 until parents.length()) {
            val parentId = parents.optString(i).takeIf { it.isNotBlank() } ?: continue
            val parent = runCatching {
                getJson(
                    accessToken,
                    "$DRIVE_API/files/${Uri.encode(parentId)}" +
                        "?supportsAllDrives=true&fields=id,name,mimeType,trashed,owners",
                )
            }.getOrNull() ?: continue
            if (parent.optBoolean("trashed", false)) continue
            if (parent.optString("mimeType") != "application/vnd.google-apps.folder") continue
            if (!parent.optString("name").equals(CLOUD_FOLDER_NAME, ignoreCase = true)) continue
            val parentOwner = firstOwnerEmail(parent)?.lowercase().orEmpty()
            if (parentOwner.isEmpty() || parentOwner != me) {
                return true
            }
        }
        return false
    }

    private fun folderMetaWithParents(accessToken: String, folderId: String): JSONObject? {
        return runCatching {
            getJson(
                accessToken,
                "$DRIVE_API/files/${Uri.encode(folderId)}" +
                    "?supportsAllDrives=true&fields=id,name,mimeType,modifiedTime,owners,parents,trashed",
            )
        }.getOrNull()?.takeUnless { it.optBoolean("trashed", false) }
    }

    /**
     * Persist an accepted invite so the Android home screen can list it even when Drive
     * does not put link-shared folders into sharedWithMe.
     */
    suspend fun rememberInvitedProject(
        accessToken: String,
        folderId: String,
        projectName: String,
        ownerEmail: String?,
    ) = withContext(Dispatchers.IO) {
        val id = folderId.trim()
        if (id.isEmpty()) return@withContext
        val name = projectName.trim().ifEmpty { "Untitled" }
        val existing = readInvitedRegistry(accessToken).toMutableList()
        existing.removeAll { it.optString("id") == id }
        existing.add(
            0,
            JSONObject()
                .put("id", id)
                .put("name", name)
                .put("ownerEmail", ownerEmail?.trim().orEmpty())
                .put("updatedAt", System.currentTimeMillis()),
        )
        while (existing.size > 50) {
            existing.removeAt(existing.lastIndex)
        }
        writeInvitedRegistry(accessToken, existing)
    }

    private fun loadRememberedInvitedProjects(accessToken: String): List<DriveRemoteProject> {
        val out = mutableListOf<DriveRemoteProject>()
        for (entry in readInvitedRegistry(accessToken)) {
            val id = entry.optString("id").takeIf { it.isNotBlank() } ?: continue
            val meta = folderMetaWithParents(accessToken, id) ?: continue
            if (meta.optString("mimeType") != "application/vnd.google-apps.folder") continue
            out += DriveRemoteProject(
                folderId = id,
                name = meta.optString("name").ifBlank {
                    entry.optString("name").ifBlank { "Untitled" }
                },
                modifiedTimeMs = parseDriveTime(meta.optString("modifiedTime")).takeIf { it > 0 }
                    ?: entry.optLong("updatedAt", 0L),
                ownerEmail = firstOwnerEmail(meta)
                    ?: entry.optString("ownerEmail").takeIf { it.isNotBlank() },
                ownedByMe = false,
            )
        }
        return out
    }

    private fun readInvitedRegistry(accessToken: String): List<JSONObject> {
        val fileId = findAppDataFileId(accessToken, INVITED_REGISTRY_NAME) ?: return emptyList()
        return runCatching {
            val bytes = downloadDriveFile(accessToken, fileId)
            val payload = JSONObject(String(bytes, StandardCharsets.UTF_8))
            val arr = payload.optJSONArray("projects") ?: return emptyList()
            buildList {
                for (i in 0 until arr.length()) {
                    arr.optJSONObject(i)?.let { add(it) }
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun writeInvitedRegistry(accessToken: String, projects: List<JSONObject>) {
        val payload = JSONObject().put(
            "projects",
            JSONArray().also { arr -> projects.forEach { arr.put(it) } },
        )
        val bytes = payload.toString().toByteArray(StandardCharsets.UTF_8)
        val existingId = findAppDataFileId(accessToken, INVITED_REGISTRY_NAME)
        uploadAppDataJson(accessToken, INVITED_REGISTRY_NAME, bytes, existingId)
    }

    private fun findAppDataFileId(accessToken: String, fileName: String): String? {
        val url =
            "$DRIVE_API/files?spaces=appDataFolder&pageSize=10" +
                "&fields=files(id,name)" +
                "&q=" + URLEncoder.encode(
                    "name = '${escapeQuery(fileName)}' and trashed = false",
                    "UTF-8",
                )
        val payload = runCatching { getJson(accessToken, url) }.getOrNull() ?: return null
        val files = payload.optJSONArray("files") ?: return null
        for (i in 0 until files.length()) {
            val file = files.optJSONObject(i) ?: continue
            if (file.optString("name") == fileName) {
                return file.optString("id").takeIf { it.isNotBlank() }
            }
        }
        return null
    }

    private fun uploadAppDataJson(
        accessToken: String,
        fileName: String,
        bytes: ByteArray,
        existingId: String?,
    ) {
        val metadata = JSONObject()
            .put("name", fileName)
            .put("mimeType", "application/json")
        if (existingId.isNullOrBlank()) {
            metadata.put("parents", JSONArray().put("appDataFolder"))
        }
        val boundary = "undertwig_${System.currentTimeMillis()}"
        val body = ByteArrayOutputStream()
        DataOutputStream(body).use { out ->
            out.writeBytes("--$boundary\r\n")
            out.writeBytes("Content-Type: application/json; charset=UTF-8\r\n\r\n")
            out.write(metadata.toString().toByteArray(StandardCharsets.UTF_8))
            out.writeBytes("\r\n--$boundary\r\n")
            out.writeBytes("Content-Type: application/json\r\n\r\n")
            out.write(bytes)
            out.writeBytes("\r\n--$boundary--\r\n")
        }
        val url = if (existingId.isNullOrBlank()) {
            "$DRIVE_UPLOAD/files?uploadType=multipart&spaces=appDataFolder&fields=id"
        } else {
            "$DRIVE_UPLOAD/files/${Uri.encode(existingId)}?uploadType=multipart&fields=id"
        }
        val method = if (existingId.isNullOrBlank()) "POST" else "PATCH"
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            doOutput = true
            setRequestProperty("Authorization", "Bearer $accessToken")
            setRequestProperty("Content-Type", "multipart/related; boundary=$boundary")
            connectTimeout = 30_000
            readTimeout = 60_000
        }
        connection.outputStream.use { it.write(body.toByteArray()) }
        val code = connection.responseCode
        if (code !in 200..299) {
            throwDriveHttpError(code, connection, "Could not save invited project list.")
        }
        connection.disconnect()
    }

    /**
     * Pull the local project's Drive folder into the on-device mirror (desktop "Load").
     * Always refreshes [projectId] in place so the open editor sees the new files.
     * @return number of files downloaded
     */
    suspend fun syncProjectFromDrive(
        accessToken: String,
        projectId: String,
        projectName: String,
    ): Int = withContext(Dispatchers.IO) {
        val summary = projects.listProjects().firstOrNull { it.id == projectId }
            ?: error("Open a project first.")
        val name = projectName.trim().ifEmpty { summary.name }
        val folderId = resolveProjectFolderId(accessToken, projectId, name)
            ?: error(
                "“$name” was not found on Google Drive. Save it once from this device, or open it from Cloud first.",
            )
        val role = summary.driveRole?.takeIf { it.isNotBlank() } ?: "owner"
        val owner = summary.ownerEmail

        coroutineContext.ensureActive()
        val meta = getJson(
            accessToken,
            "$DRIVE_API/files/${Uri.encode(folderId)}" +
                "?supportsAllDrives=true&fields=id,name,mimeType,trashed,owners",
        )
        if (meta.optBoolean("trashed", false)) {
            error("That Google Drive folder was trashed.")
        }

        coroutineContext.ensureActive()
        val entries = listFolderTree(accessToken, folderId, "")
        val folders = entries.filter { it.isFolder }.map { it.path }
        val fileEntries = entries.filter { !it.isFolder }
        if (fileEntries.isEmpty()) {
            error(
                "“$name” has no downloadable files yet. Open it in Undertwig on the web and Save, then try again.",
            )
        }

        val files = linkedMapOf<String, ByteArray>()
        for (entry in fileEntries) {
            coroutineContext.ensureActive()
            files[entry.path] = downloadDriveFile(accessToken, entry.id)
        }

        projects.replaceProjectContents(
            projectId = projectId,
            name = name,
            driveFolderId = folderId,
            role = role,
            ownerEmail = owner ?: firstOwnerEmail(meta),
            folders = folders,
            files = files,
        )
        files.size
    }

    /**
     * Download a Drive project folder into a local mirror and return the local project id.
     */
    suspend fun pullProject(
        accessToken: String,
        folderId: String,
        projectName: String,
        role: String,
        ownerEmail: String?,
    ): String = withContext(Dispatchers.IO) {
        val meta = getJson(
            accessToken,
            "$DRIVE_API/files/${Uri.encode(folderId)}" +
                "?supportsAllDrives=true&fields=id,name,mimeType,trashed,owners",
        )
        if (meta.optBoolean("trashed", false)) {
            error("That Google Drive folder was trashed.")
        }
        val name = projectName.trim().ifEmpty { meta.optString("name").ifBlank { "Untitled" } }
        val owner = ownerEmail ?: firstOwnerEmail(meta)

        coroutineContext.ensureActive()
        val entries = listFolderTree(accessToken, folderId, "")
        val folders = entries.filter { it.isFolder }.map { it.path }
        val fileEntries = entries.filter { !it.isFolder }
        if (fileEntries.isEmpty()) {
            error(
                "“$name” has no downloadable files yet. Open it in Undertwig on the web and Save, then try again.",
            )
        }

        val files = linkedMapOf<String, ByteArray>()
        for (entry in fileEntries) {
            coroutineContext.ensureActive()
            files[entry.path] = downloadDriveFile(accessToken, entry.id)
        }

        projects.importDriveMirror(
            name = name,
            driveFolderId = folderId,
            role = role,
            ownerEmail = owner,
            folders = folders,
            files = files,
        )
    }

    private fun listChildren(accessToken: String, folderId: String): List<JSONObject> {
        val all = mutableListOf<JSONObject>()
        var pageToken = ""
        val query = "'${escapeQuery(folderId)}' in parents and trashed = false"
        do {
            var url =
                "$DRIVE_API/files?supportsAllDrives=true&includeItemsFromAllDrives=true" +
                    "&pageSize=100" +
                    "&fields=" + URLEncoder.encode(
                        "nextPageToken,files(id,name,mimeType,modifiedTime,owners)",
                        "UTF-8",
                    ) +
                    "&q=" + URLEncoder.encode(query, "UTF-8")
            if (pageToken.isNotEmpty()) {
                url += "&pageToken=" + URLEncoder.encode(pageToken, "UTF-8")
            }
            val payload = getJson(accessToken, url)
            val files = payload.optJSONArray("files") ?: JSONArray()
            for (i in 0 until files.length()) {
                all += files.getJSONObject(i)
            }
            pageToken = payload.optString("nextPageToken")
        } while (pageToken.isNotBlank())
        return all
    }

    private fun listFolderTree(
        accessToken: String,
        folderId: String,
        prefix: String,
    ): List<DriveTreeEntry> {
        val out = mutableListOf<DriveTreeEntry>()
        for (child in listChildren(accessToken, folderId)) {
            val id = child.optString("id").takeIf { it.isNotBlank() } ?: continue
            val name = child.optString("name").takeIf { it.isNotBlank() } ?: continue
            val mime = child.optString("mimeType")
            val path = if (prefix.isEmpty()) name else "$prefix/$name"
            // Skip Google Docs/Sheets/etc. — Undertwig stores plain project files.
            if (mime.startsWith("application/vnd.google-apps.") &&
                mime != "application/vnd.google-apps.folder"
            ) {
                continue
            }
            if (mime == "application/vnd.google-apps.folder") {
                out += DriveTreeEntry(path = path, name = name, id = id, mimeType = mime, isFolder = true)
                out += listFolderTree(accessToken, id, path)
            } else {
                out += DriveTreeEntry(path = path, name = name, id = id, mimeType = mime, isFolder = false)
            }
        }
        return out
    }

    private fun downloadDriveFile(accessToken: String, fileId: String): ByteArray {
        val url =
            "$DRIVE_API/files/${Uri.encode(fileId)}?alt=media&supportsAllDrives=true"
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 30_000
            readTimeout = 120_000
            setRequestProperty("Authorization", "Bearer $accessToken")
        }
        try {
            val code = connection.responseCode
            if (code !in 200..299) {
                throwDriveHttpError(code, connection, "Could not download a Drive file.")
            }
            return connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    private fun firstOwnerEmail(meta: JSONObject): String? {
        val owners = meta.optJSONArray("owners") ?: return null
        for (i in 0 until owners.length()) {
            val email = owners.optJSONObject(i)?.optString("emailAddress")?.trim()
            if (!email.isNullOrBlank()) return email
        }
        return null
    }

    private fun parseDriveTime(value: String?): Long {
        if (value.isNullOrBlank()) return 0L
        return runCatching {
            java.time.Instant.parse(value).toEpochMilli()
        }.getOrDefault(0L)
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
                "&fields=files(id,name,mimeType,modifiedTime,owners,parents)" +
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
                throwDriveHttpError(code, connection, "Could not upload $fileName to Google Drive.")
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
                throwDriveHttpError(code, connection, "Google Drive request failed.")
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
                throwDriveHttpError(code, connection, "Could not create Drive folder.")
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

    private fun throwDriveHttpError(code: Int, connection: HttpURLConnection, fallback: String): Nothing {
        val message = readError(connection, fallback)
        if (code == 401 || AuthRepository.isInvalidCredentialsMessage(message)) {
            throw AuthRepository.InvalidDriveCredentialsException(message)
        }
        throw IllegalStateException(message)
    }

    private fun readError(connection: HttpURLConnection, fallback: String): String {
        val raw = runCatching { readBody(connection) }.getOrNull().orEmpty()
        if (raw.isBlank()) {
            return if (connection.responseCode == 401) {
                "Request had invalid authentication credentials."
            } else {
                fallback
            }
        }
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
        private const val INVITED_REGISTRY_NAME = "undertwig-invited-projects-v1.json"
        private const val DRIVE_API = "https://www.googleapis.com/drive/v3"
        private const val DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3"
        private const val PREFS = "undertwig_drive"
        private const val KEY_UNDERTWIG_FOLDER = "undertwig_folder_id"
    }
}
