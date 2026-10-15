// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-preview-webview",
  platforms: [.iOS(.v14)],
  products: [.library(name: "tauri-plugin-preview-webview", type: .static, targets: ["tauri-plugin-preview-webview"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-preview-webview", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
