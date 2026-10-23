use base64::{engine::general_purpose::STANDARD, Engine};
use crate::desktop::{PendingDownload, Progress};
use std::{path::Path, time::Instant};

pub const MAX_BYTES: usize = 32 * 1024 * 1024;

pub fn decode(url: &str) -> Result<Vec<u8>, String> {
    let comma = url.as_bytes().iter().take(64).position(|c| *c == b',')
        .ok_or("Invalid image data URL")?;
    let mime = url[..comma].strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or("Invalid image data URL")?;
    if !matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml") {
        return Err("Unsupported image MIME type".into());
    }
    let encoded = &url[comma + 1..];
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("Image exceeds 32 MiB".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| "Invalid base64 image")?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("Image must contain 1 byte to 32 MiB".into());
    }
    Ok(bytes)
}

pub async fn save(
    url: &str, directory: &Path, name: &str, notify: impl FnMut(u64, Option<u64>),
) -> Result<PendingDownload, String> {
    let bytes = decode(url)?;
    let total = Some(bytes.len() as u64);
    let mut pending = PendingDownload::create(directory, name, total).map_err(|e| e.to_string())?;
    let mut progress = Progress::new(notify, total, Instant::now());
    let mut received = 0;
    for chunk in bytes.chunks(64 * 1024) {
        tokio::task::yield_now().await;
        received = pending.write_chunk(chunk, received, total).map_err(|e| e.to_string())?;
        progress.update(received, Instant::now(), false);
    }
    tokio::task::yield_now().await;
    pending.finish(received, total).map_err(|e| e.to_string())?;
    progress.update(received, Instant::now(), true);
    Ok(pending)
}
