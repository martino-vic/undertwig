package com.undertwig.app.engine

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class CompileResult(
    val ok: Boolean,
    val pdfBytes: ByteArray?,
    val log: String,
)

/**
 * Runs SwiftLaTeX PdfTeX inside a WebView (local compute, not a browsed website).
 */
class LatexEngine(context: Context) {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var engineReady = false
    private var pendingReady: ((Result<Unit>) -> Unit)? = null
    private var pendingResult: ((Result<CompileResult>) -> Unit)? = null
    private var progressListener: ((String) -> Unit)? = null

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureWebView() {
        if (webView != null) return
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(appContext))
            .build()

        val view = WebView(appContext)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.cacheMode = WebSettings.LOAD_DEFAULT
        view.settings.allowFileAccess = false
        view.addJavascriptInterface(NativeBridge(), "UndertwigNative")
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
            ) = request?.url?.let { assetLoader.shouldInterceptRequest(it) }
        }
        webView = view
        view.loadUrl("https://appassets.androidplatform.net/assets/engine/runner.html")
    }

    private suspend fun awaitReady() {
        if (engineReady) return
        suspendCancellableCoroutine { cont ->
            pendingReady = { result ->
                if (cont.isActive) {
                    result.fold(
                        onSuccess = { cont.resume(Unit) },
                        onFailure = { cont.resumeWithException(it) },
                    )
                }
            }
            cont.invokeOnCancellation { pendingReady = null }
        }
    }

    suspend fun warmUp() = withContext(Dispatchers.Main) {
        ensureWebView()
        awaitReady()
    }

    suspend fun compile(
        files: Map<String, Pair<String, Boolean>>,
        onProgress: (String) -> Unit = {},
    ): CompileResult = withContext(Dispatchers.Main) {
        ensureWebView()
        awaitReady()
        progressListener = onProgress
        val payload = JSONObject()
        files.forEach { (path, value) ->
            val (content, binary) = value
            payload.put(
                path,
                JSONObject()
                    .put("content", content)
                    .put("binary", binary),
            )
        }
        val json = JSONObject.quote(payload.toString())
        suspendCancellableCoroutine { cont ->
            pendingResult = { result ->
                progressListener = null
                if (cont.isActive) {
                    result.fold(
                        onSuccess = { cont.resume(it) },
                        onFailure = { cont.resumeWithException(it) },
                    )
                }
            }
            cont.invokeOnCancellation { pendingResult = null }
            webView?.evaluateJavascript(
                "window.UndertwigEngine.compile($json)",
                null,
            )
        }
    }

    fun destroy() {
        mainHandler.post {
            webView?.destroy()
            webView = null
            engineReady = false
        }
    }

    private inner class NativeBridge {
        @JavascriptInterface
        fun postMessage(message: String) {
            mainHandler.post {
                val obj = runCatching { JSONObject(message) }.getOrNull() ?: return@post
                when (obj.optString("type")) {
                    "ready" -> {
                        engineReady = true
                        pendingReady?.invoke(Result.success(Unit))
                        pendingReady = null
                    }
                    "progress" -> {
                        progressListener?.invoke(obj.optString("message", "Converting…"))
                    }
                    "result" -> {
                        val ok = obj.optBoolean("ok", false)
                        val log = obj.optString("log", "")
                        val b64 = if (obj.isNull("pdfBase64")) null else obj.optString("pdfBase64")
                        val bytes = if (ok && !b64.isNullOrBlank()) {
                            android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                        } else {
                            null
                        }
                        pendingResult?.invoke(
                            Result.success(CompileResult(ok = ok, pdfBytes = bytes, log = log)),
                        )
                        pendingResult = null
                    }
                }
            }
        }
    }
}
