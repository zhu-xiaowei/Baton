import AppKit
let dir = CommandLine.arguments[1], out = CommandLine.arguments[2]
for app in try! FileManager.default.contentsOfDirectory(atPath: dir).filter({ $0.hasSuffix(".app") }).sorted() {
  let icon = NSWorkspace.shared.icon(forFile: "\(dir)/\(app)")
  for px in [128, 256, 512] {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    icon.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(app)-\(px).png"))
  }
  print(app, icon.representations.map { "\($0.pixelsWide)" })
}
