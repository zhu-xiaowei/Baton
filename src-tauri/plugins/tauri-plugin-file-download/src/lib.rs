use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod filename;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_file_download);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct ProgressReader<R> {
  inner: R,
  loaded: u64,
  total: Option<u64>,
  channel: tauri::ipc::Channel<serde_json::Value>,
  reported_at: Option<std::time::Instant>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl<R: std::io::Read> std::io::Read for ProgressReader<R> {
  fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
    let size = self.inner.read(buffer)?;
    self.loaded += size as u64;
    if let Some(total) = self.total {
      if size > 0 && self.reported_at.map_or(true, |at| at.elapsed().as_millis() >= 200) {
        self.reported_at = Some(std::time::Instant::now());
        let _ = self.channel.send(serde_json::json!({ "loaded": self.loaded, "total": total }));
      }
    }
    Ok(size)
  }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn download<R: Runtime>(app: tauri::AppHandle<R>, url: String, name: String,
  on_progress: tauri::ipc::Channel<serde_json::Value>) -> Result<serde_json::Value, String> {
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
    let total = response.content_length();
    let reader = ProgressReader { inner: response, loaded: 0, total, channel: on_progress, reported_at: None };
    let result = std::io::copy(&mut reader.take(max_bytes + 1), &mut file)
      .map_err(|error| error.to_string())
      .and_then(|size| if size > max_bytes { Err("File exceeds 512 MB".to_string()) } else { Ok(size) });
    drop(file);
    if let Err(error) = result { let _ = std::fs::remove_file(&path); return Err(error); }
    #[cfg(target_os = "macos")]
    bounce_downloads_stack(&path);
    Ok(serde_json::json!({ "status": "saved", "path": path }))
  }).await.map_err(|error| error.to_string())?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn save<R: Runtime>(app: tauri::AppHandle<R>, name: String, data: String) -> Result<serde_json::Value, String> {
  use base64::Engine;
  use std::io::Write;
  use tauri::Manager;
  let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "Invalid file data".to_string())?;
  let directory = app.path().download_dir().map_err(|error| error.to_string())?;
  tauri::async_runtime::spawn_blocking(move || {
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let (path, mut file) = filename::reserve_file(&directory, &name).map_err(|error| error.to_string())?;
    let result = file.write_all(&bytes).map_err(|error| error.to_string());
    drop(file);
    if let Err(error) = result { let _ = std::fs::remove_file(&path); return Err(error); }
    #[cfg(target_os = "macos")]
    bounce_downloads_stack(&path);
    Ok(serde_json::json!({ "status": "saved", "path": path }))
  }).await.map_err(|error| error.to_string())?
}

// The same distributed notification Safari posts: the Dock's Downloads stack bounces for the file.
#[cfg(target_os = "macos")]
fn bounce_downloads_stack(path: &std::path::Path) {
  use objc2_foundation::{NSDistributedNotificationCenter, NSString};
  let name = NSString::from_str("com.apple.DownloadFileFinished");
  let file = NSString::from_str(&path.to_string_lossy());
  unsafe { NSDistributedNotificationCenter::defaultCenter().postNotificationName_object(&name, Some(&file)); }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  let builder = Builder::new("file-download");
  #[cfg(not(any(target_os = "android", target_os = "ios")))]
  let builder = builder.invoke_handler(tauri::generate_handler![download, save]);
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
