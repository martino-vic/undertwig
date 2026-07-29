package com.undertwig.app.data

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class ProjectSummary(
    val id: String,
    val name: String,
    val updatedAt: Long,
)

data class ProjectFile(
    val path: String,
    val content: String,
    val binary: Boolean = false,
)

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
                )
            }
            ?.sortedByDescending { it.updatedAt }
            .orEmpty()
    }

    /**
     * Ensure the website Sample Project starter exists.
     * @return project id to auto-open when this was a first-empty install; otherwise null
     */
    fun ensureSampleProject(): String? {
        val existing = listProjects()
        if (existing.any { it.name == SAMPLE_PROJECT_NAME }) {
            return null
        }
        val created = createSampleProject()
        return if (existing.isEmpty()) created.id else null
    }

    fun createSampleProject(): ProjectSummary {
        val id = UUID.randomUUID().toString()
        val dir = File(root, id).also { it.mkdirs() }
        copyAssetTree("sample", dir)
        writeMeta(dir, SAMPLE_PROJECT_NAME)
        return ProjectSummary(
            id = id,
            name = SAMPLE_PROJECT_NAME,
            updatedAt = System.currentTimeMillis(),
        )
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

    fun createFile(projectId: String, relativePath: String, content: String = "") {
        writeFile(projectId, relativePath, content)
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
            .filter { path ->
                val lower = path.lowercase()
                !lower.endsWith(".pdf")
            }
            .associateWith { path -> readFile(projectId, path) }
    }

    fun savePdf(projectId: String, bytes: ByteArray): File {
        val out = File(projectDir(projectId), "main.pdf")
        out.writeBytes(bytes)
        touch(projectDir(projectId))
        return out
    }

    fun pdfFile(projectId: String): File? {
        val file = File(projectDir(projectId), "main.pdf")
        return file.takeIf { it.exists() && it.length() > 0L }
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

    private fun writeMeta(dir: File, name: String) {
        val meta = JSONObject()
            .put("name", name)
            .put("updatedAt", System.currentTimeMillis())
        File(dir, META_FILE).writeText(meta.toString())
    }

    private fun readMeta(dir: File): JSONObject? {
        val file = File(dir, META_FILE)
        if (!file.exists()) return null
        return runCatching { JSONObject(file.readText()) }.getOrNull()
    }

    companion object {
        private const val META_FILE = "project.json"
        const val SAMPLE_PROJECT_NAME = "Sample Project"

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
