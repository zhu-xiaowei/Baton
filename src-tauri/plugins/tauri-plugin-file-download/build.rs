fn main() {
  tauri_plugin::Builder::new(&["download", "cancel", "open_download", "reveal_download"])
    .android_path("android")
    .ios_path("ios")
    .build();
}
