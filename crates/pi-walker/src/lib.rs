//! # pi-walker
//!
//! Parallel, ignore-aware filesystem walker shared by `glob`, `grep`, and
//! workspace scans. Std-only: a worker pool over a shared directory queue, with
//! gitignore semantics implemented in [`glob`].
//!
//! The walker is the substrate for two agent-facing tools:
//!
//! * `glob` — list paths matching a pattern, gitignore-respecting.
//! * `grep` — regex-free literal and pattern search over the same walk, so a
//!   single traversal serves both.

pub mod glob;
pub mod search;

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

pub use glob::{glob_match, IgnoreSet, Pattern};

/// Knobs for a walk.
#[derive(Debug, Clone)]
pub struct WalkOptions {
    /// Honour `.gitignore` / `.ignore` files found along the way.
    pub respect_gitignore: bool,
    /// Skip dot-prefixed entries.
    pub skip_hidden: bool,
    /// Stop descending past this depth (0 = the root itself).
    pub max_depth: Option<usize>,
    /// Stop after this many results.
    pub limit: Option<usize>,
    /// Follow symlinked directories. Off by default: cycles are cheap to hit.
    pub follow_symlinks: bool,
    /// Worker threads. Defaults to the machine's parallelism, capped at 8.
    pub threads: usize,
    /// Always-on ignores, applied before any `.gitignore`.
    pub extra_ignores: Vec<String>,
}

impl Default for WalkOptions {
    fn default() -> Self {
        let threads = thread::available_parallelism()
            .map(|n| n.get().min(8))
            .unwrap_or(4);
        Self {
            respect_gitignore: true,
            skip_hidden: true,
            max_depth: None,
            limit: None,
            follow_symlinks: false,
            threads,
            extra_ignores: vec![
                ".git".into(),
                "node_modules".into(),
                "target".into(),
                "dist".into(),
                ".turbo".into(),
            ],
        }
    }
}

/// One walked path.
#[derive(Debug, Clone)]
pub struct Entry {
    /// Path relative to the walk root, forward-slash separated.
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub is_dir: bool,
    pub size: u64,
}

/// Shared work queue plus the parked-worker bookkeeping that lets the pool
/// shut down exactly when the queue drains rather than on a timeout.
struct Queue {
    items: Mutex<QueueState>,
    ready: Condvar,
}

struct QueueState {
    dirs: VecDeque<(PathBuf, String, usize, Arc<IgnoreSet>)>,
    idle: usize,
    done: bool,
}

impl Queue {
    fn push(&self, item: (PathBuf, String, usize, Arc<IgnoreSet>)) {
        let mut state = self.items.lock().unwrap();
        state.dirs.push_back(item);
        self.ready.notify_one();
    }

    fn pop(&self, workers: usize) -> Option<(PathBuf, String, usize, Arc<IgnoreSet>)> {
        let mut state = self.items.lock().unwrap();
        loop {
            if state.done {
                return None;
            }
            if let Some(item) = state.dirs.pop_front() {
                return Some(item);
            }
            state.idle += 1;
            if state.idle == workers {
                // Every worker is parked and the queue is empty: the walk is over.
                state.done = true;
                self.ready.notify_all();
                return None;
            }
            state = self.ready.wait(state).unwrap();
            state.idle -= 1;
        }
    }

    fn stop(&self) {
        let mut state = self.items.lock().unwrap();
        state.done = true;
        self.ready.notify_all();
    }
}

