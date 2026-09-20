fn main() {
  tauri_plugin::Builder::new(&["download"])
    .android_path("android")
    .ios_path("ios")
    .build();
}
