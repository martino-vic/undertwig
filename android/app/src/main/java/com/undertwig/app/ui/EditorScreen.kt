package com.undertwig.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.undertwig.app.data.AuthUser
import com.undertwig.app.data.BibToolId
import com.undertwig.app.data.LatexEngineId
import com.undertwig.app.data.ProjectDownloadInfo
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditorScreen(
    state: EditorUiState,
    authUser: AuthUser?,
    signingIn: Boolean,
    onBack: () -> Unit,
    onSelectFile: (String) -> Unit,
    onEditorChange: (String) -> Unit,
    onSave: () -> Unit,
    onConvert: () -> Unit,
    onBibliography: () -> Unit,
    onCancelBusy: () -> Unit,
    onOpenPdf: () -> Unit,
    onLogin: () -> Unit,
    onLogout: () -> Unit,
    onSelectLatexEngine: (LatexEngineId) -> Unit,
    onSelectBibTool: (BibToolId) -> Unit,
    onPrepareDownload: () -> ProjectDownloadInfo?,
    onExportZip: () -> Result<File>,
    onAddFile: (String) -> Unit,
    onAddFolder: (String) -> Unit,
    onDeletePath: (path: String, isFolder: Boolean) -> Unit,
    onRenamePath: (from: String, to: String, isFolder: Boolean) -> Unit,
) {
    val context = LocalContext.current
    var showAdd by remember { mutableStateOf(false) }
    var showAccount by remember { mutableStateOf(false) }
    var addIsFolder by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("notes.tex") }
    var showLog by remember { mutableStateOf(false) }
    var showEnginePicker by remember { mutableStateOf(false) }
    var showBibPicker by remember { mutableStateOf(false) }
    var downloadInfo by remember { mutableStateOf<ProjectDownloadInfo?>(null) }
    var actionTarget by remember { mutableStateOf<FileBrowserTarget?>(null) }
    var renameTarget by remember { mutableStateOf<FileBrowserTarget?>(null) }
    var renameValue by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<FileBrowserTarget?>(null) }

    fun runProjectDownload() {
        val export = onExportZip()
        export.fold(
            onSuccess = { zip ->
                val ok = downloadToDownloads(
                    context = context,
                    source = zip,
                    mimeType = "application/zip",
                    displayName = zip.name,
                    failureLabel = "Could not download project zip.",
                )
                if (ok) {
                    downloadInfo = null
                }
            },
            onFailure = { error ->
                Toast.makeText(
                    context,
                    error.message ?: "Could not create project zip.",
                    Toast.LENGTH_LONG,
                ).show()
            },
        )
    }

    val storagePermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            runProjectDownload()
        } else {
            Toast.makeText(context, "Storage permission is required to download.", Toast.LENGTH_SHORT)
                .show()
        }
    }

    fun confirmProjectDownload() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            runProjectDownload()
            return
        }
        val permission = Manifest.permission.WRITE_EXTERNAL_STORAGE
        val granted = ContextCompat.checkSelfPermission(context, permission) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            runProjectDownload()
        } else {
            storagePermissionLauncher.launch(permission)
        }
    }
    var browserDir by remember(state.projectId) {
        mutableStateOf(parentDirOf(state.activePath))
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            state.projectName,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            state.status,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(
                        onClick = {
                            addIsFolder = false
                            newName = "notes.tex"
                            showAdd = true
                        },
                    ) {
                        Icon(Icons.Default.Add, contentDescription = "Add file or folder")
                    }
                    IconButton(onClick = onSave) {
                        Icon(Icons.Default.Save, contentDescription = "Save")
                    }
                    IconButton(
                        onClick = {
                            val info = onPrepareDownload()
                            if (info == null) {
                                Toast.makeText(
                                    context,
                                    "Open a project to download.",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            } else {
                                downloadInfo = info
                            }
                        },
                    ) {
                        Icon(Icons.Default.Download, contentDescription = "Download project")
                    }
                    if (authUser != null) {
                        IconButton(onClick = { showAccount = true }) {
                            Icon(
                                Icons.Default.AccountCircle,
                                contentDescription = "Account ${authUser.email}",
                            )
                        }
                    } else {
                        TextButton(
                            onClick = onLogin,
                            enabled = !signingIn,
                        ) {
                            Text(if (signingIn) "…" else "Log in")
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            key(state.projectId) {
                ProjectFileTree(
                    files = state.files,
                    folders = state.folders,
                    activePath = state.activePath,
                    currentDir = browserDir,
                    onCurrentDirChange = { browserDir = it },
                    onSelectFile = { path ->
                        browserDir = parentDirOf(path)
                        onSelectFile(path)
                    },
                    onLongPressTarget = { actionTarget = it },
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }

            val darkEditor = isSystemInDarkTheme()
            val texHighlight = remember(state.activePath, darkEditor) {
                if (isHighlightableTexPath(state.activePath)) {
                    TexVisualTransformation(darkEditor)
                } else {
                    VisualTransformation.None
                }
            }
            BasicTextField(
                value = state.editorText,
                onValueChange = onEditorChange,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp)
                    .verticalScroll(rememberScrollState()),
                textStyle = TextStyle(
                    color = MaterialTheme.colorScheme.onBackground,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 14.sp,
                    lineHeight = 20.sp,
                ),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                visualTransformation = texHighlight,
            )

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val compactPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp)
                val convertBusy = state.busy == EditorBusy.Convert
                val bibBusy = state.busy == EditorBusy.Bibliography
                ActionButton(
                    onClick = {
                        if (convertBusy) onCancelBusy() else onConvert()
                    },
                    onLongClick = if (!convertBusy && !bibBusy) {
                        { showEnginePicker = true }
                    } else {
                        null
                    },
                    enabled = !bibBusy,
                    contentPadding = compactPadding,
                    expand = true,
                    modifier = Modifier.weight(1f),
                ) {
                    if (convertBusy) {
                        CircularProgressIndicator(
                            modifier = Modifier
                                .height(16.dp)
                                .width(16.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text("Cancel", maxLines = 1)
                    } else {
                        Text("Convert", maxLines = 1)
                    }
                }
                ActionButton(
                    onClick = {
                        if (bibBusy) onCancelBusy() else onBibliography()
                    },
                    onLongClick = if (!convertBusy && !bibBusy) {
                        { showBibPicker = true }
                    } else {
                        null
                    },
                    enabled = !convertBusy,
                    contentPadding = compactPadding,
                    containerColor = Color(0xFFE67E22),
                    contentColor = Color.White,
                    expand = false,
                ) {
                    if (bibBusy) {
                        CircularProgressIndicator(
                            modifier = Modifier
                                .height(16.dp)
                                .width(16.dp),
                            strokeWidth = 2.dp,
                            color = Color.White,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text("Cancel", maxLines = 1)
                    } else {
                        Text("Bib", maxLines = 1)
                    }
                }
                OutlinedButton(
                    onClick = { showLog = true },
                    enabled = state.lastLog.isNotBlank(),
                    contentPadding = compactPadding,
                ) {
                    Text("Log", maxLines = 1)
                }
                if (state.pdfPath != null) {
                    OutlinedButton(
                        onClick = onOpenPdf,
                        contentPadding = compactPadding,
                    ) {
                        Text("PDF", maxLines = 1)
                    }
                }
            }

            state.error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                )
            }
        }
    }

    if (showAccount && authUser != null) {
        AlertDialog(
            onDismissRequest = { showAccount = false },
            title = { Text(authUser.name) },
            text = {
                Text(authUser.email)
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showAccount = false
                        onLogout()
                    },
                ) {
                    Text("Log out")
                }
            },
            dismissButton = {
                TextButton(onClick = { showAccount = false }) {
                    Text("Close")
                }
            },
        )
    }

    if (showAdd) {
        val locationLabel = if (browserDir.isEmpty()) "project root" else "$browserDir/"
        AlertDialog(
            onDismissRequest = { showAdd = false },
            title = { Text("New file or folder") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "Creating in $locationLabel",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = !addIsFolder,
                            onClick = {
                                if (addIsFolder) {
                                    addIsFolder = false
                                    if (newName == "new-folder" || !newName.contains('.')) {
                                        newName = "notes.tex"
                                    }
                                }
                            },
                            label = { Text("File") },
                        )
                        FilterChip(
                            selected = addIsFolder,
                            onClick = {
                                if (!addIsFolder) {
                                    addIsFolder = true
                                    if (newName == "notes.tex" || newName.contains('.')) {
                                        newName = "new-folder"
                                    }
                                }
                            },
                            label = { Text("Folder") },
                        )
                    }
                    OutlinedTextField(
                        value = newName,
                        onValueChange = { newName = it },
                        singleLine = true,
                        label = { Text(if (addIsFolder) "Folder name" else "File name") },
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val name = newName.trim().trimStart('/').trimEnd('/')
                        if (name.isNotEmpty()) {
                            val path = if (browserDir.isEmpty()) name else "$browserDir/$name"
                            if (addIsFolder) {
                                onAddFolder(path)
                            } else {
                                onAddFile(path)
                                browserDir = parentDirOf(path)
                            }
                        }
                        showAdd = false
                    },
                ) { Text("Add") }
            },
            dismissButton = {
                TextButton(onClick = { showAdd = false }) { Text("Cancel") }
            },
        )
    }

    actionTarget?.let { target ->
        val label = if (target.isFolder) "${target.path}/" else target.path
        AlertDialog(
            onDismissRequest = { actionTarget = null },
            title = { Text(label) },
            text = { Text("Delete or rename this ${if (target.isFolder) "folder" else "file"}?") },
            confirmButton = {
                TextButton(
                    onClick = {
                        actionTarget = null
                        renameTarget = target
                        renameValue = target.path
                    },
                ) { Text("Rename") }
            },
            dismissButton = {
                Row {
                    TextButton(
                        onClick = {
                            actionTarget = null
                            deleteTarget = target
                        },
                    ) { Text("Delete") }
                    TextButton(onClick = { actionTarget = null }) { Text("Cancel") }
                }
            },
        )
    }

    renameTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text(if (target.isFolder) "Rename folder" else "Rename file") },
            text = {
                OutlinedTextField(
                    value = renameValue,
                    onValueChange = { renameValue = it },
                    singleLine = true,
                    label = { Text("Path") },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val next = renameValue.trim().trimStart('/')
                        if (next.isNotEmpty() && next != target.path) {
                            onRenamePath(target.path, next, target.isFolder)
                        }
                        renameTarget = null
                    },
                ) { Text("Rename") }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text("Cancel") }
            },
        )
    }

    deleteTarget?.let { target ->
        val label = if (target.isFolder) "${target.path}/" else target.path
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete?") },
            text = {
                Text(
                    if (target.isFolder) {
                        "Delete folder “$label” and everything inside it?"
                    } else {
                        "Delete “$label”?"
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onDeletePath(target.path, target.isFolder)
                        deleteTarget = null
                    },
                ) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("Cancel") }
            },
        )
    }

    if (showLog) {
        val clipboard = LocalClipboardManager.current
        val logText = state.lastLog.ifBlank { "No log yet." }
        AlertDialog(
            onDismissRequest = { showLog = false },
            title = { Text("Compiler log") },
            text = {
                Text(
                    logText,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = {
                TextButton(onClick = { showLog = false }) { Text("Close") }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(logText))
                    },
                ) { Text("Copy") }
            },
        )
    }

    if (showEnginePicker) {
        LatexEnginePickerSheet(
            selected = state.latexEngine,
            onSelect = onSelectLatexEngine,
            onDismiss = { showEnginePicker = false },
        )
    }
    if (showBibPicker) {
        BibToolPickerSheet(
            selected = state.bibTool,
            onSelect = onSelectBibTool,
            onDismiss = { showBibPicker = false },
        )
    }

    downloadInfo?.let { info ->
        AlertDialog(
            onDismissRequest = { downloadInfo = null },
            title = { Text("Download project") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Save “${info.projectName}” as a zip on this phone.")
                    Text("File: ${info.zipFileName}")
                    Text("Files: ${info.fileCount}")
                    Text("Size: ${info.readableSize}")
                    Text(
                        "The zip goes to your Downloads folder.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = { confirmProjectDownload() }) { Text("Download") }
            },
            dismissButton = {
                TextButton(onClick = { downloadInfo = null }) { Text("Cancel") }
            },
        )
    }
}

