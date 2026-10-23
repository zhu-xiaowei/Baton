#[path = "../../../src-tauri/plugins/tauri-plugin-file-download/src/filename.rs"]
pub mod filename;
#[path = "../../../src-tauri/plugins/tauri-plugin-file-download/src/desktop.rs"]
pub mod desktop;
#[path = "../../../src-tauri/plugins/tauri-plugin-file-download/src/operations.rs"]
pub mod operations;
pub mod local_image {
    include!("../../../src-tauri/plugins/tauri-plugin-file-download/src/local_image.rs");
    #[cfg(test)]
    include!("rust.rs");
}
