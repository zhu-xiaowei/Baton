use crate::desktop::{PendingDownload, Progress};
use std::{path::Path, time::{Duration, Instant}};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

pub fn parse_url(url: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid download URL")?;
    if url.scheme() != "https" || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
    {
        return Err("Downloads require an HTTPS URL".into());
    }
    Ok(url)
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(IDLE_TIMEOUT)
        .https_only(true)
        .no_gzip().no_brotli().no_deflate().no_zstd()
        .build().map_err(network_error)
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Download timed out while connecting or waiting for data. Please retry.".into()
    } else {
        error.without_url().to_string()
    }
}

pub async fn save(
    client: reqwest::Client,
    url: reqwest::Url,
    directory: &Path,
    name: &str,
    idle: Duration,
    notify: impl FnMut(u64, Option<u64>),
) -> Result<PendingDownload, String> {
    let mut response = tokio::time::timeout(idle, client.get(url).send()).await
        .map_err(|_| "Download timed out waiting for response headers. Please retry.")?
        .and_then(|response| response.error_for_status()).map_err(network_error)?;
    let total = response.headers().get(reqwest::header::CONTENT_LENGTH)
        .map(|value| value.to_str().ok().and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| "Invalid Content-Length".to_string()))
        .transpose()?;
    let mut pending = PendingDownload::create(directory, name, total).map_err(|e| e.to_string())?;
    let mut progress = Progress::new(notify, total, Instant::now());
    let mut received = 0;
    let mut deadline = tokio::time::Instant::now() + idle;
    loop {
        let chunk = tokio::time::timeout_at(deadline, response.chunk()).await
            .map_err(|_| "Download timed out: no data received. Please retry.")?
            .map_err(network_error)?;
        let Some(chunk) = chunk else { break };
        if chunk.is_empty() { continue; }
        // File writes stay in this future: dropping it cannot leave a background
        // writer recreating a partial file after cancellation has completed.
        received = pending.write_chunk(&chunk, received, total).map_err(|e| e.to_string())?;
        progress.update(received, Instant::now(), false);
        deadline = tokio::time::Instant::now() + idle;
    }
    pending.finish(received, total).map_err(|e| e.to_string())?;
    progress.update(received, Instant::now(), true);
    Ok(pending)
}
