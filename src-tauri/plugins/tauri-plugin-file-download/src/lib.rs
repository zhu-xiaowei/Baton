use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod filename;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod local_image;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod operations;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod transfer;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone, Default)]
struct DownloadState {
  receipts: std::sync::Arc<std::sync::Mutex<desktop::Receipts>>,
  operations: operations::Operations,
}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_file_download);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn download<R: Runtime>(
  app: tauri::AppHandle<R>,
  webview: tauri::Webview<R>,
  state: tauri::State<'_, DownloadState>,
  url: String,
  name: String,
  mime: Option<String>,
  on_progress: Option<tauri::ipc::JavaScriptChannelId>,
  request_id: Option<String>,
) -> Result<serde_json::Value, String> {
  use tauri::Manager;
  let _ = mime;
  let owner = webview.label().to_owned();
  let mut operation = state.operations.begin(&owner, request_id.as_deref())?;
  let on_progress: Option<tauri::ipc::Channel<serde_json::Value>> =
    on_progress.map(|id| id.channel_on(webview));
  let directory = app.path().download_dir().map_err(|error| error.to_string())?;
  if let Some(channel) = &on_progress {
    let _ = channel.send(serde_json::json!({ "received": 0, "total": null, "state": "connecting" }));
  }
  let pending = operation.run(async {
    if url.starts_with("data:") {
      return local_image::save(&url, &directory, &name, |received, total| {
        if let Some(channel) = &on_progress {
          let _ = channel.send(serde_json::json!({ "received": received, "total": total }));
        }
      }).await;
    }
    let url = transfer::parse_url(&url)?;
    transfer::save(transfer::client()?, url, &directory, &name, transfer::IDLE_TIMEOUT, |received, total| {
      if let Some(channel) = &on_progress {
        let _ = channel.send(serde_json::json!({ "received": received, "total": total }));
      }
    }).await
  }).await?;
  operation.complete(|| {
    let id = state.receipts.lock().map_err(|_| "Download receipts unavailable".to_string())?
      .insert(&owner, pending.path()).map_err(|error| error.to_string())?;
    let result = serde_json::json!({
      "status": "saved",
      "canOpen": cfg!(any(target_os = "macos", target_os = "linux")),
      "canReveal": cfg!(any(target_os = "macos", target_os = "linux")),
      "id": id,
      "path": pending.path(),
      "name": pending.path().file_name().unwrap().to_string_lossy(),
    });
    pending.commit();
    Ok(result)
  })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn cancel<R: Runtime>(
  webview: tauri::Webview<R>,
  state: tauri::State<'_, DownloadState>,
  request_id: String,
) -> Result<(), String> {
  if let Some(mut finished) = state.operations.cancel(webview.label(), &request_id)? {
    finished.wait_for(|done| *done).await.map_err(|_| "Download cancellation acknowledgement lost")?;
  }
  Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn use_receipt(state: DownloadState, owner: String, id: String, reveal: bool) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    desktop::open_receipt(&state.receipts, &owner, &id, reveal).map_err(|error| error.to_string())
  }).await.map_err(|error| error.to_string())?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn open_download<R: Runtime>(webview: tauri::Webview<R>, state: tauri::State<'_, DownloadState>, id: String) -> Result<(), String> {
  use_receipt(state.inner().clone(), webview.label().to_owned(), id, false).await
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn reveal_download<R: Runtime>(webview: tauri::Webview<R>, state: tauri::State<'_, DownloadState>, id: String) -> Result<(), String> {
  use_receipt(state.inner().clone(), webview.label().to_owned(), id, true).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  let builder = Builder::new("file-download");
  #[cfg(not(any(target_os = "android", target_os = "ios")))]
  let builder = builder.invoke_handler(tauri::generate_handler![download, cancel, open_download, reveal_download]);
  builder.setup(|_app, api| {
    #[cfg(target_os = "ios")]
    api.register_ios_plugin(init_plugin_file_download)?;
    #[cfg(target_os = "android")]
    api.register_android_plugin("com.batonai.download", "FileDownloadPlugin")?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
      use tauri::Manager;
      let _ = api;
      _app.manage(DownloadState::default());
    }
    Ok(())
  }).build()
}
