import Foundation
import ObjectiveC.runtime
import Tauri
import UIKit
import UserNotifications
import WebKit

private struct ListenArgs: Decodable {
  let onClick: Channel
}

// This object outlives webview navigation. Persist taps before signaling JS, so
// a cold launch or a sign-in redirect cannot lose the destination.
private final class PushCoordinator: NSObject, UNUserNotificationCenterDelegate {
  static let shared = PushCoordinator()
  private let pendingKey = "baton.pendingPushNavigation"
  private var localDelegate: UNUserNotificationCenterDelegate?
  private var installedApplicationDelegate: ObjectIdentifier?
  private var registrations: [Invoke] = []
  private var registrationTimeout: DispatchWorkItem?
  var onClick: Channel?

  func install() {
    let center = UNUserNotificationCenter.current()
    if center.delegate !== self {
      localDelegate = center.delegate
      center.delegate = self
    }
    guard let delegate = UIApplication.shared.delegate else { return }
    let delegateClass: AnyClass = type(of: delegate)
    let identifier = ObjectIdentifier(delegateClass)
    guard installedApplicationDelegate != identifier else { return }
    installedApplicationDelegate = identifier

    // Tao owns UIApplicationDelegate. Add APNs callbacks to its actual class,
    // preserving any existing implementation instead of replacing its delegate.
    let success = #selector(UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:))
    let originalSuccess = class_getInstanceMethod(delegateClass, success).map(method_getImplementation)
    typealias Success = @convention(c) (AnyObject, Selector, UIApplication, NSData) -> Void
    let successBlock: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { receiver, app, token in
      PushCoordinator.shared.registered(token as Data)
      if let original = originalSuccess {
        unsafeBitCast(original, to: Success.self)(receiver, success, app, token)
      }
    }
    class_replaceMethod(delegateClass, success, imp_implementationWithBlock(successBlock), "v@:@@")

    let failure = #selector(UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:))
    let originalFailure = class_getInstanceMethod(delegateClass, failure).map(method_getImplementation)
    typealias Failure = @convention(c) (AnyObject, Selector, UIApplication, NSError) -> Void
    let failureBlock: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { receiver, app, error in
      PushCoordinator.shared.failed(error.localizedDescription)
      if let original = originalFailure {
        unsafeBitCast(original, to: Failure.self)(receiver, failure, app, error)
      }
    }
    class_replaceMethod(delegateClass, failure, imp_implementationWithBlock(failureBlock), "v@:@@")
  }

  func register(_ invoke: Invoke) {
    install()
    registrations.append(invoke)
    guard registrations.count == 1 else { return }
    let timeout = DispatchWorkItem { [weak self] in
      self?.failed("APNs registration timed out. Check network access and push signing.")
    }
    registrationTimeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
    UIApplication.shared.registerForRemoteNotifications()
  }

  private func registered(_ data: Data) {
    registrationTimeout?.cancel()
    registrationTimeout = nil
    let token = data.map { String(format: "%02x", $0) }.joined()
    let waiting = registrations
    registrations.removeAll()
    waiting.forEach { $0.resolve(["token": token]) }
  }

  private func failed(_ message: String) {
    registrationTimeout?.cancel()
    registrationTimeout = nil
    let waiting = registrations
    registrations.removeAll()
    waiting.forEach { $0.reject(message) }
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
    if notification.request.trigger is UNPushNotificationTrigger {
      if #available(iOS 14.0, *) {
        completion([.banner, .list, .sound])
      } else {
        completion([.alert, .sound])
      }
    } else if let handler = localDelegate,
              handler.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
      handler.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completion)
    } else {
      completion([])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completion: @escaping () -> Void
  ) {
    if response.notification.request.trigger is UNPushNotificationTrigger {
      if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
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
      } else {
        completion()
      }
    } else if let handler = localDelegate,
              handler.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
      handler.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completion)
    } else {
      completion()
    }
  }
}

class ApnsPlugin: Plugin {
  override init() {
    super.init()
    PushCoordinator.shared.install()
  }

  public override func load(webview: WKWebView) {
    super.load(webview: webview)
    PushCoordinator.shared.install()
  }

  @objc public func register(_ invoke: Invoke) {
    DispatchQueue.main.async { PushCoordinator.shared.register(invoke) }
  }

  @objc public func listen(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ListenArgs.self)
    DispatchQueue.main.async {
      PushCoordinator.shared.onClick = args.onClick
      invoke.resolve()
    }
  }

  @objc public func takePending(_ invoke: Invoke) {
    DispatchQueue.main.async { invoke.resolve(PushCoordinator.shared.takePending()) }
  }
}

@_cdecl("init_plugin_apns")
func initPlugin() -> Plugin { ApnsPlugin() }
