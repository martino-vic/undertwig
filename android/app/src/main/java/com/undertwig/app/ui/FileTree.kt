package com.undertwig.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * One-row project browser: same vertical footprint as the old flat chips,
 * with folder depth via drill-down (tap a folder, use ← to go up).
 */
@Composable
fun ProjectFileTree(
    files: List<String>,
    activePath: String,
    onSelectFile: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val treeFiles = remember(files) {
        files.filter { !it.lowercase().endsWith(".pdf") }
    }

    var currentDir by remember { mutableStateOf(parentDir(activePath)) }

    LaunchedEffect(activePath) {
        currentDir = parentDir(activePath)
    }

    LaunchedEffect(treeFiles) {
        if (currentDir.isNotEmpty() && !dirExists(treeFiles, currentDir)) {
            currentDir = parentDir(activePath).takeIf { dirExists(treeFiles, it) || it.isEmpty() }
                ?: ""
        }
    }

    val entries = remember(treeFiles, currentDir) {
        entriesInDir(treeFiles, currentDir)
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
                onClick = { currentDir = parentDir(currentDir) },
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
                        onClick = {
                            currentDir = entry.path
                        },
                    )
                }
                is DirEntry.File -> {
                    NavChip(
                        label = entry.name,
                        selected = entry.path == activePath,
                        emphasis = false,
                        onClick = { onSelectFile(entry.path) },
                    )
                }
            }
        }
    }
}

@Composable
private fun NavChip(
    label: String,
    selected: Boolean,
    emphasis: Boolean,
    muted: Boolean = false,
    onClick: () -> Unit,
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
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

private sealed class DirEntry {
    data class Folder(val path: String, val name: String) : DirEntry()
    data class File(val path: String, val name: String) : DirEntry()
}

private fun parentDir(path: String): String {
    val clean = path.trim('/').replace('\\', '/')
    val slash = clean.lastIndexOf('/')
    return if (slash <= 0) "" else clean.substring(0, slash)
}

private fun dirExists(files: List<String>, dir: String): Boolean {
    if (dir.isEmpty()) return true
    val prefix = "$dir/"
    return files.any { it.startsWith(prefix) }
}

private fun entriesInDir(files: List<String>, dir: String): List<DirEntry> {
    val prefix = if (dir.isEmpty()) "" else "$dir/"
    val folders = linkedSetOf<String>()
    val fileEntries = mutableListOf<DirEntry.File>()

    for (path in files) {
        if (dir.isEmpty()) {
            val slash = path.indexOf('/')
            if (slash < 0) {
                fileEntries += DirEntry.File(path = path, name = path)
            } else {
                folders += path.substring(0, slash)
            }
        } else {
            if (!path.startsWith(prefix)) continue
            val rest = path.substring(prefix.length)
            if (rest.isEmpty()) continue
            val slash = rest.indexOf('/')
            if (slash < 0) {
                fileEntries += DirEntry.File(path = path, name = rest)
            } else {
                folders += rest.substring(0, slash)
            }
        }
    }

    val folderEntries = folders.sorted().map { name ->
        val path = if (dir.isEmpty()) name else "$dir/$name"
        DirEntry.Folder(path = path, name = name)
    }
    return folderEntries + fileEntries.sortedBy { it.name }
}
