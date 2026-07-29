package com.undertwig.app.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private data class TreeEntry(
    val key: String,
    val name: String,
    val depth: Int,
    val isFolder: Boolean,
    val filePath: String? = null,
)

@Composable
fun ProjectFileTree(
    files: List<String>,
    activePath: String,
    onSelectFile: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val treeFiles = remember(files) {
        files.filter { path ->
            val lower = path.lowercase()
            !lower.endsWith(".pdf")
        }
    }
    val allFolders = remember(treeFiles) { folderPaths(treeFiles) }
    var expanded by remember { mutableStateOf<Set<String>>(emptySet()) }
    var seeded by remember { mutableStateOf(false) }

    LaunchedEffect(treeFiles) {
        // First paint for this project: open folders so hierarchy is visible immediately.
        if (!seeded && treeFiles.isNotEmpty()) {
            expanded = allFolders
            seeded = true
        }
    }

    LaunchedEffect(activePath) {
        val ancestors = ancestorFolders(activePath)
        if (ancestors.isNotEmpty()) {
            expanded = expanded + ancestors
        }
    }

    val rows = remember(treeFiles, expanded) {
        flattenTree(treeFiles, expanded)
    }

    val panel = MaterialTheme.colorScheme.surface.copy(alpha = 0.55f)

    LazyColumn(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(max = 220.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(panel)
            .padding(vertical = 4.dp),
        contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
    ) {
        items(rows, key = { it.key }) { entry ->
            FileTreeRow(
                entry = entry,
                selected = entry.filePath != null && entry.filePath == activePath,
                expanded = entry.isFolder && entry.key in expanded,
                onClick = {
                    if (entry.isFolder) {
                        expanded = if (entry.key in expanded) {
                            expanded - entry.key
                        } else {
                            expanded + entry.key
                        }
                    } else if (entry.filePath != null) {
                        onSelectFile(entry.filePath)
                    }
                },
            )
        }
    }
}

@Composable
private fun FileTreeRow(
    entry: TreeEntry,
    selected: Boolean,
    expanded: Boolean,
    onClick: () -> Unit,
) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 90f else 0f,
        animationSpec = tween(durationMillis = 160),
        label = "folderChevron",
    )
    val selectedBg = MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)
    val nameColor = when {
        selected -> MaterialTheme.colorScheme.primary
        entry.isFolder -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f)
        else -> MaterialTheme.colorScheme.onSurface
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = (entry.depth * 14).dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) selectedBg else MaterialTheme.colorScheme.surface.copy(alpha = 0f))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (entry.isFolder) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowRight,
                contentDescription = if (expanded) "Collapse" else "Expand",
                modifier = Modifier
                    .size(18.dp)
                    .rotate(rotation),
                tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
            )
        } else {
            Box(modifier = Modifier.size(18.dp))
        }
        Text(
            text = entry.name,
            color = nameColor,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = when {
                selected -> FontWeight.SemiBold
                entry.isFolder -> FontWeight.Medium
                else -> FontWeight.Normal
            },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(start = 4.dp)
                .weight(1f),
        )
    }
}

private fun folderPaths(files: List<String>): Set<String> {
    val folders = linkedSetOf<String>()
    for (path in files) {
        val parts = path.split('/').filter { it.isNotEmpty() }
        if (parts.size < 2) continue
        var current = ""
        for (i in 0 until parts.lastIndex) {
            current = if (current.isEmpty()) parts[i] else "$current/${parts[i]}"
            folders += current
        }
    }
    return folders
}

private fun ancestorFolders(filePath: String): Set<String> {
    val parts = filePath.split('/').filter { it.isNotEmpty() }
    if (parts.size < 2) return emptySet()
    val out = linkedSetOf<String>()
    var current = ""
    for (i in 0 until parts.lastIndex) {
        current = if (current.isEmpty()) parts[i] else "$current/${parts[i]}"
        out += current
    }
    return out
}

private fun flattenTree(files: List<String>, expanded: Set<String>): List<TreeEntry> {
    data class Dir(
        val childrenDirs: MutableMap<String, Dir> = linkedMapOf(),
        val files: MutableList<String> = mutableListOf(),
    )

    val root = Dir()
    for (path in files.sorted()) {
        val parts = path.split('/').filter { it.isNotEmpty() }
        if (parts.isEmpty()) continue
        var node = root
        for (i in 0 until parts.lastIndex) {
            node = node.childrenDirs.getOrPut(parts[i]) { Dir() }
        }
        node.files += parts.last()
    }

    val rows = mutableListOf<TreeEntry>()

    fun walk(dir: Dir, prefix: String, depth: Int) {
        val dirNames = dir.childrenDirs.keys.sorted()
        for (name in dirNames) {
            val folderPath = if (prefix.isEmpty()) name else "$prefix/$name"
            rows += TreeEntry(
                key = folderPath,
                name = name,
                depth = depth,
                isFolder = true,
            )
            if (folderPath in expanded) {
                walk(dir.childrenDirs.getValue(name), folderPath, depth + 1)
            }
        }
        for (name in dir.files.sorted()) {
            val filePath = if (prefix.isEmpty()) name else "$prefix/$name"
            rows += TreeEntry(
                key = "file:$filePath",
                name = name,
                depth = depth,
                isFolder = false,
                filePath = filePath,
            )
        }
    }

    walk(root, prefix = "", depth = 0)
    return rows
}
