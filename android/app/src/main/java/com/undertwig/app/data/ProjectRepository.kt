package com.undertwig.app.data

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

data class ProjectSummary(
    val id: String,
    val name: String,
    val updatedAt: Long,
    val driveFolderId: String? = null,
    val driveRole: String? = null,
    val ownerEmail: String? = null,
)

enum class ProjectOrigin {
    Local,
    Drive,
    Invited,
}

data class HomeProjectItem(
    val key: String,
    val name: String,
    val updatedAt: Long,
    val origin: ProjectOrigin,
    val localId: String? = null,
    val driveFolderId: String? = null,
    val ownerEmail: String? = null,
) {
    val canDelete: Boolean get() = localId != null
    val detailLabel: String
        get() = when (origin) {
            ProjectOrigin.Local -> "On this device"
            ProjectOrigin.Drive -> "Google Drive"
            ProjectOrigin.Invited ->
                ownerEmail?.takeIf { it.isNotBlank() }?.let { "Shared · $it" } ?: "Shared with you"
        }
}

data class DriveRemoteProject(
    val folderId: String,
    val name: String,
    val modifiedTimeMs: Long,
    val ownerEmail: String?,
    val ownedByMe: Boolean,
)

data class DriveTreeEntry(
    val path: String,
    val name: String,
    val id: String,
    val mimeType: String,
    val isFolder: Boolean,
)

data class ProjectFile(
    val path: String,
    val content: String,
    val binary: Boolean = false,
)

data class ProjectDownloadInfo(
    val projectId: String,
    val projectName: String,
    val fileCount: Int,
    val totalBytes: Long,
) {
    val zipFileName: String
        get() = sanitizeFileName(projectName) + ".zip"

    val readableSize: String
        get() = formatByteSize(totalBytes)

    companion object {
        fun sanitizeFileName(name: String): String {
            val cleaned = name.trim()
                .replace(Regex("[\\\\/:*?\"<>|]"), "-")
                .replace(Regex("\\s+"), " ")
                .trim('.', ' ')
            return cleaned.ifEmpty { "project" }
        }

        fun formatByteSize(bytes: Long): String {
            if (bytes < 1024L) return "$bytes B"
            val kb = bytes / 1024.0
            if (kb < 1024.0) return String.format("%.1f KB", kb)
            val mb = kb / 1024.0
            if (mb < 1024.0) return String.format("%.1f MB", mb)
            return String.format("%.2f GB", mb / 1024.0)
        }
    }
}

class ProjectRepository(context: Context) {
    private val appContext = context.applicationContext
    private val root = File(context.filesDir, "projects").also { it.mkdirs() }

    fun listProjects(): List<ProjectSummary> {
        if (!root.exists()) return emptyList()
        return root.listFiles()
            ?.filter { it.isDirectory }
            ?.mapNotNull { dir ->
                val meta = readMeta(dir) ?: return@mapNotNull null
                ProjectSummary(
                    id = dir.name,
                    name = meta.optString("name", dir.name),
                    updatedAt = meta.optLong("updatedAt", dir.lastModified()),
                    driveFolderId = meta.optString("driveFolderId").takeIf { it.isNotBlank() },
                    driveRole = meta.optString("driveRole").takeIf { it.isNotBlank() },
                    ownerEmail = meta.optString("ownerEmail").takeIf { it.isNotBlank() },
                )
            }
            ?.sortedByDescending { it.updatedAt }
            .orEmpty()
    }

    fun findByDriveFolderId(folderId: String): ProjectSummary? {
        val want = folderId.trim()
        if (want.isEmpty()) return null
        return listProjects().firstOrNull { it.driveFolderId == want }
    }

    fun setDriveLink(
        projectId: String,
        folderId: String,
        role: String,
        ownerEmail: String? = null,
    ) {
        val dir = projectDir(projectId)
        val meta = readMeta(dir) ?: JSONObject().put("name", projectId)
        meta.put("driveFolderId", folderId)
        meta.put("driveRole", role)
        if (!ownerEmail.isNullOrBlank()) {
            meta.put("ownerEmail", ownerEmail)
        }
        meta.put("updatedAt", System.currentTimeMillis())
        File(dir, META_FILE).writeText(meta.toString())
    }

