package com.undertwig.app.ui

import android.app.Activity
import android.app.Application
import android.widget.Toast
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.undertwig.app.data.AuthRepository
import com.undertwig.app.data.AuthUser
import com.undertwig.app.data.BibToolId
import com.undertwig.app.data.DriveSyncRepository
import com.undertwig.app.data.EnginePrefs
import com.undertwig.app.data.HomeProjectItem
import com.undertwig.app.data.LatexEngineId
import com.undertwig.app.data.ProjectDownloadInfo
import com.undertwig.app.data.ProjectFile
import com.undertwig.app.data.ProjectOrigin
import com.undertwig.app.data.ProjectRepository
import com.undertwig.app.data.ProjectSummary
import com.undertwig.app.engine.LatexEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import kotlin.coroutines.coroutineContext

data class HomeUiState(
    val projects: List<HomeProjectItem> = emptyList(),
    val cloudLoading: Boolean = false,
    val openingKey: String? = null,
    val cloudError: String? = null,
)

data class AuthUiState(
    val user: AuthUser? = null,
    val signingIn: Boolean = false,
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
    val loadingFile: Boolean = false,
    val lastLog: String = "",
    val pdfPath: String? = null,
    /** Increments on each successful Convert so PdfScreen reloads overwritten main.pdf. */
    val pdfRevision: Long = 0L,
    /** Bumped when disk content replaces the editor buffer (e.g. Load from Drive). */
    val editorRevision: Long = 0L,
    /** Project-relative PDF currently shown in the full-screen viewer (any tree PDF). */
    val previewPdfRelativePath: String? = null,
    val latexEngine: LatexEngineId = LatexEngineId.PdfLaTeX,
    val bibTool: BibToolId = BibToolId.BibTeX,
    val error: String? = null,
) {
    val converting: Boolean get() = busy != EditorBusy.Idle
}

class UndertwigViewModel(application: Application) : AndroidViewModel(application) {
    private val repo = ProjectRepository(application)
    private val enginePrefs = EnginePrefs(application)
    private val authRepo = AuthRepository(application)
    private val driveSync = DriveSyncRepository(application, repo)
    private val engine = LatexEngine()
    private var busyJob: Job? = null
    private var statusTickerJob: Job? = null
    private var statusFlashJob: Job? = null
    private var saveJob: Job? = null
    private var loadFileJob: Job? = null
    private var cloudJob: Job? = null
    private var openCloudJob: Job? = null
    @Volatile private var latestBusyStatus: String? = null
    @Volatile private var busyStatusStartedAtMs: Long = 0L
    private var cachedDriveOwned: List<com.undertwig.app.data.DriveRemoteProject> = emptyList()
    private var cachedDriveInvited: List<com.undertwig.app.data.DriveRemoteProject> = emptyList()

    private val _home = MutableStateFlow(HomeUiState())
    val home: StateFlow<HomeUiState> = _home.asStateFlow()

    private val _auth = MutableStateFlow(AuthUiState(user = authRepo.currentUser()))
    val auth: StateFlow<AuthUiState> = _auth.asStateFlow()

    private val _editor = MutableStateFlow(
        EditorUiState(
            latexEngine = enginePrefs.latexEngine(),
            bibTool = enginePrefs.bibTool(),
        ),
    )
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

