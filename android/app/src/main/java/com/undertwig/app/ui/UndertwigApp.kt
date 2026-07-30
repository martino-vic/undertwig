package com.undertwig.app.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
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
    val auth by viewModel.auth.collectAsStateWithLifecycle()
    val activity = LocalContext.current as ComponentActivity
    val startDestination = remember {
        if (viewModel.editor.value.projectId.isNotEmpty()) "editor" else "home"
    }
    val navController = rememberNavController()

    NavHost(navController = navController, startDestination = startDestination) {
        composable("home") {
            HomeScreen(
                projects = home.projects,
                authUser = auth.user,
                signingIn = auth.signingIn,
                cloudLoading = home.cloudLoading,
                openingKey = home.openingKey,
                cloudError = home.cloudError,
                onOpen = { item ->
                    viewModel.openHomeProject(item, activity) {
                        navController.navigate("editor")
                    }
                },
                onCreate = { name -> viewModel.createProject(name) },
                onDelete = { id -> viewModel.deleteProject(id) },
                onLogin = { viewModel.signInWithGoogle(activity) },
                onLogout = viewModel::signOut,
                onRefreshCloud = { viewModel.refreshCloudProjects(activity) },
            )
        }
        composable("editor") {
            EditorScreen(
                state = editor,
                authUser = auth.user,
                signingIn = auth.signingIn,
                onBack = { navController.popBackStack() },
                onSelectFile = { path ->
                    if (path.endsWith(".pdf", ignoreCase = true)) {
                        if (viewModel.openPdfPreview(path)) {
                            navController.navigate("pdf")
                        }
                    } else {
                        viewModel.selectFile(path)
                    }
                },
                onEditorChange = viewModel::onEditorChange,
                onSave = { viewModel.saveActive(activity) },
                onLoadFromDrive = { viewModel.loadProjectFromDrive(activity) },
                onCancelLoadFromDrive = viewModel::cancelLoadFromDrive,
                onConvert = viewModel::convert,
                onBibliography = viewModel::updateBibliography,
                onCancelBusy = viewModel::cancelBusy,
                onOpenPdf = {
                    if (viewModel.openPdfPreview("main.pdf")) {
                        navController.navigate("pdf")
                    }
                },
                onLogin = { viewModel.signInWithGoogle(activity) },
                onLogout = viewModel::signOut,
                onSelectLatexEngine = viewModel::setLatexEngine,
                onSelectBibTool = viewModel::setBibTool,
                onPrepareDownload = viewModel::projectDownloadInfo,
                onExportZip = viewModel::exportProjectZip,
                onAddFile = viewModel::addFile,
                onAddFolder = viewModel::addFolder,
                onDeletePath = viewModel::deletePath,
                onRenamePath = viewModel::renamePath,
                onResolveDriveConflict = viewModel::resolveDriveConflict,
            )
        }
        composable("pdf") {
            val file = viewModel.pdfFile()
            if (file != null && file.exists()) {
                PdfScreen(
                    pdfFile = file,
                    title = viewModel.previewPdfTitle(),
                    onBack = { navController.popBackStack() },
                    contentRevision = editor.pdfRevision,
                )
            } else {
                navController.popBackStack()
            }
        }
    }
}
