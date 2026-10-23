use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};
use crate::filename;

pub const MAX_BYTES: u64 = 512 * 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// A reserved destination is removed on every failure, including unwinding.
pub struct PendingDownload {
    path: PathBuf,
    file: Option<File>,
    committed: bool,
}

impl PendingDownload {
    pub fn create(directory: &Path, name: &str, total: Option<u64>) -> io::Result<Self> {
        if total.is_some_and(|total| total > MAX_BYTES) {
            return Err(io::Error::other("File exceeds 512 MB"));
        }
        fs::create_dir_all(directory)?;
        let directory = fs::canonicalize(directory)?;
        let (path, file) = filename::reserve_file(&directory, name)?;
        Ok(Self { path, file: Some(file), committed: false })
    }

    pub fn write_chunk(&mut self, bytes: &[u8], received: u64, total: Option<u64>) -> io::Result<u64> {
        let next = received.checked_add(bytes.len() as u64)
            .filter(|next| *next <= MAX_BYTES)
            .ok_or_else(|| io::Error::other("File exceeds 512 MB"))?;
        if total.is_some_and(|total| next > total) {
            return Err(io::Error::other("Received more bytes than Content-Length"));
        }
        self.file.as_mut().unwrap().write_all(bytes)?;
        Ok(next)
    }

    pub fn finish(&mut self, received: u64, total: Option<u64>) -> io::Result<()> {
        if total.is_some_and(|total| received != total) {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof,
                "Incomplete download: received bytes do not match Content-Length"));
        }
        self.file.as_mut().unwrap().sync_all()?;
        self.file.take();
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for PendingDownload {
    fn drop(&mut self) {
        self.file.take();
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(crate) struct Progress<F> {
    notify: F,
    total: Option<u64>,
    last_report: Instant,
    last_received: u64,
}

impl<F: FnMut(u64, Option<u64>)> Progress<F> {
    pub(crate) fn new(mut notify: F, total: Option<u64>, now: Instant) -> Self {
        notify(0, total);
        Self {
            notify,
            total,
            last_report: now,
            last_received: 0,
        }
    }

    pub(crate) fn update(&mut self, received: u64, now: Instant, finished: bool) {
        if received != self.last_received
            && (finished || now.duration_since(self.last_report) >= PROGRESS_INTERVAL)
        {
            (self.notify)(received, self.total);
            self.last_received = received;
            self.last_report = now;
        }
    }
}

#[derive(Default)]
pub struct Receipts {
    next_id: u64,
    paths: HashMap<(String, String), PathBuf>,
}

impl Receipts {
    pub fn insert(&mut self, owner: &str, path: &Path) -> io::Result<String> {
        validate_path(path)?;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| io::Error::other("Download receipt IDs exhausted"))?;
        let id = format!("download-{}", self.next_id);
        self.paths.insert((owner.to_owned(), id.clone()), path.to_path_buf());
        Ok(id)
    }

    pub fn resolve(&self, owner: &str, id: &str) -> io::Result<PathBuf> {
        let path = self
            .paths
            .get(&(owner.to_owned(), id.to_owned()))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Unknown download receipt"))?;
        validate_path(path)?;
        Ok(path.clone())
    }
}

fn validate_path(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || !fs::symlink_metadata(path)?.file_type().is_file()
        || fs::canonicalize(path)? != path
    {
        return Err(io::Error::other("Saved download is no longer a regular file at its recorded path"));
    }
    Ok(())
}

fn open_command(path: &Path, reveal: bool) -> io::Result<Command> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/open");
        if reveal {
            command.arg("-R");
        }
        command.arg(path);
        Ok(command)
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("xdg-open");
        // xdg-open has no portable file-selection API; reveal opens its folder.
        command.arg(if reveal {
            path.parent().ok_or_else(|| io::Error::other("Missing download folder"))?
        } else {
            path
        });
        Ok(command)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (path, reveal);
        Err(io::Error::new(io::ErrorKind::Unsupported, "Opening downloads is unsupported on this platform"))
    }
}

pub fn open_receipt(receipts: &Mutex<Receipts>, owner: &str, id: &str, reveal: bool) -> io::Result<()> {
    let path = receipts
        .lock()
        .map_err(|_| io::Error::other("Download receipts unavailable"))?
        .resolve(owner, id)?;
    let output = open_command(&path, reveal)?.output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "System file opener failed ({})",
            output.status
        )));
    }
    Ok(())
}
