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

private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
  private let progress: Channel?
  private let completion: (URLSessionDownloadTask, URL?, Error?) -> Void
  private var reportedBytes: Int64 = 0

  init(progress: Channel?, completion: @escaping (URLSessionDownloadTask, URL?, Error?) -> Void) {
    self.progress = progress
    self.completion = completion
    super.init()
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                  didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                  totalBytesExpectedToWrite: Int64) {
    // Report after >1% more bytes; completion follows the file move.
    guard totalBytesWritten > 0, totalBytesExpectedToWrite > totalBytesWritten else { return }
    guard totalBytesWritten - reportedBytes > totalBytesExpectedToWrite / 100 else { return }
    reportedBytes = totalBytesWritten
    try? progress?.send(DownloadProgress(loaded: totalBytesWritten, total: totalBytesExpectedToWrite))
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                  didFinishDownloadingTo location: URL) {
    // URLSession removes this file when the callback returns, so move it synchronously.
    completion(downloadTask, location, nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    session.finishTasksAndInvalidate()
    if let error = error, let downloadTask = task as? URLSessionDownloadTask {
      completion(downloadTask, nil, error)
    }
  }
}

// One download at a time: a new download or `cancel` stops the current one, which resolves as cancelled.
class FileDownloadPlugin: Plugin {
  private var task: URLSessionDownloadTask?
  private var sharing = false
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
    let delegate = DownloadDelegate(progress: channel) { [weak self] task, temporary, error in
      guard let self = self else { return }
      DispatchQueue.main.async {
        guard self.task === task else { return }
        self.task = nil
      }
      if (error as? URLError)?.code == .cancelled {
        invoke.resolve(["status": "cancelled"]); return
      }
      var directory: URL?
      do {
        if let error = error { throw error }
        guard let response = task.response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              let temporary = temporary else { throw NSError(domain: "Download failed", code: 1) }
        let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 512 * 1024 * 1024 else { throw NSError(domain: "File exceeds 512 MB", code: 1) }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("baton-download-" + UUID().uuidString)
        directory = folder
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent(name)
        try FileManager.default.moveItem(at: temporary, to: target)
        DispatchQueue.main.async {
          // Always send completion before sharing: invoke only resolves after the
          // share sheet is dismissed. Empty files also need a completed fraction.
          let total = max(Int64(size), 1)
          try? channel?.send(DownloadProgress(loaded: total, total: total))
          self.share(target, folder, invoke)
        }
      } catch {
        if let directory = directory { try? FileManager.default.removeItem(at: directory) }
        invoke.reject(error.localizedDescription)
      }
    }
    let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
    let task = session.downloadTask(with: url)
    self.task = task
    task.resume()
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
