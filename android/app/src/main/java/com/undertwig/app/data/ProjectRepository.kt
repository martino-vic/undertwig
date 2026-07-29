package com.undertwig.app.data

import android.content.Context
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

    fun createProject(name: String): ProjectSummary {
        val id = UUID.randomUUID().toString()
        val dir = File(root, id).also { it.mkdirs() }
        val safeName = name.trim().ifEmpty { "Untitled" }
        writeTextFile(dir, "main.tex", SAMPLE_MAIN_TEX)
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
        return ProjectFile(path = relativePath, content = file.readText(), binary = false)
    }

    fun writeFile(projectId: String, relativePath: String, content: String) {
        val dir = projectDir(projectId)
        writeTextFile(dir, relativePath, content)
        touch(dir)
    }

    fun createFile(projectId: String, relativePath: String, content: String = "") {
        writeFile(projectId, relativePath, content)
    }

    fun deleteFile(projectId: String, relativePath: String) {
        resolve(projectId, relativePath).delete()
        touch(projectDir(projectId))
    }

    fun projectName(projectId: String): String {
        return readMeta(projectDir(projectId))?.optString("name", projectId) ?: projectId
    }

    fun filesForCompile(projectId: String): Map<String, ProjectFile> {
        return listFiles(projectId).associateWith { path -> readFile(projectId, path) }
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

    private fun projectDir(id: String): File = File(root, id).also { require(it.exists()) { "Unknown project" } }

    private fun resolve(projectId: String, relativePath: String): File {
        val clean = relativePath.trim('/').replace('\\', '/')
        require(!clean.contains("..")) { "Invalid path" }
        return File(projectDir(projectId), clean)
    }

    private fun writeTextFile(dir: File, relativePath: String, content: String) {
        val clean = relativePath.trim('/').replace('\\', '/')
        require(!clean.contains("..")) { "Invalid path" }
        val file = File(dir, clean)
        file.parentFile?.mkdirs()
        file.writeText(content)
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
        private val SAMPLE_MAIN_TEX = """
            \documentclass{article}
            \usepackage[margin=1in]{geometry}
            \title{Hello from Undertwig}
            \author{Android}
            \date{\today}
            \begin{document}
            \maketitle
            This PDF was compiled on your device with SwiftLaTeX WebAssembly.
            \end{document}
        """.trimIndent() + "\n"
    }
}