    fun signInWithGoogle(activity: Activity) {
        if (_auth.value.signingIn) return
        viewModelScope.launch {
            _auth.update { it.copy(signingIn = true) }
            try {
                val user = authRepo.signInWithGoogle(activity)
                _auth.update { AuthUiState(user = user, signingIn = false) }
                _editor.update { it.copy(status = "Logged in") }
                Toast.makeText(
                    getApplication(),
                    "Signed in as ${user.email}",
                    Toast.LENGTH_SHORT,
                ).show()
                refreshCloudProjects(activity)
            } catch (_: AuthRepository.SignInCancelledException) {
                _auth.update { it.copy(signingIn = false) }
            } catch (e: CancellationException) {
                _auth.update { it.copy(signingIn = false) }
                throw e
            } catch (e: Exception) {
                _auth.update { it.copy(signingIn = false) }
                Toast.makeText(
                    getApplication(),
                    e.message ?: "Google Sign-In failed.",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            authRepo.signOut()
            _auth.value = AuthUiState()
            cachedDriveOwned = emptyList()
            cachedDriveInvited = emptyList()
            refreshProjects()
            _editor.update { it.copy(status = "Signed out") }
            Toast.makeText(getApplication(), "Signed out", Toast.LENGTH_SHORT).show()
        }
    }

    fun setLatexEngine(engineId: LatexEngineId) {
        enginePrefs.setLatexEngine(engineId)
        _editor.update {
            it.copy(
                latexEngine = engineId,
                status = "Engine: ${engineId.label}",
            )
        }
    }

    fun setBibTool(toolId: BibToolId) {
        enginePrefs.setBibTool(toolId)
        _editor.update {
            it.copy(
                bibTool = toolId,
                status = "Bib tool: ${toolId.label}",
            )
        }
    }

    fun attachEngine(context: android.content.Context) {
        engine.attach(context)
    }

    fun refreshProjects() {
        _home.update {
            it.copy(
                projects = buildHomeProjects(),
                cloudError = if (_auth.value.user == null) null else it.cloudError,
            )
        }
    }

    fun refreshCloudProjects(activity: Activity) {
        if (_auth.value.user == null) {
            cachedDriveOwned = emptyList()
            cachedDriveInvited = emptyList()
            refreshProjects()
            return
        }
        if (cloudJob?.isActive == true) return
        cloudJob = viewModelScope.launch {
            _home.update { it.copy(cloudLoading = true, cloudError = null) }
            try {
                val email = _auth.value.user?.email
                val (owned, invited) = withDriveAccess(activity) { token ->
                    driveSync.listCloudProjects(token, email)
                }
                cachedDriveOwned = owned
                cachedDriveInvited = invited
                _home.update {
                    it.copy(
                        projects = buildHomeProjects(),
                        cloudLoading = false,
                        cloudError = null,
                    )
                }
            } catch (e: AuthRepository.SignInCancelledException) {
                _home.update {
                    it.copy(
                        cloudLoading = false,
                        projects = buildHomeProjects(),
                    )
                }
            } catch (e: CancellationException) {
                _home.update { it.copy(cloudLoading = false) }
                throw e
            } catch (e: Exception) {
                if (isInvalidDriveCredentials(e)) {
                    authRepo.clearDriveToken()
                }
                _home.update {
                    it.copy(
                        cloudLoading = false,
                        cloudError = e.message ?: "Could not load Google Drive projects.",
                        projects = buildHomeProjects(),
                    )
                }
            }
        }
    }

    fun openHomeProject(item: HomeProjectItem, activity: Activity, onOpened: () -> Unit) {
        val localId = item.localId
        if (localId != null) {
            openProject(localId)
            onOpened()
            return
        }

        val folderId = item.driveFolderId
        if (folderId.isNullOrBlank()) return
        if (openCloudJob?.isActive == true) return
        openCloudJob = viewModelScope.launch {
            _home.update { it.copy(openingKey = item.key) }
            try {
                val role = when (item.origin) {
                    ProjectOrigin.Invited -> "writer"
                    ProjectOrigin.Drive, ProjectOrigin.Local -> "owner"
                }
                val id = withDriveAccess(activity) { token ->
                    driveSync.pullProject(
                        accessToken = token,
                        folderId = folderId,
                        projectName = item.name,
                        role = role,
                        ownerEmail = item.ownerEmail,
                    )
                }
                openProject(id)
                refreshCloudProjects(activity)
                _home.update { it.copy(openingKey = null) }
                onOpened()
            } catch (e: AuthRepository.SignInCancelledException) {
                _home.update { it.copy(openingKey = null) }
                Toast.makeText(
                    getApplication(),
                    "Drive permission was cancelled.",
                    Toast.LENGTH_LONG,
                ).show()
            } catch (e: CancellationException) {
                _home.update { it.copy(openingKey = null) }
                throw e
            } catch (e: Exception) {
                if (isInvalidDriveCredentials(e)) {
                    authRepo.clearDriveToken()
                }
                _home.update { it.copy(openingKey = null) }
                Toast.makeText(
                    getApplication(),
                    e.message ?: "Could not open Drive project.",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    private fun buildHomeProjects(): List<HomeProjectItem> {
        val local = repo.listProjects()
        val items = mutableListOf<HomeProjectItem>()
        val localFolderIds = local.mapNotNull { it.driveFolderId }.toSet()
        val localNamesLower = local.map { it.name.trim().lowercase() }.toSet()

        for (project in local) {
            val role = project.driveRole?.lowercase()
            val origin = when {
                role == "writer" || role == "reader" -> ProjectOrigin.Invited
                else -> ProjectOrigin.Local
            }
            items += HomeProjectItem(
                key = "local:${project.id}",
                name = project.name,
                updatedAt = project.updatedAt,
                origin = origin,
                localId = project.id,
                driveFolderId = project.driveFolderId,
                ownerEmail = project.ownerEmail,
            )
        }

        for (remote in cachedDriveOwned) {
            if (remote.folderId in localFolderIds) continue
            if (remote.name.trim().lowercase() in localNamesLower) continue
            items += HomeProjectItem(
                key = "drive:${remote.folderId}",
                name = remote.name,
                updatedAt = remote.modifiedTimeMs,
                origin = ProjectOrigin.Drive,
                localId = null,
                driveFolderId = remote.folderId,
                ownerEmail = remote.ownerEmail,
            )
        }

        for (remote in cachedDriveInvited) {
            if (remote.folderId in localFolderIds) continue
            // Already shown as local invited mirror.
            if (items.any {
                    it.origin == ProjectOrigin.Invited &&
                        (it.driveFolderId == remote.folderId ||
                            it.name.trim().equals(remote.name.trim(), ignoreCase = true))
                }
            ) {
                continue
            }
            items += HomeProjectItem(
                key = "invite:${remote.folderId}",
                name = remote.name,
                updatedAt = remote.modifiedTimeMs,
                origin = ProjectOrigin.Invited,
                localId = null,
                driveFolderId = remote.folderId,
                ownerEmail = remote.ownerEmail,
            )
        }

        return items.sortedByDescending { it.updatedAt }
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
            latexEngine = enginePrefs.latexEngine(),
            bibTool = enginePrefs.bibTool(),
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

    fun saveActive(activity: Activity) {
        val state = _editor.value
        if (state.projectId.isEmpty()) {
            _editor.update {
                it.copy(status = "Nothing to save", error = "Open a project first.")
            }
            return
        }
        if (ProjectRepository.isBinaryPath(state.activePath)) {
            _editor.update {
                it.copy(
                    status = "Can’t save binary here",
                    error = "Open a text file to save edits.",
                )
            }
            return
        }
        if (saveJob?.isActive == true) return

        val path = state.activePath.ifBlank { "main.tex" }
        val where = "${state.projectName}/$path"
        val projectId = state.projectId
        val projectName = state.projectName
        val loggedIn = _auth.value.user != null

        runCatching {
            repo.writeFile(projectId, path, state.editorText)
            val written = repo.readFile(projectId, path)
            check(!written.binary && written.content == state.editorText) {
                "Saved file could not be verified."
            }
        }.fold(
            onSuccess = {
                _editor.update {
                    it.copy(
                        dirty = false,
                        error = null,
                        files = repo.listFiles(projectId),
                        folders = repo.listFolders(projectId),
                    )
                }
                refreshProjects()

                if (!loggedIn) {
                    flashStatus("Saved successfully")
                    Toast.makeText(
                        getApplication(),
                        "Saved successfully to this app",
                        Toast.LENGTH_SHORT,
                    ).show()
                    return@fold
                }

                saveJob = viewModelScope.launch {
                    _editor.update { it.copy(status = "Saving to Drive…") }
                    try {
                        withDriveAccess(activity) { token ->
                            driveSync.uploadProject(token, projectId, projectName)
                        }
                        flashStatus("Saved successfully")
                    } catch (e: AuthRepository.SignInCancelledException) {
                        flashStatus("Saved locally")
                        Toast.makeText(
                            getApplication(),
                            "Saved on this device. Drive permission was cancelled.",
                            Toast.LENGTH_LONG,
                        ).show()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        if (isInvalidDriveCredentials(e)) {
                            authRepo.clearDriveToken()
                        }
                        _editor.update {
                            it.copy(
                                status = "Drive save failed",
                                error = e.message ?: "Could not save to Google Drive.",
                            )
                        }
                        Toast.makeText(
                            getApplication(),
                            "Saved on this device, but Drive failed: ${e.message ?: "unknown error"}",
                            Toast.LENGTH_LONG,
                        ).show()
                        delay(STATUS_FLASH_MS)
                        if (_editor.value.status == "Drive save failed") {
                            restoreEditingStatus()
                        }
                    }
                }
            },
            onFailure = { error ->
                val detail = error.message ?: "Could not save $where."
                _editor.update {
                    it.copy(
                        status = "Save failed",
                        error = detail,
                    )
                }
                Toast.makeText(getApplication(), "Save failed: $detail", Toast.LENGTH_LONG).show()
            },
        )
    }

    /**
     * Load the current project from Google Drive into the local tree (desktop "Load").
     * While in flight, call again or [cancelLoadFromDrive] to abort.
     */
    fun loadProjectFromDrive(activity: Activity) {
        if (loadFileJob?.isActive == true) {
            cancelLoadFromDrive()
            return
        }
        val state = _editor.value
        if (state.projectId.isEmpty()) {
            _editor.update {
                it.copy(status = "Nothing to load", error = "Open a project first.")
            }
            return
        }
        if (_auth.value.user == null) {
            Toast.makeText(
                getApplication(),
                "Log in to load from Google Drive.",
                Toast.LENGTH_SHORT,
            ).show()
            return
        }

        val projectId = state.projectId
        val projectName = state.projectName
        val previousActive = state.activePath

        // Flush unsaved text before replacing local files (same as desktop).
        if (state.dirty && !ProjectRepository.isBinaryPath(state.activePath)) {
            runCatching {
                repo.writeFile(projectId, state.activePath, state.editorText)
            }
        }

        loadFileJob = viewModelScope.launch {
            _editor.update {
                it.copy(
                    loadingFile = true,
                    status = "Loading “$projectName” from Google Drive…",
                    error = null,
                )
            }
            try {
                val fileCount = withDriveAccess(activity) { token ->
                    driveSync.syncProjectFromDrive(token, projectId, projectName)
                }
                val files = repo.listFiles(projectId)
                val folders = repo.listFolders(projectId)
                val active = when {
                    previousActive.isNotBlank() && previousActive in files -> previousActive
                    "main.tex" in files -> "main.tex"
                    else -> files.firstOrNull().orEmpty()
                }
                val loadedText = if (active.isNotEmpty()) {
                    editorDisplayText(repo.readFile(projectId, active))
                } else {
                    ""
                }
                val loadedMessage =
                    "Loaded “$projectName” from Google Drive (" +
                        "$fileCount file${if (fileCount == 1) "" else "s"})."
                statusFlashJob?.cancel()
                _editor.update {
                    it.copy(
                        projectName = repo.projectName(projectId),
                        files = files,
                        folders = folders,
                        activePath = active,
                        editorText = loadedText,
                        dirty = false,
                        loadingFile = false,
                        error = null,
                        status = loadedMessage,
                        editorRevision = it.editorRevision + 1L,
                        pdfPath = repo.existingFile(projectId, "main.pdf")?.absolutePath,
                    )
                }
                refreshProjects()
            } catch (e: AuthRepository.SignInCancelledException) {
                _editor.update { it.copy(loadingFile = false) }
                Toast.makeText(
                    getApplication(),
                    "Drive permission was cancelled.",
                    Toast.LENGTH_LONG,
                ).show()
                restoreEditingStatus()
            } catch (e: CancellationException) {
                _editor.update {
                    it.copy(
                        loadingFile = false,
                        status = "Load cancelled.",
                        error = null,
                    )
                }
                // Job is already cancelling — don't delay (it would throw again).
            } catch (e: Exception) {
                if (isInvalidDriveCredentials(e)) {
                    authRepo.clearDriveToken()
                }
                _editor.update {
                    it.copy(
                        loadingFile = false,
                        status = "Load failed",
                        error = e.message ?: "Could not load from Google Drive.",
                    )
                }
                Toast.makeText(
                    getApplication(),
                    e.message ?: "Could not load from Google Drive.",
                    Toast.LENGTH_LONG,
                ).show()
                delay(STATUS_FLASH_MS)
                if (_editor.value.status == "Load failed") {
                    restoreEditingStatus()
                }
            }
        }
    }

    fun cancelLoadFromDrive() {
        val job = loadFileJob ?: return
        if (!job.isActive) return
        _editor.update {
            it.copy(status = "Cancelling…", error = null)
        }
        job.cancel()
    }

    private fun flashStatus(message: String) {
        statusFlashJob?.cancel()
        _editor.update { it.copy(status = message, error = null) }
        statusFlashJob = viewModelScope.launch {
            delay(STATUS_FLASH_MS)
            if (_editor.value.status == message) {
                restoreEditingStatus()
            }
        }
    }

    private fun isInvalidDriveCredentials(error: Throwable): Boolean {
        if (error is AuthRepository.InvalidDriveCredentialsException) return true
        return AuthRepository.isInvalidCredentialsMessage(error.message)
    }

    /**
     * Run a Drive API call with an access token. If Drive rejects the token, drop the local
     * cache and authorize once more — same simple Identity.authorize() path as before.
     */
    private suspend fun <T> withDriveAccess(activity: Activity, block: suspend (String) -> T): T {
        val firstToken = authRepo.ensureDriveAccessToken(activity, forceRefresh = false)
        return try {
            block(firstToken)
        } catch (e: Exception) {
            if (e is CancellationException || e is AuthRepository.SignInCancelledException) {
                throw e
            }
            if (!isInvalidDriveCredentials(e)) {
                throw e
            }
            val freshToken = authRepo.ensureDriveAccessToken(activity, forceRefresh = true)
            block(freshToken)
        }
    }

    private fun restoreEditingStatus() {
        val path = _editor.value.activePath
        _editor.update {
            it.copy(
                status = when {
                    path.isNotBlank() -> "Editing $path"
                    else -> "Ready."
                },
            )
        }
    }

    fun projectDownloadInfo(): ProjectDownloadInfo? {
        val id = _editor.value.projectId
        if (id.isEmpty()) return null
        // Persist unsaved edits so the zip matches what you see.
        val state = _editor.value
        if (state.dirty && !ProjectRepository.isBinaryPath(state.activePath)) {
            runCatching {
                repo.writeFile(state.projectId, state.activePath, state.editorText)
                _editor.update { it.copy(dirty = false) }
            }
        }
        return runCatching { repo.projectDownloadInfo(id) }.getOrNull()
    }

    fun exportProjectZip(): Result<File> {
        val id = _editor.value.projectId
        if (id.isEmpty()) {
            return Result.failure(IllegalStateException("Open a project first."))
        }
        val state = _editor.value
        if (state.dirty && !ProjectRepository.isBinaryPath(state.activePath)) {
            runCatching {
                repo.writeFile(state.projectId, state.activePath, state.editorText)
                _editor.update { it.copy(dirty = false) }
            }
        }
        return runCatching {
            val zip = repo.zipProject(id)
            _editor.update {
                it.copy(
                    status = "Project zip ready",
                    error = null,
                )
            }
            zip
        }
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
                val engineId = _editor.value.latexEngine
                startThrottledStatus("Convert: starting…")
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Convert,
                        status = "Convert: starting…",
                        error = null,
                        dirty = false,
                    )
                }
                val files = repo.filesForCompile(state.projectId).mapValues { (_, file) ->
                    file.content to file.binary
                }
                val compile = engine.compile(files, engineId.id) { message ->
                    noteBusyStatus(tidyConvertStatus(message))
                }
                stopThrottledStatus()
                if (compile.ok && compile.pdfBytes != null) {
                    val pdf = repo.savePdf(state.projectId, compile.pdfBytes)
                    _editor.update {
                        it.copy(
                            busy = EditorBusy.Idle,
                            status = "PDF ready",
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
                            status = "Convert failed",
                            lastLog = compile.log,
                            error = "Conversion failed. Check the log.",
                        )
                    }
                }
            } catch (_: CancellationException) {
                stopThrottledStatus()
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = "Convert cancelled",
                        error = null,
                    )
                }
            } catch (error: Exception) {
                stopThrottledStatus()
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = "Convert failed",
                        error = error.message ?: "Conversion failed.",
                        lastLog = error.message.orEmpty(),
                    )
                }
            } finally {
                stopThrottledStatus()
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
                val toolId = _editor.value.bibTool
                startThrottledStatus("Bib: starting…")
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Bibliography,
                        status = "Bib: starting…",
                        error = null,
                        dirty = false,
                    )
                }
                val files = repo.filesForCompile(state.projectId).mapValues { (_, file) ->
                    file.content to file.binary
                }
                val bib = engine.runBibliography(files, toolId.id) { message ->
                    noteBusyStatus(tidyBibStatus(message))
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
                stopThrottledStatus()
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = if (bib.ok) {
                            "Bib done — convert again"
                        } else {
                            "Bib failed"
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
                stopThrottledStatus()
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = "Bib cancelled",
                        error = null,
                    )
                }
            } catch (error: Exception) {
                stopThrottledStatus()
                _editor.update {
                    it.copy(
                        busy = EditorBusy.Idle,
                        status = "Bib failed",
                        error = error.message ?: "Bibliography failed.",
                        lastLog = error.message.orEmpty(),
                    )
                }
            } finally {
                stopThrottledStatus()
                if (busyJob === coroutineContext[Job]) {
                    busyJob = null
                }
                refreshProjects()
            }
        }
    }

    fun cancelBusy() {
        if (_editor.value.busy == EditorBusy.Idle) return
        stopThrottledStatus()
        _editor.update { it.copy(status = "Cancelling…") }
        engine.cancelCurrentWork()
        busyJob?.cancel()
        busyJob = null
    }

    /**
     * One short status line during Convert/Bib: map noisy worker logs to compact
     * phase labels, paint phase changes immediately, and refresh about every 10s
     * with elapsed time so the top-bar subtitle stays fully readable.
     */
    private fun startThrottledStatus(initial: String) {
        stopThrottledStatus()
        latestBusyStatus = initial
        busyStatusStartedAtMs = System.currentTimeMillis()
        statusTickerJob = viewModelScope.launch {
            while (isActive) {
                delay(STATUS_TICK_MS)
                val message = latestBusyStatus ?: continue
                if (_editor.value.busy == EditorBusy.Idle) break
                _editor.update { ui -> ui.copy(status = withElapsed(message)) }
            }
        }
    }

    private fun noteBusyStatus(message: String) {
        val cleaned = message.replace(Regex("\\s+"), " ").trim()
        if (cleaned.isEmpty()) return
        val previous = latestBusyStatus
        latestBusyStatus = cleaned
        if (previous != cleaned && _editor.value.busy != EditorBusy.Idle) {
            _editor.update { ui -> ui.copy(status = withElapsed(cleaned)) }
        }
    }

    private fun stopThrottledStatus() {
        statusTickerJob?.cancel()
        statusTickerJob = null
        latestBusyStatus = null
        busyStatusStartedAtMs = 0L
    }

    private fun withElapsed(message: String): String {
        val started = busyStatusStartedAtMs
        if (started <= 0L) return message
        val elapsedSec = ((System.currentTimeMillis() - started) / 1000L).toInt()
        return if (elapsedSec >= 10) "$message · ${elapsedSec}s" else message
    }

    private fun tidyConvertStatus(raw: String): String {
        val text = raw.replace(Regex("\\s+"), " ").trim()
        val pass = Regex("""pass\s+(\d+)\s*/\s*(\d+)""", RegexOption.IGNORE_CASE)
            .find(text)
        return when {
            pass != null ->
                "Convert: pass ${pass.groupValues[1]}/${pass.groupValues[2]}…"
            text.contains("TeX format", ignoreCase = true) ->
                "Convert: format…"
            text.contains("LuaLaTeX", ignoreCase = true) &&
                text.contains("Downloading", ignoreCase = true) ->
                "Convert: Lua assets…"
            text.contains("Loading pdfLaTeX", ignoreCase = true) ||
                text.contains("Loading LuaLaTeX", ignoreCase = true) ||
                text.contains("Loading", ignoreCase = true) ->
                "Convert: loading…"
            text.contains("Writing", ignoreCase = true) ->
                "Convert: writing…"
            text.contains("Converting", ignoreCase = true) ||
                text.contains("pdfLaTeX", ignoreCase = true) ||
                text.contains("LuaLaTeX", ignoreCase = true) ->
                "Convert: running…"
            text.contains("Downloading", ignoreCase = true) ||
                text.contains("Fetching", ignoreCase = true) ||
                text.contains("package", ignoreCase = true) ->
                "Convert: packages…"
            else -> "Convert: working…"
        }
    }

    private fun tidyBibStatus(raw: String): String {
        val text = raw.replace(Regex("\\s+"), " ").trim()
        return when {
            text.contains("Preparing citation", ignoreCase = true) ||
                text.contains("Preparing Biber", ignoreCase = true) ||
                text.contains("(1/3)") ||
                text.contains("(1/4)") ->
                "Bib: preparing…"
            text.contains("Creating main.aux", ignoreCase = true) ->
                "Bib: creating aux…"
            text.contains("control file", ignoreCase = true) ||
                text.contains("main.bcf", ignoreCase = true) ->
                "Bib: building bcf…"
            text.contains("Downloading", ignoreCase = true) ||
                text.contains("Fetching", ignoreCase = true) ->
                "Bib: downloading…"
            text.contains("Loading", ignoreCase = true) ||
                text.contains("(2/3)") ||
                text.contains("(2/4)") ->
                "Bib: loading…"
            text.contains("Running Biber", ignoreCase = true) ||
                text.contains("(4/4)") ->
                "Bib: running…"
            text.contains("Running BibTeX", ignoreCase = true) ||
                text.contains("(3/3)") ||
                text.contains("(3/4)") ->
                "Bib: running…"
            else -> "Bib: working…"
        }
    }

    companion object {
        private const val STATUS_TICK_MS = 10_000L
        private const val STATUS_FLASH_MS = 2_500L
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
