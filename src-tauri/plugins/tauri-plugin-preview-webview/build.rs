fn main() {
  tauri_plugin::Builder::new(&["create", "navigate", "action", "layout", "remove"])
    .ios_path("ios")
    .build();
}
