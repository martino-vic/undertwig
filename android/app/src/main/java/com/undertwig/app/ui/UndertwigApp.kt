package com.undertwig.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController

@Composable
fun UndertwigApp(
    viewModel: UndertwigViewModel,
) {
    val home by viewModel.home.collectAsStateWithLifecycle()
    val editor by viewModel.editor.collectAsStateWithLifecycle()
    val startDestination = remember {
        if (viewModel.editor.value.projectId.isNotEmpty()) "editor" else "home"
    }
    val navController = rememberNavController()

    NavHost(navController = navController, startDestination = startDestination) {
        composable("home") {
            HomeScreen(
                projects = home.projects,
                onOpen = { id ->
                    viewModel.openProject(id)
                    navController.navigate("editor")
                },
                onCreate = { name -> viewModel.createProject(name) },
                onDelete = { id -> viewModel.deleteProject(id) },
            )
        }
        composable("editor") {
            EditorScreen(
                state = editor,
                onBack = { navController.popBackStack() },
                onSelectFile = viewModel::selectFile,
                onEditorChange = viewModel::onEditorChange,
                onSave = viewModel::saveActive,
                onConvert = viewModel::convert,
                onBibliography = viewModel::updateBibliography,
                onCancelBusy = viewModel::cancelBusy,
                onOpenPdf = {
                    if (editor.pdfPath != null) {
                        navController.navigate("pdf")
                    }
                },
                onAddFile = viewModel::addFile,
                onAddFolder = viewModel::addFolder,
                onDeletePath = viewModel::deletePath,
                onRenamePath = viewModel::renamePath,
            )
        }
        composable("pdf") {
            val file = viewModel.pdfFile()
            if (file != null && file.exists()) {
                PdfScreen(
                    pdfFile = file,
                    title = "${editor.projectName}.pdf",
                    onBack = { navController.popBackStack() },
                    contentRevision = editor.pdfRevision,
                )
            } else {
                navController.popBackStack()
            }
        }
    }
}
