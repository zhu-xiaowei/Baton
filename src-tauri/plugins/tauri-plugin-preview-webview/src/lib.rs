use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_preview_webview);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("preview-webview").setup(|_app, api| {
    #[cfg(target_os = "ios")]
    api.register_ios_plugin(init_plugin_preview_webview)?;
    #[cfg(not(target_os = "ios"))]
    let _ = api;
    Ok(())
  }).build()
}
