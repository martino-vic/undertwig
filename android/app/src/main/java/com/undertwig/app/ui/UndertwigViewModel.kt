package com.undertwig.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.undertwig.app.data.ProjectFile
import com.undertwig.app.data.ProjectRepository
import com.undertwig.app.data.ProjectSummary
import com.undertwig.app.engine.LatexEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import kotlin.coroutines.coroutineContext

data class HomeUiState(
    val projects: List<ProjectSummary> = emptyList(),
)

enum class EditorBusy {
    Idle,
    Convert,
    Bibliography,
}

data class EditorUiState(
    val projectId: String = "",
    val projectName: String = "",
    val files: List<String> = emptyList(),
    val folders: List<String> = emptyList(),
    val activePath: String = "main.tex",
    val editorText: String = "",
    val dirty: Boolean = false,
    val status: String = "Ready.",
    val busy: EditorBusy = EditorBusy.Idle,
    val lastLog: String = "",
    val pdfPath: String? = null,
    /** Increments on each successful Convert so PdfScreen reloads overwritten main.pdf. */
    val pdfRevision: Long = 0L,
    /** Project-relative PDF currently shown in the full-screen viewer (any tree PDF). */
    val previewPdfRelativePath: String? = null,
    val error: String? = null,
) {
    val converting: Boolean get() = busy != EditorBusy.Idle
}

class UndertwigViewModel(application: Application) : AndroidViewModel(application) {
    private val repo = ProjectRepository(application)
    private val engine = LatexEngine()
    private var busyJob: Job? = null

    private val _home = MutableStateFlow(HomeUiState())
    val home: StateFlow<HomeUiState> = _home.asStateFlow()

    private val _editor = MutableStateFlow(EditorUiState())
    val editor: StateFlow<EditorUiState> = _editor.asStateFlow()

    init {
        // Match the website starters: Sample Project + DummyHippo; open Sample on fresh install.
        val openId = repo.ensureDefaultProjects()
        refreshProjects()
        if (openId != null) {
            openProject(openId)
        }
        // Do not create WebView here — Application context / early init crashes on many emulators.
    }

    fun attachEngine(context: android.content.Context) {
        engine.attach(context)
    }

    fun refreshProjects() {
        _home.update { it.copy(projects = repo.listProjects()) }
    }

    fun createProject(name: String) {
        repo.createProject(name)
        refreshProjects()
    }

    fun deleteProject(id: String) {
        repo.deleteProject(id)
        refreshProjects()
    }

    fun openProject(id: String) {
        val files = repo.listFiles(id)
        val active = when {
            "main.tex" in files -> "main.tex"
            files.isNotEmpty() -> files.first()
            else -> "main.tex"
        }
        if (active !in files) {
            repo.createFile(id, "main.tex", "")
        }
        val file = repo.readFile(id, active)
        val pdf = repo.pdfFile(id)?.absolutePath
        _editor.value = EditorUiState(
            projectId = id,
            projectName = repo.projectName(id),
            files = repo.listFiles(id),
            folders = repo.listFolders(id),
            activePath = active,
            editorText = editorDisplayText(file),
            dirty = false,
            status = "Editing $active",
            pdfPath = pdf,
        )
    }

    fun selectFile(path: String) {
        val state = _editor.value
        if (state.dirty && !ProjectRepository.isBinaryPath(state.activePath)) {
            repo.writeFile(state.projectId, state.activePath, state.editorText)
        }
        val file = repo.readFile(state.projectId, path)
        _editor.update {
            it.copy(
                activePath = path,
                editorText = editorDisplayText(file),
                dirty = false,
                files = repo.listFiles(state.projectId),
                folders = repo.listFolders(state.projectId),
                status = "Editing $path",
            )
        }
    }

    fun onEditorChange(text: String) {
        if (ProjectRepository.isBinaryPath(_editor.value.activePath)) return
        _editor.update { it.copy(editorText = text, dirty = true) }
    }

    fun saveActive() {
        val state = _editor.value
        if (ProjectRepository.isBinaryPath(state.activePath)) return
        repo.writeFile(state.projectId, state.activePath, state.editorText)
        _editor.update {
            it.copy(
                dirty = false,
                status = "Saved ${state.activePath}",
                files = repo.listFiles(state.projectId),
                folders = repo.listFolders(state.projectId),
            )
        }
        refreshProjects()
    }

    fun addFile(path: String) {
        val state = _editor.value
        val clean = path.trim().trimStart('/')
        if (clean.isEmpty()) return
        runCatching {
            repo.createFile(state.projectId, clean, "")
        }.onFailure { error ->
            _editor.update {
                it.copy(error = error.message ?: "Could not create file.", status = "Create failed.")
            }
            return
        }
        selectFile(clean)
    }

