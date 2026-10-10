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
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use uuid::Uuid;

const CHUNK_BYTES: usize = 16 * 1024;
const WINDOW_BYTES: usize = 128 * 1024;
const MAX_STREAMS: usize = 24;
const MAX_TUNNELS: usize = 4;
const MAX_PORT_ATTEMPTS: usize = 1024;

fn local_origin(port: u16) -> String {
  let host = if cfg!(target_os = "macos") { "localhost" } else { "127.0.0.1" };
  format!("http://{host}:{port}")
}

fn bind_local_listeners(preferred_port: u16) -> Result<(Vec<TcpListener>, u16), String> {
  if preferred_port == 0 { return Err("Invalid preview port".into()); }
  for port in (preferred_port..=u16::MAX).take(MAX_PORT_ATTEMPTS) {
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
  Err(format!("No local preview port available starting at {preferred_port}"))
}

#[cfg(test)]
mod tests {
  use super::bind_local_listeners;
  use std::net::{TcpListener, TcpStream};

  #[test]
  fn uses_requested_port_then_falls_forward_when_occupied() {
    let occupied = loop {
      let listener = TcpListener::bind("127.0.0.1:0").unwrap();
      if listener.local_addr().unwrap().port() < u16::MAX { break listener; }
    };
    let requested = occupied.local_addr().unwrap().port();
    let (fallback_listeners, fallback) = bind_local_listeners(requested).unwrap();
    assert!(fallback > requested);
    drop(occupied);
    let (listeners, available) = bind_local_listeners(requested).unwrap();
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
      if let Ok(writer) = socket.writer.lock() {
        let _ = writer.shutdown(Shutdown::Both);
      }
      if let Ok(sessions) = self.sessions.lock() {
        if let Some(session) = sessions.get(&socket.tunnel_id) {
          if let Ok(mut sockets) = session.sockets.lock() {
            sockets.remove(stream_id);
          }
        }
      }
    }
  }

  fn accept_loop(self: Arc<Self>, app: AppHandle, tunnel_id: String,
      listener: TcpListener, session: Arc<PreviewSession>) {
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
          let writer = match reader.try_clone() {
            Ok(value) => value,
            Err(_) => continue,
          };
          let stream_id = Uuid::new_v4().to_string();
          let socket = Arc::new(PreviewSocket {
            tunnel_id: tunnel_id.clone(), writer: Mutex::new(writer),
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
          thread::sleep(Duration::from_millis(20));
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
pub fn preview_start(app: AppHandle, window: WebviewWindow,
    manager: State<'_, Arc<PreviewProxy>>, tunnel_id: String,
    preferred_port: u16) -> Result<String, String> {
  Uuid::parse_str(&tunnel_id).map_err(|_| "Invalid preview tunnel ID".to_string())?;
  if preferred_port == 0 { return Err("Invalid preview port".into()); }
  let mut sessions = manager.sessions.lock().map_err(|_| "Preview state unavailable")?;
  if let Some(session) = sessions.get(&tunnel_id) {
    if session.owner != window.label() { return Err("Preview already open in another window".into()); }
    return Ok(local_origin(session.port));
  }
  if sessions.len() >= MAX_TUNNELS { return Err("Too many active previews".into()); }
  let (listeners, port) = bind_local_listeners(preferred_port)?;
  for listener in &listeners {
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
  }
  let session = Arc::new(PreviewSession {
    port, owner: window.label().to_string(), stopped: AtomicBool::new(false),
    accept_threads: Mutex::new(Vec::new()),
    sockets: Mutex::new(HashSet::new()),
  });
  let mut accept_threads = session.accept_threads.lock().map_err(|_| "Preview state unavailable")?;
  sessions.insert(tunnel_id.clone(), Arc::clone(&session));
  drop(sessions);
  let manager = Arc::clone(manager.inner());
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
    tunnel_id: String) {
  let manager = Arc::clone(manager.inner());
  let _ = tauri::async_runtime::spawn_blocking(move || {
    let session = manager.sessions.lock().ok().and_then(|mut sessions| sessions.remove(&tunnel_id));
    if let Some(session) = session {
      session.stopped.store(true, Ordering::Release);
      let accept_threads = session.accept_threads.lock()
        .map(|mut threads| std::mem::take(&mut *threads)).unwrap_or_default();
      for thread in accept_threads { let _ = thread.join(); }
      let stream_ids: Vec<String> = session.sockets.lock()
        .map(|sockets| sockets.iter().cloned().collect()).unwrap_or_default();
      for stream_id in stream_ids {
        manager.close_socket(&stream_id);
      }
    }
  }).await;
}
