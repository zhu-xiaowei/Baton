use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub struct Appearance {
  pub mode: String,
  pub canvas: String,
  pub surface: String,
  pub strip: String,
}

impl Default for Appearance {
  fn default() -> Self {
    Self {
      mode: "dark".into(),
      canvas: "#0d1117".into(),
      surface: "#161b22".into(),
      strip: "#010409".into(),
    }
  }
}

impl Appearance {
  fn valid(&self) -> bool {
    matches!(self.mode.as_str(), "light" | "dark")
      && [&self.canvas, &self.surface, &self.strip].iter().all(|color| {
        color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|c| c.is_ascii_hexdigit())
      })
  }

  #[cfg(desktop)]
  fn theme(&self) -> tauri::Theme {
    if self.mode == "light" { tauri::Theme::Light } else { tauri::Theme::Dark }
  }

  #[cfg(desktop)]
  pub fn color(&self, strip: bool) -> tauri::webview::Color {
    let value = if strip { &self.strip } else { &self.surface };
    let rgb = u32::from_str_radix(&value[1..], 16).unwrap_or(0x161b22);
    tauri::webview::Color((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255)
  }
}

#[cfg(target_os = "macos")]
pub fn current(app: &tauri::AppHandle) -> Appearance {
  app.state::<Mutex<Appearance>>().lock().unwrap_or_else(|error| error.into_inner()).clone()
}

fn apply(app: &tauri::AppHandle, appearance: &Appearance) {
  #[cfg(desktop)]
  {
    app.set_theme(Some(appearance.theme()));
    // Per-window and per-webview access needs Tauri's `unstable` feature, enabled only on macOS.
    #[cfg(not(target_os = "macos"))]
    for window in app.webview_windows().values() {
      let _ = window.set_theme(Some(appearance.theme()));
      let _ = window.set_background_color(Some(appearance.color(false)));
    }
    #[cfg(target_os = "macos")]
    for window in app.windows().values() {
      let _ = window.set_theme(Some(appearance.theme()));
      let _ = window.set_background_color(Some(appearance.color(false)));
    }
    // WKWebView does not implement Tauri's set_background_color.
    #[cfg(target_os = "macos")]
    for webview in app.webviews().values() {
      let color = appearance.color(webview.label().starts_with("tab-strip-"));
      let _ = webview.with_webview(move |platform| unsafe {
        use objc2::{msg_send, sel};
        use objc2_app_kit::NSColor;
        use objc2_foundation::{NSObject, NSObjectProtocol};
        let view = &*(platform.inner() as *const NSObject);
        if view.respondsToSelector(sel!(setUnderPageBackgroundColor:)) {
          let native = NSColor::colorWithSRGBRed_green_blue_alpha(
            f64::from(color.0) / 255.0, f64::from(color.1) / 255.0,
            f64::from(color.2) / 255.0, 1.0,
          );
          let _: () = msg_send![view, setUnderPageBackgroundColor: &*native];
        }
      });
    }
    #[cfg(target_os = "macos")]
    tauri_plugin_preview_webview::set_appearance(app, appearance.mode == "light", &appearance.canvas);
  }
  #[cfg(mobile)]
  let _ = (app, appearance);
}

pub fn setup(app: &tauri::AppHandle) {
  let saved = app.path().app_config_dir().ok()
    .and_then(|dir| std::fs::read(dir.join("appearance.json")).ok())
    .and_then(|bytes| serde_json::from_slice::<Appearance>(&bytes).ok())
    .filter(Appearance::valid)
    .unwrap_or_default();
  app.manage(Mutex::new(saved.clone()));
  apply(app, &saved);
}

#[tauri::command]
pub fn appearance_set(app: tauri::AppHandle, appearance: Appearance) -> Result<(), String> {
  if !appearance.valid() { return Err("Invalid appearance".into()); }
  let state = app.state::<Mutex<Appearance>>();
  let mut current = state.lock().unwrap_or_else(|error| error.into_inner());
  if *current == appearance { return Ok(()); }
  *current = appearance.clone();
  if let Ok(dir) = app.path().app_config_dir() {
    if let Err(error) = std::fs::create_dir_all(&dir)
      .and_then(|_| std::fs::write(dir.join("appearance.json"), serde_json::to_vec(&appearance)?)) {
      log::warn!("Could not save appearance: {error}");
    }
  }
  drop(current);
  apply(&app, &appearance);
  app.emit("baton-theme", &appearance.mode).map_err(|error| error.to_string())?;
  Ok(())
}
