fn main() {
  tauri_plugin::Builder::new(&["download", "save"])
    .android_path("android")
    .ios_path("ios")
    .build();
}
