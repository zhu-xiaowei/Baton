// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-apns",
  platforms: [.iOS(.v13)],
  products: [
    .library(name: "tauri-plugin-apns", type: .static, targets: ["tauri-plugin-apns"])
  ],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [
    .target(name: "tauri-plugin-apns", dependencies: [.byName(name: "Tauri")], path: "Sources")
  ]
)
