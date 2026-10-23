use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub const CANCELLED: &str = "Download cancelled";
const HISTORY_LIMIT: usize = 256;
const HISTORY_TTL: Duration = Duration::from_secs(60);
type Key = (String, String);

enum Entry {
    Active { cancel: watch::Sender<bool>, finished: watch::Receiver<bool> },
    Terminal { cancelled: bool, at: Instant },
}

#[derive(Clone, Default)]
pub struct Operations(Arc<Mutex<HashMap<Key, Entry>>>);

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("requestId must contain 1–128 UTF-8 bytes".into());
    }
    Ok(())
}

fn prune(entries: &mut HashMap<Key, Entry>, now: Instant) {
    entries.retain(|_, entry| match entry {
        Entry::Active { .. } => true,
        Entry::Terminal { at, .. } => now.duration_since(*at) < HISTORY_TTL,
    });
    while entries.values().filter(|e| matches!(e, Entry::Terminal { .. })).count() > HISTORY_LIMIT {
        let oldest = entries.iter().filter_map(|(key, entry)| match entry {
            Entry::Terminal { at, .. } => Some((key.clone(), *at)),
            _ => None,
        }).min_by_key(|(_, at)| *at).unwrap().0;
        entries.remove(&oldest);
    }
}

impl Operations {
    pub fn begin(&self, owner: &str, request_id: Option<&str>) -> Result<Operation, String> {
        let key = request_id.map(|id| {
            validate_id(id)?;
            Ok::<_, String>((owner.to_owned(), id.to_owned()))
        }).transpose()?;
        let (sender, receiver) = watch::channel(false);
        let (finished, completion) = watch::channel(false);
        if let Some(key) = &key {
            let mut entries = self.0.lock().map_err(|_| "Download registry unavailable")?;
            prune(&mut entries, Instant::now());
            match entries.get(key) {
                Some(Entry::Terminal { cancelled: true, .. }) => return Err(CANCELLED.into()),
                Some(_) => return Err("requestId has already been used".into()),
                None => {}
            }
            entries.insert(key.clone(), Entry::Active { cancel: sender.clone(), finished: completion });
        }
        Ok(Operation { registry: self.clone(), key, receiver, _sender: sender, finished })
    }

    pub fn cancel(&self, owner: &str, request_id: &str) -> Result<Option<watch::Receiver<bool>>, String> {
        validate_id(request_id)?;
        let key = (owner.to_owned(), request_id.to_owned());
        let mut entries = self.0.lock().map_err(|_| "Download registry unavailable")?;
        prune(&mut entries, Instant::now());
        let completion = match entries.get(&key) {
            Some(Entry::Active { cancel, finished }) => {
                cancel.send_replace(true);
                Some(finished.clone())
            }
            Some(Entry::Terminal { .. }) => None,
            None => {
                entries.insert(key, Entry::Terminal { cancelled: true, at: Instant::now() });
                None
            }
        };
        prune(&mut entries, Instant::now());
        Ok(completion)
    }
}

pub struct Operation {
    registry: Operations,
    key: Option<Key>,
    receiver: watch::Receiver<bool>,
    _sender: watch::Sender<bool>,
    finished: watch::Sender<bool>,
}

impl Operation {
    pub async fn run<T>(&mut self, transfer: impl Future<Output = Result<T, String>>) -> Result<T, String> {
        tokio::select! {
            biased;
            _ = self.receiver.wait_for(|cancelled| *cancelled) => Err(CANCELLED.into()),
            result = transfer => result,
        }
    }

    // The receipt and saved file become visible atomically with respect to cancel.
    pub fn complete<T>(&self, commit: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let mut entries = self.registry.0.lock().map_err(|_| "Download registry unavailable")?;
        if *self.receiver.borrow() {
            return Err(CANCELLED.into());
        }
        let result = commit();
        if let Some(key) = &self.key {
            entries.insert(key.clone(), Entry::Terminal { cancelled: false, at: Instant::now() });
            prune(&mut entries, Instant::now());
        }
        result
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        if let (Some(key), Ok(mut entries)) = (&self.key, self.registry.0.lock()) {
            if matches!(entries.get(key), Some(Entry::Active { .. })) {
                entries.insert(key.clone(), Entry::Terminal {
                    cancelled: *self.receiver.borrow(), at: Instant::now(),
                });
                prune(&mut entries, Instant::now());
            }
        }
        self.finished.send_replace(true);
    }
}
