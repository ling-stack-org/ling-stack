package expo.modules.lingvisualizationpreview

import android.content.Context
import android.graphics.Color
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class LingVisualizationPreviewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LingVisualizationPreview")
    View(LingVisualizationPreviewView::class) {
      Events("onLoadError")
      Prop("html") { view: LingVisualizationPreviewView, html: String -> view.show(html) }
      OnViewDestroys { view: LingVisualizationPreviewView -> view.dispose() }
    }
  }
}

class LingVisualizationPreviewView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onLoadError by EventDispatcher()
  private val webView = WebView(context).apply {
    setBackgroundColor(Color.TRANSPARENT)
    settings.apply {
      javaScriptEnabled = false
      javaScriptCanOpenWindowsAutomatically = false
      domStorageEnabled = false
      allowFileAccess = false
      allowContentAccess = false
      blockNetworkLoads = true
      cacheMode = WebSettings.LOAD_NO_CACHE
      setSupportMultipleWindows(false)
      useWideViewPort = true
    }
    setDownloadListener { _, _, _, _, _ -> }
    webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        request.url.toString().substringBefore('#') !in setOf("about:blank", "about:srcdoc")

      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) onLoadError(emptyMap<String, Any>())
      }
    }
  }

  init {
    addView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    webView.layout(0, 0, right - left, bottom - top)
  }

  fun show(html: String) {
    webView.stopLoading()
    webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
  }

  fun dispose() {
    webView.stopLoading()
    removeView(webView)
    webView.destroy()
  }
}