/**
 * Material-looking action button that supports tap and long-press.
 *
 * [expand] must be true only when the caller gives this a weighted/filled width
 * (e.g. Convert). Wrap-content siblings like Bib must keep [expand] false so
 * they do not steal the whole bottom row.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ActionButton(
    onClick: () -> Unit,
    onLongClick: (() -> Unit)?,
    enabled: Boolean,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    expand: Boolean = false,
    containerColor: Color = MaterialTheme.colorScheme.primary,
    contentColor: Color = MaterialTheme.colorScheme.onPrimary,
    content: @Composable RowScope.() -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val bg = if (enabled) containerColor else containerColor.copy(alpha = 0.38f)
    val fg = if (enabled) contentColor else contentColor.copy(alpha = 0.38f)
    Surface(
        modifier = modifier
            .defaultMinSize(
                minWidth = ButtonDefaults.MinWidth,
                minHeight = ButtonDefaults.MinHeight,
            )
            .widthIn(min = ButtonDefaults.MinWidth)
            .combinedClickable(
                enabled = enabled,
                role = Role.Button,
                interactionSource = interaction,
                indication = ripple(color = fg),
                onClick = onClick,
                onLongClick = onLongClick,
            ),
        shape = ButtonDefaults.shape,
        color = bg,
        contentColor = fg,
        shadowElevation = if (enabled) 1.dp else 0.dp,
    ) {
        ProvideTextStyle(value = MaterialTheme.typography.labelLarge) {
            Row(
                modifier = Modifier
                    .then(if (expand) Modifier.fillMaxWidth() else Modifier)
                    .padding(contentPadding),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
                content = content,
            )
        }
    }
}

