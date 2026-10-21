#[tauri::command]
pub fn macos_set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
  if !scale.is_finite() || !(0.75..=2.0).contains(&scale) {
    return Err("Zoom must be between 75% and 200%".into());
  }
  #[cfg(target_os = "macos")]
  {
    use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};

    // WKWebView.pageZoom requires macOS 11; Baton also supports older systems.
    if !NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
      majorVersion: 11,
      minorVersion: 0,
      patchVersion: 0,
    }) {
      return Err("Native page zoom requires macOS 11 or newer".into());
    }
    window.set_zoom(scale).map_err(|error| error.to_string())
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = window;
    Err("This zoom command is only available on macOS".into())
  }
}
