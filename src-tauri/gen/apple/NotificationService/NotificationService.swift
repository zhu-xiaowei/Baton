import Foundation
import Security
import UserNotifications

// A push carries only an event ID: the relay and Apple never see the text. Resolve it
// against the user's own server (credentials shared by the app through a keychain group);
// if that fails in time, the placeholder from the push is shown and the tap still works.
final class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?
  private var task: URLSessionDataTask?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let content = request.content.mutableCopy() as! UNMutableNotificationContent
    self.content = content
    deliver = contentHandler
    guard let id = content.userInfo["id"] as? String,
          let (server, apiKey) = Self.credentials(),
          var url = URLComponents(string: server + "/api/notifications/event") else {
      return finish()
    }
    url.queryItems = [URLQueryItem(name: "id", value: id)]
    var fetch = URLRequest(url: url.url!, timeoutInterval: 20)
    fetch.setValue(apiKey, forHTTPHeaderField: "x-api-key")
    task = URLSession.shared.dataTask(with: fetch) { [weak self] data, response, _ in
      if (response as? HTTPURLResponse)?.statusCode == 200,
         let data = data,
         let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
        // Two bold lines, each truncated on its own: a long project name no longer hides the session.
        content.title = event["projectName"] as? String ?? event["title"] as? String ?? content.title
        content.subtitle = event["sessionTitle"] as? String ?? ""
        content.body = event["body"] as? String ?? content.body
        content.threadIdentifier = event["rootSessionId"] as? String ?? ""
        // The app opens the session from these on tap.
        content.userInfo = event.compactMapValues { $0 as? String }.merging(["id": id]) { $1 }
      }
      self?.finish()
    }
    task?.resume()
  }

  override func serviceExtensionTimeWillExpire() {
    task?.cancel()
    finish()
  }

  private func finish() {
    guard let deliver = deliver, let content = content else { return }
    self.deliver = nil
    deliver(content)
  }

  private static func credentials() -> (String, String)? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.batonai.push",
      kSecAttrAccount as String: "server",
      kSecAttrAccessGroup as String: Bundle.main.object(forInfoDictionaryKey: "BatonKeychainGroup") as? String ?? "",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data,
          let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
          let server = saved["server"], let apiKey = saved["apiKey"] else { return nil }
    return (server, apiKey)
  }
}
