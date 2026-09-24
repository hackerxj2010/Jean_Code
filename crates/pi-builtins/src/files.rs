//! File operations (architecture §8.2): `ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`,
//! `touch`, `stat`, `file`, `basename`, `dirname`, `realpath`, `mktemp`, `tee`.
//!
//! These run in-process instead of forking a shell, which is the whole point:
//! no quoting layer between the agent's intent and the syscall, no PATH
//! ambiguity about which `ls` ran, and identical behaviour on Windows and Unix.
//! Forking `ls` on Windows finds either nothing or a Git-Bash build with
//! different flags; that inconsistency is a bug factory.

use crate::text::Output;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// ---- ls -------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct LsOptions {
    /// Include entries whose name starts with a dot.
    pub all: bool,
    /// One entry per line with size, kind, and mtime.
    pub long: bool,
    pub recursive: bool,
    /// Sort by mtime, newest first.
    pub by_time: bool,
    /// Sort by size, largest first.
    pub by_size: bool,
    pub reverse: bool,
    /// Append `/` to directories.
    pub classify: bool,
    /// Stop after this many entries. Unbounded output is how a listing of
    /// `node_modules` eats an agent's whole context window.
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Seconds since the epoch; 0 when the platform will not say.
    pub modified: u64,
}

pub fn ls(path: &Path, options: &LsOptions) -> Output {
    let mut entries = match collect(path, options, 0) {
        Ok(entries) => entries,
        Err(message) => return Output::fail(format!("ls: {}: {message}", path.display()), 2),
    };

    sort_entries(&mut entries, options);

    let total = entries.len();
    if let Some(limit) = options.limit {
        entries.truncate(limit);
    }

    let mut out = String::new();
    for entry in &entries {
        if options.long {
            out.push_str(&format_long(entry, options));
        } else {
            out.push_str(&entry.name);
            if options.classify && entry.is_dir {
                out.push('/');
            }
        }
        out.push('\n');
    }

    if let Some(limit) = options.limit {
        if total > limit {
            // Say what was hidden. A truncated listing that does not admit it
            // reads as a complete one, and the agent concludes the files aren't
            // there.
            out.push_str(&format!("... {} more entries not shown\n", total - limit));
        }
    }

    Output::ok(out)
}

fn collect(path: &Path, options: &LsOptions, depth: usize) -> std::io::Result<Vec<Entry>> {
    // A hard depth cap: a symlink cycle would otherwise recurse until the stack
    // gives out.
    if depth > 64 {
        return Ok(Vec::new());
    }

    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Ok(vec![entry_for(path, path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())?]);
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(path)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();

        if !options.all && name.starts_with('.') {
            continue;
        }

        let entry = entry_for(&item.path(), if options.recursive && depth > 0 {
            format!("{}/{name}", path.display())
        } else {
            name
        })?;

        let is_dir = entry.is_dir;
        let child = entry.path.clone();
        entries.push(entry);

        if options.recursive && is_dir {
            // A symlinked directory is not followed: that is where cycles live.
            if !fs::symlink_metadata(&child).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
                entries.extend(collect(&child, options, depth + 1)?);
            }
        }
    }
    Ok(entries)
}

fn entry_for(path: &Path, name: String) -> std::io::Result<Entry> {
    let metadata = fs::symlink_metadata(path)?;
    let is_symlink = metadata.file_type().is_symlink();
    // Report the target's kind for a symlink, which is what a user means by
    // "is this a directory".
    let resolved = if is_symlink { fs::metadata(path).ok() } else { None };
    let is_dir = resolved.as_ref().map(|m| m.is_dir()).unwrap_or(metadata.is_dir());

    Ok(Entry {
        name,
        path: path.to_path_buf(),
        is_dir,
        is_symlink,
        size: metadata.len(),
        modified: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
    })
}

fn sort_entries(entries: &mut [Entry], options: &LsOptions) {
    if options.by_time {
        entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    } else if options.by_size {
        entries.sort_by(|a, b| b.size.cmp(&a.size));
    } else {
        entries.sort_by(|a, b| a.name.cmp(&b.name));
    }
    if options.reverse {
        entries.reverse();
    }
}

