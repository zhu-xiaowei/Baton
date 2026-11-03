use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
  collections::{HashMap, HashSet},
  io::{ErrorKind, Read, Write},
  net::{Shutdown, TcpListener, TcpStream},
  sync::{atomic::{AtomicBool, Ordering}, Arc, Condvar, Mutex},
  thread,
  time::Duration,
};
use tauri::{AppHandle, Emitter, State, Webview};
use uuid::Uuid;

const CHUNK_BYTES: usize = 16 * 1024;
const WINDOW_BYTES: usize = 128 * 1024;
const MAX_STREAMS: usize = 24;
const MAX_TUNNELS: usize = 4;
const MAX_PORT_ATTEMPTS: usize = 1024;
// Rejection prefix for a taken local port; the suffix names the owner for the app's dialog.
const PORT_IN_USE: &str = "port-in-use:";

fn local_origin(port: u16) -> String {
  let host = if cfg!(target_os = "macos") { "localhost" } else { "127.0.0.1" };
  format!("http://{host}:{port}")
}

// Without `next`, only the requested port is tried; privileged ports a phone cannot bind still move up.
fn bind_local_listeners(preferred_port: u16, next: bool) -> Result<(Vec<TcpListener>, u16), String> {
  if preferred_port == 0 { return Err("Invalid preview port".into()); }
  let attempts = if next || preferred_port < 1024 { MAX_PORT_ATTEMPTS } else { 1 };
  for port in (preferred_port..=u16::MAX).take(attempts) {
    let ipv4 = match TcpListener::bind(("127.0.0.1", port)) {
      Ok(listener) => listener,
      Err(error) if error.kind() == ErrorKind::AddrInUse
        || (port < 1024 && error.kind() == ErrorKind::PermissionDenied) => continue,
      Err(error) => return Err(format!("Could not bind local preview port {port}: {error}")),
    };
    let mut listeners = vec![ipv4];
    match TcpListener::bind(("::1", port)) {
      Ok(listener) => listeners.push(listener),
      Err(error) if error.kind() == ErrorKind::AddrNotAvailable
        || (port >= 1024 && error.kind() == ErrorKind::PermissionDenied) => {}
      Err(error) if error.kind() == ErrorKind::AddrInUse
        || (port < 1024 && error.kind() == ErrorKind::PermissionDenied) => continue,
      Err(error) => return Err(format!("Could not bind local preview port {port}: {error}")),
    }
    return Ok((listeners, port));
  }
  if attempts == 1 { return Err(PORT_IN_USE.into()); }
  Err(format!("No local preview port available starting at {preferred_port}"))
}

// The process listening on a local port, as (pid, name). Desktop only: phones cannot see other apps.
#[cfg(desktop)]
fn port_process(port: u16) -> Option<(u32, String)> {
  use std::process::Command;
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("netstat").args(["-ano", "-p", "TCP"]).creation_flags(CREATE_NO_WINDOW).output().ok()?;
    let pid: u32 = String::from_utf8_lossy(&output.stdout).lines().find_map(|line| {
      let fields: Vec<&str> = line.split_whitespace().collect();
      // A listening socket has no foreign address; the state column is localized.
      (fields.len() == 5 && fields[1].ends_with(&format!(":{port}")) && matches!(fields[2], "0.0.0.0:0" | "[::]:0"))
        .then(|| fields[4].parse().ok()).flatten()
    })?;
    let output = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
      .creation_flags(CREATE_NO_WINDOW).output().ok()?;
    let name = String::from_utf8_lossy(&output.stdout).lines().next()?.strip_prefix('"')?.split('"').next()?.to_string();
    return (!name.is_empty() && pid != std::process::id()).then_some((pid, name));
  }
  #[cfg(not(windows))]
  {
    let output = Command::new("lsof").args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpc"]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let pid: u32 = text.lines().find_map(|line| line.strip_prefix('p')?.parse().ok())?;
    let name = text.lines().find_map(|line| line.strip_prefix('c'))?.to_string();
    (pid != std::process::id()).then_some((pid, name))
  }
}