    /**
     * Create or refresh a local project mirror of a Drive folder.
     * @return local project id
     */
    fun importDriveMirror(
        name: String,
        driveFolderId: String,
        role: String,
        ownerEmail: String?,
        folders: List<String>,
        files: Map<String, ByteArray>,
    ): String {
        val existing = findByDriveFolderId(driveFolderId)
        val id = existing?.id ?: UUID.randomUUID().toString()
        val dir = File(root, id).also { it.mkdirs() }
        if (existing == null) {
            // Fresh import: clear anything unexpected.
            dir.listFiles()?.forEach { child ->
                if (child.name != META_FILE) child.deleteRecursively()
            }
        } else {
            // Refresh: remove old content files/folders, keep meta briefly.
            dir.listFiles()?.forEach { child ->
                if (child.name != META_FILE) child.deleteRecursively()
            }
        }

        for (folder in folders) {
            val clean = normalizePath(folder)
            if (clean.isNotEmpty()) {
                File(dir, clean).mkdirs()
            }
        }
        for ((relativePath, bytes) in files) {
            val clean = normalizePath(relativePath)
            if (clean.isEmpty()) continue
            val out = File(dir, clean)
            out.parentFile?.mkdirs()
            out.writeBytes(bytes)
        }

        val safeName = name.trim().ifEmpty { "Untitled" }
        val meta = JSONObject()
            .put("name", safeName)
            .put("updatedAt", System.currentTimeMillis())
            .put("driveFolderId", driveFolderId)
            .put("driveRole", role)
        if (!ownerEmail.isNullOrBlank()) {
            meta.put("ownerEmail", ownerEmail)
        }
        File(dir, META_FILE).writeText(meta.toString())
        return id
    }

    /**
     * Ensure default starters exist (Sample Project, then DummyHippo).
     * Also refreshes packaged starter sources when [STARTER_ASSET_VERSION] advances
     * so app updates (e.g. DummyHippo figures) replace the on-disk copy.
     * @return project id to auto-open when this was a first-empty install; otherwise null
     */
    fun ensureDefaultProjects(): String? {
        val existing = listProjects()
        val wasEmpty = existing.isEmpty()
        var openId: String? = null

        if (existing.none { it.name == SAMPLE_PROJECT_NAME }) {
            val sample = createSampleProject()
            if (wasEmpty) {
                openId = sample.id
            }
        }
        if (listProjects().none { it.name == DUMMY_HIPPO_NAME }) {
            createDummyHippoProject()
        }
        refreshStarterAssetsIfNeeded(SAMPLE_PROJECT_NAME, "sample")
        refreshStarterAssetsIfNeeded(DUMMY_HIPPO_NAME, "dummyhippo")
        return openId
    }

    fun createSampleProject(): ProjectSummary {
        val id = UUID.randomUUID().toString()
        val dir = File(root, id).also { it.mkdirs() }
        copyAssetTree("sample", dir)
        writeMeta(dir, SAMPLE_PROJECT_NAME, STARTER_ASSET_VERSION)
        return ProjectSummary(
            id = id,
            name = SAMPLE_PROJECT_NAME,
            updatedAt = System.currentTimeMillis(),
        )
    }

    fun createDummyHippoProject(): ProjectSummary {
        val id = UUID.randomUUID().toString()
        val dir = File(root, id).also { it.mkdirs() }
        copyAssetTree("dummyhippo", dir)
        writeMeta(dir, DUMMY_HIPPO_NAME, STARTER_ASSET_VERSION)
        return ProjectSummary(
            id = id,
            name = DUMMY_HIPPO_NAME,
            updatedAt = System.currentTimeMillis(),
        )
    }

    /**
     * Re-copy bundled starter files when the APK asset pack is newer than the
     * on-disk project. Drops stale main.pdf so PDF preview cannot show an old convert.
     */
    private fun refreshStarterAssetsIfNeeded(projectName: String, assetDir: String) {
        val project = listProjects().find { it.name == projectName } ?: return
        val dir = projectDir(project.id)
        val meta = readMeta(dir) ?: return
        val version = meta.optInt("assetVersion", 0)
        if (version >= STARTER_ASSET_VERSION) return

        copyAssetTree(assetDir, dir)
        File(dir, "main.pdf").delete()
        meta.put("assetVersion", STARTER_ASSET_VERSION)
        meta.put("updatedAt", System.currentTimeMillis())
        File(dir, META_FILE).writeText(meta.toString())
    }

