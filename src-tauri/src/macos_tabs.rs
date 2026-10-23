// macOS tabs: each window holds a tab-strip webview in the titlebar row plus one content
// webview per tab. Hidden tabs keep their own page, draft, navigation and connection.
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct Tab {
  id: String,
  title: String,
}

#[derive(Clone, Serialize)]
pub struct TabsState {
  tabs: Vec<Tab>,
  selected: String,
  fullscreen: bool,
}

#[tauri::command]
pub async fn macos_tabs_state(webview: tauri::Webview) -> Result<TabsState, String> {
  imp::state(&webview)
}

#[tauri::command]
pub async fn macos_tabs_new(webview: tauri::Webview) -> Result<(), String> {
  imp::new_tab(&webview)
}

#[tauri::command]
pub async fn macos_tabs_select(webview: tauri::Webview, id: String) -> Result<(), String> {
  imp::select(&webview, &id)
}

// index < 0 selects the last tab (Cmd+9); otherwise a zero-based position.
#[tauri::command]
pub async fn macos_tabs_select_index(webview: tauri::Webview, index: i32) -> Result<(), String> {
  imp::select_index(&webview, index)
}

#[tauri::command]
pub async fn macos_tabs_step(webview: tauri::Webview, delta: i32) -> Result<(), String> {
  imp::step(&webview, delta)
}

#[tauri::command]
pub async fn macos_tabs_move(webview: tauri::Webview, id: String, index: usize) -> Result<(), String> {
  imp::move_tab(&webview, &id, index)
}

#[tauri::command]
pub async fn macos_tabs_close(webview: tauri::Webview, id: Option<String>) -> Result<(), String> {
  imp::close(&webview, id.as_deref())
}

#[tauri::command]
pub async fn macos_tabs_set_title(webview: tauri::Webview, title: String) -> Result<(), String> {
  imp::set_title(&webview, &title)
}

#[cfg(not(target_os = "macos"))]
mod imp {
  use super::TabsState;
  const UNSUPPORTED: &str = "Tabs are only available on macOS";
  pub fn state(_: &tauri::Webview) -> Result<TabsState, String> { Err(UNSUPPORTED.into()) }
  pub fn new_tab(_: &tauri::Webview) -> Result<(), String> { Err(UNSUPPORTED.into()) }
  pub fn select(_: &tauri::Webview, _: &str) -> Result<(), String> { Err(UNSUPPORTED.into()) }
  pub fn select_index(_: &tauri::Webview, _: i32) -> Result<(), String> { Err(UNSUPPORTED.into()) }
  pub fn step(_: &tauri::Webview, _: i32) -> Result<(), String> { Err(UNSUPPORTED.into()) }
  pub fn move_tab(_: &tauri::Webview, _: &str, _: usize) -> Result<(), String> { Err(UNSUPPORTED.into()) }
  pub fn close(_: &tauri::Webview, _: Option<&str>) -> Result<(), String> { Err(UNSUPPORTED.into()) }
  pub fn set_title(_: &tauri::Webview, _: &str) -> Result<(), String> { Err(UNSUPPORTED.into()) }
}

#[cfg(target_os = "macos")]
pub use imp::{attach, handle_menu, setup_menu};