fn format_long(entry: &Entry, options: &LsOptions) -> String {
    let kind = if entry.is_symlink {
        "l"
    } else if entry.is_dir {
        "d"
    } else {
        "-"
    };
    let size = if entry.is_dir { String::from("-") } else { human_size(entry.size) };
    let name = if options.classify && entry.is_dir {
        format!("{}/", entry.name)
    } else {
        entry.name.clone()
    };
    format!("{kind} {size:>8}  {}  {name}", format_time(entry.modified))
}

/// Human-readable byte counts. Exact below 1 KiB — for small files the byte
/// count is the useful number, and "0.0K" tells nobody anything.
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "K", "M", "G", "T"];
    if bytes < 1024 {
        return format!("{bytes}B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value >= 10.0 {
        format!("{:.0}{}", value, UNITS[unit])
    } else {
        format!("{:.1}{}", value, UNITS[unit])
    }
}

/// `YYYY-MM-DD HH:MM` in UTC.
///
/// Local time would need a timezone database; UTC is unambiguous and sorts,
/// which matters more in a tool's output than matching a user's wall clock.
pub fn format_time(seconds: u64) -> String {
    if seconds == 0 {
        return "                ".to_string();
    }
    let (year, month, day, hour, minute, _) = civil_from_epoch(seconds);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}")
}

/// Converts epoch seconds to a UTC civil date.
///
/// Howard Hinnant's `civil_from_days`: the era arithmetic handles leap years
/// including the century rules without a lookup table.
pub fn civil_from_epoch(seconds: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let rem = seconds % 86_400;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };

    (year, m, d, (rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32)
}

// ---- cat ------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CatOptions {
    pub number_lines: bool,
    /// Collapse runs of blank lines to one.
    pub squeeze_blank: bool,
    /// Mark line ends with `$`.
    pub show_ends: bool,
    /// Refuse to read more than this many bytes.
    pub max_bytes: Option<u64>,
}

pub fn cat(paths: &[PathBuf], options: &CatOptions) -> Output {
    let mut out = String::new();
    let mut errors = String::new();
    let mut code = 0;
    let mut number = 1usize;

    for path in paths {
        let content = match read_text(path, options.max_bytes) {
            Ok(content) => content,
            Err(message) => {
                errors.push_str(&format!("cat: {}: {message}\n", path.display()));
                code = 1;
                continue;
            }
        };

        let mut previous_blank = false;
        for line in content.lines() {
            if options.squeeze_blank && line.is_empty() {
                if previous_blank {
                    continue;
                }
                previous_blank = true;
            } else {
                previous_blank = false;
            }

            if options.number_lines {
                out.push_str(&format!("{number:6}\t"));
                number += 1;
            }
            out.push_str(line);
            if options.show_ends {
                out.push('$');
            }
            out.push('\n');
        }
    }

    Output { stdout: out, stderr: errors, code }
}

/// Reads a file as text, refusing binaries and oversized files.
pub fn read_text(path: &Path, max_bytes: Option<u64>) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        return Err("is a directory".to_string());
    }

    if let Some(limit) = max_bytes {
        if metadata.len() > limit {
            return Err(format!(
                "{} exceeds the {} limit; read a range instead",
                human_size(metadata.len()),
                human_size(limit)
            ));
        }
    }

    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;

    if is_binary(&bytes) {
        return Err(format!("binary file ({})", human_size(metadata.len())));
    }

    // Lossy on purpose: a file with one bad byte is still worth reading, and
    // failing the whole read over it helps nobody.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether a byte slice looks like a binary.
///
/// A NUL in the first 8 KiB is the signal every tool uses, because no text
/// encoding this crate handles emits one.
pub fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

// ---- copy, move, remove ---------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CopyOptions {
    pub recursive: bool,
    /// Refuse to overwrite an existing destination.
    pub no_clobber: bool,
    /// Report what would happen without touching the filesystem.
    pub dry_run: bool,
}

