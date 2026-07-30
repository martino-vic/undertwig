package com.undertwig.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
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

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun EditorScreen(
    state: EditorUiState,
    authUser: AuthUser?,
    signingIn: Boolean,
    onBack: () -> Unit,
    onSelectFile: (String) -> Unit,
    onEditorChange: (String) -> Unit,
    onSave: () -> Unit,
    onLoadFromDrive: () -> Unit,
    onCancelLoadFromDrive: () -> Unit,
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
    onRefreshWritingRoom: () -> Unit = {},
    onWritingRoomClick: () -> Unit = {},
    onConfirmWritingRoomPrompt: () -> Unit = {},
    onDismissWritingRoomPrompt: () -> Unit = {},
    onUnsavedWritingRoomExit: (UnsavedExitChoice) -> Unit = {},
    onWritingRoomActivity: () -> Unit = {},
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

    LaunchedEffect(state.projectId, state.activePath, authUser?.email) {
        onRefreshWritingRoom()
    }

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
    var overflowOpen by remember { mutableStateOf(false) }
    val imeVisible = WindowInsets.isImeVisible
    val editorScroll = rememberScrollState()
    val editorScope = rememberCoroutineScope()
    val bringCursorIntoView = remember { BringIntoViewRequester() }
    var editorLayout by remember { mutableStateOf<TextLayoutResult?>(null) }
    var textFieldValue by remember(state.projectId, state.activePath, state.editorRevision) {
        mutableStateOf(TextFieldValue(state.editorText, TextRange(0)))
    }
    val darkEditor = isSystemInDarkTheme()
    val texHighlight = remember(state.activePath, darkEditor, state.editorRevision) {
        if (isHighlightableTexPath(state.activePath)) {
            TexVisualTransformation(darkEditor)
        } else {
            VisualTransformation.None
        }
    }

    fun scrollCursorAboveKeyboard(layout: TextLayoutResult) {
        val original = textFieldValue.selection.max.coerceIn(0, textFieldValue.text.length)
        val transformed = texHighlight.filter(AnnotatedString(textFieldValue.text))
        val mapped = transformed.offsetMapping
            .originalToTransformed(original)
            .coerceIn(0, layout.layoutInput.text.length)
        val cursor = layout.getCursorRect(mapped)
        // Extra space below the caret so the keyboard does not cover the line being typed.
        val target = Rect(
            left = cursor.left,
            top = cursor.top,
            right = cursor.right.coerceAtLeast(cursor.left + 1f),
            bottom = cursor.bottom + 96f,
        )
        editorScope.launch {
            bringCursorIntoView.bringIntoView(target)
        }
    }

    LaunchedEffect(imeVisible, textFieldValue.selection, textFieldValue.text.length) {
        if (!imeVisible) return@LaunchedEffect
        delay(60)
        editorLayout?.let { scrollCursorAboveKeyboard(it) }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        modifier = Modifier
            .fillMaxSize()
            .imePadding()
            .pointerInput(state.inWritingRoom) {
                if (!state.inWritingRoom) return@pointerInput
                awaitPointerEventScope {
                    while (true) {
                        awaitPointerEvent()
                        onWritingRoomActivity()
                    }
                }
            },
        topBar = {
            Surface(tonalElevation = 2.dp) {
                Column(modifier = Modifier.windowInsetsPadding(WindowInsets.statusBars)) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(56.dp)
                            .padding(horizontal = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .padding(horizontal = 6.dp),
                        ) {
                            Text(
                                state.projectName,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.titleMedium,
                            )
                        }
                        IconButton(onClick = onSave) {
                            Icon(Icons.Default.Save, contentDescription = "Save")
                        }
                        if (authUser != null) {
                            if (state.loadingFile) {
                                TextButton(onClick = onCancelLoadFromDrive) {
                                    Text("Cancel")
                                }
                            } else {
                                IconButton(onClick = onLoadFromDrive) {
                                    Icon(
                                        Icons.Default.Refresh,
                                        contentDescription = "Load current project from Google Drive",
                                    )
                                }
                            }
                        }
                        Box {
                            IconButton(onClick = { overflowOpen = true }) {
                                Icon(Icons.Default.MoreVert, contentDescription = "More")
                            }
                            DropdownMenu(
                                expanded = overflowOpen,
                                onDismissRequest = { overflowOpen = false },
                            ) {
                                DropdownMenuItem(
                                    text = { Text("New file / folder") },
                                    onClick = {
                                        overflowOpen = false
                                        addIsFolder = false
                                        newName = "notes.tex"
                                        showAdd = true
                                    },
                                    leadingIcon = {
                                        Icon(Icons.Default.Add, contentDescription = null)
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("Download project") },
                                    onClick = {
                                        overflowOpen = false
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
                                    leadingIcon = {
                                        Icon(Icons.Default.Download, contentDescription = null)
                                    },
                                )
                                if (authUser != null) {
                                    DropdownMenuItem(
                                        text = { Text("Account") },
                                        onClick = {
                                            overflowOpen = false
                                            showAccount = true
                                        },
                                        leadingIcon = {
                                            Icon(Icons.Default.AccountCircle, contentDescription = null)
                                        },
                                    )
                                } else {
                                    DropdownMenuItem(
                                        text = { Text(if (signingIn) "Signing in…" else "Log in") },
                                        onClick = {
                                            overflowOpen = false
                                            onLogin()
                                        },
                                        enabled = !signingIn,
                                        leadingIcon = {
                                            Icon(Icons.Default.AccountCircle, contentDescription = null)
                                        },
                                    )
                                }
                            }
                        }
                    }
                    if (state.writingRoomAvailable) {
                        TextButton(
                            onClick = onWritingRoomClick,
                            enabled = !state.writingRoomBusy,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 0.dp),
                        ) {
                            Text(
                                if (state.inWritingRoom) {
                                    "Exit writing room"
                                } else {
                                    "Enter writing room"
                                },
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .windowInsetsPadding(WindowInsets.navigationBars),
        ) {
            if (!imeVisible) {
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
            }

            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .pointerInput(state.inWritingRoom) {
                        if (!state.inWritingRoom) return@pointerInput
                        awaitPointerEventScope {
                            while (true) {
                                awaitPointerEvent()
                                onWritingRoomActivity()
                            }
                        }
                    },
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(editorScroll)
                        .padding(horizontal = 12.dp)
                        .padding(bottom = if (imeVisible) 48.dp else 0.dp),
                ) {
                    key(state.projectId, state.activePath, state.editorRevision) {
                        BasicTextField(
                            value = textFieldValue,
                            onValueChange = { next ->
                                textFieldValue = next
                                onEditorChange(next.text)
                            },
                            readOnly = state.editorReadOnly,
                            onTextLayout = { layout ->
                                editorLayout = layout
                                if (imeVisible) {
                                    scrollCursorAboveKeyboard(layout)
                                }
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .defaultMinSize(minHeight = 240.dp)
                                .bringIntoViewRequester(bringCursorIntoView),
                            textStyle = TextStyle(
                                color = MaterialTheme.colorScheme.onBackground,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 14.sp,
                                lineHeight = 20.sp,
                            ),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            visualTransformation = texHighlight,
                        )
                    }
                }
            }

            if (!imeVisible) {
                state.writingRoomOccupiedMessage?.let {
                    Text(
                        "Room occupied",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }

                Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 10.dp, vertical = 10.dp)
                            .padding(bottom = 4.dp),
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

                    state.error?.let { err ->
                        Text(
                            err,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                        )
                    }
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
            text = {
                Text(
                    if (target.isFolder) {
                        "Delete or rename this folder?"
                    } else {
                        "Delete or rename this file?"
                    },
                )
            },
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

    when (val prompt = state.writingRoomPrompt) {
        is WritingRoomPrompt.Enter -> {
            AlertDialog(
                onDismissRequest = onDismissWritingRoomPrompt,
                properties = androidx.compose.ui.window.DialogProperties(
                    dismissOnBackPress = true,
                    dismissOnClickOutside = false,
                ),
                title = { Text("Enter writing room") },
                text = {
                    Text(
                        "The writing room has space for only one person at a time. Cross this door to enter it. While you are inside, collaborators have to stay out. Exit when you are done (or close the tab) to allow others to enter again.",
                    )
                },
                confirmButton = {
                    TextButton(onClick = onConfirmWritingRoomPrompt) { Text("Enter writing room") }
                },
                dismissButton = {
                    TextButton(onClick = onDismissWritingRoomPrompt) { Text("View only") }
                },
            )
        }
        is WritingRoomPrompt.Exit -> {
            AlertDialog(
                onDismissRequest = onDismissWritingRoomPrompt,
                title = { Text("Exit writing room?") },
                text = {
                    Text(
                        "Leave the writing room for “${prompt.projectName}”? Others will be able to enter and edit this project.",
                    )
                },
                confirmButton = {
                    TextButton(onClick = onConfirmWritingRoomPrompt) { Text("Exit writing room") }
                },
                dismissButton = {
                    TextButton(onClick = onDismissWritingRoomPrompt) { Text("Stay") }
                },
            )
        }
        is WritingRoomPrompt.ExitUnsaved -> {
            AlertDialog(
                onDismissRequest = onDismissWritingRoomPrompt,
                title = { Text("Unsaved changes") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            "You have unsaved changes. Would you like to save them to the cloud, save a copy to your local drawer, or discard them?",
                        )
                        TextButton(
                            onClick = { onUnsavedWritingRoomExit(UnsavedExitChoice.SaveCloud) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Save to cloud")
                        }
                        TextButton(
                            onClick = { onUnsavedWritingRoomExit(UnsavedExitChoice.SaveLocalCopy) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Save a local copy")
                        }
                        TextButton(
                            onClick = { onUnsavedWritingRoomExit(UnsavedExitChoice.Discard) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Discard")
                        }
                    }
                },
                confirmButton = {},
                dismissButton = {
                    TextButton(onClick = onDismissWritingRoomPrompt) { Text("Stay") }
                },
            )
        }
        is WritingRoomPrompt.IdleExit -> {
            var remainingSec by remember(prompt) {
                mutableIntStateOf(
                    (UndertwigViewModel.WRITING_ROOM_IDLE_AUTO_EXIT_MS / 1000L).toInt(),
                )
            }
            LaunchedEffect(prompt) {
                while (remainingSec > 0) {
                    delay(1000)
                    remainingSec -= 1
                }
                onConfirmWritingRoomPrompt()
            }
            val mins = remainingSec / 60
            val secs = remainingSec % 60
            val countdown = "$mins:" + secs.toString().padStart(2, '0')
            AlertDialog(
                onDismissRequest = onDismissWritingRoomPrompt,
                title = { Text("Still in the writing room?") },
                text = {
                    val minutes = prompt.minutes
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            "You've been inactive for $minutes minute${if (minutes == 1) "" else "s"}. Would you like to exit the writing room so others can edit “${prompt.projectName}”?",
                        )
                        Text(
                            "Leaving automatically in $countdown if you don’t respond.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f),
                        )
                    }
                },
                confirmButton = {
                    TextButton(onClick = onConfirmWritingRoomPrompt) { Text("Exit writing room") }
                },
                dismissButton = {
                    TextButton(onClick = onDismissWritingRoomPrompt) { Text("Stay") }
                },
            )
        }
        is WritingRoomPrompt.Occupied -> {
            AlertDialog(
                onDismissRequest = onDismissWritingRoomPrompt,
                title = { Text("Writing room occupied") },
                text = {
                    Text(prompt.message)
                },
                confirmButton = {
                    TextButton(onClick = onConfirmWritingRoomPrompt) { Text("OK") }
                },
            )
        }
        null -> Unit
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

