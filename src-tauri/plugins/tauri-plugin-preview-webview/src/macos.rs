use std::{
  cell::{Cell, RefCell},
  collections::{HashMap, HashSet},
  ffi::c_void,
  ptr,
};

use block2::Block;
use objc2::{
  define_class, msg_send,
  rc::Retained,
  runtime::{AnyObject, Bool, ProtocolObject},
  sel, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{NSColor, NSEvent, NSView};
use objc2_foundation::{
  ns_string, NSError, NSKeyValueObservingOptions, NSNumber, NSObject, NSObjectNSKeyValueCoding,
  NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSPoint, NSProcessInfo, NSRect, NSSize, NSString,
  NSURLRequest, NSURL,
};
use objc2_web_kit::{
  WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKUIDelegate, WKWebView,
  WKWebViewConfiguration, WKWebsiteDataStore, WKWindowFeatures,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, Runtime, Webview};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
  id: String,
  url: String,
  loading: bool,
  progress: f64,
  can_go_back: bool,
  can_go_forward: bool,
  error: Option<String>,
  close_requested: bool,
  event: Option<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
  left: f64,
  top: f64,
  width: f64,
  height: f64,
  viewport_width: f64,
  visible: bool,
  interactive: bool,
}

struct ViewIvars {
  interactive: Cell<bool>,
}

define_class!(
  #[unsafe(super(WKWebView))]
  #[name = "BatonPreviewWebView"]
  #[thread_kind = MainThreadOnly]
  #[ivars = ViewIvars]
  struct PreviewView;

  unsafe impl NSObjectProtocol for PreviewView {}

  impl PreviewView {
    #[unsafe(method_id(hitTest:))]
    fn hit_test(&self, point: NSPoint) -> Option<Retained<NSView>> {
      if self.ivars().interactive.get() {
        unsafe { msg_send![super(self), hitTest: point] }
      } else {
        None
      }
    }

    #[unsafe(method(performKeyEquivalent:))]
    fn perform_key_equivalent(&self, _event: &NSEvent) -> Bool {
      // Let the app's Edit/New Window menu handle command-key shortcuts.
      Bool::NO
    }
  }
);

impl PreviewView {
  fn new(mtm: MainThreadMarker, configuration: &WKWebViewConfiguration) -> Retained<Self> {
    let view = Self::alloc(mtm).set_ivars(ViewIvars {
      interactive: Cell::new(true),
    });
    unsafe { msg_send![super(view), initWithFrame: NSRect::ZERO, configuration: configuration] }
  }
}

struct ObserverIvars {
  id: String,
  view: Retained<PreviewView>,
  channel: Channel<ViewState>,
  requested_url: RefCell<String>,
  observing: Cell<bool>,
  retry_navigation: Cell<bool>,
}

fn allowed_preview_url(url: &str) -> bool {
  let Ok(url) = tauri::Url::parse(url) else {
    return false;
  };
  match url.scheme() {
    "http" | "https" => url.host_str().is_some() && url.username().is_empty() && url.password().is_none(),
    "about" => url.as_str() == "about:blank",
    "blob" | "data" => true,
    _ => false,
  }
}

define_class!(
  #[unsafe(super(NSObject))]
  #[name = "BatonPreviewObserver"]
  #[thread_kind = MainThreadOnly]
  #[ivars = ObserverIvars]
  struct PreviewObserver;

  unsafe impl NSObjectProtocol for PreviewObserver {}

  impl PreviewObserver {
    #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
    fn observe(
      &self, _key: Option<&NSString>, _object: Option<&AnyObject>,
      _change: Option<&AnyObject>, _context: *mut c_void,
    ) {
      self.emit(None);
    }
  }

  unsafe impl WKNavigationDelegate for PreviewObserver {
    #[unsafe(method(webView:didStartProvisionalNavigation:))]
    fn started(&self, _view: &WKWebView, _navigation: Option<&WKNavigation>) {
      self.emit_event(None, Some("started"));
    }
    #[unsafe(method(webView:didCommitNavigation:))]
    fn committed(&self, _view: &WKWebView, _navigation: Option<&WKNavigation>) { self.emit(None); }
    #[unsafe(method(webView:didFinishNavigation:))]
    fn finished(&self, _view: &WKWebView, _navigation: Option<&WKNavigation>) {
      self.ivars().retry_navigation.set(false);
      self.emit_event(None, Some("finished"));
    }
    #[unsafe(method(webView:didFailNavigation:withError:))]
    fn failed(&self, _view: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
      self.report_failure(error);
    }
    #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
    fn provisional_failed(&self, _view: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
      self.report_failure(error);
    }
    #[unsafe(method(webViewWebContentProcessDidTerminate:))]
    fn terminated(&self, _view: &WKWebView) {
      self.ivars().retry_navigation.set(true);
      self.emit(Some("The preview process stopped. Reload to continue.".into()));
    }
    #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
    fn navigation_policy(
      &self, _view: &WKWebView, action: &WKNavigationAction,
      handler: &Block<dyn Fn(WKNavigationActionPolicy)>,
    ) {
      unsafe {
        let url = action.request().URL().and_then(|url| url.absoluteString()).map(|url| url.to_string());
        if !url.as_deref().is_some_and(allowed_preview_url) {
          handler.call((WKNavigationActionPolicy::Cancel,));
          return;
        }
        if action.targetFrame().is_some_and(|frame| frame.isMainFrame()) {
          *self.ivars().requested_url.borrow_mut() = url.unwrap();
        }
        handler.call((WKNavigationActionPolicy::Allow,));
      }
    }
  }

  unsafe impl WKUIDelegate for PreviewObserver {
    #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
    fn new_window(
      &self, view: &WKWebView, _configuration: &WKWebViewConfiguration,
      action: &WKNavigationAction, _features: &WKWindowFeatures,
    ) -> Option<Retained<WKWebView>> {
      unsafe {
        let request = action.request();
        let allowed = request.URL().and_then(|url| url.absoluteString())
          .is_some_and(|url| allowed_preview_url(&url.to_string()));
        if action.targetFrame().is_none() && allowed { view.loadRequest(&request); }
      }
      None
    }
  }
);

