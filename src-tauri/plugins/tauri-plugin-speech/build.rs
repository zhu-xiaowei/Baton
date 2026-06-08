const COMMANDS: &[&str] = &["start_recognition", "stop_recognition", "request_permission"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
