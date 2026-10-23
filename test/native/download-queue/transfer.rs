#[cfg(test)]
mod tests {
    use super::*;
    use crate::{desktop::MAX_BYTES, operations::{Operations, CANCELLED}};
    use std::{fs, path::PathBuf, sync::atomic::{AtomicUsize, Ordering}};
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, sync::oneshot};

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!("baton-async-download-{}-{}",
                std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn empty(&self) -> bool { fs::read_dir(&self.0).unwrap().next().is_none() }
    }
    impl Drop for Directory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    async fn server(response: &'static [u8], tls: bool) -> (
        reqwest::Url, oneshot::Receiver<()>, tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("{}://{}/file?secret=must-not-leak",
            if tls { "https" } else { "http" }, listener.local_addr().unwrap()).parse().unwrap();
        let (started, ready) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buf = [0; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buf[..n]);
                if tls || request.windows(4).any(|w| w == b"\r\n\r\n") { break; }
            }
            socket.write_all(response).await.unwrap();
            let _ = started.send(());
            let mut buf = [0; 4096];
            loop {
                match tokio::time::timeout(Duration::from_secs(2), socket.read(&mut buf)).await
                    .expect("cancel/timeout left the connection open") {
                    Ok(0) => break,
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe) => break,
                    Ok(_) if tls => continue,
                    other => panic!("unexpected peer read: {other:?}"),
                }
            }
        });
        (url, ready, peer)
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn cancellation_ack_waits_for_socket_abort_and_partial_cleanup() {
        for response in [
            b"".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\npartial".as_slice(),
        ] {
            let dir = Directory::new();
            let (url, started, peer) = server(response, false).await;
            let operations = Operations::default();
            let mut operation = operations.begin("webview-a", Some("request")).unwrap();
            let path = dir.0.clone();
            let transfer = tokio::spawn(async move {
                operation.run(save(test_client(), url, &path, "file.zip",
                    Duration::from_secs(5), |_, _| {})).await
            });
            started.await.unwrap();
            if !response.is_empty() {
                tokio::time::timeout(Duration::from_secs(1), async {
                    loop {
                        if fs::read_dir(&dir.0).unwrap().any(|e| e.unwrap().metadata().unwrap().len() > 0) { break; }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }).await.unwrap();
            }
            let mut done = operations.cancel("webview-a", "request").unwrap().unwrap();
            tokio::time::timeout(Duration::from_secs(1), done.wait_for(|done| *done)).await.unwrap().unwrap();
            assert!(dir.empty(), "cancel acknowledged before cleanup");
            assert!(matches!(transfer.await.unwrap(), Err(e) if e == CANCELLED));
            peer.await.unwrap();
            assert!(dir.empty());
        }
    }

    #[tokio::test]
    async fn native_header_and_body_idle_timeouts_close_socket_and_clean_up() {
        for response in [
            b"".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\npartial".as_slice(),
        ] {
            let dir = Directory::new();
            let (url, _, peer) = server(response, false).await;
            let result = save(test_client(), url, &dir.0, "file",
                Duration::from_millis(75), |_, _| {}).await;
            assert!(matches!(result, Err(e) if e.contains("timed out") && !e.contains("secret")));
            assert!(dir.empty());
            peer.await.unwrap();
        }
    }

    #[tokio::test]
    async fn stalled_tls_handshake_obeys_connect_timeout() {
        let dir = Directory::new();
        let (url, _, peer) = server(b"", true).await;
        let client = reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_millis(75)).build().unwrap();
        let start = Instant::now();
        let result = save(client, url, &dir.0, "file", Duration::from_secs(2), |_, _| {}).await;
        assert!(matches!(result, Err(e) if e.contains("timed out") && !e.contains("secret")));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(dir.empty());
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn progress_resets_idle_deadline_and_saved_receipt_survives_late_cancel() {
        let dir = Directory::new();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap()).parse().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            socket.read(&mut buf).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            for _ in 0..6 {
                socket.write_all(b"1\r\nx\r\n").await.unwrap();
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            socket.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let operations = Operations::default();
        let mut operation = operations.begin("a", Some("success")).unwrap();
        let mut events = Vec::new();
        let pending = operation.run(save(test_client(), url, &dir.0, "../file.zip",
            Duration::from_millis(150), |n, total| events.push((n, total)))).await.unwrap();
        let path = pending.path().to_owned();
        let mut receipts = crate::desktop::Receipts::default();
        let id = operation.complete(|| {
            let id = receipts.insert("webview-a", &path).map_err(|e| e.to_string())?;
            pending.commit();
            Ok(id)
        }).unwrap();
        assert!(operations.cancel("a", "success").unwrap().is_none());
        assert_eq!(receipts.resolve("webview-a", &id).unwrap(), path);
        assert_eq!(fs::read(path).unwrap(), b"xxxxxx");
        assert_eq!(events.first(), Some(&(0, None)));
        assert_eq!(events.last(), Some(&(6, None)));
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn response_errors_truncation_and_size_limit_remove_partial_files_and_strip_url() {
        for response in [
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n".to_string(),
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabc".into(),
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_BYTES + 1),
            "HTTP/1.1 200 OK\r\nContent-Length: invalid\r\n\r\n".into(),
        ] {
            let dir = Directory::new();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/?secret=must-not-leak", listener.local_addr().unwrap()).parse().unwrap();
            let peer = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0; 4096];
                socket.read(&mut buf).await.unwrap();
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let result = save(test_client(), url, &dir.0, "file", Duration::from_secs(1), |_, _| {}).await;
            assert!(matches!(result, Err(e) if !e.contains("secret") && !e.contains("127.0.0.1")));
            assert!(dir.empty());
            peer.await.unwrap();
        }
    }

    #[test]
    fn public_entry_rejects_insecure_and_credential_urls_without_echoing_them() {
        for url in ["http://example.com", "https://user:secret@example.com", "file:///secret", "bad secret"] {
            let error = parse_url(url).unwrap_err();
            assert!(!error.contains("secret"));
        }
        assert!(parse_url("https://example.com/file?signature=secret").is_ok());
    }
    #[tokio::test]
    async fn zip_download_preserves_exact_binary_bytes_with_known_and_unknown_size() {
        const ZIP: &[u8] = b"PK\x03\x04\x14\x00\x00\x00\x00\x00\x00\x00G]9\xc0-\x80\x17\x00\x00\x00\x17\x00\x00\x00\x0a\x00\x00\x00source.txtBaton source fixture\x0a\x00\xffPK\x01\x02\x14\x03\x14\x00\x00\x00\x00\x00\x00\x00G]9\xc0-\x80\x17\x00\x00\x00\x17\x00\x00\x00\x0a\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x80\x01\x00\x00\x00\x00source.txtPK\x05\x06\x00\x00\x00\x00\x01\x00\x01\x008\x00\x00\x00?\x00\x00\x00\x00\x00";
        for known_size in [true, false] {
            let dir = Directory::new();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/source.zip", listener.local_addr().unwrap()).parse().unwrap();
            let peer = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0; 4096];
                socket.read(&mut buf).await.unwrap();
                let header = if known_size {
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\n\r\n", ZIP.len())
                } else {
                    "HTTP/1.0 200 OK\r\nContent-Type: application/zip\r\n\r\n".into()
                };
                socket.write_all(header.as_bytes()).await.unwrap();
                for chunk in ZIP.chunks(7) {
                    socket.write_all(chunk).await.unwrap();
                    tokio::task::yield_now().await;
                }
            });
            let mut events = Vec::new();
            let pending = save(test_client(), url, &dir.0, "source.zip", Duration::from_secs(1),
                |n, total| events.push((n, total))).await.unwrap();
            assert_eq!(fs::read(pending.path()).unwrap(), ZIP);
            assert_eq!(pending.path().extension().unwrap(), "zip");
            assert_eq!(events.last(), Some(&(ZIP.len() as u64, known_size.then_some(ZIP.len() as u64))));
            pending.commit();
            peer.await.unwrap();
        }
    }

}
