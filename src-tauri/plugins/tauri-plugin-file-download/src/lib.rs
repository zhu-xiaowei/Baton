use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod filename;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_file_download);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn download<R: Runtime>(app: tauri::AppHandle<R>, url: String, name: String) -> Result<serde_json::Value, String> {
  use std::{io::Read, time::Duration};
  use tauri::Manager;
  let directory = app.path().download_dir().map_err(|error| error.to_string())?;
  tauri::async_runtime::spawn_blocking(move || {
    let url = reqwest::Url::parse(&url).map_err(|_| "Invalid download URL".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
      return Err("Downloads require an HTTPS URL".to_string());
    }
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(3600))
      .https_only(true).build().map_err(|error| error.to_string())?;
    let response = client.get(url).send().and_then(|response| response.error_for_status())
      .map_err(|error| error.without_url().to_string())?;
    let max_bytes = 512 * 1024 * 1024;
    if response.content_length().is_some_and(|size| size > max_bytes) { return Err("File exceeds 512 MB".to_string()); }
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let (path, mut file) = filename::reserve_file(&directory, &name).map_err(|error| error.to_string())?;
    let result = std::io::copy(&mut response.take(max_bytes + 1), &mut file)
      .map_err(|error| error.to_string())
      .and_then(|size| if size > max_bytes { Err("File exceeds 512 MB".to_string()) } else { Ok(size) });
    drop(file);
    if let Err(error) = result { let _ = std::fs::remove_file(&path); return Err(error); }
    Ok(serde_json::json!({ "status": "saved", "path": path }))
  }).await.map_err(|error| error.to_string())?
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  let builder = Builder::new("file-download");
  #[cfg(not(any(target_os = "android", target_os = "ios")))]
  let builder = builder.invoke_handler(tauri::generate_handler![download]);
  builder.setup(|_app, api| {
    #[cfg(target_os = "ios")]
    api.register_ios_plugin(init_plugin_file_download)?;
    #[cfg(target_os = "android")]
    api.register_android_plugin("com.batonai.download", "FileDownloadPlugin")?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = api;
    Ok(())
  }).build()
}
