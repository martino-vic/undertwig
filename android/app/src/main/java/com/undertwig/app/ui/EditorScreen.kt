package com.undertwig.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditorScreen(
    state: EditorUiState,
    onBack: () -> Unit,
    onSelectFile: (String) -> Unit,
    onEditorChange: (String) -> Unit,
    onSave: () -> Unit,
    onConvert: () -> Unit,
    onOpenPdf: () -> Unit,
    onAddFile: (String) -> Unit,
    onDeletePath: (path: String, isFolder: Boolean) -> Unit,
    onRenamePath: (from: String, to: String, isFolder: Boolean) -> Unit,
) {
    var showAdd by remember { mutableStateOf(false) }
    var newFile by remember { mutableStateOf("notes.tex") }
    var showLog by remember { mutableStateOf(false) }
    var actionTarget by remember { mutableStateOf<FileBrowserTarget?>(null) }
    var renameTarget by remember { mutableStateOf<FileBrowserTarget?>(null) }
    var renameValue by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<FileBrowserTarget?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(state.projectName)
                        Text(
                            state.status,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { showAdd = true }) {
                        Icon(Icons.Default.Add, contentDescription = "Add file")
                    }
                    IconButton(onClick = onSave) {
                        Icon(Icons.Default.Save, contentDescription = "Save")
                    }
                    if (state.pdfPath != null) {
                        IconButton(onClick = onOpenPdf) {
                            Icon(Icons.Default.PictureAsPdf, contentDescription = "PDF")
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
                    activePath = state.activePath,
                    onSelectFile = onSelectFile,
                    onLongPressTarget = { actionTarget = it },
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
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
            )

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Button(
                    onClick = onConvert,
                    enabled = !state.converting,
                    modifier = Modifier.weight(1f),
                ) {
                    if (state.converting) {
                        CircularProgressIndicator(
                            modifier = Modifier
                                .height(18.dp)
                                .width(18.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("Converting…")
                    } else {
                        Text("Convert")
                    }
                }
                OutlinedButton(
                    onClick = { showLog = true },
                    enabled = state.lastLog.isNotBlank(),
                ) {
                    Text("Log")
                }
                if (state.pdfPath != null) {
                    OutlinedButton(onClick = onOpenPdf) { Text("PDF") }
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

    if (showAdd) {
        AlertDialog(
            onDismissRequest = { showAdd = false },
            title = { Text("New file") },
            text = {
                OutlinedTextField(
                    value = newFile,
                    onValueChange = { newFile = it },
                    singleLine = true,
                    label = { Text("Path") },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onAddFile(newFile)
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
        AlertDialog(
            onDismissRequest = { showLog = false },
            title = { Text("Compiler log") },
            text = {
                Text(
                    state.lastLog.ifBlank { "No log yet." },
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = {
                TextButton(onClick = { showLog = false }) { Text("Close") }
            },
        )
    }
}
