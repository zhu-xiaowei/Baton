// swift-tools-version:5.3
import PackageDescription
let package = Package(
  name: "tauri-plugin-file-download",
  platforms: [.iOS(.v13)],
  products: [.library(name: "tauri-plugin-file-download", type: .static, targets: ["tauri-plugin-file-download"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-file-download", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