pub fn cp(source: &Path, destination: &Path, options: &CopyOptions) -> Output {
    let mut copied = Vec::new();
    match copy_into(source, destination, options, &mut copied) {
        Ok(()) => {
            let verb = if options.dry_run { "would copy" } else { "copied" };
            Output::ok(format!("{verb} {} file(s)\n", copied.len()))
        }
        Err(message) => Output::fail(format!("cp: {message}"), 1),
    }
}

fn copy_into(
    source: &Path,
    destination: &Path,
    options: &CopyOptions,
    copied: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|e| format!("{}: {e}", source.display()))?;

    // Copying a directory into itself would recurse forever.
    if metadata.is_dir() && destination.starts_with(source) {
        return Err(format!(
            "{} is inside {}: that would copy forever",
            destination.display(),
            source.display()
        ));
    }

    if metadata.is_dir() {
        if !options.recursive {
            return Err(format!("{} is a directory (use recursive)", source.display()));
        }
        if !options.dry_run {
            fs::create_dir_all(destination).map_err(|e| format!("{}: {e}", destination.display()))?;
        }
        for item in fs::read_dir(source).map_err(|e| format!("{}: {e}", source.display()))? {
            let item = item.map_err(|e| e.to_string())?;
            copy_into(&item.path(), &destination.join(item.file_name()), options, copied)?;
        }
        return Ok(());
    }

    if destination.exists() && options.no_clobber {
        return Err(format!("{} exists", destination.display()));
    }

    if !options.dry_run {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::copy(source, destination)
            .map_err(|e| format!("{} -> {}: {e}", source.display(), destination.display()))?;
    }
    copied.push(destination.to_path_buf());
    Ok(())
}

pub fn mv(source: &Path, destination: &Path, no_clobber: bool) -> Output {
    if destination.exists() && no_clobber {
        return Output::fail(format!("mv: {} exists", destination.display()), 1);
    }

    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(error) = fs::create_dir_all(parent) {
                return Output::fail(format!("mv: {}: {error}", parent.display()), 1);
            }
        }
    }

    match fs::rename(source, destination) {
        Ok(()) => Output::ok(String::new()),
        // A rename across filesystems fails with EXDEV; copy-then-delete is the
        // documented fallback and is what `mv` itself does.
        Err(_) => {
            let options = CopyOptions { recursive: true, ..Default::default() };
            let mut copied = Vec::new();
            if let Err(message) = copy_into(source, destination, &options, &mut copied) {
                return Output::fail(format!("mv: {message}"), 1);
            }
            let removed = if source.is_dir() {
                fs::remove_dir_all(source)
            } else {
                fs::remove_file(source)
            };
            match removed {
                Ok(()) => Output::ok(String::new()),
                Err(error) => Output::fail(
                    format!("mv: copied, but could not remove {}: {error}", source.display()),
                    1,
                ),
            }
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct RemoveOptions {
    pub recursive: bool,
    /// Ignore paths that do not exist.
    pub force: bool,
    pub dry_run: bool,
}

pub fn rm(paths: &[PathBuf], options: &RemoveOptions) -> Output {
    let mut removed = 0usize;
    let mut errors = String::new();
    let mut code = 0;

    for path in paths {
        // Refusing a filesystem root is not paranoia: an unset variable in a
        // command the agent composed turns `rm -rf $DIR/build` into `rm -rf /`.
        if is_root(path) {
            errors.push_str(&format!("rm: refusing to remove {}\n", path.display()));
            code = 1;
            continue;
        }

        if !path.exists() {
            if !options.force {
                errors.push_str(&format!("rm: {}: no such file\n", path.display()));
                code = 1;
            }
            continue;
        }

        if options.dry_run {
            removed += 1;
            continue;
        }

        let result = if path.is_dir() {
            if !options.recursive {
                errors.push_str(&format!("rm: {} is a directory\n", path.display()));
                code = 1;
                continue;
            }
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };

        match result {
            Ok(()) => removed += 1,
            Err(error) => {
                errors.push_str(&format!("rm: {}: {error}\n", path.display()));
                code = 1;
            }
        }
    }

    let verb = if options.dry_run { "would remove" } else { "removed" };
    Output { stdout: format!("{verb} {removed} path(s)\n"), stderr: errors, code }
}

/// Whether a path is a filesystem root or a drive letter.
pub fn is_root(path: &Path) -> bool {
    let normalized = path.components().collect::<Vec<_>>();
    match normalized.len() {
        0 => true,
        1 => matches!(normalized[0], Component::RootDir | Component::Prefix(_)),
        2 => matches!(
            (&normalized[0], &normalized[1]),
            (Component::Prefix(_), Component::RootDir)
        ),
        _ => false,
    }
}

// ---- mkdir, touch ---------------------------------------------------------

pub fn mkdir(paths: &[PathBuf], parents: bool) -> Output {
    let mut errors = String::new();
    let mut code = 0;
    let mut made = 0;

    for path in paths {
        let result = if parents { fs::create_dir_all(path) } else { fs::create_dir(path) };
        match result {
            Ok(()) => made += 1,
            // `mkdir -p` on an existing directory is a success, not an error.
            Err(_) if parents && path.is_dir() => made += 1,
            Err(error) => {
                errors.push_str(&format!("mkdir: {}: {error}\n", path.display()));
                code = 1;
            }
        }
    }

    Output { stdout: format!("created {made} director{}\n", if made == 1 { "y" } else { "ies" }), stderr: errors, code }
}

pub fn touch(paths: &[PathBuf]) -> Output {
    let mut errors = String::new();
    let mut code = 0;

    for path in paths {
        if path.exists() {
            // Rewriting the content to itself is the portable way to bump mtime
            // without a platform-specific utimes call.
            let result = fs::read(path).and_then(|bytes| fs::write(path, bytes));
            if let Err(error) = result {
                errors.push_str(&format!("touch: {}: {error}\n", path.display()));
                code = 1;
            }
            continue;
        }

        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                let _ = fs::create_dir_all(parent);
            }
        }
        if let Err(error) = fs::write(path, "") {
            errors.push_str(&format!("touch: {}: {error}\n", path.display()));
            code = 1;
        }
    }

    Output { stdout: String::new(), stderr: errors, code }
}

