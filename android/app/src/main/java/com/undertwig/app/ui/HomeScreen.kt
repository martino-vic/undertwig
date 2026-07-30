package com.undertwig.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.undertwig.app.data.AuthUser
import com.undertwig.app.data.HomeProjectItem
import com.undertwig.app.data.ProjectOrigin
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    projects: List<HomeProjectItem>,
    authUser: AuthUser?,
    signingIn: Boolean,
    cloudLoading: Boolean,
    openingKey: String?,
    cloudError: String?,
    onOpen: (HomeProjectItem) -> Unit,
    onCreate: (String) -> Unit,
    onDelete: (String) -> Unit,
    onLogin: () -> Unit,
    onLogout: () -> Unit,
    onRefreshCloud: () -> Unit,
) {
    var showCreate by remember { mutableStateOf(false) }
    var showAccount by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("MyPaper") }

    LaunchedEffect(authUser?.id) {
        if (authUser != null) {
            onRefreshCloud()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Undertwig", fontWeight = FontWeight.Bold)
                        Text(
                            when {
                                authUser != null -> "Projects on this device and Drive"
                                else -> "Local LaTeX on your device"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                actions = {
                    if (authUser != null) {
                        IconButton(
                            onClick = onRefreshCloud,
                            enabled = !cloudLoading,
                        ) {
                            if (cloudLoading) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(18.dp),
                                    strokeWidth = 2.dp,
                                )
                            } else {
                                Icon(
                                    Icons.Default.Refresh,
                                    contentDescription = "Refresh Google Drive projects",
                                )
                            }
                        }
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
        floatingActionButton = {
            FloatingActionButton(onClick = { showCreate = true }) {
                Icon(Icons.Default.Add, contentDescription = "New project")
            }
        },
    ) { padding ->
        when {
            projects.isEmpty() && !cloudLoading -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("No projects yet", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        if (authUser != null) {
                            "Create a project, or Save one from another device to see it here."
                        } else {
                            "Create a project to edit LaTeX and convert to PDF on-device."
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { showCreate = true }) { Text("New project") }
                    if (cloudError != null) {
                        Spacer(Modifier.height(12.dp))
                        Text(
                            cloudError,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
            else -> {
                val cloudProjects = remember(projects) {
                    projects.filter { it.origin != ProjectOrigin.Local }
                }
                val localProjects = remember(projects) {
                    projects.filter { it.origin == ProjectOrigin.Local }
                }
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (cloudLoading || cloudError != null) {
                        item(key = "cloud-status") {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                if (cloudLoading) {
                                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                                    Text(
                                        "Loading Google Drive…",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                                    )
                                } else if (cloudError != null) {
                                    Text(
                                        cloudError,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                            }
                        }
                    }
                    items(cloudProjects, key = { it.key }) { project ->
                        ProjectCard(
                            project = project,
                            opening = openingKey == project.key,
                            onOpen = { onOpen(project) },
                            onDelete = {
                                val id = project.localId
                                if (id != null) onDelete(id)
                            },
                        )
                    }
                    items(localProjects, key = { it.key }) { project ->
                        ProjectCard(
                            project = project,
                            opening = openingKey == project.key,
                            onOpen = { onOpen(project) },
                            onDelete = {
                                val id = project.localId
                                if (id != null) onDelete(id)
                            },
                        )
                    }
                }
            }
        }
    }

    if (showAccount && authUser != null) {
        AlertDialog(
            onDismissRequest = { showAccount = false },
            title = { Text(authUser.name) },
            text = { Text(authUser.email) },
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

    if (showCreate) {
        AlertDialog(
            onDismissRequest = { showCreate = false },
            title = { Text("New project") },
            text = {
                OutlinedTextField(
                    value = newName,
                    onValueChange = { newName = it },
                    singleLine = true,
                    label = { Text("Name") },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onCreate(newName)
                        showCreate = false
                    },
                ) { Text("Create") }
            },
            dismissButton = {
                TextButton(onClick = { showCreate = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun ProjectCard(
    project: HomeProjectItem,
    opening: Boolean,
    onOpen: () -> Unit,
    onDelete: () -> Unit,
) {
    val dark = isSystemInDarkTheme()
    // Three distinct hues: neutral local, cool Drive-owned, warm invited.
    val container = when (project.origin) {
        ProjectOrigin.Local -> MaterialTheme.colorScheme.surface
        ProjectOrigin.Drive -> if (dark) Color(0xFF1A2C33) else Color(0xFFE4F0F4)
        ProjectOrigin.Invited -> if (dark) Color(0xFF2A2418) else Color(0xFFF3E6D4)
    }
    val accent = when (project.origin) {
        ProjectOrigin.Local -> Color.Transparent
        ProjectOrigin.Drive -> if (dark) Color(0xFF3D7A8C) else Color(0xFF5B8FA3)
        ProjectOrigin.Invited -> if (dark) Color(0xFFB08A4A) else Color(0xFFC4923A)
    }
    val date = remember(project.updatedAt) {
        if (project.updatedAt <= 0L) {
            project.detailLabel
        } else {
            DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
                .format(Date(project.updatedAt))
        }
    }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !opening, onClick = onOpen),
        colors = CardDefaults.cardColors(containerColor = container),
        border = if (accent == Color.Transparent) {
            null
        } else {
            BorderStroke(1.dp, accent.copy(alpha = 0.45f))
        },
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(project.name, style = MaterialTheme.typography.titleMedium)
                Text(
                    project.detailLabel,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (project.updatedAt > 0L) {
                    Text(
                        date,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                    )
                }
            }
            when {
                opening -> {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                }
                project.canDelete -> {
                    IconButton(onClick = onDelete) {
                        Icon(Icons.Default.Delete, contentDescription = "Delete")
                    }
                }
            }
        }
    }
}