    fun createProject(name: String): ProjectSummary {
        val id = UUID.randomUUID().toString()
        val dir = File(root, id).also { it.mkdirs() }
        val safeName = name.trim().ifEmpty { "Untitled" }
        writeTextFile(dir, "main.tex", BLANK_MAIN_TEX)
        writeMeta(dir, safeName)
        return ProjectSummary(id = id, name = safeName, updatedAt = System.currentTimeMillis())
    }

    fun renameProject(id: String, name: String) {
        val dir = projectDir(id)
        val meta = readMeta(dir) ?: JSONObject()
        meta.put("name", name.trim().ifEmpty { "Untitled" })
        meta.put("updatedAt", System.currentTimeMillis())
        File(dir, META_FILE).writeText(meta.toString())
    }

    fun deleteProject(id: String) {
        projectDir(id).deleteRecursively()
    }

    fun listFiles(projectId: String): List<String> {
        val dir = projectDir(projectId)
        return dir.walkTopDown()
            .filter { it.isFile && it.name != META_FILE }
            .map { it.relativeTo(dir).path.replace(File.separatorChar, '/') }
            .sorted()
            .toList()
    }

    /** Relative folder paths (including empty folders), excluding the project root. */
    fun listFolders(projectId: String): List<String> {
        val dir = projectDir(projectId)
        return dir.walkTopDown()
            .filter { it.isDirectory && it != dir }
            .map { it.relativeTo(dir).path.replace(File.separatorChar, '/') }
            .filter { it.isNotEmpty() && !it.contains("..") }
            .sorted()
            .toList()
    }

    fun createFolder(projectId: String, relativePath: String) {
        val clean = normalizePath(relativePath)
        require(clean.isNotEmpty()) { "Invalid folder path" }
        require(!clean.contains("..")) { "Invalid folder path" }
        val dir = projectDir(projectId)
        val target = File(dir, clean)
        require(!target.isFile) { "A file already exists at “$clean”" }
        check(target.exists() || target.mkdirs()) { "Could not create folder" }
        touch(dir)
    }

    fun readFile(projectId: String, relativePath: String): ProjectFile {
        val file = resolve(projectId, relativePath)
        require(file.exists()) { "Missing file: $relativePath" }
        if (isBinaryPath(relativePath)) {
            val b64 = Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
            return ProjectFile(path = relativePath, content = b64, binary = true)
        }
        return ProjectFile(path = relativePath, content = file.readText(), binary = false)
    }

    fun writeFile(projectId: String, relativePath: String, content: String) {
        require(!isBinaryPath(relativePath)) { "Refusing to overwrite binary file as text: $relativePath" }
        val dir = projectDir(projectId)
        writeTextFile(dir, relativePath, content)
        touch(dir)
    }

    fun writeFileBytes(projectId: String, relativePath: String, bytes: ByteArray) {
        val clean = normalizePath(relativePath)
        require(clean.isNotEmpty()) { "Invalid file path" }
        require(!clean.contains("..")) { "Invalid file path" }
        val dir = projectDir(projectId)
        val out = File(dir, clean)
        require(!out.isDirectory) { "A folder already exists at “$clean”" }
        out.parentFile?.mkdirs()
        out.writeBytes(bytes)
        touch(dir)
    }

    fun createFile(projectId: String, relativePath: String, content: String = "") {
        val clean = normalizePath(relativePath)
        require(clean.isNotEmpty()) { "Invalid file path" }
        val target = File(projectDir(projectId), clean)
        require(!target.isDirectory) { "A folder already exists at “$clean”" }
        writeFile(projectId, clean, content)
    }

    fun deleteFile(projectId: String, relativePath: String) {
        deletePath(projectId, relativePath, isFolder = false)
    }

    fun deletePath(projectId: String, relativePath: String, isFolder: Boolean) {
        val clean = normalizePath(relativePath)
        require(clean.isNotEmpty()) { "Invalid path" }
        val dir = projectDir(projectId)
        val target = File(dir, clean)
        if (isFolder) {
            if (target.isDirectory) {
                target.deleteRecursively()
            } else {
                val prefix = "$clean/"
                listFiles(projectId)
                    .filter { it.startsWith(prefix) }
                    .forEach { File(dir, it).delete() }
                // Remove emptied parent dirs under the folder path.
                target.deleteRecursively()
            }
        } else {
            target.delete()
        }
        touch(dir)
    }

