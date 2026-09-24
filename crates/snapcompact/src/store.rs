//! A content-addressed store for compacted text.
//!
//! Compaction is only safe if it is reversible. The store holds the original
//! text of every frame, addressed by its hash, so an agent that decides a frame
//! mattered after all can fetch it back rather than having lost it.
//!
//! Content addressing rather than sequential ids: two identical tool outputs —
//! the same `cargo test` run twice — store once, and the same content always
//! has the same name across sessions.

use pi_builtins::hash::sha256_hex;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Store {
    /// Where blobs live, or `None` for a store that exists only in memory.
    root: Option<PathBuf>,
    /// A read cache, and the whole store when `root` is `None`.
    cache: HashMap<String, String>,
}

impl Store {
    /// A store backed by a directory.
    pub fn at(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let _ = fs::create_dir_all(&root);
        Store { root: Some(root), cache: HashMap::new() }
    }

    /// A store that keeps everything in memory, for tests and short sessions.
    pub fn in_memory() -> Self {
        Store { root: None, cache: HashMap::new() }
    }

    /// Stores text, returning its hash.
    pub fn put(&mut self, text: &str) -> String {
        let hash = sha256_hex(text.as_bytes());

        if let Some(root) = &self.root {
            let path = self.path_for(root, &hash);
            // Already stored: identical content has an identical hash, so
            // rewriting it would be pure cost.
            if !path.exists() {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::write(&path, text);
            }
        }

        self.cache.insert(hash.clone(), text.to_string());
        hash
    }

    /// Retrieves text by hash, or by an unambiguous prefix of one.
    pub fn get(&self, hash: &str) -> Option<String> {
        if let Some(text) = self.cache.get(hash) {
            return Some(text.clone());
        }

        let root = self.root.as_ref()?;

        // A full hash resolves directly.
        if hash.len() == 64 {
            return fs::read_to_string(self.path_for(root, hash)).ok();
        }

        // A prefix has to be searched for, and is only valid if it matches one
        // blob — returning an arbitrary one of several would be worse than
        // failing.
        let mut found: Option<PathBuf> = None;
        let prefix_dir = root.join(hash.get(..2).unwrap_or(""));
        let Ok(entries) = fs::read_dir(&prefix_dir) else { return None };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = format!("{}{name}", hash.get(..2).unwrap_or(""));
            if full.starts_with(hash) {
                if found.is_some() {
                    return None;
                }
                found = Some(entry.path());
            }
        }

        fs::read_to_string(found?).ok()
    }

    /// Whether a hash is stored.
    pub fn has(&self, hash: &str) -> bool {
        self.get(hash).is_some()
    }

    /// Blob count and total bytes on disk.
    pub fn stats(&self) -> (usize, u64) {
        let Some(root) = &self.root else {
            let bytes = self.cache.values().map(|text| text.len() as u64).sum();
            return (self.cache.len(), bytes);
        };

        let mut count = 0;
        let mut bytes = 0;

        let Ok(buckets) = fs::read_dir(root) else { return (0, 0) };
        for bucket in buckets.flatten() {
            let Ok(entries) = fs::read_dir(bucket.path()) else { continue };
            for entry in entries.flatten() {
                if let Ok(metadata) = entry.metadata() {
                    count += 1;
                    bytes += metadata.len();
                }
            }
        }
        (count, bytes)
    }

    /// Removes blobs not named in `keep`, returning how many went.
    ///
    /// Nothing calls this automatically. Deleting the record of what happened
    /// in a session is not a decision to make on a timer.
    pub fn prune(&mut self, keep: &[String]) -> usize {
        let Some(root) = self.root.clone() else {
            let before = self.cache.len();
            self.cache.retain(|hash, _| keep.contains(hash));
            return before - self.cache.len();
        };

        let mut removed = 0;
        let Ok(buckets) = fs::read_dir(&root) else { return 0 };

        for bucket in buckets.flatten() {
            let bucket_name = bucket.file_name().to_string_lossy().into_owned();
            let Ok(entries) = fs::read_dir(bucket.path()) else { continue };

            for entry in entries.flatten() {
                let hash = format!("{bucket_name}{}", entry.file_name().to_string_lossy());
                if !keep.contains(&hash) && fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                    self.cache.remove(&hash);
                }
            }
        }
        removed
    }

    /// Blobs are bucketed by their first two hex characters, so no directory
    /// holds a hundred thousand entries — which is where filesystem listing
    /// performance collapses.
    fn path_for(&self, root: &Path, hash: &str) -> PathBuf {
        root.join(&hash[..2]).join(&hash[2..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "snapcompact-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn round_trips_in_memory() {
        let mut store = Store::in_memory();
        let hash = store.put("hello");
        assert_eq!(store.get(&hash).unwrap(), "hello");
    }

    #[test]
    fn round_trips_on_disk() {
        let root = temp();
        let mut store = Store::at(&root);
        let hash = store.put("persisted content");

        // A fresh store with an empty cache must still find it.
        let reopened = Store::at(&root);
        assert_eq!(reopened.get(&hash).unwrap(), "persisted content");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn identical_content_stores_once() {
        let root = temp();
        let mut store = Store::at(&root);
        let first = store.put("the same output");
        let second = store.put("the same output");

        assert_eq!(first, second);
        assert_eq!(store.stats().0, 1);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_prefix_resolves_when_it_is_unambiguous() {
        let root = temp();
        let mut store = Store::at(&root);
        let hash = store.put("findable");

        let reopened = Store::at(&root);
        assert_eq!(reopened.get(&hash[..12]).unwrap(), "findable");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_missing_hash_returns_none_rather_than_an_empty_string() {
        let store = Store::in_memory();
        assert!(store.get(&"0".repeat(64)).is_none());
        assert!(!store.has("nonexistent"));
    }

    #[test]
    fn blobs_are_bucketed_by_prefix() {
        let root = temp();
        let mut store = Store::at(&root);
        let hash = store.put("bucketed");
        assert!(root.join(&hash[..2]).join(&hash[2..]).exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pruning_keeps_what_it_is_told_to() {
        let root = temp();
        let mut store = Store::at(&root);
        let kept = store.put("keep this");
        let dropped = store.put("drop this");

        assert_eq!(store.prune(&[kept.clone()]), 1);
        assert!(store.get(&kept).is_some());

        let reopened = Store::at(&root);
        assert!(reopened.get(&dropped).is_none());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stats_report_what_is_stored() {
        let mut store = Store::in_memory();
        store.put("aaa");
        store.put("bbbb");
        let (count, bytes) = store.stats();
        assert_eq!(count, 2);
        assert_eq!(bytes, 7);
    }
}
