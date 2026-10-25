import Foundation
import Tauri
import UIKit
import WebKit

struct DownloadArgs: Decodable {
  let url: String
  let name: String
  let onProgress: Channel?
}

struct SaveArgs: Decodable {
  let name: String
  let data: String
}

struct DownloadProgress: Encodable {
  let loaded: Int64
  let total: Int64
}

// One download at a time: a new download or `cancel` stops the current one, which resolves as cancelled.
class FileDownloadPlugin: Plugin {
  private var task: URLSessionDownloadTask?
  private var sharing = false
  private var progressTimer: Timer?
  private weak var webview: WKWebView?

  override public func load(webview: WKWebView) {
    self.webview = webview
  }

  @objc public func cancel(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.task?.cancel()
      invoke.resolve()
    }
  }

  @objc public func download(_ invoke: Invoke) {
    let args: DownloadArgs
    do { args = try invoke.parseArgs(DownloadArgs.self) }
    catch { invoke.reject("Invalid download arguments"); return }
    guard let url = URL(string: args.url), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else {
      invoke.reject("Downloads require an HTTPS URL"); return
    }
    let name = (args.name.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
    guard !name.isEmpty, name != ".", name != ".." else { invoke.reject("Invalid filename"); return }
    DispatchQueue.main.async { self.start(invoke, url: url, name: name, progress: args.onProgress) }
  }

  private func start(_ invoke: Invoke, url: URL, name: String, progress channel: Channel?) {
    guard !sharing else { invoke.reject("Finish sharing the previous file first"); return }
    task?.cancel()
    progressTimer?.invalidate()
    var task: URLSessionDownloadTask?
    task = URLSession.shared.downloadTask(with: url) { [weak self] temporary, response, error in
      guard let self = self else { return }
      DispatchQueue.main.async {
        guard self.task === task else { return }
        self.task = nil
        self.progressTimer?.invalidate()
        self.progressTimer = nil
      }
      if (error as? URLError)?.code == .cancelled {
        invoke.resolve(["status": "cancelled"]); return
      }
      var directory: URL?
      do {
        if let error = error { throw error }
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              let temporary = temporary else { throw NSError(domain: "Download failed", code: 1) }
        let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 512 * 1024 * 1024 else { throw NSError(domain: "File exceeds 512 MB", code: 1) }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("baton-download-" + UUID().uuidString)
        directory = folder
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent(name)
        try FileManager.default.moveItem(at: temporary, to: target)
        DispatchQueue.main.async { self.share(target, folder, invoke) }
      } catch {
        if let directory = directory { try? FileManager.default.removeItem(at: directory) }
        invoke.reject(error.localizedDescription)
      }
    }
    self.task = task
    // task.progress rarely notifies during a transfer; the byte counters are current, so poll them.
    // Common modes keep the timer firing while the user scrolls.
    if let channel = channel, let task = task {
      let timer = Timer(timeInterval: 0.2, repeats: true) { _ in
        let total = task.countOfBytesExpectedToReceive
        guard total > 0, task.countOfBytesReceived > 0 else { return }
        try? channel.send(DownloadProgress(loaded: task.countOfBytesReceived, total: total))
      }
      RunLoop.main.add(timer, forMode: .common)
      progressTimer = timer
    }
    task?.resume()
  }

  // A file made on the device (e.g. a diagram image): no network, straight to the share sheet.
  @objc public func save(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(SaveArgs.self), let data = Data(base64Encoded: args.data) else {
      invoke.reject("Invalid save arguments"); return
    }
    let name = (args.name as NSString).lastPathComponent
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("baton-download-" + UUID().uuidString)
    let target = folder.appendingPathComponent(name.isEmpty ? "download" : name)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try data.write(to: target)
    } catch {
      try? FileManager.default.removeItem(at: folder)
      invoke.reject(error.localizedDescription); return
    }
    DispatchQueue.main.async {
      guard !self.sharing else {
        try? FileManager.default.removeItem(at: folder)
        invoke.reject("Finish sharing the previous file first"); return
      }
      self.share(target, folder, invoke)
    }
  }

  private func share(_ target: URL, _ folder: URL, _ invoke: Invoke) {
    guard var presenter = webview?.window?.rootViewController else {
      try? FileManager.default.removeItem(at: folder)
      invoke.reject("No window available for sharing"); return
    }
    while let presented = presenter.presentedViewController { presenter = presented }
    let sheet = UIActivityViewController(activityItems: [target], applicationActivities: nil)
    sheet.popoverPresentationController?.sourceView = presenter.view
    sheet.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 1, width: 1, height: 1)
    sharing = true
    sheet.completionWithItemsHandler = { _, completed, _, error in
      self.sharing = false
      try? FileManager.default.removeItem(at: folder)
      if let error = error { invoke.reject(error.localizedDescription) }
      else { invoke.resolve(["status": completed ? "shared" : "cancelled"]) }
    }
    presenter.present(sheet, animated: true)
  }
}

@_cdecl("init_plugin_file_download")
func initPlugin() -> Plugin { FileDownloadPlugin() }
