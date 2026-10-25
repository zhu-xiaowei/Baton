import Foundation
import Tauri
import UIKit
import WebKit

struct DownloadArgs: Decodable {
  let url: String
  let name: String
}

struct SaveArgs: Decodable {
  let name: String
  let data: String
}

class FileDownloadPlugin: Plugin {
  private var downloading = false
  private weak var webview: WKWebView?

  override public func load(webview: WKWebView) {
    self.webview = webview
  }

  @objc public func download(_ invoke: Invoke) {
    guard !downloading else { invoke.reject("A download or share is already in progress"); return }
    let args: DownloadArgs
    do { args = try invoke.parseArgs(DownloadArgs.self) }
    catch { invoke.reject("Invalid download arguments"); return }
    guard let url = URL(string: args.url), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else {
      invoke.reject("Downloads require an HTTPS URL"); return
    }
    let name = (args.name.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
    guard !name.isEmpty, name != ".", name != ".." else { invoke.reject("Invalid filename"); return }
    downloading = true
    let task = URLSession.shared.downloadTask(with: url) { [weak self] temporary, response, error in
      guard let self = self else { return }
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
        DispatchQueue.main.async { self.downloading = false; invoke.reject(error.localizedDescription) }
      }
    }
    task.resume()
  }

  // A file made on the device (e.g. a diagram image): no network, straight to the share sheet.
  @objc public func save(_ invoke: Invoke) {
    guard !downloading else { invoke.reject("A download or share is already in progress"); return }
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
    downloading = true
    DispatchQueue.main.async { self.share(target, folder, invoke) }
  }

  private func share(_ target: URL, _ folder: URL, _ invoke: Invoke) {
    guard var presenter = webview?.window?.rootViewController else {
      downloading = false
      try? FileManager.default.removeItem(at: folder)
      invoke.reject("No window available for sharing"); return
    }
    while let presented = presenter.presentedViewController { presenter = presented }
    let sheet = UIActivityViewController(activityItems: [target], applicationActivities: nil)
    sheet.popoverPresentationController?.sourceView = presenter.view
    sheet.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 1, width: 1, height: 1)
    sheet.completionWithItemsHandler = { _, completed, _, error in
      self.downloading = false
      try? FileManager.default.removeItem(at: folder)
      if let error = error { invoke.reject(error.localizedDescription) }
      else { invoke.resolve(["status": completed ? "shared" : "cancelled"]) }
    }
    presenter.present(sheet, animated: true)
  }
}

@_cdecl("init_plugin_file_download")
func initPlugin() -> Plugin { FileDownloadPlugin() }