#[cfg(target_os = "macos")]
mod imp {
  use super::{Tab, TabsState};
  use objc2::{msg_send, sel};
  use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow};
  use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize};
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
  use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID};
  use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder,
    WebviewUrl, Window,
  };

  // Must match --tab-strip-height in web/css/tab-strip.css.
  pub const STRIP_HEIGHT: f64 = 41.0;
  const DEFAULT_TITLE: &str = "Baton";
  const STRIP_COLOR: tauri::webview::Color = tauri::webview::Color(0x01, 0x04, 0x09, 0xff);
  const CONTENT_COLOR: tauri::webview::Color = tauri::webview::Color(0x16, 0x1b, 0x22, 0xff);

  static TAB_SEQ: AtomicUsize = AtomicUsize::new(0);
  static WINDOWS: OnceLock<Mutex<HashMap<String, WindowTabs>>> = OnceLock::new();

  struct WindowTabs {
    order: Vec<String>,
    selected: String,
    titles: HashMap<String, String>,
    fullscreen: bool,
  }

  fn windows() -> MutexGuard<'static, HashMap<String, WindowTabs>> {
    WINDOWS.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  fn strip_label(window: &str) -> String {
    format!("tab-strip-{window}")
  }

  fn snapshot(tabs: &WindowTabs) -> TabsState {
    TabsState {
      tabs: tabs.order.iter().map(|id| Tab {
        id: id.clone(),
        title: tabs.titles.get(id).cloned().unwrap_or_else(|| DEFAULT_TITLE.into()),
      }).collect(),
      selected: tabs.selected.clone(),
      fullscreen: tabs.fullscreen,
    }
  }

  fn with_tabs<T>(window: &str, f: impl FnOnce(&mut WindowTabs) -> T) -> Result<T, String> {
    windows().get_mut(window).map(f).ok_or_else(|| "This window has no tabs".into())
  }

  fn broadcast(window: &Window) {
    let label = window.label();
    let Ok(state) = with_tabs(label, |tabs| snapshot(tabs)) else { return };
    let _ = window.emit_to(EventTarget::webview(strip_label(label)), "macos-tabs", state);
  }

  // AppKit's frame view supports a custom titlebar height and lays the traffic lights out
  // within it. Giving it the strip height makes AppKit itself place them on the strip, so
  // nothing moves them afterwards.
  fn titlebar_follows_strip(window: &Window) {
    let Ok(ptr) = window.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = window.run_on_main_thread(move || unsafe {
      let Some(ns_window) = (ptr as *const NSWindow).as_ref() else { return };
      let Some(frame) = ns_window.contentView().and_then(|view| view.superview()) else { return };
      if !frame.respondsToSelector(sel!(setCustomTitlebarHeight:)) { return; }
      let _: () = msg_send![&*frame, setCustomTitlebarHeight: STRIP_HEIGHT];
    });
  }

  // Wry pins child webviews to the top-left; AppKit autoresizing keeps the strip and content
  // aligned during live resize. Wry's parent view is not flipped, so y grows upwards.
  fn place(webview: &Webview, strip: bool) {
    let _ = webview.with_webview(move |platform| unsafe {
      let Some(view) = (platform.inner() as *const NSView).as_ref() else { return };
      let Some(parent) = view.superview() else { return };
      let size = parent.bounds().size;
      let (y, height, vertical) = if strip {
        (size.height - STRIP_HEIGHT, STRIP_HEIGHT, NSAutoresizingMaskOptions::ViewMinYMargin)
      } else {
        (0.0, (size.height - STRIP_HEIGHT).max(0.0), NSAutoresizingMaskOptions::ViewHeightSizable)
      };
      view.setFrame(NSRect::new(NSPoint::new(0.0, y), NSSize::new(size.width, height)));
      view.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | vertical);
    });
  }

  fn release(app: &AppHandle, tab: &str) {
    crate::preview_proxy::release_owner(Arc::clone(app.state::<Arc<crate::preview_proxy::PreviewProxy>>().inner()), tab.to_string());
    tauri_plugin_preview_webview::release_owner(app, tab);
  }

  pub fn attach(window: &Window, first: &Webview) -> tauri::Result<()> {
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    // With the unstable feature Tauri stretches a window's own webview to the full window on
    // every resize, which would slide it back under the strip; AppKit autoresizing takes over.
    first.set_auto_resize(false)?;
    place(first, false);
    let strip = window.add_child(
      WebviewBuilder::new(strip_label(window.label()), WebviewUrl::App("tabs.html".into()))
        .disable_drag_drop_handler()
        .background_color(STRIP_COLOR),
      LogicalPosition::new(0.0, 0.0),
      LogicalSize::new(size.width, STRIP_HEIGHT),
    )?;
    place(&strip, true);
    windows().insert(window.label().to_string(), WindowTabs {
      order: vec![first.label().to_string()],
      selected: first.label().to_string(),
      titles: HashMap::new(),
      fullscreen: false,
    });
    let owner = window.clone();
    titlebar_follows_strip(window);
    window.on_window_event(move |event| match event {
      tauri::WindowEvent::Resized(_) => {
        let fullscreen = owner.is_fullscreen().unwrap_or(false);
        let changed = with_tabs(owner.label(), |tabs| std::mem::replace(&mut tabs.fullscreen, fullscreen) != fullscreen);
        if changed.unwrap_or(false) { broadcast(&owner); }
      }
      tauri::WindowEvent::Destroyed => {
        let removed = windows().remove(owner.label());
        // A closed window cannot run page teardown; release every tab's preview tunnels.
        for tab in removed.map(|tabs| tabs.order).unwrap_or_default() { release(owner.app_handle(), &tab); }
      }
      _ => {}
    });
    Ok(())
  }

  pub fn state(webview: &Webview) -> Result<TabsState, String> {
    with_tabs(webview.window().label(), |tabs| snapshot(tabs))
  }

  fn open(window: &Window) -> Result<(), String> {
    let size = window.inner_size().and_then(|size| Ok(size.to_logical::<f64>(window.scale_factor()?)))
      .map_err(|e| e.to_string())?;
    let label = format!("tab-{}", TAB_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
    let webview = window.add_child(
      WebviewBuilder::new(&label, WebviewUrl::App("index.html".into()))
        .disable_drag_drop_handler()
        .background_color(CONTENT_COLOR),
      LogicalPosition::new(0.0, STRIP_HEIGHT),
      LogicalSize::new(size.width, (size.height - STRIP_HEIGHT).max(1.0)),
    ).map_err(|e| e.to_string())?;
    place(&webview, false);
    with_tabs(window.label(), |tabs| tabs.order.push(label.clone()))?;
    show(window, &label)
  }

  pub fn new_tab(webview: &Webview) -> Result<(), String> {
    open(&webview.window())
  }

  // Show the new tab before hiding the old one so the content area never flashes empty.
  fn show(window: &Window, id: &str) -> Result<(), String> {
    let previous = with_tabs(window.label(), |tabs| {
      if !tabs.order.iter().any(|tab| tab == id) { return Err("Tab is closed".to_string()); }
      Ok(std::mem::replace(&mut tabs.selected, id.to_string()))
    })??;
    let app = window.app_handle();
    if let Some(next) = app.get_webview(id) {
      next.show().map_err(|e| e.to_string())?;
      tauri_plugin_preview_webview::set_owner_visible(app, id, true);
      let _ = next.set_focus();
    }
    if previous != id {
      tauri_plugin_preview_webview::set_owner_visible(app, &previous, false);
      if let Some(old) = app.get_webview(&previous) { let _ = old.hide(); }
    }
    broadcast(window);
    Ok(())
  }

  pub fn select(webview: &Webview, id: &str) -> Result<(), String> {
    show(&webview.window(), id)
  }

  fn pick(window: &Window, choose: impl FnOnce(&WindowTabs) -> Option<String>) -> Result<(), String> {
    match with_tabs(window.label(), |tabs| choose(tabs))? {
      Some(id) => show(window, &id),
      None => Ok(()),
    }
  }

  pub fn select_index(webview: &Webview, index: i32) -> Result<(), String> {
    pick(&webview.window(), |tabs| {
      if index < 0 { tabs.order.last().cloned() } else { tabs.order.get(index as usize).cloned() }
    })
  }

  pub fn step(webview: &Webview, delta: i32) -> Result<(), String> {
    pick(&webview.window(), |tabs| {
      let count = tabs.order.len() as i32;
      let current = tabs.order.iter().position(|tab| *tab == tabs.selected)? as i32;
      tabs.order.get((current + delta).rem_euclid(count) as usize).cloned()
    })
  }

  fn close_tab(window: &Window, id: Option<&str>) -> Result<(), String> {
    enum Plan { Window, Tab { id: String, next: Option<String> } }
    let plan = with_tabs(window.label(), |tabs| {
      let id = id.map(str::to_string).unwrap_or_else(|| tabs.selected.clone());
      let index = tabs.order.iter().position(|tab| *tab == id)?;
      if tabs.order.len() == 1 { return Some(Plan::Window); }
      // Like Chrome: closing the selected tab activates its right neighbour, else the left one.
      let next = (tabs.selected == id).then(|| {
        tabs.order.get(index + 1).or_else(|| tabs.order.get(index - 1)).cloned()
      }).flatten();
      Some(Plan::Tab { id, next })
    })?;
    match plan {
      None => Ok(()),
      Some(Plan::Window) => window.close().map_err(|e| e.to_string()),
      Some(Plan::Tab { id, next }) => {
        if let Some(next) = next { show(window, &next)?; }
        with_tabs(window.label(), |tabs| {
          tabs.order.retain(|tab| *tab != id);
          tabs.titles.remove(&id);
        })?;
        let app = window.app_handle();
        release(app, &id);
        if let Some(webview) = app.get_webview(&id) { webview.close().map_err(|e| e.to_string())?; }
        broadcast(window);
        Ok(())
      }
    }
  }

  pub fn move_tab(webview: &Webview, id: &str, index: usize) -> Result<(), String> {
    let window = webview.window();
    with_tabs(window.label(), |tabs| {
      let from = tabs.order.iter().position(|tab| tab == id).ok_or("Tab is closed")?;
      let tab = tabs.order.remove(from);
      tabs.order.insert(index.min(tabs.order.len()), tab);
      Ok::<_, String>(())
    })??;
    broadcast(&window);
    Ok(())
  }

  pub fn close(webview: &Webview, id: Option<&str>) -> Result<(), String> {
    close_tab(&webview.window(), id)
  }

  pub fn set_title(webview: &Webview, title: &str) -> Result<(), String> {
    let title: String = title.split(|c: char| c.is_whitespace() || c.is_control())
      .filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ").chars().take(200).collect();
    let title = if title.is_empty() { DEFAULT_TITLE.to_string() } else { title };
    let window = webview.window();
    let id = webview.label().to_string();
    let changed = with_tabs(window.label(), |tabs| {
      tabs.order.contains(&id) && tabs.titles.insert(id.clone(), title.clone()).as_ref() != Some(&title)
    })?;
    if changed { broadcast(&window); }
    Ok(())
  }

  pub fn setup_menu(app: &tauri::App, menu: &Menu<tauri::Wry>, file: &Submenu<tauri::Wry>) -> tauri::Result<()> {
    // Cmd+W closes a tab, so drop the predefined Close Window items that also claim it.
    for submenu in [Some(file.clone()), menu.get(WINDOW_SUBMENU_ID).and_then(|item| item.as_submenu().cloned())]
      .into_iter().flatten()
    {
      for item in submenu.items()? {
        if let MenuItemKind::Predefined(predefined) = &item {
          if predefined.text()? == "Close Window" { submenu.remove(predefined)?; }
        }
      }
    }
    file.insert(&MenuItemBuilder::new("New Tab").id("macos_tab_new").accelerator("Cmd+T").build(app)?, 1)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;
    file.append(&MenuItemBuilder::new("Close Tab").id("macos_tab_close").accelerator("Cmd+W").build(app)?)?;
    file.append(&MenuItemBuilder::new("Close Window").id("macos_window_close").accelerator("Cmd+Shift+W").build(app)?)?;
    Ok(())
  }

  // Menu events run on the main thread; tab work is dispatched so it never blocks AppKit.
  pub fn handle_menu(app: &AppHandle, id: &str) {
    if !matches!(id, "macos_tab_new" | "macos_tab_close" | "macos_window_close") {
      return;
    }
    let (app, id) = (app.clone(), id.to_string());
    tauri::async_runtime::spawn(async move {
      let Some(window) = app.get_focused_window() else {
        if id == "macos_tab_new" { crate::spawn_peek_window(&app); }
        return;
      };
      let result = match id.as_str() {
        "macos_tab_new" => open(&window),
        "macos_tab_close" => close_tab(&window, None),
        _ => window.close().map_err(|e| e.to_string()),
      };
      if let Err(error) = result { log::warn!("tab action {id} failed: {error}"); }
    });
  }
}