    fun addFolder(path: String) {
        val state = _editor.value
        val clean = path.trim().trimStart('/')
        if (clean.isEmpty() || state.projectId.isEmpty()) return
        runCatching {
            repo.createFolder(state.projectId, clean)
        }.onFailure { error ->
            _editor.update {
                it.copy(error = error.message ?: "Could not create folder.", status = "Create failed.")
            }
            return
        }
        _editor.update {
            it.copy(
                files = repo.listFiles(state.projectId),
                folders = repo.listFolders(state.projectId),
                status = "Created folder $clean",
                error = null,
            )
        }
        refreshProjects()
    }

    fun deletePath(path: String, isFolder: Boolean) {
        val state = _editor.value
        if (state.projectId.isEmpty()) return
        val clean = path.trim().trimStart('/')
        if (clean.isEmpty()) return
        runCatching {
            if (state.dirty &&
                !ProjectRepository.isBinaryPath(state.activePath) &&
                !isAffectedByDelete(state.activePath, clean, isFolder)
            ) {
                repo.writeFile(state.projectId, state.activePath, state.editorText)
            }
            repo.deletePath(state.projectId, clean, isFolder)
        }.onFailure { error ->
            _editor.update {
                it.copy(error = error.message ?: "Delete failed.", status = "Delete failed.")
            }
            return
        }
        reloadAfterPathChange(
            preferredPath = null,
            status = if (isFolder) "Deleted folder $clean" else "Deleted $clean",
        )
    }

    fun renamePath(fromPath: String, toPath: String, isFolder: Boolean) {
        val state = _editor.value
        if (state.projectId.isEmpty()) return
        val from = fromPath.trim().trimStart('/')
        val to = toPath.trim().trimStart('/')
        if (from.isEmpty() || to.isEmpty()) return
        runCatching {
            if (state.dirty &&
                !ProjectRepository.isBinaryPath(state.activePath) &&
                !isAffectedByDelete(state.activePath, from, isFolder)
            ) {
                repo.writeFile(state.projectId, state.activePath, state.editorText)
            } else if (state.dirty &&
                !isFolder &&
                state.activePath == from &&
                !ProjectRepository.isBinaryPath(from)
            ) {
                // Save into the new name after rename; write old content first if still present.
                repo.writeFile(state.projectId, from, state.editorText)
            }
            repo.renamePath(state.projectId, from, to, isFolder)
        }.onFailure { error ->
            _editor.update {
                it.copy(error = error.message ?: "Rename failed.", status = "Rename failed.")
            }
            return
        }
        val nextActive = when {
            !isFolder && state.activePath == from -> to
            isFolder && (state.activePath == from || state.activePath.startsWith("$from/")) -> {
                to + state.activePath.removePrefix(from)
            }
            else -> state.activePath
        }
        reloadAfterPathChange(
            preferredPath = nextActive,
            status = if (isFolder) "Renamed folder to $to" else "Renamed to $to",
        )
    }

    private fun isAffectedByDelete(activePath: String, target: String, isFolder: Boolean): Boolean {
        return if (isFolder) {
            activePath == target || activePath.startsWith("$target/")
        } else {
            activePath == target
        }
    }

    private fun reloadAfterPathChange(preferredPath: String?, status: String) {
        val state = _editor.value
        var files = repo.listFiles(state.projectId)
        var active = when {
            preferredPath != null && preferredPath in files -> preferredPath
            state.activePath in files -> state.activePath
            "main.tex" in files -> "main.tex"
            files.isNotEmpty() -> files.first()
            else -> "main.tex"
        }
        if (active !in files) {
            repo.createFile(state.projectId, "main.tex", "")
            files = repo.listFiles(state.projectId)
            active = "main.tex"
        }
        val file = repo.readFile(state.projectId, active)
        _editor.update {
            it.copy(
                files = files,
                folders = repo.listFolders(state.projectId),
                activePath = active,
                editorText = editorDisplayText(file),
                dirty = false,
                status = status,
                pdfPath = repo.pdfFile(state.projectId)?.absolutePath,
                error = null,
            )
        }
        refreshProjects()
    }

