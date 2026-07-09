#[cfg(desktop)]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(desktop)]
static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(0);

// Open a fresh viewer window. Each window is its own WebView (isolated DOM/JS,
// own WS connection + sessionStorage nav), so different windows can browse
// different projects/sessions without interfering. Cascade-offset so it
// doesn't land exactly on top of the window that spawned it.
#[cfg(desktop)]
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

      // Desktop menu: add ⌘N (New Window) alongside the system defaults
      // (Edit copy/paste, Window cycling). Mobile has no menu bar.
      #[cfg(desktop)]
      {
        use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

        let new_window = MenuItemBuilder::new("New Window")
          .id("new_window")
          .accelerator("CmdOrCtrl+N")
          .build(app)?;

        let file_menu = SubmenuBuilder::new(app, "File")
          .item(&new_window)
          .separator()
          .close_window()
          .build()?;

        let menu = MenuBuilder::new(app)
          .item(&file_menu)
          .copy()
          .cut()
          .paste()
          .select_all()
          .undo()
          .redo()
          .minimize()
          .fullscreen()
          .build()?;

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