// ---- stat, file -----------------------------------------------------------

pub fn stat(path: &Path) -> Output {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => return Output::fail(format!("stat: {}: {error}", path.display()), 1),
    };

    let kind = if metadata.file_type().is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "file"
    };

    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut out = format!(
        "path:     {}\nkind:     {kind}\nsize:     {} ({} bytes)\nmodified: {} UTC\nreadonly: {}\n",
        path.display(),
        human_size(metadata.len()),
        metadata.len(),
        format_time(modified),
        metadata.permissions().readonly(),
    );

    if metadata.file_type().is_symlink() {
        if let Ok(target) = fs::read_link(path) {
            out.push_str(&format!("target:   {}\n", target.display()));
        }
    }

    Output::ok(out)
}

/// `file` — identifies content by magic bytes, not by extension.
///
/// An extension is a claim; the bytes are evidence. An agent that trusts
/// `.txt` on a zip archive will paste 4 MB of noise into its own context.
pub fn file_kind(path: &Path) -> Output {
    let mut handle = match fs::File::open(path) {
        Ok(handle) => handle,
        Err(error) => return Output::fail(format!("file: {}: {error}", path.display()), 1),
    };

    let mut header = [0u8; 512];
    let read = handle.read(&mut header).unwrap_or(0);
    let header = &header[..read];

    Output::ok(format!("{}: {}\n", path.display(), describe_bytes(header)))
}