// Quits the process only while it is still the one the dialog named.
#[cfg(desktop)]
fn quit_port_process(port: u16, expected: u32) -> Result<(), String> {
  let Some((pid, name)) = port_process(port) else { return Ok(()) };
  if pid != expected { return Err(PORT_IN_USE.into()); }
  #[cfg(windows)]
  let status = {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).creation_flags(0x0800_0000).status()
  };
  #[cfg(not(windows))]
  let status = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status();
  match status {
    Ok(status) if status.success() => Ok(()),
    _ => Err(format!("Could not quit {name}")),
  }
}

#[cfg(test)]
mod tests {
  use super::{bind_local_listeners, PreviewProxy, PreviewSession};
  use std::{
    collections::HashSet,
    net::{TcpListener, TcpStream},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
  };

  #[test]
  fn reset_releases_only_the_owner_sessions() {
    let proxy = PreviewProxy::default();
    let mut owned = Vec::new();
    for (id, owner) in [("a", "main"), ("b", "other"), ("c", "main")] {
      let session = Arc::new(PreviewSession {
        port: 1, owner: owner.into(), stopped: AtomicBool::new(false),
        accept_threads: Mutex::new(Vec::new()), sockets: Mutex::new(HashSet::new()),
      });
      if owner == "main" { owned.push(Arc::clone(&session)); }
      proxy.sessions.lock().unwrap().insert(id.into(), session);
    }
    for session in proxy.remove_owned("main") { proxy.stop_session(&session); }
    let sessions = proxy.sessions.lock().unwrap();
    assert_eq!(sessions.keys().collect::<Vec<_>>(), ["b"]);
    assert!(!sessions["b"].stopped.load(Ordering::Acquire));
    assert!(owned.iter().all(|session| session.stopped.load(Ordering::Acquire)));
  }

  #[test]
  fn uses_requested_port_then_falls_forward_when_occupied() {
    let occupied = loop {
      let listener = TcpListener::bind("127.0.0.1:0").unwrap();
      if listener.local_addr().unwrap().port() < u16::MAX { break listener; }
    };
    let requested = occupied.local_addr().unwrap().port();
    assert_eq!(bind_local_listeners(requested, false).err().as_deref(), Some(super::PORT_IN_USE));
    let (fallback_listeners, fallback) = bind_local_listeners(requested, true).unwrap();
    assert!(fallback > requested);
    drop(occupied);
    let (listeners, available) = bind_local_listeners(requested, false).unwrap();
    assert_eq!(available, requested);
    TcpStream::connect(("127.0.0.1", available)).unwrap();
    if listeners.len() == 2 {
      TcpStream::connect(("::1", available)).unwrap();
    }
    drop(fallback_listeners);
  }
}

#[derive(Default)]
pub struct PreviewProxy {
  sessions: Mutex<HashMap<String, Arc<PreviewSession>>>,
  sockets: Mutex<HashMap<String, Arc<PreviewSocket>>>,
}

struct PreviewSession {
  port: u16,
  owner: String,
  stopped: AtomicBool,
  accept_threads: Mutex<Vec<thread::JoinHandle<()>>>,
  sockets: Mutex<HashSet<String>>,
}

