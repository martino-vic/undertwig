package com.undertwig.app.data

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
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
            require(!name.equals(CLOUD_FOLDER_NAME, ignoreCase = true)) {
                "Project name cannot be \"$CLOUD_FOLDER_NAME\"."
            }
            projectFolderId = ensureChildFolder(accessToken, rootId, name)
            require(projectFolderId != rootId) {
                "Refusing to save into the Undertwig root folder."
            }
            savedRole = "owner"
            projects.setDriveLink(projectId, projectFolderId, role = "owner")
        }

        // Never sync file content against the Undertwig root (would touch every project).
        runCatching { ensureUndertwigFolder(accessToken) }.getOrNull()?.let { rootId ->
            require(projectFolderId != rootId) {
                "Refusing to save into the Undertwig root folder. Re-open the project and try again."
            }
        }

        for (folder in projects.listFolders(projectId)) {
            ensurePathFolders(accessToken, projectFolderId, folder)
        }

        for (relativePath in projects.listFiles(projectId)) {
            if (relativePath == LOCK_DIR_NAME || relativePath.startsWith("$LOCK_DIR_NAME/")) {
                continue
            }
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

    data class FileEditLock(
        val path: String,
        val holderEmail: String?,
        val holderName: String?,
        val deviceId: String?,
        val since: String?,
        val heartbeat: String?,
        val fileId: String? = null,
        val parentId: String? = null,
    ) {
        fun holderLabel(): String {
            val name = holderName?.trim().orEmpty()
            val email = holderEmail?.trim().orEmpty()
            return when {
                name.isNotEmpty() && email.isNotEmpty() -> "$name ($email)"
                name.isNotEmpty() -> name
                email.isNotEmpty() -> email
                else -> "Someone"
            }
        }

        fun isStale(nowMs: Long = System.currentTimeMillis()): Boolean {
            val hb = heartbeat?.trim().orEmpty()
            if (hb.isEmpty()) return true
            // Unparseable heartbeat: do NOT treat as stale — stealing a live room is worse.
            val ms = parseLockTimestampMs(hb) ?: return false
            return nowMs - ms > LOCK_STALE_MS
        }
    }

    data class FileLockResult(
        val ok: Boolean,
        val lock: FileEditLock? = null,
        val message: String? = null,
    )

    fun deviceId(): String {
        val existing = prefs.getString(KEY_DEVICE_ID, null)?.trim().orEmpty()
        if (existing.isNotEmpty()) return existing
        val created = "android-" + java.util.UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_ID, created).apply()
        return created
    }

    private fun isHeldByThisDevice(lock: FileEditLock): Boolean =
        !lock.deviceId.isNullOrBlank() && lock.deviceId == deviceId()

    /**
     * True only when THIS device holds the lock. Same Google account on phone vs laptop
     * must not steal each other's writing room.
     */
    private fun isHeldByMe(lock: FileEditLock, holderEmail: String?): Boolean {
        return isHeldByThisDevice(lock)
    }

    suspend fun peekFileLock(
        accessToken: String,
        projectId: String,
        projectName: String,
        holderEmail: String? = null,
    ): FileEditLock? = withContext(Dispatchers.IO) {
        val folderId = resolveProjectFolderId(accessToken, projectId, projectName) ?: return@withContext null
        val existing = readProjectLockFile(accessToken, folderId) ?: return@withContext null
        if (existing.isStale() || isHeldByMe(existing, holderEmail)) return@withContext null
        existing
    }

    /** Returns the lock even when we hold it (for resume-after-reload). */
    suspend fun readProjectLock(
        accessToken: String,
        projectId: String,
        projectName: String,
    ): FileEditLock? = withContext(Dispatchers.IO) {
        val folderId = resolveProjectFolderId(accessToken, projectId, projectName) ?: return@withContext null
        val existing = readProjectLockFile(accessToken, folderId) ?: return@withContext null
        if (existing.isStale()) return@withContext null
        existing
    }

    suspend fun acquireFileLock(
        accessToken: String,
        projectId: String,
        projectName: String,
        holderEmail: String?,
        holderName: String?,
    ): FileLockResult = withContext(Dispatchers.IO) {
        val folderId = resolveProjectFolderId(accessToken, projectId, projectName)
            ?: return@withContext FileLockResult(
                ok = false,
                message = "Project is not linked to Google Drive yet. Save once first.",
            )
        var existing = readProjectLockFile(accessToken, folderId)
        if (existing != null && !isHeldByMe(existing, holderEmail)) {
            if (!existing.isStale()) {
                return@withContext occupiedResult(existing)
            }
            // Appears abandoned — re-check so a throttled desktop heartbeat can land first.
            delay(LOCK_STEAL_RECHECK_MS)
            existing = readProjectLockFile(accessToken, folderId)
            if (existing != null && !isHeldByMe(existing, holderEmail) && !existing.isStale()) {
                return@withContext occupiedResult(existing)
            }
        }
        val payload = buildLockJson(
            holderEmail,
            holderName,
            since = if (existing != null && isHeldByMe(existing, holderEmail)) existing.since else null,
        )
        if (!writeProjectLockFile(accessToken, folderId, payload)) {
            val blocker = readProjectLockFile(accessToken, folderId)
            return@withContext if (blocker != null) {
                occupiedResult(blocker)
            } else {
                FileLockResult(
                    ok = false,
                    message = "Someone is currently in the writing room. The writing room has space for one person only at the time.",
                )
            }
        }
        val again = readProjectLockFile(accessToken, folderId)
            ?: return@withContext FileLockResult(
                ok = false,
                message = "Could not verify the writing room lock on Google Drive.",
            )
        if (!isHeldByMe(again, holderEmail)) {
            return@withContext occupiedResult(again)
        }
        FileLockResult(ok = true, lock = again)
    }

    private fun occupiedResult(lock: FileEditLock): FileLockResult =
        FileLockResult(
            ok = false,
            lock = lock,
            message = "${lock.holderLabel()} is currently in the writing room. The writing room has space for one person only at the time.",
        )

    suspend fun heartbeatFileLock(
        accessToken: String,
        projectId: String,
        projectName: String,
        holderEmail: String?,
        holderName: String?,
    ): FileLockResult = withContext(Dispatchers.IO) {
        val folderId = resolveProjectFolderId(accessToken, projectId, projectName)
            ?: return@withContext FileLockResult(ok = false, message = "Not linked to Drive.")
        val existing = readProjectLockFile(accessToken, folderId)
        if (existing == null) {
            return@withContext acquireFileLock(
                accessToken, projectId, projectName, holderEmail, holderName,
            )
        }
        if (!isHeldByMe(existing, holderEmail)) {
            if (!existing.isStale()) {
                return@withContext occupiedResult(existing)
            }
            delay(LOCK_STEAL_RECHECK_MS)
            val retry = readProjectLockFile(accessToken, folderId)
            if (retry != null && !isHeldByMe(retry, holderEmail) && !retry.isStale()) {
                return@withContext occupiedResult(retry)
            }
            return@withContext acquireFileLock(
                accessToken, projectId, projectName, holderEmail, holderName,
            )
        }
        val payload = buildLockJson(holderEmail, holderName, since = existing.since)
        if (!writeProjectLockFile(accessToken, folderId, payload)) {
            val blocker = readProjectLockFile(accessToken, folderId)
            return@withContext if (blocker != null) occupiedResult(blocker) else FileLockResult(
                ok = false,
                message = "Someone is currently in the writing room. The writing room has space for one person only at the time.",
            )
        }
        FileLockResult(ok = true, lock = readProjectLockFile(accessToken, folderId))
    }

    suspend fun releaseFileLock(
        accessToken: String,
        projectId: String,
        projectName: String,
        holderEmail: String? = null,
    ): Boolean = withContext(Dispatchers.IO) {
        val folderId = resolveProjectFolderId(accessToken, projectId, projectName) ?: return@withContext false
        val existing = readProjectLockFile(accessToken, folderId) ?: return@withContext true
        if (!isHeldByMe(existing, holderEmail) && !existing.isStale()) return@withContext false
        val fileId = existing.fileId ?: return@withContext false
        // Match web: owners can trash; writers in shared folders must removeParents.
        removeDriveItemFromProject(
            accessToken = accessToken,
            fileId = fileId,
            parentId = existing.parentId,
        )
        // Confirm the lock is gone (trashed files must not still look held).
        val stillThere = readProjectLockFile(accessToken, folderId)
        stillThere == null || stillThere.isStale() || !isHeldByMe(stillThere, holderEmail)
    }

    /**
     * Remove a Drive file from a project folder. Prefer trash when allowed; otherwise
     * detach via removeParents (required for non-owners in shared Undertwig folders).
     */
    private fun removeDriveItemFromProject(
        accessToken: String,
        fileId: String,
        parentId: String?,
    ) {
        val trashed = runCatching {
            trashDriveFile(accessToken, fileId)
            true
        }.getOrElse { false }
        if (trashed) return
        val parent = parentId?.takeIf { it.isNotBlank() }
            ?: error("Could not release the writing room lock (no parent folder).")
        removeDriveParents(accessToken, fileId, parent)
    }

    private fun removeDriveParents(accessToken: String, fileId: String, parentId: String) {
        val url =
            "$DRIVE_API/files/${Uri.encode(fileId)}" +
                "?supportsAllDrives=true" +
                "&removeParents=${Uri.encode(parentId)}" +
                "&fields=id,parents"
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "PATCH"
            doOutput = true
            connectTimeout = 30_000
            readTimeout = 60_000
            setRequestProperty("Authorization", "Bearer $accessToken")
            setRequestProperty("Content-Length", "0")
        }
        try {
            connection.outputStream.use { /* empty body */ }
            val code = connection.responseCode
            if (code !in 200..299) {
                throwDriveHttpError(code, connection, "Could not release edit lock.")
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun buildLockJson(
        holderEmail: String?,
        holderName: String?,
        since: String?,
    ): JSONObject {
        val now = java.time.Instant.now().toString()
        return JSONObject()
            .put("version", 2)
            .put("scope", "project")
            .put("path", ".")
            .put("holderEmail", holderEmail)
            .put("holderName", holderName)
            .put("deviceId", deviceId())
            .put("since", since ?: now)
            .put("heartbeat", now)
    }

    /**
     * Read the project writing-room lock. Scans every `.undertwig-locks` folder in case
     * Drive has duplicates, and prefers a live (non-stale) lock from another device.
     */
    private fun readProjectLockFile(
        accessToken: String,
        projectFolderId: String,
    ): FileEditLock? {
        val lockDirs = findNamedChildren(
            accessToken,
            projectFolderId,
            LOCK_DIR_NAME,
            mimeType = "application/vnd.google-apps.folder",
        )
        if (lockDirs.isEmpty()) return null

        val locks = mutableListOf<FileEditLock>()
        for (dir in lockDirs) {
            val parentId = dir.optString("id").takeIf { it.isNotBlank() } ?: continue
            val remotes = findNamedChildren(accessToken, parentId, PROJECT_LOCK_FILE, mimeType = null)
            for (remote in remotes) {
                val mime = remote.optString("mimeType")
                if (mime == "application/vnd.google-apps.folder") continue
                val fileId = remote.optString("id").takeIf { it.isNotBlank() } ?: continue
                val bytes = runCatching { downloadDriveFile(accessToken, fileId) }.getOrNull()
                    ?: continue
                val json = runCatching { JSONObject(String(bytes, StandardCharsets.UTF_8)) }.getOrNull()
                    ?: continue
                locks += FileEditLock(
                    path = json.optString("path").ifBlank { "." },
                    holderEmail = json.optString("holderEmail").takeIf { it.isNotBlank() },
                    holderName = json.optString("holderName").takeIf { it.isNotBlank() },
                    deviceId = json.optString("deviceId").takeIf { it.isNotBlank() },
                    since = json.optString("since").takeIf { it.isNotBlank() },
                    heartbeat = json.optString("heartbeat").takeIf { it.isNotBlank() },
                    fileId = fileId,
                    parentId = parentId,
                )
            }
        }
        if (locks.isEmpty()) return null

        // Prefer a live lock held by someone else — that is the exclusivity signal.
        locks.firstOrNull { !it.isStale() && !isHeldByThisDevice(it) }?.let { return it }
        // Else our own live lock (resume).
        locks.firstOrNull { !it.isStale() && isHeldByThisDevice(it) }?.let { return it }
        // Else newest by heartbeat / since.
        return locks.maxByOrNull { lock ->
            parseLockTimestampMs(lock.heartbeat)
                ?: parseLockTimestampMs(lock.since)
                ?: 0L
        }
    }

    private fun writeProjectLockFile(
        accessToken: String,
        projectFolderId: String,
        payload: JSONObject,
    ): Boolean {
        // Reuse an existing lock file/folder when present so we never create a parallel room.
        val existingLock = readProjectLockFile(accessToken, projectFolderId)
        if (existingLock != null && !isHeldByThisDevice(existingLock) && !existingLock.isStale()) {
            // Someone else still holds the room — never overwrite.
            return false
        }
        val parentId: String
        val existingId: String?
        if (existingLock?.fileId != null && existingLock.parentId != null) {
            parentId = existingLock.parentId
            existingId = existingLock.fileId
        } else {
            parentId = ensureChildFolder(accessToken, projectFolderId, LOCK_DIR_NAME)
            existingId = findNamedChild(accessToken, parentId, PROJECT_LOCK_FILE, mimeType = null)
                ?.optString("id")
                ?.takeIf { it.isNotBlank() }
        }
        val tmp = File.createTempFile("undertwig-lock-", ".json")
        try {
            tmp.writeText(payload.toString(2))
            uploadFile(
                accessToken = accessToken,
                parentId = parentId,
                fileName = PROJECT_LOCK_FILE,
                file = tmp,
                existingId = existingId,
            )
        } finally {
            tmp.delete()
        }
        return true
    }

    private fun trashDriveFile(accessToken: String, fileId: String) {
        val url = "$DRIVE_API/files/${Uri.encode(fileId)}?supportsAllDrives=true"
        val body = """{"trashed":true}""".toByteArray(StandardCharsets.UTF_8)
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "PATCH"
            doOutput = true
            connectTimeout = 30_000
            readTimeout = 60_000
            setRequestProperty("Authorization", "Bearer $accessToken")
            setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            setRequestProperty("Content-Length", body.size.toString())
        }
        try {
            connection.outputStream.use { it.write(body) }
            val code = connection.responseCode
            if (code !in 200..299) {
                throwDriveHttpError(code, connection, "Could not release edit lock.")
            }
        } finally {
            connection.disconnect()
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

            // Project folder shared directly → only keep if parent is someone else's Undertwig.
            // Unknown/unreadable parents are handled by the invite registry (opened via Undertwig),
            // not by listing every Shared-with-me folder.
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
        for (remembered in loadRememberedInvitedProjects(accessToken, me)) {
            val id = remembered.folderId
            if (id in ownedIds || id == rootId || id in invitedIds) continue
            invitedIds += id
            invited += remembered
        }

        owned.sortedByDescending { it.modifiedTimeMs } to
            invited.sortedByDescending { it.modifiedTimeMs }
    }

    private enum class InviteStatus {
        FOREIGN_UNDERTWIG,
        NOT_UNDERTWIG,
        UNKNOWN,
    }

    /**
     * Classify by Undertwig parent folder only (never by LaTeX file contents):
     * - FOREIGN_UNDERTWIG: parent is Undertwig not owned by me
     * - NOT_UNDERTWIG: readable parents exist and none is a foreign Undertwig
     * - UNKNOWN: parents missing or unreadable (typical for project-only invites)
     */
    private fun undertwigInviteStatus(
        accessToken: String,
        folderMeta: JSONObject,
        me: String,
    ): InviteStatus {
        val parents = folderMeta.optJSONArray("parents")
        if (parents == null || parents.length() == 0) {
            return InviteStatus.UNKNOWN
        }
        var readableParents = 0
        for (i in 0 until parents.length()) {
            val parentId = parents.optString(i).takeIf { it.isNotBlank() } ?: continue
            val parent = runCatching {
                getJson(
                    accessToken,
                    "$DRIVE_API/files/${Uri.encode(parentId)}" +
                        "?supportsAllDrives=true&fields=id,name,mimeType,trashed,owners",
                )
            }.getOrNull()
            if (parent == null) {
                return InviteStatus.UNKNOWN
            }
            readableParents += 1
            if (parent.optBoolean("trashed", false)) continue
            if (parent.optString("mimeType") != "application/vnd.google-apps.folder") continue
            if (!parent.optString("name").equals(CLOUD_FOLDER_NAME, ignoreCase = true)) continue
            val parentOwner = firstOwnerEmail(parent)?.lowercase().orEmpty()
            if (parentOwner.isEmpty() || parentOwner != me) {
                return InviteStatus.FOREIGN_UNDERTWIG
            }
        }
        return if (readableParents > 0) InviteStatus.NOT_UNDERTWIG else InviteStatus.UNKNOWN
    }

    /**
     * True only when a parent folder is named Undertwig and is not owned by [me].
     * Unrelated shared Drive folders are excluded from Cloud (invited).
     */
    private fun isUnderForeignUndertwig(
        accessToken: String,
        folderMeta: JSONObject,
        me: String,
    ): Boolean = undertwigInviteStatus(accessToken, folderMeta, me) == InviteStatus.FOREIGN_UNDERTWIG

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
     * Persist an accepted invite under Drive/Undertwig so the Android home screen can
     * list it after a desktop open + refresh (appDataFolder is per OAuth client).
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

    private fun loadRememberedInvitedProjects(
        accessToken: String,
        me: String,
    ): List<DriveRemoteProject> {
        val registry = readInvitedRegistry(accessToken)
        val out = mutableListOf<DriveRemoteProject>()
        val kept = mutableListOf<JSONObject>()
        for (entry in registry) {
            val id = entry.optString("id").takeIf { it.isNotBlank() } ?: continue
            val meta = folderMetaWithParents(accessToken, id) ?: continue
            if (meta.optString("mimeType") != "application/vnd.google-apps.folder") continue
            // Registry entries were accepted through Undertwig; keep unless parents
            // prove this folder is not under a foreign Undertwig.
            if (undertwigInviteStatus(accessToken, meta, me) == InviteStatus.NOT_UNDERTWIG) {
                continue
            }
            kept += entry
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
        if (kept.size != registry.size) {
            runCatching { writeInvitedRegistry(accessToken, kept) }
        }
        return out
    }

    private fun readInvitedRegistry(accessToken: String): List<JSONObject> {
        val fromUndertwig = readUndertwigRegistry(accessToken)
        if (fromUndertwig.isNotEmpty()) {
            return fromUndertwig
        }
        val legacy = readLegacyAppDataRegistry(accessToken)
        if (legacy.isNotEmpty()) {
            // One-time migrate so both OAuth clients share the same list.
            runCatching { writeInvitedRegistry(accessToken, legacy) }
        }
        return legacy
    }

    private fun readUndertwigRegistry(accessToken: String): List<JSONObject> {
        val rootId = runCatching { ensureUndertwigFolder(accessToken) }.getOrNull() ?: return emptyList()
        val remote = findNamedChild(accessToken, rootId, INVITED_REGISTRY_NAME, mimeType = null)
            ?: return emptyList()
        if (remote.optString("mimeType") == "application/vnd.google-apps.folder") {
            return emptyList()
        }
        val fileId = remote.optString("id").takeIf { it.isNotBlank() } ?: return emptyList()
        return runCatching {
            parseRegistryBytes(downloadDriveFile(accessToken, fileId))
        }.getOrDefault(emptyList())
    }

    private fun readLegacyAppDataRegistry(accessToken: String): List<JSONObject> {
        val fileId = findAppDataFileId(accessToken, LEGACY_APPDATA_REGISTRY_NAME) ?: return emptyList()
        return runCatching {
            parseRegistryBytes(downloadAppDataFile(accessToken, fileId))
        }.getOrDefault(emptyList())
    }

    private fun parseRegistryBytes(bytes: ByteArray): List<JSONObject> {
        val payload = JSONObject(String(bytes, StandardCharsets.UTF_8))
        val arr = payload.optJSONArray("projects") ?: return emptyList()
        return buildList {
            for (i in 0 until arr.length()) {
                arr.optJSONObject(i)?.let { add(it) }
            }
        }
    }

    private fun downloadAppDataFile(accessToken: String, fileId: String): ByteArray {
        val url =
            "$DRIVE_API/files/${Uri.encode(fileId)}?alt=media&spaces=appDataFolder"
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 30_000
            readTimeout = 60_000
            setRequestProperty("Authorization", "Bearer $accessToken")
        }
        try {
            val code = connection.responseCode
            if (code !in 200..299) {
                throwDriveHttpError(code, connection, "Could not download invited project list.")
            }
            return connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    private fun writeInvitedRegistry(accessToken: String, projects: List<JSONObject>) {
        val payload = JSONObject().put(
            "projects",
            JSONArray().also { arr -> projects.forEach { arr.put(it) } },
        )
        val bytes = payload.toString().toByteArray(StandardCharsets.UTF_8)
        val rootId = ensureUndertwigFolder(accessToken)
        val existing = findNamedChild(accessToken, rootId, INVITED_REGISTRY_NAME, mimeType = null)
        val existingId = existing
            ?.takeUnless { it.optString("mimeType") == "application/vnd.google-apps.folder" }
            ?.optString("id")
            ?.takeIf { it.isNotBlank() }
        val tmp = File.createTempFile("undertwig-invites-", ".json")
        try {
            tmp.writeBytes(bytes)
            uploadFile(
                accessToken = accessToken,
                parentId = rootId,
                fileName = INVITED_REGISTRY_NAME,
                file = tmp,
                existingId = existingId,
            )
        } finally {
            tmp.delete()
        }
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
            // Hide per-file edit locks from the LaTeX project tree.
            if (prefix.isEmpty() && name == LOCK_DIR_NAME) continue
            if (path == LOCK_DIR_NAME || path.startsWith("$LOCK_DIR_NAME/")) continue
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
        val files = findNamedChildren(accessToken, parentId, name, mimeType)
        if (files.isEmpty()) return null
        if (files.size == 1) return files[0]
        // Prefer the newest when Drive has duplicate names (common for lock folders).
        var best = files[0]
        var bestMs = parseDriveTime(best.optString("modifiedTime"))
        for (i in 1 until files.size) {
            val candidate = files[i]
            val ms = parseDriveTime(candidate.optString("modifiedTime"))
            if (ms >= bestMs) {
                best = candidate
                bestMs = ms
            }
        }
        return best
    }

    private fun findNamedChildren(
        accessToken: String,
        parentId: String,
        name: String,
        mimeType: String?,
    ): List<JSONObject> {
        val mimeClause = if (mimeType.isNullOrBlank()) {
            ""
        } else {
            " and mimeType = '${escapeQuery(mimeType)}'"
        }
        val files = driveSearch(
            accessToken,
            "name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents " +
                "and trashed = false$mimeClause",
            pageSize = 25,
        )
        val out = ArrayList<JSONObject>(files.length())
        for (i in 0 until files.length()) {
            out += files.getJSONObject(i)
        }
        return out
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
        // Lives under Drive/Undertwig so web + Android share it (appData is per OAuth client).
        private const val INVITED_REGISTRY_NAME = ".undertwig-invited-projects-v1.json"
        private const val LEGACY_APPDATA_REGISTRY_NAME = "undertwig-invited-projects-v1.json"
        private const val LOCK_DIR_NAME = ".undertwig-locks"
        private const val PROJECT_LOCK_FILE = "project.json"
        // Must outlast browser background-tab timer throttling (~1 min) or Android
        // will steal a live desktop writing room. Heartbeat is every 20s.
        private const val LOCK_STALE_MS = 2 * 60 * 1000L
        private const val LOCK_STEAL_RECHECK_MS = 1_500L
        private const val DRIVE_API = "https://www.googleapis.com/drive/v3"
        private const val DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3"
        private const val PREFS = "undertwig_drive"
        private const val KEY_UNDERTWIG_FOLDER = "undertwig_folder_id"
        private const val KEY_DEVICE_ID = "undertwig_device_id"

        private fun parseLockTimestampMs(raw: String?): Long? {
            val value = raw?.trim().orEmpty()
            if (value.isEmpty()) return null
            runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()?.let { return it }
            runCatching { java.time.OffsetDateTime.parse(value).toInstant().toEpochMilli() }
                .getOrNull()
                ?.let { return it }
            runCatching { java.time.ZonedDateTime.parse(value).toInstant().toEpochMilli() }
                .getOrNull()
                ?.let { return it }
            value.toLongOrNull()?.takeIf { it > 1_000_000_000_000L }?.let { return it }
            return null
        }
    }
}
