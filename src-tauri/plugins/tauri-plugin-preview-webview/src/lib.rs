use tauri::{
  plugin::{Builder, TauriPlugin},
  Runtime,
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{release_owner, set_owner_visible};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_preview_webview);

#[cfg(target_os = "ios")]
extern "C" {
  fn clear_preview_webviews();
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  let builder = Builder::new("preview-webview");
  #[cfg(target_os = "macos")]
  let builder = builder
    .invoke_handler(tauri::generate_handler![
      macos::create,
      macos::navigate,
      macos::action,
      macos::layout,
      macos::remove
    ])
    .on_event(|app, event| {
      if let tauri::RunEvent::WindowEvent {
        label,
        event: tauri::WindowEvent::Destroyed,
        ..
      } = event
      {
        macos::close_window(app, label);
      }
    });
  #[cfg(any(target_os = "ios", target_os = "macos"))]
  let builder = builder.on_page_load(|webview, payload| {
    if payload.event() == tauri::webview::PageLoadEvent::Started {
      #[cfg(target_os = "macos")]
      macos::clear_host(webview);
      #[cfg(target_os = "ios")]
      let _ = webview.with_webview(|_| unsafe { clear_preview_webviews() });
    }
  });
  builder
    .setup(|_app, api| {
      #[cfg(target_os = "ios")]
      api.register_ios_plugin(init_plugin_preview_webview)?;
      #[cfg(not(target_os = "ios"))]
      let _ = api;
      Ok(())
    })
    .build()
}