fn observed_keys() -> [&'static NSString; 5] {
  [
    ns_string!("URL"),
    ns_string!("loading"),
    ns_string!("estimatedProgress"),
    ns_string!("canGoBack"),
    ns_string!("canGoForward"),
  ]
}

impl PreviewObserver {
  fn new(
    mtm: MainThreadMarker,
    id: String,
    view: Retained<PreviewView>,
    channel: Channel<ViewState>,
  ) -> Retained<Self> {
    let observer = Self::alloc(mtm).set_ivars(ObserverIvars {
      id,
      view,
      channel,
      requested_url: RefCell::new(String::new()),
      observing: Cell::new(false),
      retry_navigation: Cell::new(false),
    });
    let observer: Retained<Self> = unsafe { msg_send![super(observer), init] };
    unsafe {
      observer
        .ivars()
        .view
        .setNavigationDelegate(Some(ProtocolObject::from_ref(&*observer)));
      observer
        .ivars()
        .view
        .setUIDelegate(Some(ProtocolObject::from_ref(&*observer)));
      for key in observed_keys() {
        observer.ivars().view.addObserver_forKeyPath_options_context(
          &observer,
          key,
          NSKeyValueObservingOptions::New,
          ptr::null_mut(),
        );
      }
    }
    observer.ivars().observing.set(true);
    observer
  }

  fn emit(&self, error: Option<String>) {
    self.emit_event(error, None);
  }

  fn report_failure(&self, error: &NSError) {
    if error.code() == -999 || (error.domain().to_string() == "WebKitErrorDomain" && error.code() == 102) {
      return;
    }
    self.ivars().retry_navigation.set(true);
    self.emit(Some(error.localizedDescription().to_string()));
  }

  fn emit_event(&self, error: Option<String>, event: Option<&'static str>) {
    let state = self.ivars();
    unsafe {
      let url = state
        .view
        .URL()
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .unwrap_or_else(|| state.requested_url.borrow().clone());
      let _ = state.channel.send(ViewState {
        id: state.id.clone(),
        url,
        loading: state.view.isLoading(),
        progress: state.view.estimatedProgress(),
        can_go_back: state.view.canGoBack(),
        can_go_forward: state.view.canGoForward(),
        error,
        close_requested: false,
        event,
      });
    }
  }

  fn detach(&self) {
    if self.ivars().observing.replace(false) {
      for key in observed_keys() {
        unsafe {
          self.ivars().view.removeObserver_forKeyPath(self, key);
        }
      }
    }
  }
}

struct Entry {
  owner: String,
  window: String,
  host: Retained<WKWebView>,
  view: Retained<PreviewView>,
  observer: Retained<PreviewObserver>,
  wanted: Cell<bool>,
}

impl Drop for Entry {
  fn drop(&mut self) {
    self.observer.detach();
    unsafe {
      self.view.setNavigationDelegate(None);
      self.view.setUIDelegate(None);
      self.view.stopLoading();
    }
    self.view.removeFromSuperview();
  }
}

