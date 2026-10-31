fn main() {
    tauri_plugin::Builder::new(&["register", "start", "stop", "listen", "take_pending", "set_open", "open_settings"])
        .android_path("android")
        .ios_path("ios")
        .build();
}