struct PreviewSocket {
  tunnel_id: String,
  writer: Mutex<TcpStream>,
  // Separate handle: a write blocked on a non-reading browser holds `writer`.
  shutdown: TcpStream,
  credit: (Mutex<usize>, Condvar),
  stopped: AtomicBool,
  read_logged: AtomicBool,
  write_logged: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SocketEvent {
  tunnel_id: String,
  stream_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BytesEvent {
  tunnel_id: String,
  stream_id: String,
  seq: u64,
  data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinEvent {
  tunnel_id: String,
  stream_id: String,
  seq: u64,
}

impl PreviewProxy {
  fn socket(&self, stream_id: &str) -> Result<Arc<PreviewSocket>, String> {
    self.sockets.lock().map_err(|_| "Preview socket state unavailable".to_string())?
      .get(stream_id).cloned().ok_or_else(|| "Preview socket closed".to_string())
  }

  fn close_socket(&self, stream_id: &str) {
    let socket = self.sockets.lock().ok().and_then(|mut sockets| sockets.remove(stream_id));
    if let Some(socket) = socket {
      socket.stopped.store(true, Ordering::Release);
      socket.credit.1.notify_all();
      let _ = socket.shutdown.shutdown(Shutdown::Both);
      if let Ok(sessions) = self.sessions.lock() {
        if let Some(session) = sessions.get(&socket.tunnel_id) {
          if let Ok(mut sockets) = session.sockets.lock() {
            sockets.remove(stream_id);
          }
        }
      }
    }
  }

  fn remove_owned(&self, owner: &str) -> Vec<Arc<PreviewSession>> {
    let Ok(mut sessions) = self.sessions.lock() else { return Vec::new() };
    let ids: Vec<String> = sessions.iter()
      .filter(|(_, session)| session.owner == owner).map(|(id, _)| id.clone()).collect();
    ids.iter().filter_map(|id| sessions.remove(id)).collect()
  }

  // Another tab (or device) forwarding this local port gives it up; its page reports the closed listener.
  fn take_over(&self, app: &AppHandle, port: u16) {
    let taken: Vec<(String, Arc<PreviewSession>)> = self.sessions.lock().map(|mut sessions| {
      let ids: Vec<String> = sessions.iter().filter(|(_, session)| session.port == port).map(|(id, _)| id.clone()).collect();
      ids.into_iter().filter_map(|id| sessions.remove(&id).map(|session| (id, session))).collect()
    }).unwrap_or_default();
    for (tunnel_id, session) in taken {
      self.stop_session(&session);
      let _ = app.emit_to(&session.owner, "preview-listener-closed", SocketEvent { tunnel_id, stream_id: String::new() });
    }
  }

  fn port_in_use(&self, port: u16) -> String {
    let baton = self.sessions.lock().map(|sessions| sessions.values().any(|session| session.port == port)).unwrap_or(false);
    if baton { return format!("{PORT_IN_USE}baton"); }
    #[cfg(desktop)]
    if let Some((pid, name)) = port_process(port) { return format!("{PORT_IN_USE}app:{pid}:{name}"); }
    PORT_IN_USE.into()
  }

  fn stop_session(&self, session: &PreviewSession) {
    session.stopped.store(true, Ordering::Release);
    let accept_threads = session.accept_threads.lock()
      .map(|mut threads| std::mem::take(&mut *threads)).unwrap_or_default();
    for thread in accept_threads { let _ = thread.join(); }
    let stream_ids: Vec<String> = session.sockets.lock()
      .map(|sockets| sockets.iter().cloned().collect()).unwrap_or_default();
    for stream_id in stream_ids {
      self.close_socket(&stream_id);
    }
  }

  fn accept_loop(self: Arc<Self>, app: AppHandle, tunnel_id: String,
      mut listener: TcpListener, session: Arc<PreviewSession>) {
    let addr = listener.local_addr().ok();
    while !session.stopped.load(Ordering::Acquire) {
      match listener.accept() {
        Ok((reader, _)) => {
          // Accepted sockets can inherit O_NONBLOCK from the listener on BSD systems.
          // Browser connections must block while waiting for the remote response.
          if reader.set_nonblocking(false).is_err() {
            let _ = reader.shutdown(Shutdown::Both);
            continue;
          }
          let mut stream_ids = match session.sockets.lock() {
            Ok(value) => value,
            Err(_) => break,
          };
          if stream_ids.len() >= MAX_STREAMS {
            let _ = reader.shutdown(Shutdown::Both);
            continue;
          }
          let (writer, shutdown) = match (reader.try_clone(), reader.try_clone()) {
            (Ok(writer), Ok(shutdown)) => (writer, shutdown),
            _ => continue,
          };
          let stream_id = Uuid::new_v4().to_string();
          let socket = Arc::new(PreviewSocket {
            tunnel_id: tunnel_id.clone(), writer: Mutex::new(writer), shutdown,
            credit: (Mutex::new(0), Condvar::new()), stopped: AtomicBool::new(false),
            read_logged: AtomicBool::new(false), write_logged: AtomicBool::new(false),
          });
          if let Ok(mut sockets) = self.sockets.lock() {
            sockets.insert(stream_id.clone(), Arc::clone(&socket));
            stream_ids.insert(stream_id.clone());
          } else {
            continue;
          }
          drop(stream_ids);
          if app.emit_to(&session.owner, "preview-socket-open", SocketEvent {
            tunnel_id: tunnel_id.clone(), stream_id: stream_id.clone(),
          }).is_err() {
            self.close_socket(&stream_id);
            continue;
          }
          if cfg!(debug_assertions) { log::info!("BATON_PREVIEW_NATIVE_ACCEPT"); }
          let manager = Arc::clone(&self);
          let app = app.clone();
          let owner = session.owner.clone();
          let tunnel_id = tunnel_id.clone();
          thread::spawn(move || manager.read_loop(app, owner, tunnel_id, stream_id, reader, socket));
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
          // iOS defuncts a suspended app's sockets: accept keeps returning WouldBlock
          // and only SO_ERROR reports it. Close it, then take the same port back.
          if matches!(listener.take_error(), Ok(None)) {
            thread::sleep(Duration::from_millis(20));
            continue;
          }
          log::warn!("Preview listener on {addr:?} is defunct; rebinding");
          drop(listener);
          let fresh = addr.and_then(|addr| (0..25).find_map(|_| {
            let fresh = TcpListener::bind(addr).ok().filter(|fresh| fresh.set_nonblocking(true).is_ok());
            if fresh.is_none() { thread::sleep(Duration::from_millis(200)); }
            fresh
          }));
          match fresh {
            Some(fresh) => listener = fresh,
            None => {
              // The IPv4 listener is required; a lost optional IPv6 one is not fatal.
              if addr.is_some_and(|addr| addr.is_ipv4()) {
                let _ = app.emit_to(&session.owner, "preview-listener-closed", SocketEvent {
                  tunnel_id: tunnel_id.clone(), stream_id: String::new(),
                });
              }
              return;
            }
          }
        }
        Err(_) => break,
      }
    }
  }

  fn read_loop(self: Arc<Self>, app: AppHandle, owner: String, tunnel_id: String,
      stream_id: String, mut reader: TcpStream, socket: Arc<PreviewSocket>) {
    let mut seq = 0;
    let mut buffer = [0_u8; CHUNK_BYTES];
    loop {
      let (credit, notify) = &socket.credit;
      let mut available = match credit.lock() {
        Ok(value) => value,
        Err(_) => break,
      };
      while *available == 0 && !socket.stopped.load(Ordering::Acquire) {
        let result = notify.wait_timeout(available, Duration::from_secs(60));
        match result {
          Ok((value, waited)) => {
            available = value;
            if waited.timed_out() && *available == 0 { break; }
          }
          Err(_) => return,
        }
      }
      if socket.stopped.load(Ordering::Acquire) || *available == 0 { break; }
      let capacity = (*available).min(CHUNK_BYTES);
      drop(available);
      match reader.read(&mut buffer[..capacity]) {
        Ok(0) => {
          let _ = app.emit_to(&owner, "preview-socket-fin", FinEvent {
            tunnel_id, stream_id, seq,
          });
          return;
        }
        Ok(count) => {
          if cfg!(debug_assertions) && !socket.read_logged.swap(true, Ordering::AcqRel) {
            log::info!("BATON_PREVIEW_NATIVE_BROWSER_BYTES");
          }
          if let Ok(mut available) = credit.lock() {
            *available = available.saturating_sub(count);
          } else { break; }
          seq += 1;
          if app.emit_to(&owner, "preview-socket-bytes", BytesEvent {
            tunnel_id: tunnel_id.clone(), stream_id: stream_id.clone(), seq,
            data: STANDARD.encode(&buffer[..count]),
          }).is_err() { break; }
        }
        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
        Err(_) => break,
      }
    }
    let _ = app.emit_to(&owner, "preview-socket-close", SocketEvent {
      tunnel_id, stream_id: stream_id.clone(),
    });
    self.close_socket(&stream_id);
  }
}

#[tauri::command]
// mode: "strict" (only the requested port), "next" (the first free port from it),
// "takeover" (release Baton's own listener on it first) or "quit:<pid>" (desktop: quit that process first).
// Process lookups and the quit wait block, so this runs off the main thread.
pub async fn preview_start(app: AppHandle, window: Webview,
    manager: State<'_, Arc<PreviewProxy>>, tunnel_id: String,
    preferred_port: u16, mode: Option<String>) -> Result<String, String> {
  let manager = Arc::clone(manager.inner());
  let owner = window.label().to_string();
  tauri::async_runtime::spawn_blocking(move || start_preview(app, manager, owner, tunnel_id, preferred_port, mode))
    .await.map_err(|error| error.to_string())?
}

fn start_preview(app: AppHandle, manager: Arc<PreviewProxy>, owner: String, tunnel_id: String,
    preferred_port: u16, mode: Option<String>) -> Result<String, String> {
  Uuid::parse_str(&tunnel_id).map_err(|_| "Invalid preview tunnel ID".to_string())?;
  if preferred_port == 0 { return Err("Invalid preview port".into()); }
  let mode = mode.unwrap_or_else(|| "next".into());
  {
    let sessions = manager.sessions.lock().map_err(|_| "Preview state unavailable")?;
    if let Some(session) = sessions.get(&tunnel_id) {
      if session.owner != owner { return Err("Preview already open in another window".into()); }
      return Ok(local_origin(session.port));
    }
    let released = if mode == "takeover" { sessions.values().filter(|session| session.port == preferred_port).count() } else { 0 };
    if sessions.len() - released >= MAX_TUNNELS { return Err("Too many active previews".into()); }
  }
  if mode == "takeover" { manager.take_over(&app, preferred_port); }
  let quit = mode.strip_prefix("quit:").map(|pid| pid.parse::<u32>().unwrap_or(0));
  #[cfg(desktop)]
  if let Some(pid) = quit {
    quit_port_process(preferred_port, pid)
      .map_err(|error| if error == PORT_IN_USE { manager.port_in_use(preferred_port) } else { error })?;
  }
  // A quit process may take a moment to release its socket.
  let mut waits = if quit.is_some() { 30 } else { 0 };
  let (listeners, port) = loop {
    match bind_local_listeners(preferred_port, mode == "next") {
      Err(error) if error == PORT_IN_USE && waits > 0 => {
        waits -= 1;
        thread::sleep(Duration::from_millis(100));
      }
      Err(error) if error == PORT_IN_USE => return Err(manager.port_in_use(preferred_port)),
      result => break result?,
    }
  };
  for listener in &listeners {
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
  }
  let mut sessions = manager.sessions.lock().map_err(|_| "Preview state unavailable")?;
  if sessions.len() >= MAX_TUNNELS { return Err("Too many active previews".into()); }
  let session = Arc::new(PreviewSession {
    port, owner, stopped: AtomicBool::new(false),
    accept_threads: Mutex::new(Vec::new()),
    sockets: Mutex::new(HashSet::new()),
  });
  let mut accept_threads = session.accept_threads.lock().map_err(|_| "Preview state unavailable")?;
  sessions.insert(tunnel_id.clone(), Arc::clone(&session));
  drop(sessions);
  for listener in listeners {
    let manager = Arc::clone(&manager);
    let app = app.clone();
    let tunnel_id = tunnel_id.clone();
    let session = Arc::clone(&session);
    accept_threads.push(thread::spawn(move || manager.accept_loop(app, tunnel_id, listener, session)));
  }
  drop(accept_threads);
  if cfg!(debug_assertions) { log::info!("BATON_PREVIEW_NATIVE_LISTEN"); }
  Ok(local_origin(port))
}

#[tauri::command]
pub fn preview_credit(manager: State<'_, Arc<PreviewProxy>>,
    stream_id: String, bytes: usize) -> Result<(), String> {
  if bytes == 0 || bytes > WINDOW_BYTES { return Err("Invalid preview credit".into()); }
  let socket = manager.socket(&stream_id)?;
  let mut credit = socket.credit.0.lock().map_err(|_| "Preview credit unavailable")?;
  *credit = credit.saturating_add(bytes).min(WINDOW_BYTES);
  socket.credit.1.notify_one();
  Ok(())
}

#[tauri::command]
pub async fn preview_write(manager: State<'_, Arc<PreviewProxy>>,
    stream_id: String, data: String) -> Result<(), String> {
  let bytes = STANDARD.decode(data).map_err(|_| "Invalid preview bytes")?;
  if bytes.is_empty() || bytes.len() > CHUNK_BYTES { return Err("Invalid preview bytes".into()); }
  let socket = manager.socket(&stream_id)?;
  tauri::async_runtime::spawn_blocking(move || {
    socket.writer.lock().map_err(|_| "Preview writer unavailable".to_string())?
      .write_all(&bytes).map_err(|error| error.to_string())?;
    if cfg!(debug_assertions) && !socket.write_logged.swap(true, Ordering::AcqRel) {
      log::info!("BATON_PREVIEW_NATIVE_REMOTE_BYTES");
    }
    Ok(())
  }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn preview_shutdown_write(manager: State<'_, Arc<PreviewProxy>>,
    stream_id: String) -> Result<(), String> {
  let socket = manager.socket(&stream_id)?;
  let writer = socket.writer.lock().map_err(|_| "Preview writer unavailable")?;
  writer.shutdown(Shutdown::Write).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn preview_close_socket(manager: State<'_, Arc<PreviewProxy>>,
    stream_id: String) {
  manager.close_socket(&stream_id);
}

#[tauri::command]
pub async fn preview_stop(manager: State<'_, Arc<PreviewProxy>>,
    tunnel_id: String) -> Result<(), String> {
  let manager = Arc::clone(manager.inner());
  tauri::async_runtime::spawn_blocking(move || {
    let session = manager.sessions.lock().ok().and_then(|mut sessions| sessions.remove(&tunnel_id));
    if let Some(session) = session { manager.stop_session(&session); }
  }).await.map_err(|error| error.to_string())?;
  Ok(())
}

// A reloaded webview loses its tunnel IDs, so it releases everything it still owns.
#[tauri::command]
pub async fn preview_reset(window: Webview,
    manager: State<'_, Arc<PreviewProxy>>) -> Result<(), String> {
  release_owner(Arc::clone(manager.inner()), window.label().to_string())
    .await.map_err(|error| error.to_string())
}

// Owners are webview labels: a macOS tab owns its tunnels, not the window hosting it.
pub fn release_owner(manager: Arc<PreviewProxy>, owner: String) -> tauri::async_runtime::JoinHandle<()> {
  tauri::async_runtime::spawn_blocking(move || {
    for session in manager.remove_owned(&owner) { manager.stop_session(&session); }
  })
}
