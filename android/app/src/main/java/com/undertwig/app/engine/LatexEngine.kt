package com.undertwig.app.engine

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ContextThemeWrapper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class CompileResult(
    val ok: Boolean,
    val pdfBytes: ByteArray?,
    val log: String,
)

data class BibliographyResult(
    val ok: Boolean,
    val log: String,
    val outputs: Map<String, String>,
)

/**
 * Runs SwiftLaTeX PdfTeX inside a WebView (local compute, not a browsed website).
 * WebView is created lazily and only with an Activity-backed context.
 */
class LatexEngine {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val contextWrapper = MutableContextWrapper(null)
    private var webView: WebView? = null
    private var engineReady = false
    private var pendingReady: ((Result<Unit>) -> Unit)? = null
    private var pendingResult: ((Result<CompileResult>) -> Unit)? = null
    private var pendingBibResult: ((Result<BibliographyResult>) -> Unit)? = null
    private var progressListener: ((String) -> Unit)? = null
    private val creating = AtomicBoolean(false)

    /** Bind to a live Activity (or other UI context) before compile. */
    fun attach(context: Context) {
        contextWrapper.baseContext = context
    }

    fun detach() {
        mainHandler.post {
            destroyWebView()
            contextWrapper.baseContext = null
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureWebView() {
        if (webView != null) return
        val base = contextWrapper.baseContext
            ?: throw IllegalStateException("LatexEngine is not attached to a UI context.")
        if (!creating.compareAndSet(false, true)) return
        try {
            // Application-context WebViews crash on many devices; theme-wrap as a safeguard.
            val themed = ContextThemeWrapper(base, android.R.style.Theme_DeviceDefault)
            val assetLoader = WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(base.applicationContext))
                .build()

            val view = WebView(themed)
            view.settings.javaScriptEnabled = true
            view.settings.domStorageEnabled = true
            // Engine assets are versioned in APK; never serve a stale cached Worker script.
            view.settings.cacheMode = WebSettings.LOAD_NO_CACHE
            view.settings.allowFileAccess = false
            try {
                view.clearCache(true)
            } catch (error: Throwable) {
                Log.w(TAG, "clearCache failed", error)
            }
            view.addJavascriptInterface(NativeBridge(), "UndertwigNative")
            view.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?,
                ) = request?.url?.let { assetLoader.shouldInterceptRequest(it) }

                override fun onReceivedError(
                    view: WebView?,
                    errorCode: Int,
                    description: String?,
                    failingUrl: String?,
                ) {
                    Log.e(TAG, "WebView error $errorCode: $description ($failingUrl)")
                    if (!engineReady) {
                        pendingReady?.invoke(
                            Result.failure(IllegalStateException(description ?: "WebView failed to load")),
                        )
                        pendingReady = null
                    }
                }
            }
            webView = view
            engineReady = false
            // Cache-bust query so WebView cannot reuse an older runner/Worker bundle.
            view.loadUrl(
                "https://appassets.androidplatform.net/assets/engine/runner.html?v=$ENGINE_ASSET_VERSION",
            )
        } catch (error: Throwable) {
            webView = null
            Log.e(TAG, "Failed to create WebView", error)
            throw IllegalStateException(
                "Android System WebView is missing or failed to start. " +
                    "Install/update Android System WebView on the emulator/device.",
                error,
            )
        } finally {
            creating.set(false)
        }
    }

    private fun destroyWebView() {
        val ready = pendingReady
        val compile = pendingResult
        val bib = pendingBibResult
        pendingReady = null
        pendingResult = null
        pendingBibResult = null
        progressListener = null
        try {
            webView?.stopLoading()
            webView?.destroy()
        } catch (error: Throwable) {
            Log.w(TAG, "WebView destroy failed", error)
        }
        webView = null
        engineReady = false
        // Resume waiters so Cancel cannot leave coroutines suspended forever.
        ready?.invoke(Result.failure(CancellationException("Cancelled")))
        compile?.invoke(Result.failure(CancellationException("Cancelled")))
        bib?.invoke(Result.failure(CancellationException("Cancelled")))
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
            // Timeout: if ready never arrives, fail rather than hang forever.
            mainHandler.postDelayed({
                if (!engineReady && pendingReady != null) {
                    pendingReady?.invoke(
                        Result.failure(
                            IllegalStateException(
                                "Engine page did not become ready. Check System WebView on the emulator.",
                            ),
                        ),
                    )
                    pendingReady = null
                }
            }, 20_000L)
        }
    }

    suspend fun compile(
        files: Map<String, Pair<String, Boolean>>,
        engineId: String = "pdflatex",
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
        val filesJson = JSONObject.quote(payload.toString())
        val engineJson = JSONObject.quote(engineId.ifBlank { "pdflatex" })
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
            cont.invokeOnCancellation {
                pendingResult = null
                progressListener = null
                // Tear down Wasm workers so Cancel stops work, not just the UI wait.
                destroyWebView()
            }
            // Fail rather than spin on "Converting…" forever if JS never returns.
            mainHandler.postDelayed({
                if (pendingResult != null) {
                    pendingResult?.invoke(
                        Result.success(
                            CompileResult(
                                ok = false,
                                pdfBytes = null,
                                log = "Convert timed out. Try again, or check network for LaTeX packages.",
                            ),
                        ),
                    )
                    pendingResult = null
                    progressListener = null
                }
            }, 240_000L)
            webView?.evaluateJavascript(
                "window.UndertwigEngine.compile($filesJson, $engineJson)",
                null,
            ) ?: cont.resumeWithException(IllegalStateException("WebView was destroyed."))
        }
    }

    suspend fun runBibliography(
        files: Map<String, Pair<String, Boolean>>,
        bibTool: String = "bibtex",
        onProgress: (String) -> Unit = {},
    ): BibliographyResult = withContext(Dispatchers.Main) {
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
        val filesJson = JSONObject.quote(payload.toString())
        val toolJson = JSONObject.quote(bibTool.ifBlank { "bibtex" })
        suspendCancellableCoroutine { cont ->
            pendingBibResult = { result ->
                progressListener = null
                if (cont.isActive) {
                    result.fold(
                        onSuccess = { cont.resume(it) },
                        onFailure = { cont.resumeWithException(it) },
                    )
                }
            }
            cont.invokeOnCancellation {
                pendingBibResult = null
                progressListener = null
                destroyWebView()
            }
            mainHandler.postDelayed({
                if (pendingBibResult != null) {
                    pendingBibResult?.invoke(
                        Result.success(
                            BibliographyResult(
                                ok = false,
                                log = "Bibliography timed out. Convert once, then try Bib again.",
                                outputs = emptyMap(),
                            ),
                        ),
                    )
                    pendingBibResult = null
                    progressListener = null
                }
            }, 300_000L)
            webView?.evaluateJavascript(
                "window.UndertwigEngine.runBibliography($filesJson, $toolJson)",
                null,
            ) ?: cont.resumeWithException(IllegalStateException("WebView was destroyed."))
        }
    }

    /** Abort in-flight Convert/Bib by destroying the engine WebView (and its workers). */
    fun cancelCurrentWork() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            destroyWebView()
        } else {
            mainHandler.post { destroyWebView() }
        }
    }

    fun destroy() {
        mainHandler.post { destroyWebView() }
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
                    "bib-result" -> {
                        val ok = obj.optBoolean("ok", false)
                        val log = obj.optString("log", "")
                        val outputs = linkedMapOf<String, String>()
                        val outputsObj = obj.optJSONObject("outputs")
                        if (outputsObj != null) {
                            val keys = outputsObj.keys()
                            while (keys.hasNext()) {
                                val key = keys.next()
                                outputs[key] = outputsObj.optString(key, "")
                            }
                        }
                        pendingBibResult?.invoke(
                            Result.success(
                                BibliographyResult(ok = ok, log = log, outputs = outputs),
                            ),
                        )
                        pendingBibResult = null
                    }
                }
            }
        }
    }

    companion object {
        private const val TAG = "UndertwigEngine"
        /** Bump whenever bundled engine JS/Wasm/fmt changes. */
        private const val ENGINE_ASSET_VERSION = "10"
    }
}
