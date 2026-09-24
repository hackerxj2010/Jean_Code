//! Finding executables and project roots.
//!
//! A server binary is looked for where the project would put it first
//! (`node_modules/.bin`, a virtualenv), then on `PATH`, then among the tools
//! Jean installed itself. Project-local first because that copy matches the
//! project's own versions — a TypeScript server from the project's
//! `node_modules` type-checks with the TypeScript the project compiles with.

use std::env;
use std::path::{Path, PathBuf};

/// `(os, arch)` in the vocabulary release assets use.
pub fn platform() -> (&'static str, &'static str) {
    let os = match env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    };
    let arch = match env::consts::ARCH {
        "aarch64" | "arm64" => "aarch64",
        _ => "x86_64",
    };
    (os, arch)
}

/// The file names a command may have on disk. On Windows a bare `npm` is
/// `npm.cmd`, and an extension-less file (npm's POSIX shim) cannot be started
/// by `CreateProcess`, so only names with an executable extension count.
pub fn executable_names(binary: &str) -> Vec<String> {
    if !cfg!(windows) {
        return vec![binary.to_string()];
    }
    let lower = binary.to_lowercase();
    let extensions = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let extensions: Vec<String> = extensions.split(';').filter(|e| !e.is_empty()).map(|e| e.to_lowercase()).collect();
    if extensions.iter().any(|extension| lower.ends_with(extension.as_str())) {
        return vec![binary.to_string()];
    }
    extensions.iter().map(|extension| format!("{binary}{extension}")).collect()
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else { return false };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }
    #[allow(unreachable_code)]
    true
}

/// Where `binary` resolves: a path containing a separator is checked as
/// given; a bare name is searched in `first`, then `PATH`, then `last`.
pub fn which(binary: &str, first: &[PathBuf], last: &[PathBuf]) -> Option<PathBuf> {
    if binary.contains('/') || binary.contains('\\') {
        let path = PathBuf::from(binary);
        if is_executable(&path) {
            return Some(path);
        }
        return executable_names(binary).into_iter().map(PathBuf::from).find(|p| is_executable(p));
    }

    let names = executable_names(binary);
    let direct = |dirs: &[PathBuf]| {
        dirs.iter().flat_map(|dir| names.iter().map(move |name| dir.join(name))).find(|candidate| is_executable(candidate))
    };
    if let Some(found) = direct(first) {
        return Some(found);
    }
    // `PATH` through a listing of each directory, taken once and reused: a
    // status check over seventy servers would otherwise stat every name,
    // with every Windows executable extension, in every `PATH` directory.
    let index = path_index();
    for (dir, entries) in index.iter() {
        for name in &names {
            let key = if cfg!(windows) { name.to_lowercase() } else { name.clone() };
            if let Some(actual) = entries.get(&key) {
                let candidate = dir.join(actual);
                if is_executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    direct(last)
}

type PathIndex = Vec<(PathBuf, std::collections::HashMap<String, String>)>;

/// Every file in every `PATH` directory, by (lower-cased on Windows) name,
/// refreshed every thirty seconds so a tool installed mid-session is seen.
fn path_index() -> std::sync::Arc<PathIndex> {
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static CACHE: OnceLock<Mutex<Option<(Instant, String, Arc<PathIndex>)>>> = OnceLock::new();

    let path = env::var("PATH").unwrap_or_default();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|p| p.into_inner());
    if let Some((built, from, index)) = cache.as_ref() {
        if *from == path && built.elapsed() < Duration::from_secs(30) {
            return Arc::clone(index);
        }
    }
    let index: PathIndex = env::split_paths(&path)
        .map(|dir| {
            let entries = std::fs::read_dir(&dir)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| {
                            let name = entry.file_name().to_string_lossy().to_string();
                            (if cfg!(windows) { name.to_lowercase() } else { name.clone() }, name)
                        })
                        .collect()
                })
                .unwrap_or_default();
            (dir, entries)
        })
        .collect();
    let index = Arc::new(index);
    *cache = Some((Instant::now(), path, Arc::clone(&index)));
    index
}

/// Directories a project keeps its own tool binaries in, nearest first.
pub fn project_bin_dirs(root: &Path, project_root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push_for = |dir: &Path| {
        dirs.push(dir.join("node_modules").join(".bin"));
        for venv in [".venv", "venv", ".env"] {
            dirs.push(dir.join(venv).join(if cfg!(windows) { "Scripts" } else { "bin" }));
        }
    };
    push_for(root);
    if root != project_root {
        push_for(project_root);
    }
    dirs
}

fn has_marker(dir: &Path, marker: &str) -> bool {
    if let Some(suffix) = marker.strip_prefix('*') {
        // `*.csproj`: any entry with that suffix.
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        return entries.flatten().any(|entry| entry.file_name().to_string_lossy().ends_with(suffix));
    }
    dir.join(marker).exists()
}

/// The nearest directory at or above `start` holding one of `markers`.
///
/// The innermost wins, so each package of a monorepo gets a server rooted at
/// the package. The walk stops at `ceiling` when the file is inside it, so a
/// project never picks up a marker from the directory it happens to sit in.
pub fn find_root(start: &Path, markers: &[String], ceiling: Option<&Path>) -> Option<PathBuf> {
    let ceiling = ceiling.filter(|ceiling| start.starts_with(ceiling));
    let mut current = Some(start);
    while let Some(dir) = current {
        if markers.iter().any(|marker| has_marker(dir, marker)) {
            return Some(dir.to_path_buf());
        }
        if Some(dir) == ceiling {
            return None;
        }
        current = dir.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("pi-lsp-detect-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_innermost_root_wins_and_the_ceiling_holds() {
        let root = scratch("roots");
        fs::create_dir_all(root.join("packages/app/src")).unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("packages/app/package.json"), "{}").unwrap();
        fs::write(root.join("packages/app/App.csproj"), "").unwrap();
        let markers = vec!["package.json".to_string()];
        let start = root.join("packages/app/src");
        assert_eq!(find_root(&start, &markers, Some(&root)), Some(root.join("packages/app")));
        assert_eq!(find_root(&start, &["*.csproj".to_string()], Some(&root)), Some(root.join("packages/app")));
        assert_eq!(find_root(&start, &["nothing.here".to_string()], Some(&root)), None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_project_local_binary_is_found_before_path() {
        let root = scratch("which");
        let bin = root.join("node_modules/.bin");
        fs::create_dir_all(&bin).unwrap();
        let name = if cfg!(windows) { "my-server.cmd" } else { "my-server" };
        fs::write(bin.join(name), "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let found = which("my-server", &project_bin_dirs(&root, &root), &[]);
        assert_eq!(found, Some(bin.join(name)));
        assert!(which("definitely-not-a-real-binary-xyz", &[], &[]).is_none());
        fs::remove_dir_all(&root).ok();
    }
}
