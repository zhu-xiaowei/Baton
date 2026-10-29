fn main() {
    tauri_plugin::Builder::new(&["register", "listen", "take_pending"])
        .ios_path("ios")
        .build();
}