thread_local! {
  static ENTRIES: RefCell<HashMap<String, Entry>> = RefCell::new(HashMap::new());
  // Hosts in a background tab: their previews are siblings of the tab webview, so hiding
  // the tab alone would leave them drawn over the selected tab.
  static HIDDEN_OWNERS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

async fn on_view<R: Runtime>(
  caller: Webview<R>,
  operation: impl FnOnce(&WKWebView, MainThreadMarker) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
  let (send, mut receive) = tauri::async_runtime::channel(1);
  caller
    .with_webview(move |platform| {
      let result = (|| {
        let mtm = MainThreadMarker::new().ok_or("Preview must run on the main thread")?;
        let host =
          unsafe { platform.inner().cast::<WKWebView>().as_ref() }.ok_or("Preview host is unavailable")?;
        operation(host, mtm)
      })();
      let _ = send.try_send(result);
    })
    .map_err(|error| error.to_string())?;
  receive
    .recv()
    .await
    .ok_or_else(|| "Preview host closed".to_string())?
}

fn with_entry(
  owner: &str,
  id: &str,
  action: impl FnOnce(&Entry) -> Result<(), String>,
) -> Result<(), String> {
  ENTRIES.with(|entries| {
    let entries = entries.borrow();
    let entry = entries.get(id).ok_or("Preview is closed")?;
    if entry.owner != owner {
      return Err("Preview belongs to another window".into());
    }
    action(entry)
  })
}

#[tauri::command]
pub async fn create<R: Runtime>(
  webview: Webview<R>,
  id: String,
  on_event: Channel<ViewState>,
) -> Result<(), String> {
  let owner = webview.label().to_string();
  let window = webview.window().label().to_string();
  on_view(webview, move |host, mtm| {
    let parent = unsafe { host.superview() }.ok_or("Preview host is unavailable")?;
    if ENTRIES.with(|entries| entries.borrow().contains_key(&id)) {
      return Err("Preview already exists".into());
    }
    unsafe {
      let configuration = WKWebViewConfiguration::new(mtm);
      configuration.setWebsiteDataStore(&WKWebsiteDataStore::defaultDataStore(mtm));
      let version = NSProcessInfo::processInfo().operatingSystemVersion();
      if version.majorVersion > 10 || (version.majorVersion == 10 && version.minorVersion >= 14) {
        // Same transparent WKWebView configuration used by Wry on macOS.
        configuration.setValue_forKey(
          Some(&NSNumber::numberWithBool(false)),
          ns_string!("drawsBackground"),
        );
      }
      let view = PreviewView::new(mtm, &configuration);
      view.setHidden(true);
      view.setAllowsBackForwardNavigationGestures(true);
      if view.respondsToSelector(sel!(setUnderPageBackgroundColor:)) {
        view.setUnderPageBackgroundColor(Some(&NSColor::colorWithSRGBRed_green_blue_alpha(
          13.0 / 255.0,
          17.0 / 255.0,
          23.0 / 255.0,
          1.0,
        )));
      }
      let observer = PreviewObserver::new(mtm, id.clone(), view.clone(), on_event);
      parent.addSubview(&view);
      let host = Retained::retain(host as *const WKWebView as *mut WKWebView).unwrap();
      ENTRIES.with(|entries| {
        entries.borrow_mut().insert(
          id,
          Entry {
            owner,
            window,
            host,
            view,
            observer,
            wanted: Cell::new(false),
          },
        )
      });
    }
    Ok(())
  })
  .await
}

#[tauri::command]
pub async fn navigate<R: Runtime>(webview: Webview<R>, id: String, url: String) -> Result<(), String> {
  let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid preview URL")?;
  if !matches!(parsed.scheme(), "http" | "https")
    || parsed.host_str().is_none()
    || !parsed.username().is_empty()
    || parsed.password().is_some()
  {
    return Err("Preview requires an HTTP or HTTPS URL".into());
  }
  let owner = webview.label().to_string();
  on_view(webview, move |_, _| {
    with_entry(&owner, &id, |entry| {
      let url = NSURL::URLWithString(&NSString::from_str(&url)).ok_or("Invalid preview URL")?;
      *entry.observer.ivars().requested_url.borrow_mut() = parsed.to_string();
      entry.observer.ivars().retry_navigation.set(false);
      unsafe {
        entry.view.loadRequest(&NSURLRequest::requestWithURL(&url));
      }
      Ok(())
    })
  })
  .await
}

#[tauri::command]
pub async fn action<R: Runtime>(webview: Webview<R>, id: String, action: String) -> Result<(), String> {
  let owner = webview.label().to_string();
  on_view(webview, move |_, _| {
    with_entry(&owner, &id, |entry| {
      unsafe {
        match action.as_str() {
          "back" => {
            entry.view.goBack();
          }
          "forward" => {
            entry.view.goForward();
          }
          "reload" => {
            if entry.observer.ivars().retry_navigation.get() || entry.view.URL().is_none() {
              let url = entry.observer.ivars().requested_url.borrow().clone();
              let url = NSURL::URLWithString(&NSString::from_str(&url)).ok_or("Invalid preview URL")?;
              entry.observer.ivars().retry_navigation.set(false);
              entry.view.loadRequest(&NSURLRequest::requestWithURL(&url));
            } else {
              entry.view.reload();
            }
          }
          "stop" => entry.view.stopLoading(),
          _ => return Err("Unknown preview action".into()),
        }
      }
      entry.observer.emit(None);
      Ok(())
    })
  })
  .await
}

#[tauri::command]
pub async fn layout<R: Runtime>(webview: Webview<R>, id: String, bounds: Bounds) -> Result<(), String> {
  let owner = webview.label().to_string();
  on_view(webview, move |_, _| {
    with_entry(&owner, &id, |entry| {
      if ![
        bounds.left,
        bounds.top,
        bounds.width,
        bounds.height,
        bounds.viewport_width,
      ]
      .iter()
      .all(|n| n.is_finite())
        || bounds.viewport_width <= 0.0
      {
        return Err("Invalid preview bounds".into());
      }
      let host_bounds = entry.host.bounds();
      let scale = host_bounds.size.width / bounds.viewport_width;
      let left = (bounds.left * scale).max(0.0);
      let right = ((bounds.left + bounds.width.max(0.0)) * scale)
        .min(host_bounds.size.width)
        .max(left);
      let top = (bounds.top * scale).max(0.0);
      let bottom = ((bounds.top + bounds.height.max(0.0)) * scale)
        .min(host_bounds.size.height)
        .max(top);
      let height = bottom - top;
      let rect = NSRect::new(
        NSPoint::new(
          host_bounds.origin.x + left,
          host_bounds.origin.y
            + if entry.host.isFlipped() {
              top
            } else {
              host_bounds.size.height - bottom
            },
        ),
        NSSize::new(right - left, height),
      );
      let parent = unsafe { entry.view.superview() }.ok_or("Preview host closed")?;
      entry
        .view
        .setFrame(entry.host.convertRect_toView(rect, Some(&parent)));
      entry.view.ivars().interactive.set(bounds.interactive);
      entry.wanted.set(bounds.visible && right > left && height > 0.0);
      let hidden = HIDDEN_OWNERS.with(|owners| owners.borrow().contains(&entry.owner));
      entry.view.setHidden(hidden || !entry.wanted.get());
      Ok(())
    })
  })
  .await
}

#[tauri::command]
pub async fn remove<R: Runtime>(webview: Webview<R>, id: String) -> Result<(), String> {
  let owner = webview.label().to_string();
  on_view(webview, move |_, _| {
    ENTRIES.with(|entries| {
      let mut entries = entries.borrow_mut();
      if entries.get(&id).is_some_and(|entry| entry.owner != owner) {
        return Err("Preview belongs to another window".into());
      }
      let removed = entries.remove(&id);
      drop(entries);
      drop(removed);
      Ok(())
    })
  })
  .await
}

fn remove_entries(matches: impl Fn(&Entry) -> bool) {
  let removed: Vec<_> = ENTRIES.with(|entries| {
    let mut entries = entries.borrow_mut();
    let ids: Vec<_> = entries
      .iter()
      .filter(|(_, entry)| matches(entry))
      .map(|(id, _)| id.clone())
      .collect();
    ids.into_iter().filter_map(|id| entries.remove(&id)).collect()
  });
  drop(removed);
}

pub fn clear_host<R: Runtime>(webview: &Webview<R>) {
  let owner = webview.label().to_string();
  let _ = webview.with_webview(move |_| remove_entries(|entry| entry.owner == owner));
}

pub fn close_window<R: Runtime>(app: &tauri::AppHandle<R>, window: &str) {
  let window = window.to_string();
  let _ = app.run_on_main_thread(move || remove_entries(|entry| entry.window == window));
}

pub fn set_owner_visible<R: Runtime>(app: &tauri::AppHandle<R>, owner: &str, visible: bool) {
  let owner = owner.to_string();
  let _ = app.run_on_main_thread(move || {
    HIDDEN_OWNERS.with(|owners| {
      let mut owners = owners.borrow_mut();
      if visible { owners.remove(&owner); } else { owners.insert(owner.clone()); }
    });
    ENTRIES.with(|entries| {
      for entry in entries.borrow().values().filter(|entry| entry.owner == owner) {
        entry.view.setHidden(!visible || !entry.wanted.get());
      }
    });
  });
}

pub fn release_owner<R: Runtime>(app: &tauri::AppHandle<R>, owner: &str) {
  let owner = owner.to_string();
  let _ = app.run_on_main_thread(move || {
    HIDDEN_OWNERS.with(|owners| owners.borrow_mut().remove(&owner));
    remove_entries(|entry| entry.owner == owner);
  });
}
