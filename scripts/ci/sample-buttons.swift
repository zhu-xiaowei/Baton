// Samples the close button's offset from the window top every 5ms and prints each change.
import ApplicationServices
import Foundation
let pid = pid_t(CommandLine.arguments[1])!
let seconds = Double(CommandLine.arguments[2])!
let app = AXUIElementCreateApplication(pid)
func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}
func point(_ el: AXUIElement) -> CGPoint? {
  guard let v = attr(el, kAXPositionAttribute) else { return nil }
  var p = CGPoint.zero
  AXValueGetValue(v as! AXValue, .cgPoint, &p)
  return p
}
let start = Date()
var last = ""
while Date().timeIntervalSince(start) < seconds {
  if let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement], let w = windows.first,
     let wp = point(w) {
    let line = [kAXCloseButtonAttribute, kAXMinimizeButtonAttribute, kAXZoomButtonAttribute].map { name -> String in
      guard let b = attr(w, name), let p = point(b as! AXUIElement) else { return "-" }
      return "\(p.x - wp.x),\(p.y - wp.y)"
    }.joined(separator: " ")
    if line != last { print(String(format: "%.3f ", Date().timeIntervalSince(start)) + line); last = line; fflush(stdout) }
  }
  usleep(5000)
}
