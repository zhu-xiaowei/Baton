use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

static PROBE_URL: Mutex<Option<String>> = Mutex::new(None);

const PAGE: &str = r#"<!doctype html>
<html lang="en">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/probe.css">
<main>
  <h1>Baton local preview</h1>
  <p id="result">Loading same-origin resources...</p>
</main>
<script src="/probe.js"></script>
</html>"#;

const SCRIPT: &str = r#"fetch('/probe.json')
  .then(response => {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  })
  .then(data => {
    if (data.ready !== true) throw new Error('Unexpected resource response');
    document.getElementById('result').textContent = 'HTML, CSS, JavaScript and fetch loaded';
    window.parent.postMessage({ type: 'baton-local-preview-probe', ok: true }, '*');
  })
  .catch(error => {
    document.getElementById('result').textContent = error.message;
    window.parent.postMessage({ type: 'baton-local-preview-probe', ok: false, error: error.message }, '*');
  });"#;

const STYLE: &str = "html{background:#0d1117;color:#e6edf3;font:16px system-ui}main{margin:24px;padding:20px;border:2px solid #3fb950;border-radius:12px}";

fn respond(stream: &mut TcpStream) -> std::io::Result<()> {
  stream.set_read_timeout(Some(Duration::from_secs(2)))?;
  stream.set_write_timeout(Some(Duration::from_secs(2)))?;
  let mut request = Vec::with_capacity(1024);
  let mut chunk = [0_u8; 1024];
  while request.len() < 8192 && !request.ends_with(b"\r\n\r\n") {
    let read = stream.read(&mut chunk)?;
    if read == 0 {
      return Ok(());
    }
    request.extend_from_slice(&chunk[..read]);
    if request.windows(4).any(|part| part == b"\r\n\r\n") {
      break;
    }
  }
  let first_line = String::from_utf8_lossy(&request);
  let mut parts = first_line.lines().next().unwrap_or("").split_whitespace();
  let method = parts.next().unwrap_or("");
  let path = parts.next().unwrap_or("");
  let (status, content_type, body) = match (method, path) {
    ("GET", "/") => ("200 OK", "text/html; charset=utf-8", PAGE),
    ("GET", "/probe.js") => ("200 OK", "text/javascript; charset=utf-8", SCRIPT),
    ("GET", "/probe.css") => ("200 OK", "text/css; charset=utf-8", STYLE),
    ("GET", "/probe.json") => ("200 OK", "application/json", r#"{"ready":true}"#),
    _ => ("404 Not Found", "text/plain; charset=utf-8", "Not found"),
  };
  write!(
    stream,
    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
    body.len()
  )?;
  stream.write_all(body.as_bytes())
}

#[cfg_attr(not(test), tauri::command)]
pub fn start_local_preview_probe() -> Result<String, String> {
  let mut saved = PROBE_URL.lock().map_err(|_| "Local probe state unavailable")?;
  if let Some(url) = saved.as_ref() {
    return Ok(url.clone());
  }
  let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
  let url = format!("http://{}", listener.local_addr().map_err(|error| error.to_string())?);
  thread::Builder::new()
    .name("baton-local-preview-probe".into())
    .spawn(move || {
      for incoming in listener.incoming() {
        if let Ok(mut stream) = incoming {
          let _ = respond(&mut stream);
        }
      }
    })
    .map_err(|error| error.to_string())?;
  *saved = Some(url.clone());
  Ok(url)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn local_page_serves_its_resources() {
    let url = start_local_preview_probe().unwrap();
    for (path, expected) in [
      ("/", "Baton local preview"),
      ("/probe.css", "border:2px solid"),
      ("/probe.js", "fetch('/probe.json')"),
      ("/probe.json", r#""ready":true"#),
    ] {
      let mut stream = TcpStream::connect(url.trim_start_matches("http://")).unwrap();
      write!(stream, "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
      let mut response = String::new();
      stream.read_to_string(&mut response).unwrap();
      assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{path}: {response}");
      assert!(response.contains(expected), "{path}: {response}");
    }
  }
}
