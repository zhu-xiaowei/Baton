import Foundation
import ObjectiveC.runtime
import Security
import Tauri
import UIKit
import UserNotifications
import WebKit

private struct RegisterArgs: Decodable {
  let server: String
  let apiKey: String
}

// The notification extension resolves each ID-only push against the user's own server.
// It reads these through a shared keychain group (Info.plist), also while locked.
enum SharedServer {
  private static let item: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.batonai.push",
    kSecAttrAccount as String: "server",
    kSecAttrAccessGroup as String: Bundle.main.object(forInfoDictionaryKey: "BatonKeychainGroup") as? String ?? "",
  ]

  static func save(server: String, apiKey: String) {
    clear()
    var add = item
    add[kSecValueData as String] = try? JSONSerialization.data(withJSONObject: ["server": server, "apiKey": apiKey])
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(add as CFDictionary, nil)
  }

  static func clear() {
    SecItemDelete(item as CFDictionary)
  }
}

private struct ListenArgs: Decodable {
  let onClick: Channel
}

private struct OpenArgs: Decodable {
  let sessionId: String
}

// Outlives webview navigation. Taps are persisted before JS is signaled, so a cold
// launch or a sign-in redirect cannot lose the destination.
private final class PushCoordinator: NSObject, UNUserNotificationCenterDelegate {
  static let shared = PushCoordinator()
  private let pendingKey = "baton.pendingPushNavigation"
  private var hookedDelegate: ObjectIdentifier?
  private var registrations: [Invoke] = []
  private var registrationTimeout: DispatchWorkItem?
  var onClick: Channel?
  var openSession = ""

  func install() {
    UNUserNotificationCenter.current().delegate = self
    guard let delegate = UIApplication.shared.delegate else { return }
    let delegateClass: AnyClass = type(of: delegate)
    guard hookedDelegate != ObjectIdentifier(delegateClass) else { return }
    hookedDelegate = ObjectIdentifier(delegateClass)

    // Tao owns the UIApplicationDelegate: add the APNs callbacks to its class,
    // keeping any existing implementation.
    let success = #selector(UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:))
    let originalSuccess = class_getInstanceMethod(delegateClass, success).map(method_getImplementation)
    typealias Success = @convention(c) (AnyObject, Selector, UIApplication, NSData) -> Void
    let successBlock: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { receiver, app, token in
      PushCoordinator.shared.finish(token: (token as Data).map { String(format: "%02x", $0) }.joined())
      if let original = originalSuccess {
        unsafeBitCast(original, to: Success.self)(receiver, success, app, token)
      }
    }
    class_replaceMethod(delegateClass, success, imp_implementationWithBlock(successBlock), "v@:@@")

    let failure = #selector(UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:))
    let originalFailure = class_getInstanceMethod(delegateClass, failure).map(method_getImplementation)
    typealias Failure = @convention(c) (AnyObject, Selector, UIApplication, NSError) -> Void
    let failureBlock: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { receiver, app, error in
      PushCoordinator.shared.finish(error: error.localizedDescription)
      if let original = originalFailure {
        unsafeBitCast(original, to: Failure.self)(receiver, failure, app, error)
      }
    }
    class_replaceMethod(delegateClass, failure, imp_implementationWithBlock(failureBlock), "v@:@@")
  }

  func register(_ invoke: Invoke) {
    install()
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
      DispatchQueue.main.async {
        if let error = error { return invoke.reject(error.localizedDescription) }
        guard granted else { return invoke.resolve(["granted": false]) }
        self.registrations.append(invoke)
        guard self.registrations.count == 1 else { return }
        let timeout = DispatchWorkItem { [weak self] in
          self?.finish(error: "APNs registration timed out. Check network access and push signing.")
        }
        self.registrationTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
        UIApplication.shared.registerForRemoteNotifications()
      }
    }
  }

  private func finish(token: String? = nil, error: String? = nil) {
    registrationTimeout?.cancel()
    registrationTimeout = nil
    let waiting = registrations
    registrations.removeAll()
    // Debug builds use the APNs sandbox, release/TestFlight production (Info.plist).
    let environment = Bundle.main.object(forInfoDictionaryKey: "BatonPushEnvironment") as? String ?? ""
    for invoke in waiting {
      if let token = token {
        invoke.resolve(["granted": true, "token": token, "environment": environment])
      } else {
        invoke.reject(error ?? "APNs registration failed.")
      }
    }
  }

  func takePending() -> [[String: String]] {
    let pending = UserDefaults.standard.array(forKey: pendingKey) as? [[String: String]] ?? []
    UserDefaults.standard.removeObject(forKey: pendingKey)
    return pending
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    // Only called in the foreground: the session already on screen needs no alert.
    let session = notification.request.content.userInfo["rootSessionId"] as? String
    if !openSession.isEmpty && session == openSession {
      completion([])
    } else if #available(iOS 14.0, *) {
      completion([.banner, .list, .sound])
    } else {
      completion([.alert, .sound])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completion: @escaping () -> Void
  ) {
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return completion() }
    let data = response.notification.request.content.userInfo.reduce(into: [String: String]()) { result, entry in
      if let key = entry.key as? String, let value = entry.value as? String {
        result[key] = value
      }
    }
    DispatchQueue.main.async {
      var pending = UserDefaults.standard.array(forKey: self.pendingKey) as? [[String: String]] ?? []
      pending.append(data)
      UserDefaults.standard.set(Array(pending.suffix(10)), forKey: self.pendingKey)
      try? self.onClick?.send(["pending": true])
      completion()
    }
  }
}

class PushPlugin: Plugin {
  override init() {
    super.init()
    PushCoordinator.shared.install()
  }

  public override func load(webview: WKWebView) {
    super.load(webview: webview)
    PushCoordinator.shared.install()
  }

  @objc public func register(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(RegisterArgs.self)
    SharedServer.save(server: args.server, apiKey: args.apiKey)
    PushCoordinator.shared.register(invoke)
  }

  @objc public func stop(_ invoke: Invoke) {
    SharedServer.clear()
    invoke.resolve()
  }

  @objc public func listen(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ListenArgs.self)
    DispatchQueue.main.async {
      PushCoordinator.shared.onClick = args.onClick
      invoke.resolve()
    }
  }

  @objc public func setOpen(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    DispatchQueue.main.async {
      PushCoordinator.shared.openSession = args.sessionId
      invoke.resolve()
    }
  }

  @objc public func takePending(_ invoke: Invoke) {
    DispatchQueue.main.async { invoke.resolve(["events": PushCoordinator.shared.takePending()]) }
  }
}

@_cdecl("init_plugin_push")
func initPlugin() -> Plugin { PushPlugin() }
