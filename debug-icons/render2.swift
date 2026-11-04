import AppKit
let out = CommandLine.arguments[1]
for (name, path) in stride(from: 2, to: CommandLine.arguments.count, by: 2).map({ (CommandLine.arguments[$0], CommandLine.arguments[$0 + 1]) }) {
  let icon = NSWorkspace.shared.icon(forFile: path)
  let px = 256
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  icon.draw(in: NSRect(x: 0, y: 0, width: px, height: px)); NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
  print(name, path)
}
