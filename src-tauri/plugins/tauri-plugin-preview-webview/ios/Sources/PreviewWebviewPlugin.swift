import Foundation
import Tauri
import UIKit
import WebKit

private struct CreateArgs: Decodable {
  let id: String
  let onEvent: Channel
}

private struct IdArgs: Decodable { let id: String }
private struct NavigateArgs: Decodable { let id: String; let url: String; let html: String? }
private struct ActionArgs: Decodable { let id: String; let action: String }
private struct LayoutArgs: Decodable { let id: String; let bounds: ViewBounds }
private struct ViewBounds: Decodable {
  let left: Double
  let top: Double
  let width: Double
  let height: Double
  let viewportWidth: Double
  let visible: Bool
  let interactive: Bool
}

private struct ViewState: Encodable {
  let id: String
  let url: String
  let loading: Bool
  let progress: Double
  let canGoBack: Bool
  let canGoForward: Bool
  let error: String?
  let closeRequested: Bool
  let event: String?
}

private weak var activePreviewPlugin: PreviewWebviewPlugin?

private func allowedPreviewURL(_ url: URL?) -> Bool {
  guard let url = url else { return false }
  switch url.scheme?.lowercased() {
  case "http", "https": return url.host != nil && url.user == nil && url.password == nil
  case "about": return url.absoluteString == "about:blank"
  case "blob", "data": return true
  default: return false
  }
}

private class PreviewEntry: NSObject, WKNavigationDelegate, WKUIDelegate, UIGestureRecognizerDelegate {
  let id: String
  let view: WKWebView
  let channel: Channel
  private var observations: [NSKeyValueObservation] = []
  private var backGesture: UIScreenEdgePanGestureRecognizer?
  private var requestedURL = ""
  private var retryNavigation = false
  private var html: String?

  init(id: String, channel: Channel) {
    self.id = id
    self.channel = channel
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    view = WKWebView(frame: .zero, configuration: configuration)
    super.init()
    let background = UIColor(red: 13.0 / 255.0, green: 17.0 / 255.0, blue: 23.0 / 255.0, alpha: 1)
    view.isOpaque = false
    view.backgroundColor = background
    view.scrollView.backgroundColor = background
    view.scrollView.contentInsetAdjustmentBehavior = .never
    view.scrollView.keyboardDismissMode = .interactive
    view.scrollView.indicatorStyle = .white
    view.overrideUserInterfaceStyle = .dark
    if #available(iOS 15.0, *) { view.underPageBackgroundColor = background }
    view.isHidden = true
    view.allowsBackForwardNavigationGestures = true
    view.navigationDelegate = self
    view.uiDelegate = self
    observations = [
      view.observe(\.url, options: [.new]) { [weak self] _, _ in self?.emit() },
      view.observe(\.isLoading, options: [.new]) { [weak self] _, _ in self?.emit() },
      view.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in self?.emit() },
      view.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in self?.emit() },
      view.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in self?.emit() },
    ]
    let back = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeBack(_:)))
    back.edges = .left
    back.delegate = self
    view.addGestureRecognizer(back)
    backGesture = back
  }

  func emit(error: String? = nil, closeRequested: Bool = false, event: String? = nil) {
    try? channel.send(ViewState(
      id: id, url: view.url?.absoluteString ?? requestedURL,
      loading: view.isLoading, progress: view.estimatedProgress,
      canGoBack: view.canGoBack, canGoForward: view.canGoForward,
      error: error, closeRequested: closeRequested, event: event
    ))
  }

  func navigate(_ url: URL, html: String? = nil) {
    requestedURL = url.absoluteString
    retryNavigation = false
    self.html = html
    // A local document keeps `url` as its storage origin without loading it from the network.
    if let html = html { view.loadHTMLString(html, baseURL: url) } else { view.load(URLRequest(url: url)) }
  }

  func reload() {
    if let html = html, let url = URL(string: requestedURL) {
      navigate(url, html: html)
    } else if (retryNavigation || view.url == nil), let url = URL(string: requestedURL) {
      navigate(url)
    } else {
      view.reload()
    }
  }

  func destroy() {
    observations.removeAll()
    view.navigationDelegate = nil
    view.uiDelegate = nil
    if let backGesture = backGesture { view.removeGestureRecognizer(backGesture) }
    backGesture = nil
    view.stopLoading()
    view.removeFromSuperview()
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    !view.canGoBack
  }

  @objc private func edgeBack(_ gesture: UIScreenEdgePanGestureRecognizer) {
    if gesture.state == .ended && gesture.translation(in: view).x > 80 {
      emit(closeRequested: true)
    }
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    emit(event: "started")
  }
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { emit() }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    retryNavigation = false
    emit(event: "finished")
  }
  private func failed(_ error: Error) {
    let error = error as NSError
    if error.code == NSURLErrorCancelled
      || (error.domain == "WebKitErrorDomain" && error.code == 102) { return }
    retryNavigation = true
    emit(error: error.localizedDescription)
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failed(error)
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    failed(error)
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    retryNavigation = true
    emit(error: "The preview process stopped. Reload to continue.")
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard allowedPreviewURL(action.request.url) else { decisionHandler(.cancel); return }
    if action.targetFrame?.isMainFrame == true, let url = action.request.url {
      if url.absoluteString != requestedURL { html = nil }
      requestedURL = url.absoluteString
    }
    decisionHandler(.allow)
  }
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if navigationAction.targetFrame == nil && allowedPreviewURL(navigationAction.request.url) {
      webView.load(navigationAction.request)
    }
    return nil
  }
}