    fun convert() {
        val state = _editor.value
        when (state.busy) {
            EditorBusy.Convert -> {
                cancelBusy()
                return
            }
            EditorBusy.Bibliography -> return
            EditorBusy.Idle -> Unit
        }
        busyJob = viewModelScope.launch {
            try {
                if (state.dirty && !ProjectRepository.isBinaryPath(state.activePath)) {
                    repo.writeFile(state.projectId, state.activePath, state.editorText)
                }
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Convert,
                        status = "Starting convert…",
                        error = null,
                        dirty = false,
                    )
                }
                val files = repo.filesForCompile(state.projectId).mapValues { (_, file) ->
                    file.content to file.binary
                }
                val compile = engine.compile(files) { message ->
                    _editor.update { ui -> ui.copy(status = message) }
                }
                if (compile.ok && compile.pdfBytes != null) {
                    val pdf = repo.savePdf(state.projectId, compile.pdfBytes)
                    _editor.update {
                        it.copy(
                            busy = EditorBusy.Idle,
                            status = "PDF ready.",
                            lastLog = compile.log,
                            pdfPath = pdf.absolutePath,
                            pdfRevision = it.pdfRevision + 1,
                            files = repo.listFiles(state.projectId),
                            folders = repo.listFolders(state.projectId),
                            error = null,
                        )
                    }
                } else {
                    _editor.update {
                        it.copy(
                            busy = EditorBusy.Idle,
                            status = "Conversion failed.",
                            lastLog = compile.log,
                            error = "Conversion failed. Check the log.",
                        )
                    }
                }
            } catch (_: CancellationException) {
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = "Conversion cancelled.",
                        error = null,
                    )
                }
            } catch (error: Exception) {
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = "Conversion failed.",
                        error = error.message ?: "Conversion failed.",
                        lastLog = error.message.orEmpty(),
                    )
                }
            } finally {
                if (busyJob === coroutineContext[Job]) {
                    busyJob = null
                }
                refreshProjects()
            }
        }
    }

    fun updateBibliography() {
        val state = _editor.value
        if (state.projectId.isEmpty()) return
        when (state.busy) {
            EditorBusy.Bibliography -> {
                cancelBusy()
                return
            }
            EditorBusy.Convert -> return
            EditorBusy.Idle -> Unit
        }
        busyJob = viewModelScope.launch {
            try {
                if (state.dirty && !ProjectRepository.isBinaryPath(state.activePath)) {
                    repo.writeFile(state.projectId, state.activePath, state.editorText)
                }
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Bibliography,
                        status = "Updating bibliography…",
                        error = null,
                        dirty = false,
                    )
                }
                val files = repo.filesForCompile(state.projectId).mapValues { (_, file) ->
                    file.content to file.binary
                }
                val bib = engine.runBibliography(files) { message ->
                    _editor.update { ui -> ui.copy(status = message) }
                }
                bib.outputs.forEach { (path, content) ->
                    if (path.isNotBlank() && !ProjectRepository.isBinaryPath(path)) {
                        runCatching {
                            repo.writeFile(state.projectId, path, content)
                        }
                    }
                }
                val listed = repo.listFiles(state.projectId)
                val active = _editor.value.activePath
                val editorText = if (active in listed && !ProjectRepository.isBinaryPath(active)) {
                    repo.readFile(state.projectId, active).content
                } else {
                    _editor.value.editorText
                }
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = if (bib.ok) {
                            "Bibliography updated. Convert again to refresh the PDF."
                        } else {
                            "Bibliography failed."
                        },
                        lastLog = bib.log,
                        files = listed,
                        folders = repo.listFolders(state.projectId),
                        editorText = editorText,
                        dirty = false,
                        error = if (bib.ok) null else "Bibliography failed. Check the log.",
                    )
                }
            } catch (_: CancellationException) {
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = "Bibliography cancelled.",
                        error = null,
                    )
                }
            } catch (error: Exception) {
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = "Bibliography failed.",
                        error = error.message ?: "Bibliography failed.",
                        lastLog = error.message.orEmpty(),
                    )
                }
            } finally {
                if (busyJob === coroutineContext[Job]) {
                    busyJob = null
                }
                refreshProjects()
            }
        }
    }

    fun cancelBusy() {
        if (_editor.value.busy == EditorBusy.Idle) return
        _editor.update { it.copy(status = "Cancelling…") }
        engine.cancelCurrentWork()
        busyJob?.cancel()
        busyJob = null
    }

    /**
     * Prepare the full-screen PDF viewer for a project-relative path.
     * @return true if the file exists and can be opened.
     */
    fun openPdfPreview(relativePath: String): Boolean {
        val id = _editor.value.projectId
        if (id.isEmpty()) return false
        val clean = relativePath.trim().trim('/').replace('\\', '/')
        if (clean.isEmpty() || clean.contains("..")) return false
        if (!clean.endsWith(".pdf", ignoreCase = true)) return false
        val file = repo.absoluteFile(id, clean) ?: return false
        _editor.update {
            it.copy(
                previewPdfRelativePath = clean,
                // Keep the Convert shortcut in sync when opening main.pdf from the tree.
                pdfPath = if (clean == "main.pdf") file.absolutePath else it.pdfPath,
            )
        }
        return true
    }

    fun pdfFile(): File? {
        val state = _editor.value
        val id = state.projectId
        if (id.isEmpty()) return null
        val relative = state.previewPdfRelativePath
        if (!relative.isNullOrBlank()) {
            return repo.absoluteFile(id, relative)
        }
        return repo.pdfFile(id)
    }

    fun previewPdfTitle(): String {
        val relative = _editor.value.previewPdfRelativePath
        if (!relative.isNullOrBlank()) {
            return relative.substringAfterLast('/')
        }
        return "${_editor.value.projectName}.pdf"
    }

    private fun editorDisplayText(file: ProjectFile): String {
        return if (file.binary) {
            "(Binary asset — not editable here.)\n${file.path}"
        } else {
            file.content
        }
    }

    override fun onCleared() {
        engine.destroy()
        super.onCleared()
    }
}
