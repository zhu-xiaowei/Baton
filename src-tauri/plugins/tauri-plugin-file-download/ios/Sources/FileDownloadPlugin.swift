import Foundation
import Tauri
import UIKit
import WebKit

struct DownloadArgs: Decodable {
  let url: String
  let name: String
  let requestId: String?
  let onProgress: Channel?
}

struct CancelArgs: Decodable { let requestId: String }

private struct DownloadProgress: Encodable {
  let received: Int64
  let total: Int64?
  let state: String
}

private final class DownloadRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    guard let url = request.url, url.scheme == "https", url.host != nil,
          url.user == nil, url.password == nil else { completionHandler(nil); return }
    completionHandler(request)
  }
}

class FileDownloadPlugin: Plugin {
  private class Transfer {
    let invoke: Invoke
    let args: DownloadArgs
    let name: String
    var localWriting = false
    var task: URLSessionDownloadTask?
    var progressTimer: Timer?
    var failure: String?
    var cancelled = false
    var waiters: [Invoke] = []
    var folder: URL?
    weak var sheet: UIActivityViewController?
    init(_ invoke: Invoke, _ args: DownloadArgs, _ name: String) {
      self.invoke = invoke; self.args = args; self.name = name
    }
  }

  private var active: Transfer?
  private var history: [String: (cancelled: Bool, at: TimeInterval)] = [:]
  private weak var webview: WKWebView?
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 300
    return URLSession(configuration: config, delegate: DownloadRedirects(), delegateQueue: nil)
  }()

  override public func load(webview: WKWebView) { self.webview = webview }

  private func prune() {
    let cutoff = ProcessInfo.processInfo.systemUptime - 60
    history = history.filter { $0.value.at > cutoff }
    while history.count > 256 {
      if let oldest = history.min(by: { $0.value.at < $1.value.at }) { history.removeValue(forKey: oldest.key) }
    }
  }

  private func record(_ id: String?, cancelled: Bool) {
    guard let id = id else { return }
    prune()
    if history[id] == nil { history[id] = (cancelled, ProcessInfo.processInfo.systemUptime) }
    prune()
  }

  @objc public func download(_ invoke: Invoke) {
    DispatchQueue.main.async { self.start(invoke) }
  }

  private func start(_ invoke: Invoke) {
    let args: DownloadArgs
    do { args = try invoke.parseArgs(DownloadArgs.self) }
    catch { invoke.reject("Invalid download arguments"); return }
    if let id = args.requestId {
      guard (1...128).contains(id.utf8.count) else { invoke.reject("requestId must contain 1–128 UTF-8 bytes"); return }
      prune()
      if let entry = history[id] {
        invoke.reject(entry.cancelled ? "Download cancelled" : "requestId has already been used"); return
      }
    }
    guard active == nil else { invoke.reject("A download or share is already in progress"); return }
    let name = (args.name.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
    guard !name.isEmpty, name != ".", name != ".." else { invoke.reject("Invalid filename"); return }
    let transfer = Transfer(invoke, args, name)
    active = transfer
    if args.url.hasPrefix("data:") { saveLocalImage(transfer); return }
    guard let url = URL(string: args.url), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else {
      finish(transfer, error: "Downloads require an HTTPS URL"); return
    }
    let task = session.downloadTask(with: url) { temporary, response, error in
      // URLSession owns the temporary URL only for this callback's lifetime.
      DispatchQueue.main.sync { self.received(transfer, temporary, response, error) }
    }
    transfer.task = task
    try? args.onProgress?.send(DownloadProgress(received: 0, total: nil, state: "connecting"))
    transfer.progressTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self, weak transfer] _ in
      guard let self = self, let transfer = transfer, self.active === transfer,
            !transfer.cancelled, let task = transfer.task else { return }
      let received = task.countOfBytesReceived
      let total = task.countOfBytesExpectedToReceive
      if received > 512 * 1024 * 1024 || total > 512 * 1024 * 1024 {
        transfer.failure = "File exceeds 512 MB"
        task.cancel()
        return
      }
      try? transfer.args.onProgress?.send(DownloadProgress(received: received,
        total: total >= 0 ? total : nil, state: "downloading"))
    }
    task.resume()
  }

  @objc public func cancel(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let args = try? invoke.parseArgs(CancelArgs.self), (1...128).contains(args.requestId.utf8.count) else {
        invoke.reject("Invalid requestId"); return
      }
      if let transfer = self.active, transfer.args.requestId == args.requestId {
        transfer.cancelled = true
        transfer.waiters.append(invoke)
        if transfer.localWriting { return }
        if let task = transfer.task {
          task.cancel()
        } else {
          transfer.sheet?.dismiss(animated: false)
          self.finish(transfer, error: "Download cancelled")
        }
      } else {
        self.record(args.requestId, cancelled: true)
        invoke.resolve()
      }
    }
  }

  private func finish(_ transfer: Transfer, error: String? = nil, result: [String: String]? = nil) {
    guard active === transfer else { return }
    transfer.progressTimer?.invalidate()
    transfer.progressTimer = nil
    var cleanupError: String?
    if let folder = transfer.folder {
      do { try FileManager.default.removeItem(at: folder) }
      catch { cleanupError = "Could not remove the temporary download" }
    }
    record(transfer.args.requestId, cancelled: transfer.cancelled)
    active = nil
    if transfer.cancelled { transfer.invoke.reject("Download cancelled") }
    else if let error = error { transfer.invoke.reject(error) }
    else { transfer.invoke.resolve(result ?? [:]) }
    for waiter in transfer.waiters {
      if let cleanupError = cleanupError { waiter.reject(cleanupError) }
      else { waiter.resolve() }
    }
    transfer.waiters.removeAll()
  }

  private func received(_ transfer: Transfer, _ temporary: URL?, _ response: URLResponse?, _ error: Error?) {
    guard active === transfer else { return }
    transfer.task = nil
    transfer.progressTimer?.invalidate()
    transfer.progressTimer = nil
    if transfer.cancelled {
      if let temporary = temporary { try? FileManager.default.removeItem(at: temporary) }
      finish(transfer, error: "Download cancelled"); return
    }
    if let error = error {
      let message = (error as NSError).code == NSURLErrorTimedOut
        ? "Download timed out waiting for data. Please retry." : "Download failed. Please retry."
      finish(transfer, error: transfer.failure ?? message); return
    }
    do {
      guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
            let temporary = temporary else { finish(transfer, error: "Download failed"); return }
      let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size <= 512 * 1024 * 1024 else { finish(transfer, error: "File exceeds 512 MB"); return }
      try? transfer.args.onProgress?.send(DownloadProgress(received: Int64(size), total: Int64(size), state: "downloading"))
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent("baton-download-" + UUID().uuidString)
      transfer.folder = folder
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let target = folder.appendingPathComponent(transfer.name)
      try FileManager.default.moveItem(at: temporary, to: target)
      share(transfer, target)
    } catch {
      finish(transfer, error: "Could not save download")
    }
  }
  private func saveLocalImage(_ transfer: Transfer) {
    transfer.localWriting = true
    try? transfer.args.onProgress?.send(DownloadProgress(received: 0, total: nil, state: "downloading"))
    DispatchQueue.global(qos: .userInitiated).async {
      var folder: URL?
      var target: URL?
      var failure: String?
      do {
        let bytes = try self.imageData(transfer.args.url)
        let current = DispatchQueue.main.sync { self.active === transfer && !transfer.cancelled }
        guard current else { throw NSError(domain: "Download cancelled", code: 1) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("baton-export-" + UUID().uuidString)
        folder = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(transfer.name)
        try bytes.write(to: file, options: .atomic)
        target = file
      } catch { failure = "Could not save image. Check its format and the 32 MiB limit." }
      DispatchQueue.main.async {
        transfer.localWriting = false
        transfer.folder = folder
        if transfer.cancelled { self.finish(transfer, error: "Download cancelled"); return }
        guard let target = target else { self.finish(transfer, error: failure ?? "Could not save image"); return }
        let size = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        try? transfer.args.onProgress?.send(DownloadProgress(received: Int64(size), total: Int64(size), state: "downloading"))
        self.share(transfer, target)
      }
    }
  }

  private func imageData(_ url: String) throws -> Data {
    let invalid = NSError(domain: "Invalid or oversized image data URL (maximum 32 MiB)", code: 1)
    guard let comma = url.prefix(64).firstIndex(of: ",") else { throw invalid }
    let header = String(url[..<comma])
    let types = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]
    guard types.contains(where: { header == "data:\($0);base64" }) else { throw invalid }
    let encoded = String(url[url.index(after: comma)...])
    let maximum = 32 * 1024 * 1024
    guard encoded.utf8.count <= ((maximum + 2) / 3) * 4,
          let bytes = Data(base64Encoded: encoded), !bytes.isEmpty, bytes.count <= maximum,
          bytes.base64EncodedString() == encoded else { throw invalid }
    return bytes
  }

  private func share(_ transfer: Transfer, _ target: URL) {
    guard var presenter = webview?.window?.rootViewController else {
      finish(transfer, error: "No window available for sharing"); return
    }
    while let presented = presenter.presentedViewController { presenter = presented }
    let sheet = UIActivityViewController(activityItems: [target], applicationActivities: nil)
    transfer.sheet = sheet
    sheet.popoverPresentationController?.sourceView = presenter.view
    sheet.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 1, width: 1, height: 1)
    sheet.completionWithItemsHandler = { _, completed, _, error in
      self.finish(transfer, error: error == nil ? nil : "Could not share download",
                  result: ["status": completed ? "shared" : "cancelled"])
    }
    presenter.present(sheet, animated: true)
  }

}

@_cdecl("init_plugin_file_download")
func initPlugin() -> Plugin { FileDownloadPlugin() }