    fun renamePath(projectId: String, fromPath: String, toPath: String, isFolder: Boolean) {
        val from = normalizePath(fromPath)
        val to = normalizePath(toPath)
        require(from.isNotEmpty() && to.isNotEmpty()) { "Invalid path" }
        require(from != to) { "Name unchanged" }
        require(!to.contains("..") && !from.contains("..")) { "Invalid path" }

        val dir = projectDir(projectId)
        val src = File(dir, from)
        val dst = File(dir, to)
        require(!dst.exists()) { "“$to” already exists" }

        if (isFolder) {
            if (src.isDirectory) {
                dst.parentFile?.mkdirs()
                check(src.renameTo(dst)) { "Could not rename folder" }
            } else {
                val prefix = "$from/"
                val matches = listFiles(projectId).filter { it.startsWith(prefix) }
                require(matches.isNotEmpty()) { "Folder not found" }
                matches.forEach { old ->
                    val next = to + old.removePrefix(from)
                    val oldFile = File(dir, old)
                    val newFile = File(dir, next)
                    require(!newFile.exists()) { "“$next” already exists" }
                    newFile.parentFile?.mkdirs()
                    check(oldFile.renameTo(newFile) || copyAndDelete(oldFile, newFile)) {
                        "Could not rename $old"
                    }
                }
            }
        } else {
            require(src.isFile) { "File not found" }
            dst.parentFile?.mkdirs()
            check(src.renameTo(dst) || copyAndDelete(src, dst)) { "Could not rename file" }
        }
        touch(dir)
    }

    fun projectName(projectId: String): String {
        return readMeta(projectDir(projectId))?.optString("name", projectId) ?: projectId
    }

    fun filesForCompile(projectId: String): Map<String, ProjectFile> {
        return listFiles(projectId)
            // Skip only the convert output, not figure PDFs like figures/hippo-figure.pdf.
            .filter { path -> path != "main.pdf" && !path.endsWith("/main.pdf") }
            .associateWith { path -> readFile(projectId, path) }
    }

    fun savePdf(projectId: String, bytes: ByteArray): File {
        val dir = projectDir(projectId)
        val out = File(dir, "main.pdf")
        val tmp = File(dir, "main.pdf.tmp")
        // Atomic replace so PdfRenderer / FDs never reopen a half-written or
        // same-inode stale mapping of the previous convert.
        tmp.writeBytes(bytes)
        if (out.exists() && !out.delete()) {
            out.writeBytes(bytes)
            tmp.delete()
        } else if (!tmp.renameTo(out)) {
            tmp.copyTo(out, overwrite = true)
            tmp.delete()
        }
        out.setLastModified(System.currentTimeMillis())
        touch(dir)
        return out
    }

    fun pdfFile(projectId: String): File? {
        val file = File(projectDir(projectId), "main.pdf")
        return file.takeIf { it.exists() && it.length() > 0L }
    }

    /** Resolve a project-relative path to an existing file, or null. */
    fun absoluteFile(projectId: String, relativePath: String): File? {
        return runCatching {
            resolve(projectId, relativePath).takeIf { it.isFile && it.length() > 0L }
        }.getOrNull()
    }

    /** Any existing project file (including empty), for Drive sync. */
    fun existingFile(projectId: String, relativePath: String): File? {
        return runCatching {
            resolve(projectId, relativePath).takeIf { it.isFile }
        }.getOrNull()
    }

    fun projectDownloadInfo(projectId: String): ProjectDownloadInfo {
        val dir = projectDir(projectId)
        val files = exportableFiles(dir)
        val total = files.sumOf { it.length() }
        return ProjectDownloadInfo(
            projectId = projectId,
            projectName = projectName(projectId),
            fileCount = files.size,
            totalBytes = total,
        )
    }

    /** Zip project files (excluding app metadata) into a cache file for download. */
    fun zipProject(projectId: String): File {
        val dir = projectDir(projectId)
        val info = projectDownloadInfo(projectId)
        require(info.fileCount > 0) { "This project has no files to download." }
        val outDir = File(appContext.cacheDir, "exports").also { it.mkdirs() }
        val out = File(outDir, info.zipFileName)
        if (out.exists()) {
            out.delete()
        }
        ZipOutputStream(BufferedOutputStream(FileOutputStream(out))).use { zip ->
            exportableFiles(dir).forEach { file ->
                val relative = file.relativeTo(dir).path.replace(File.separatorChar, '/')
                zip.putNextEntry(ZipEntry(relative))
                file.inputStream().use { input -> input.copyTo(zip) }
                zip.closeEntry()
            }
        }
        return out
    }

