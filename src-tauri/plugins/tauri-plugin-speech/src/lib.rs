// Speech-to-text plugin. iOS only (SFSpeechRecognizer). Commands route directly
// to the Swift plugin's @objc methods — no Rust invoke_handler needed.
#![cfg(mobile)]

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_speech);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("speech")
        .setup(|_app, api| {
            #[cfg(target_os = "ios")]
            api.register_ios_plugin(init_plugin_speech)?;
            Ok(())
        })
        .build()
}
