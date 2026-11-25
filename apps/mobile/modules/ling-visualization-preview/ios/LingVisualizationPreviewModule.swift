import ExpoModulesCore
import WebKit

public final class LingVisualizationPreviewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LingVisualizationPreview")
    View(LingVisualizationPreviewView.self) {
      Events("onLoadError")
      Prop("html") { (view: LingVisualizationPreviewView, html: String) in
        view.show(html)
      }
    }
  }
}

final class LingVisualizationPreviewView: ExpoView, WKNavigationDelegate {
  private static let offlineRules = #"""
  [
    {"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
    {"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},
    {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}},
    {"trigger":{"url-filter":"^ftp:"},"action":{"type":"block"}}
  ]
  """#

  let onLoadError = EventDispatcher()
  private let webView: WKWebView
  private var generation = 0

  required init(appContext: AppContext? = nil) {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init(appContext: appContext)
    webView.navigationDelegate = self
    webView.allowsLinkPreview = false
    addSubview(webView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    webView.frame = bounds
  }

  func show(_ html: String) {
    generation += 1
    let request = generation
    webView.stopLoading()
    webView.loadHTMLString("", baseURL: nil)
    WKContentRuleListStore.default().compileContentRuleList(
      forIdentifier: "LingVisualizationOffline",
      encodedContentRuleList: Self.offlineRules
    ) { [weak self] rules, _ in
      DispatchQueue.main.async {
        guard let self, self.generation == request else { return }
        guard let rules else {
          self.onLoadError([:])
          return
        }
        let content = self.webView.configuration.userContentController
        content.removeAllContentRuleLists()
        content.add(rules)
        self.webView.loadHTMLString(html, baseURL: nil)
      }
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let destination = action.request.url?.absoluteString.split(separator: "#", maxSplits: 1).first
    let local = destination == "about:blank" || destination == "about:srcdoc"
    decisionHandler(local && action.targetFrame != nil ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { onLoadError([:]) }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { onLoadError([:]) }
  }
}
