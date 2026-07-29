package com.undertwig.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Parent directory of a relative path, or "" for project root. */
fun parentDirOf(path: String): String {
    val clean = path.trim('/').replace('\\', '/')
    val slash = clean.lastIndexOf('/')
    return if (slash <= 0) "" else clean.substring(0, slash)
}

data class FileBrowserTarget(
    val path: String,
    val isFolder: Boolean,
)

/**
 * One-row project browser: same vertical footprint as the old flat chips,
 * with folder depth via drill-down (tap a folder, use ← to go up).
 * Long-press a file or folder for rename/delete.
 */
@Composable
fun ProjectFileTree(
    files: List<String>,
    folders: List<String>,
    activePath: String,
    currentDir: String,
    onCurrentDirChange: (String) -> Unit,
    onSelectFile: (String) -> Unit,
    onLongPressTarget: (FileBrowserTarget) -> Unit,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(files, folders, currentDir) {
        if (currentDir.isNotEmpty() &&
            !dirExists(files, folders, currentDir)
        ) {
            val fallback = parentDirOf(activePath).takeIf {
                it.isEmpty() || dirExists(files, folders, it)
            } ?: ""
            if (fallback != currentDir) {
                onCurrentDirChange(fallback)
            }
        }
    }

    val entries = remember(files, folders, currentDir) {
        entriesInDir(files, folders, currentDir)
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (currentDir.isNotEmpty()) {
            NavChip(
                label = "← ${currentDir.substringAfterLast('/')}",
                selected = false,
                emphasis = true,
                onClick = { onCurrentDirChange(parentDirOf(currentDir)) },
                onLongClick = {
                    onLongPressTarget(FileBrowserTarget(path = currentDir, isFolder = true))
                },
            )
        }

        entries.forEach { entry ->
            when (entry) {
                is DirEntry.Folder -> {
                    NavChip(
                        label = "${entry.name}/",
                        selected = false,
                        emphasis = true,
                        muted = true,
                        onClick = { onCurrentDirChange(entry.path) },
                        onLongClick = {
                            onLongPressTarget(FileBrowserTarget(path = entry.path, isFolder = true))
                        },
                    )
                }
                is DirEntry.File -> {
                    NavChip(
                        label = entry.name,
                        selected = entry.path == activePath,
                        emphasis = false,
                        onClick = { onSelectFile(entry.path) },
                        onLongClick = {
                            onLongPressTarget(FileBrowserTarget(path = entry.path, isFolder = false))
                        },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun NavChip(
    label: String,
    selected: Boolean,
    emphasis: Boolean,
    muted: Boolean = false,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
) {
    val bg = when {
        selected -> MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
        else -> MaterialTheme.colorScheme.surface.copy(alpha = 0.65f)
    }
    val fg = when {
        selected -> MaterialTheme.colorScheme.primary
        muted -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
        else -> MaterialTheme.colorScheme.onSurface
    }

    Text(
        text = label,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        color = fg,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = when {
            selected -> FontWeight.SemiBold
            emphasis -> FontWeight.Medium
            else -> FontWeight.Normal
        },
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(bg)
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

private sealed class DirEntry {
    data class Folder(val path: String, val name: String) : DirEntry()
    data class File(val path: String, val name: String) : DirEntry()
}

private fun dirExists(files: List<String>, folders: List<String>, dir: String): Boolean {
    if (dir.isEmpty()) return true
    if (dir in folders) return true
    val prefix = "$dir/"
    return files.any { it.startsWith(prefix) } || folders.any { it.startsWith(prefix) || it == dir }
}

private fun entriesInDir(
    files: List<String>,
    folders: List<String>,
    dir: String,
): List<DirEntry> {
    val prefix = if (dir.isEmpty()) "" else "$dir/"
    val childFolders = linkedSetOf<String>()
    val fileEntries = mutableListOf<DirEntry.File>()

    for (path in files) {
        if (dir.isEmpty()) {
            val slash = path.indexOf('/')
            if (slash < 0) {
                fileEntries += DirEntry.File(path = path, name = path)
            } else {
                childFolders += path.substring(0, slash)
            }
        } else {
            if (!path.startsWith(prefix)) continue
            val rest = path.substring(prefix.length)
            if (rest.isEmpty()) continue
            val slash = rest.indexOf('/')
            if (slash < 0) {
                fileEntries += DirEntry.File(path = path, name = rest)
            } else {
                childFolders += rest.substring(0, slash)
            }
        }
    }

    for (folder in folders) {
        if (dir.isEmpty()) {
            val slash = folder.indexOf('/')
            if (slash < 0) {
                childFolders += folder
            } else {
                childFolders += folder.substring(0, slash)
            }
        } else if (folder == dir) {
            // current folder itself — ignore
        } else if (folder.startsWith(prefix)) {
            val rest = folder.substring(prefix.length)
            if (rest.isEmpty()) continue
            val slash = rest.indexOf('/')
            childFolders += if (slash < 0) rest else rest.substring(0, slash)
        }
    }

    val folderEntries = childFolders.sorted().map { name ->
        val path = if (dir.isEmpty()) name else "$dir/$name"
        DirEntry.Folder(path = path, name = name)
    }
    return folderEntries + fileEntries.sortedBy { it.name }
}
