package com.undertwig.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.undertwig.app.data.ProjectFile
import com.undertwig.app.data.ProjectRepository
import com.undertwig.app.data.ProjectSummary
import com.undertwig.app.engine.LatexEngine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

data class HomeUiState(
    val projects: List<ProjectSummary> = emptyList(),
)

data class EditorUiState(
    val projectId: String = "",
    val projectName: String = "",
    val files: List<String> = emptyList(),
    val activePath: String = "main.tex",
    val editorText: String = "",
    val dirty: Boolean = false,
    val status: String = "Ready.",
    val converting: Boolean = false,
    val lastLog: String = "",
    val pdfPath: String? = null,
    val error: String? = null,
)

class UndertwigViewModel(application: Application) : AndroidViewModel(application) {
    private val repo = ProjectRepository(application)
    private val engine = LatexEngine()

    private val _home = MutableStateFlow(HomeUiState())
    val home: StateFlow<HomeUiState> = _home.asStateFlow()

    private val _editor = MutableStateFlow(EditorUiState())
    val editor: StateFlow<EditorUiState> = _editor.asStateFlow()

    init {
        // Match the website: ship Sample Project; open it on a fresh install.
        val sampleId = repo.ensureSampleProject()
        refreshProjects()
        if (sampleId != null) {
            openProject(sampleId)
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
            )
        }
        refreshProjects()
    }

    fun addFile(path: String) {
        val state = _editor.value
        val clean = path.trim().trimStart('/')
        if (clean.isEmpty()) return
        repo.createFile(state.projectId, clean, "")
        selectFile(clean)
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
        if (state.converting) return
        viewModelScope.launch {
            if (state.dirty && !ProjectRepository.isBinaryPath(state.activePath)) {
                repo.writeFile(state.projectId, state.activePath, state.editorText)
            }
            _editor.update {
                it.copy(converting = true, status = "Starting convert…", error = null, dirty = false)
            }
            val result = runCatching {
                val files = repo.filesForCompile(state.projectId).mapValues { (_, file) ->
                    file.content to file.binary
                }
                engine.compile(files) { message ->
                    _editor.update { ui -> ui.copy(status = message) }
                }
            }
            result.fold(
                onSuccess = { compile ->
                    if (compile.ok && compile.pdfBytes != null) {
                        val pdf = repo.savePdf(state.projectId, compile.pdfBytes)
                        _editor.update {
                            it.copy(
                                converting = false,
                                status = "PDF ready.",
                                lastLog = compile.log,
                                pdfPath = pdf.absolutePath,
                                error = null,
                            )
                        }
                    } else {
                        _editor.update {
                            it.copy(
                                converting = false,
                                status = "Conversion failed.",
                                lastLog = compile.log,
                                error = "Conversion failed. Check the log.",
                            )
                        }
                    }
                },
                onFailure = { error ->
                    _editor.update {
                        it.copy(
                            converting = false,
                            status = "Conversion failed.",
                            error = error.message ?: "Conversion failed.",
                            lastLog = error.message.orEmpty(),
                        )
                    }
                },
            )
            refreshProjects()
        }
    }

    fun pdfFile(): File? {
        val path = _editor.value.pdfPath ?: return null
        return File(path).takeIf { it.exists() }
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