class PreviewWebviewPlugin: Plugin {
  private weak var host: WKWebView?
  private var entries: [String: PreviewEntry] = [:]

  override public func load(webview: WKWebView) {
    reset()
    host = webview
    activePreviewPlugin = self
  }

  fileprivate func reset() {
    entries.values.forEach { $0.destroy() }
    entries.removeAll()
  }

  private func perform(_ invoke: Invoke, _ operation: @escaping () throws -> Void) {
    DispatchQueue.main.async {
      do { try operation() }
      catch { invoke.reject(error.localizedDescription) }
    }
  }

  private func entry(_ id: String) throws -> PreviewEntry {
    guard let entry = entries[id] else {
      throw NSError(domain: "Preview", code: 1, userInfo: [NSLocalizedDescriptionKey: "Preview is closed"])
    }
    return entry
  }

  @objc public func create(_ invoke: Invoke) {
    perform(invoke) {
      let args = try invoke.parseArgs(CreateArgs.self)
      guard let host = self.host, let parent = host.superview else {
        invoke.reject("Preview host is unavailable"); return
      }
      self.entries.removeValue(forKey: args.id)?.destroy()
      let entry = PreviewEntry(id: args.id, channel: args.onEvent)
      self.entries[args.id] = entry
      parent.addSubview(entry.view)
      invoke.resolve()
    }
  }

  @objc public func navigate(_ invoke: Invoke) {
    perform(invoke) {
      let args = try invoke.parseArgs(NavigateArgs.self)
      guard let url = URL(string: args.url), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
            url.host != nil, url.user == nil, url.password == nil else {
        invoke.reject("Preview requires an HTTP or HTTPS URL"); return
      }
      try self.entry(args.id).navigate(url, html: args.html)
      invoke.resolve()
    }
  }

  @objc public func action(_ invoke: Invoke) {
    perform(invoke) {
      let args = try invoke.parseArgs(ActionArgs.self)
      let entry = try self.entry(args.id)
      switch args.action {
      case "back": entry.view.goBack()
      case "forward": entry.view.goForward()
      case "reload": entry.reload()
      case "stop": entry.view.stopLoading()
      default: invoke.reject("Unknown preview action"); return
      }
      entry.emit()
      invoke.resolve()
    }
  }

  @objc public func layout(_ invoke: Invoke) {
    perform(invoke) {
      let args = try invoke.parseArgs(LayoutArgs.self)
      guard let host = self.host else { invoke.reject("Preview host is unavailable"); return }
      let bounds = args.bounds
      guard [bounds.left, bounds.top, bounds.width, bounds.height, bounds.viewportWidth].allSatisfy({ $0.isFinite }),
            bounds.viewportWidth > 0 else { invoke.reject("Invalid preview bounds"); return }
      let scale = host.bounds.width / CGFloat(bounds.viewportWidth)
      let rect = CGRect(x: CGFloat(bounds.left) * scale, y: CGFloat(bounds.top) * scale,
                        width: CGFloat(max(0, bounds.width)) * scale, height: CGFloat(max(0, bounds.height)) * scale)
        .intersection(host.bounds)
      let view = try self.entry(args.id).view
      view.isHidden = !bounds.visible || rect.isNull || rect.isEmpty
      if !rect.isNull { view.frame = host.convert(rect, to: view.superview) }
      view.isUserInteractionEnabled = bounds.interactive
      invoke.resolve()
    }
  }

  @objc public func remove(_ invoke: Invoke) {
    perform(invoke) {
      let args = try invoke.parseArgs(IdArgs.self)
      self.entries.removeValue(forKey: args.id)?.destroy()
      invoke.resolve()
    }
  }
}

@_cdecl("init_plugin_preview_webview")
func initPlugin() -> Plugin { PreviewWebviewPlugin() }

@_cdecl("clear_preview_webviews")
func clearPreviewWebviews() { activePreviewPlugin?.reset() }