    private fun exportableFiles(projectDir: File): List<File> {
        return projectDir.walkTopDown()
            .filter { it.isFile && it.name != META_FILE }
            .sortedBy { it.relativeTo(projectDir).path }
            .toList()
    }

    private fun copyAssetTree(assetDir: String, destDir: File) {
        val assets = appContext.assets
        val children = assets.list(assetDir).orEmpty()
        if (children.isEmpty()) {
            // File leaf (assets.list returns empty for files on some devices — use open).
            assets.open(assetDir).use { input ->
                destDir.parentFile?.mkdirs()
                destDir.outputStream().use { output -> input.copyTo(output) }
            }
            return
        }
        destDir.mkdirs()
        for (child in children) {
            val assetPath = "$assetDir/$child"
            val out = File(destDir, child)
            val nested = assets.list(assetPath)
            if (nested != null && nested.isNotEmpty()) {
                copyAssetTree(assetPath, out)
            } else {
                out.parentFile?.mkdirs()
                assets.open(assetPath).use { input ->
                    out.outputStream().use { output -> input.copyTo(output) }
                }
            }
        }
    }

    private fun projectDir(id: String): File = File(root, id).also { require(it.exists()) { "Unknown project" } }

    private fun resolve(projectId: String, relativePath: String): File {
        val clean = normalizePath(relativePath)
        require(clean.isNotEmpty()) { "Invalid path" }
        require(!clean.contains("..")) { "Invalid path" }
        return File(projectDir(projectId), clean)
    }

    private fun writeTextFile(dir: File, relativePath: String, content: String) {
        val clean = normalizePath(relativePath)
        require(clean.isNotEmpty()) { "Invalid path" }
        require(!clean.contains("..")) { "Invalid path" }
        val file = File(dir, clean)
        file.parentFile?.mkdirs()
        file.writeText(content)
    }

    private fun copyAndDelete(src: File, dst: File): Boolean {
        return runCatching {
            src.copyTo(dst, overwrite = false)
            src.delete()
        }.isSuccess
    }

    private fun normalizePath(relativePath: String): String {
        return relativePath.trim().trim('/').replace('\\', '/')
    }

    private fun touch(dir: File) {
        val meta = readMeta(dir) ?: JSONObject().put("name", dir.name)
        meta.put("updatedAt", System.currentTimeMillis())
        File(dir, META_FILE).writeText(meta.toString())
    }

    private fun writeMeta(dir: File, name: String, assetVersion: Int? = null) {
        val meta = JSONObject()
            .put("name", name)
            .put("updatedAt", System.currentTimeMillis())
        if (assetVersion != null) {
            meta.put("assetVersion", assetVersion)
        }
        File(dir, META_FILE).writeText(meta.toString())
    }

    private fun readMeta(dir: File): JSONObject? {
        val file = File(dir, META_FILE)
        if (!file.exists()) return null
        return runCatching { JSONObject(file.readText()) }.getOrNull()
    }

    companion object {
        private const val META_FILE = "project.json"
        /** Bump when bundled sample/dummyhippo assets change and existing installs should re-seed. */
        private const val STARTER_ASSET_VERSION = 2
        const val SAMPLE_PROJECT_NAME = "Sample Project"
        const val DUMMY_HIPPO_NAME = "DummyHippo"

        private val BINARY_EXTENSIONS = setOf(
            "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "ico",
            "pdf", "wasm", "woff", "woff2", "ttf", "otf",
        )

        fun isBinaryPath(path: String): Boolean {
            val ext = path.substringAfterLast('.', "").lowercase()
            return ext in BINARY_EXTENSIONS
        }

        private val BLANK_MAIN_TEX = """
            \documentclass{article}
            \usepackage[margin=1in]{geometry}
            \title{Untitled}
            \author{}
            \date{\today}
            \begin{document}
            \maketitle
            \end{document}
        """.trimIndent() + "\n"
    }
}