/// A one-line description of a byte header.
pub fn describe_bytes(header: &[u8]) -> String {
    const MAGIC: &[(&[u8], &str)] = &[
        (b"\x89PNG\r\n\x1a\n", "PNG image"),
        (b"\xff\xd8\xff", "JPEG image"),
        (b"GIF87a", "GIF image"),
        (b"GIF89a", "GIF image"),
        (b"%PDF-", "PDF document"),
        (b"PK\x03\x04", "ZIP archive (or jar/docx/xlsx)"),
        (b"\x1f\x8b", "gzip compressed data"),
        (b"BZh", "bzip2 compressed data"),
        (b"\xfd7zXZ\x00", "XZ compressed data"),
        (b"\x7fELF", "ELF executable"),
        (b"MZ", "DOS/PE executable"),
        (b"\xca\xfe\xba\xbe", "Java class file"),
        (b"OggS", "Ogg media"),
        (b"RIFF", "RIFF container (wav/avi/webp)"),
        (b"\x00\x61\x73\x6d", "WebAssembly module"),
        (b"SQLite format 3\x00", "SQLite database"),
    ];

    for (magic, description) in MAGIC {
        if header.starts_with(magic) {
            return description.to_string();
        }
    }

    if header.is_empty() {
        return "empty".to_string();
    }

    if is_binary(header) {
        return "binary data".to_string();
    }

    let text = String::from_utf8_lossy(header);
    if text.starts_with("#!") {
        let line = text.lines().next().unwrap_or("");
        return format!("script ({})", line.trim_start_matches("#!").trim());
    }
    if header.starts_with(b"\xef\xbb\xbf") {
        return "UTF-8 text with BOM".to_string();
    }
    if text.trim_start().starts_with('{') || text.trim_start().starts_with('[') {
        return "JSON text".to_string();
    }
    if text.trim_start().starts_with("<?xml") {
        return "XML document".to_string();
    }
    if text.contains("\r\n") {
        return "ASCII text, CRLF line endings".to_string();
    }
    "UTF-8 text".to_string()
}

// ---- path utilities -------------------------------------------------------

pub fn basename(path: &str, suffix: Option<&str>) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let name = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    match suffix {
        Some(suffix) if name.ends_with(suffix) && name != suffix => {
            name[..name.len() - suffix.len()].to_string()
        }
        _ => name.to_string(),
    }
}

pub fn dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rfind(['/', '\\']) {
        Some(0) => "/".to_string(),
        Some(index) => trimmed[..index].to_string(),
        // No separator means the current directory, which is what `dirname`
        // prints and what callers joining onto the result depend on.
        None => ".".to_string(),
    }
}

pub fn realpath(path: &Path) -> Output {
    match fs::canonicalize(path) {
        // Windows canonicalisation yields a `\\?\` extended-length prefix that
        // most tools choke on; stripping it keeps the result usable.
        Ok(resolved) => Output::ok(format!("{}\n", strip_extended_prefix(&resolved))),
        Err(error) => Output::fail(format!("realpath: {}: {error}", path.display()), 1),
    }
}

pub fn strip_extended_prefix(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

/// Normalises a path lexically: no filesystem access, so it works for paths
/// that do not exist yet.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                // `..` past the root stays at the root rather than escaping it.
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A unique temporary path. The name carries the time and a counter, so two
/// calls in the same millisecond still differ.
pub fn mktemp(prefix: &str, directory: bool) -> Output {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("{prefix}{nanos:x}{count:x}"));

    let created = if directory { fs::create_dir_all(&path) } else { fs::write(&path, "") };
    match created {
        Ok(()) => Output::ok(format!("{}\n", path.display())),
        Err(error) => Output::fail(format!("mktemp: {error}"), 1),
    }
}

// ---- tee ------------------------------------------------------------------

