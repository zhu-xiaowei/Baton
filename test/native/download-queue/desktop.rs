#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "baton-download-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn empty(&self) -> bool {
            fs::read_dir(&self.0).unwrap().next().is_none()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn candidate(directory: &Path, name: &str, bytes: &[u8], total: Option<u64>) -> PendingDownload {
        let mut pending = PendingDownload::create(directory, name, total).unwrap();
        let received = pending.write_chunk(bytes, 0, total).unwrap();
        pending.finish(received, total).unwrap();
        pending
    }

    #[test]
    fn saved_bytes_survive_commit_and_abandoned_files_are_removed() {
        for (bytes, total) in [(b"hello".as_slice(), Some(5)), (b"hello".as_slice(), None),
                               (b"".as_slice(), Some(0)), (b"".as_slice(), None)] {
            let dir = TempDir::new();
            let pending = candidate(&dir.0, "data.txt", bytes, total);
            assert_eq!(fs::read(pending.path()).unwrap(), bytes);
            let path = pending.path().to_path_buf();
            pending.commit();
            assert!(path.exists());
            let abandoned = candidate(&dir.0, "abandoned.txt", bytes, total);
            let path = abandoned.path().to_path_buf();
            drop(abandoned);
            assert!(!path.exists());
        }
    }

    #[test]
    fn async_chunk_writer_enforces_limits_and_length_and_cleans_up() {
        let dir = TempDir::new();
        {
            let mut pending = PendingDownload::create(&dir.0, "data", None).unwrap();
            assert!(pending.write_chunk(b"x", MAX_BYTES, None).is_err());
            assert!(pending.write_chunk(b"x", u64::MAX, None).is_err());
            assert!(pending.write_chunk(b"abc", 0, Some(2)).is_err());
            assert_eq!(pending.write_chunk(b"abc", 0, Some(4)).unwrap(), 3);
            assert!(pending.finish(3, Some(4)).is_err());
        }
        assert!(dir.empty());
    }

    #[test]
    fn progress_is_throttled_and_final_count_is_never_lost() {
        let mut events = Vec::new();
        let start = Instant::now();
        let mut progress = Progress::new(|n, total| events.push((n, total)), None, start);
        progress.update(5, start + Duration::from_millis(10), false);
        progress.update(10, start + Duration::from_millis(100), false);
        progress.update(15, start + Duration::from_millis(110), false);
        progress.update(20, start + Duration::from_millis(120), true);
        progress.update(20, start + Duration::from_millis(121), true);
        assert_eq!(events, [(0, None), (10, None), (20, None)]);
    }

    #[test]
    fn receipts_are_unique_and_reject_unknown_missing_and_symlink_paths() {
        let dir = TempDir::new();
        let mut receipts = Receipts::default();
        let first = candidate(&dir.0, "../file.txt", b"a", None);
        let second = candidate(&dir.0, "../file.txt", b"b", None);
        assert_eq!(first.path().parent(), Some(dir.0.as_path()));
        assert_ne!(first.path(), second.path());
        let first_id = receipts.insert("main", first.path()).unwrap();
        let second_id = receipts.insert("main", second.path()).unwrap();
        assert_ne!(first_id, second_id);
        assert_eq!(receipts.resolve("main", &first_id).unwrap(), first.path());
        assert!(receipts.resolve("other-webview", &first_id).is_err());
        assert!(receipts.resolve("main", "/etc/passwd").is_err());
        assert!(receipts.resolve("main", "download-999").is_err());
        let first_path = first.path().to_path_buf();
        first.commit();
        fs::remove_file(&first_path).unwrap();
        assert!(receipts.resolve("main", &first_id).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(second.path(), &first_path).unwrap();
            assert!(receipts.resolve("main", &first_id).is_err());
            assert!(receipts.insert("main", &first_path).is_err());
        }
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn opener_uses_literal_paths_without_a_shell() {
        let path = Path::new("/tmp/a folder/$(touch should-not-exist).txt");
        let open = open_command(path, false).unwrap();
        let reveal = open_command(path, true).unwrap();
        assert_eq!(open.get_args().collect::<Vec<_>>(), [path.as_os_str()]);
        #[cfg(target_os = "macos")]
        {
            assert_eq!(open.get_program(), "/usr/bin/open");
            assert_eq!(reveal.get_args().collect::<Vec<_>>(), [std::ffi::OsStr::new("-R"), path.as_os_str()]);
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(open.get_program(), "xdg-open");
            assert_eq!(reveal.get_args().collect::<Vec<_>>(), [path.parent().unwrap().as_os_str()]);
        }
    }
}
