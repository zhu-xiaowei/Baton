fn main() {
  tauri_plugin::Builder::new(&["download", "cancel", "save"])
    .android_path("android")
    .ios_path("ios")
    .build();
}
