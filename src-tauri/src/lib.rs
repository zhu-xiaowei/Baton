// Multi-window is macOS-only. Windows/Linux are intentionally left single-window
// (title_bar_style/hidden_title below are macOS-only builder methods anyway).
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(target_os = "macos")]
static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(0);

#[tauri::command]
fn ios_build_number() -> Option<String> {
  #[cfg(target_os = "ios")]
  {
    use objc2_foundation::{ns_string, NSBundle, NSString};

    let build_number = NSBundle::mainBundle()
      .objectForInfoDictionaryKey(ns_string!("CFBundleVersion"))?
      .downcast::<NSString>()
      .ok()?;

    Some(build_number.to_string())
  }

  #[cfg(not(target_os = "ios"))]
  {
    None
  }
}

// Open a fresh viewer window. Each window is its own WebView (isolated DOM/JS,
// own WS connection + sessionStorage nav), so different windows can browse
// different projects/sessions without interfering. Cascade-offset so it
// doesn't land exactly on top of the window that spawned it.
#[cfg(target_os = "macos")]
fn spawn_peek_window(app: &tauri::AppHandle) {
  use tauri::{WebviewUrl, WebviewWindowBuilder};

  let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
  let label = format!("peek-{}", n);
  let offset = (n % 8) as f64 * 28.0;

  let res = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
    .title("AgentPeek")
    .inner_size(1024.0, 768.0)
    .min_inner_size(480.0, 400.0)
    .resizable(true)
    .background_color(tauri::webview::Color(0x16, 0x1b, 0x22, 0xff))
    .title_bar_style(tauri::TitleBarStyle::Transparent)
    .hidden_title(true)
    .position(120.0 + offset, 120.0 + offset)
    .build();

  if let Err(e) = res {
    log::error!("failed to create window {}: {}", label, e);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![ios_build_number])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      #[cfg(any(target_os = "android", target_os = "ios"))]
      app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
      #[cfg(target_os = "ios")]
      app.handle().plugin(tauri_plugin_speech::init())?;

      // macOS menu: start from the standard system menu (Menu::default wires up
      // the Edit submenu, so ⌘X/⌘C/⌘V reach the WebView), then inject ⌘N
      // (New Window) at the top of the File submenu. Building the menu by hand
      // would drop those predefined Edit items and break paste.
      #[cfg(target_os = "macos")]
      {
        use tauri::menu::{Menu, MenuItemBuilder};

        let menu = Menu::default(app.handle())?;

        let new_window = MenuItemBuilder::new("New Window")
          .id("new_window")
          .accelerator("Cmd+N")
          .build(app)?;

        // File is the submenu right after the app-name submenu.
        if let Some(file) = menu
          .items()?
          .iter()
          .filter_map(|i| i.as_submenu())
          .find(|s| s.text().map(|t| t == "File").unwrap_or(false))
        {
          file.prepend(&new_window)?;
        }

        app.set_menu(menu)?;
        app.on_menu_event(|app, event| {
          if event.id() == "new_window" {
            spawn_peek_window(app);
          }
        });
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