/// Walks `root`, invoking `sink` for every non-ignored entry.
///
/// `sink` is called from multiple threads and must be `Send + Sync`.
pub fn walk<F>(root: &Path, opts: &WalkOptions, sink: F) -> std::io::Result<usize>
where
    F: Fn(Entry) + Send + Sync,
{
    let root = root.to_path_buf();
    if !root.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{} does not exist", root.display()),
        ));
    }

    let mut base = IgnoreSet::new();
    for pat in &opts.extra_ignores {
        base.add(pat);
    }
    if opts.respect_gitignore {
        load_ignore_files(&root, &mut base);
    }

    let queue = Arc::new(Queue {
        items: Mutex::new(QueueState {
            dirs: VecDeque::new(),
            idle: 0,
            done: false,
        }),
        ready: Condvar::new(),
    });
    queue.push((root.clone(), String::new(), 0, Arc::new(base)));

    let count = Arc::new(AtomicUsize::new(0));
    let sink = Arc::new(sink);
    let workers = opts.threads.max(1);

    thread::scope(|scope| {
        for _ in 0..workers {
            let queue = Arc::clone(&queue);
            let count = Arc::clone(&count);
            let sink = Arc::clone(&sink);
            let root = root.clone();
            let opts = opts.clone();
            scope.spawn(move || {
                while let Some((dir, rel, depth, ignores)) = queue.pop(workers) {
                    let entries = match fs::read_dir(&dir) {
                        Ok(e) => e,
                        // Unreadable directories are skipped, not fatal: an
                        // agent scanning a tree should not die on one bad mode.
                        Err(_) => continue,
                    };

                    // A nested .gitignore extends the parent's rules.
                    let mut local = ignores;
                    if opts.respect_gitignore && depth > 0 {
                        let nested = dir.join(".gitignore");
                        if nested.is_file() {
                            if let Ok(text) = fs::read_to_string(&nested) {
                                let mut set = (*local).clone();
                                set.add_file(&text);
                                local = Arc::new(set);
                            }
                        }
                    }

                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if opts.skip_hidden && name.starts_with('.') && name != "." {
                            continue;
                        }

                        let child_rel = if rel.is_empty() {
                            name.clone()
                        } else {
                            format!("{rel}/{name}")
                        };

                        let meta = match entry.metadata() {
                            Ok(m) => m,
                            Err(_) => continue,
                        };
                        let is_dir = meta.is_dir();

                        if local.is_ignored(&child_rel, is_dir) {
                            continue;
                        }
                        if !opts.follow_symlinks && meta.file_type().is_symlink() {
                            continue;
                        }

                        let n = count.fetch_add(1, Ordering::Relaxed) + 1;
                        sink(Entry {
                            rel_path: child_rel.clone(),
                            abs_path: entry.path(),
                            is_dir,
                            size: if is_dir { 0 } else { meta.len() },
                        });

                        if let Some(limit) = opts.limit {
                            if n >= limit {
                                queue.stop();
                                return;
                            }
                        }

                        let deeper = opts.max_depth.is_none_or(|max| depth + 1 < max);
                        if is_dir && deeper {
                            queue.push((
                                root.join(&child_rel),
                                child_rel,
                                depth + 1,
                                Arc::clone(&local),
                            ));
                        }
                    }
                }
            });
        }
    });

    Ok(count.load(Ordering::Relaxed))
}

fn load_ignore_files(root: &Path, set: &mut IgnoreSet) {
    for name in [".gitignore", ".ignore", ".jeanignore"] {
        let path = root.join(name);
        if let Ok(text) = fs::read_to_string(&path) {
            set.add_file(&text);
        }
    }
}

/// Lists every path under `root` matching `pattern`, gitignore-aware.
pub fn glob_paths(root: &Path, pattern: &str, opts: &WalkOptions) -> std::io::Result<Vec<String>> {
    let compiled = Pattern::glob(pattern);
    let found = Mutex::new(Vec::new());
    walk(root, opts, |entry| {
        if !entry.is_dir && compiled.matches(&entry.rel_path, false) {
            found.lock().unwrap().push(entry.rel_path);
        }
    })?;
    let mut out = found.into_inner().unwrap();
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Each test gets its own directory: the test binary runs them in parallel
    /// and a shared fixture path would have them deleting each other's files.
    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pi-walker-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src/nested")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.join("build")).unwrap();
        fs::write(dir.join("src/index.ts"), "export const a = 1;\n").unwrap();
        fs::write(dir.join("src/nested/deep.ts"), "export const b = 2;\n").unwrap();
        fs::write(dir.join("src/notes.md"), "# notes\n").unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "module.exports={}\n").unwrap();
        fs::write(dir.join("build/out.js"), "//built\n").unwrap();
        fs::write(dir.join(".gitignore"), "build/\n").unwrap();
        dir
    }

    #[test]
    fn walks_and_respects_ignores() {
        let dir = fixture("walk");
        let found = Mutex::new(Vec::new());
        walk(&dir, &WalkOptions::default(), |e| {
            found.lock().unwrap().push(e.rel_path)
        })
        .unwrap();
        let found = found.into_inner().unwrap();

        assert!(found.contains(&"src/index.ts".to_string()));
        assert!(found.contains(&"src/nested/deep.ts".to_string()));
        // Default extra-ignores drop node_modules; .gitignore drops build/.
        assert!(!found.iter().any(|p| p.starts_with("node_modules")));
        assert!(!found.iter().any(|p| p.starts_with("build")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn globs_by_pattern() {
        let dir = fixture("glob");
        let ts = glob_paths(&dir, "**/*.ts", &WalkOptions::default()).unwrap();
        assert_eq!(ts, vec!["src/index.ts", "src/nested/deep.ts"]);
        let md = glob_paths(&dir, "**/*.md", &WalkOptions::default()).unwrap();
        assert_eq!(md, vec!["src/notes.md"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn honours_max_depth_and_limit() {
        let dir = fixture("depth");
        let shallow = Mutex::new(Vec::new());
        walk(
            &dir,
            &WalkOptions {
                max_depth: Some(1),
                ..Default::default()
            },
            |e| shallow.lock().unwrap().push(e.rel_path),
        )
        .unwrap();
        let shallow = shallow.into_inner().unwrap();
        assert!(shallow.iter().all(|p| !p.contains('/')));

        let n = walk(
            &dir,
            &WalkOptions {
                limit: Some(2),
                threads: 1,
                ..Default::default()
            },
            |_| {},
        )
        .unwrap();
        assert!(n <= 2 + 1, "limit should stop the walk promptly, got {n}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_root_is_an_error() {
        let err = walk(Path::new("/definitely/not/here"), &WalkOptions::default(), |_| {});
        assert!(err.is_err());
    }
}
