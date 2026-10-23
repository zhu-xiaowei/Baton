#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::{Operations, CANCELLED};
    use std::{fs, path::PathBuf, sync::atomic::{AtomicUsize, Ordering}};
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!("baton-image-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap(); Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Directory { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn preserves_utf8_and_rejects_invalid_input() {
        let bytes = "<svg><text>中文 &amp; café</text></svg>".as_bytes();
        assert_eq!(decode(&format!("data:image/svg+xml;base64,{}", STANDARD.encode(bytes))).unwrap(), bytes);
        for url in ["file:///tmp/x", "data:text/html;base64,YQ==", "data:image/png;base64,",
            "data:image/png;base64,YQ", "data:image/png;base64,YR==", "data:image/png;base64,@@@="] {
            assert!(decode(url).is_err(), "{url}");
        }
    }
    #[test]
    fn enforces_inclusive_size_limit() {
        let bytes = vec![42; MAX_BYTES];
        assert_eq!(decode(&format!("data:image/png;base64,{}", STANDARD.encode(&bytes))).unwrap(), bytes);
        assert!(decode(&format!("data:image/png;base64,{}", STANDARD.encode(vec![42; MAX_BYTES + 1]))).is_err());
    }
    #[tokio::test]
    async fn saves_original_bytes_without_overwriting_or_escaping_downloads() {
        let dir = Directory::new();
        let url = "data:image/png;base64,iVBORwABAP8=";
        let mut events = vec![];
        let first = save(url, &dir.0, "../图表.png", |n, t| events.push((n, t))).await.unwrap();
        let second = save(url, &dir.0, "../图表.png", |_, _| {}).await.unwrap();
        assert_eq!(first.path().parent(), Some(dir.0.as_path())); assert_ne!(first.path(), second.path());
        let bytes = STANDARD.decode("iVBORwABAP8=").unwrap();
        assert_eq!(fs::read(first.path()).unwrap(), bytes);
        assert_eq!(events.first(), Some(&(0, Some(bytes.len() as u64))));
        assert_eq!(events.last(), Some(&(bytes.len() as u64, Some(bytes.len() as u64))));
        let first_path = first.path().to_owned(); first.commit(); drop(second);
        assert!(first_path.exists()); assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        assert!(save("data:text/html;base64,YQ==", &dir.0, "bad.html", |_, _| {}).await.is_err());
    }
    #[tokio::test]
    async fn cancellation_acknowledges_only_after_the_partially_written_image_is_removed() {
        let dir = Directory::new(); let operations = Operations::default();
        let mut operation = operations.begin("window", Some("image")).unwrap();
        let path = dir.0.clone();
        let task = tokio::spawn(async move {
            let url = format!("data:image/png;base64,{}", STANDARD.encode(vec![42; 8 * 1024 * 1024]));
            operation.run(save(&url, &path, "partial.png", |_, _| {})).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if fs::read_dir(&dir.0).unwrap().any(|entry| entry.unwrap().metadata().unwrap().len() > 0) { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        let mut finished = operations.cancel("window", "image").unwrap().unwrap();
        finished.wait_for(|done| *done).await.unwrap();
        assert!(matches!(task.await.unwrap(), Err(error) if error == CANCELLED));
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }
}