pub fn tee(text: &str, paths: &[PathBuf], append: bool) -> Output {
    let mut errors = String::new();
    let mut code = 0;

    for path in paths {
        let result = if append {
            use std::io::Write;
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .and_then(|mut file| file.write_all(text.as_bytes()))
        } else {
            fs::write(path, text)
        };
        if let Err(error) = result {
            errors.push_str(&format!("tee: {}: {error}\n", path.display()));
            code = 1;
        }
    }

    // `tee` passes its input through regardless of write failures, so a
    // pipeline downstream still sees the data.
    Output { stdout: text.to_string(), stderr: errors, code }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pi-files-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn basename_and_dirname_handle_both_separators() {
        assert_eq!(basename("/a/b/c.txt", None), "c.txt");
        assert_eq!(basename(r"C:\a\b\c.txt", None), "c.txt");
        assert_eq!(basename("/a/b/c.txt", Some(".txt")), "c");
        assert_eq!(basename("/a/b/", None), "b");
        assert_eq!(dirname("/a/b/c.txt"), "/a/b");
        assert_eq!(dirname("c.txt"), ".");
    }

    #[test]
    fn basename_does_not_strip_a_name_to_nothing() {
        // `basename .txt .txt` must print `.txt`, not an empty string.
        assert_eq!(basename(".txt", Some(".txt")), ".txt");
    }

    #[test]
    fn human_size_is_exact_below_a_kilobyte() {
        assert_eq!(human_size(0), "0B");
        assert_eq!(human_size(512), "512B");
        assert_eq!(human_size(1024), "1.0K");
        assert_eq!(human_size(1024 * 1024 * 5), "5.0M");
    }

    #[test]
    fn civil_dates_match_known_instants() {
        assert_eq!(civil_from_epoch(0), (1970, 1, 1, 0, 0, 0));
        // 2000-03-01: the leap-year century rule, which naive maths gets wrong.
        assert_eq!(civil_from_epoch(951_868_800), (2000, 3, 1, 0, 0, 0));
        assert_eq!(civil_from_epoch(1_700_000_000), (2023, 11, 14, 22, 13, 20));
    }

    #[test]
    fn magic_bytes_beat_extensions() {
        assert_eq!(describe_bytes(b"\x89PNG\r\n\x1a\n\x00\x00"), "PNG image");
        assert_eq!(describe_bytes(b"%PDF-1.7"), "PDF document");
        assert!(describe_bytes(b"#!/bin/sh\necho hi").starts_with("script"));
        assert_eq!(describe_bytes(b""), "empty");
    }

    #[test]
    fn rm_refuses_a_root() {
        assert!(is_root(Path::new("/")));
        assert!(is_root(Path::new(r"C:\")));
        assert!(!is_root(Path::new("/home/user")));

        let output = rm(&[PathBuf::from("/")], &RemoveOptions { recursive: true, ..Default::default() });
        assert_eq!(output.code, 1);
        assert!(output.stderr.contains("refusing"));
    }

    #[test]
    fn normalize_does_not_escape_above_the_root() {
        assert_eq!(normalize(Path::new("a/b/../c")), PathBuf::from("a/c"));
        assert_eq!(normalize(Path::new("./a/./b")), PathBuf::from("a/b"));
    }

    #[test]
    fn copy_refuses_to_recurse_into_itself() {
        let root = temp();
        let source = root.join("src");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("a.txt"), "hello").unwrap();

        let output = cp(
            &source,
            &source.join("nested"),
            &CopyOptions { recursive: true, ..Default::default() },
        );
        assert_eq!(output.code, 1);
        assert!(output.stderr.contains("forever"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cat_reports_a_binary_rather_than_pasting_it() {
        let root = temp();
        let path = root.join("blob.bin");
        fs::write(&path, [0x00, 0x01, 0x02, 0x00]).unwrap();

        let output = cat(&[path], &CatOptions::default());
        assert_eq!(output.code, 1);
        assert!(output.stderr.contains("binary"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ls_says_how_many_entries_it_hid() {
        let root = temp();
        for index in 0..10 {
            fs::write(root.join(format!("file{index}.txt")), "").unwrap();
        }

        let output = ls(&root, &LsOptions { limit: Some(3), ..Default::default() });
        assert!(output.stdout.contains("7 more entries"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mkdir_p_is_idempotent() {
        let root = temp();
        let nested = root.join("a/b/c");
        assert_eq!(mkdir(&[nested.clone()], true).code, 0);
        assert_eq!(mkdir(&[nested], true).code, 0);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn tee_passes_input_through_even_when_a_write_fails() {
        let output = tee("payload", &[PathBuf::from("/nonexistent-dir/x/y.txt")], false);
        assert_eq!(output.stdout, "payload");
        assert_eq!(output.code, 1);
    }
}
