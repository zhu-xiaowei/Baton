fn main() {
  tauri_plugin::Builder::new(&["download", "cancel"])
    .android_path("android")
    .ios_path("ios")
    .build();
}
