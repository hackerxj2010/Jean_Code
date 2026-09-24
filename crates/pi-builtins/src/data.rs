//! `find`, `xargs`, `bc`, `diff`, `patch`, `date`, `env` (architecture §8.2).

use crate::files::{civil_from_epoch, is_binary};
use crate::regex::Regex;
use crate::text::{from_lines, to_lines, Output};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// ---- find -----------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct FindOptions {
    /// Glob against the entry's base name.
    pub name: Option<String>,
    /// Glob against the path relative to the root, so `src/**/*.ts` works.
    pub path: Option<String>,
    pub kind: Option<EntryKind>,
    pub max_depth: Option<usize>,
    pub min_depth: usize,
    /// Bytes; entries smaller than this are skipped.
    pub larger_than: Option<u64>,
    /// Modified within this many seconds of now.
    pub newer_than_seconds: Option<u64>,
    /// Directory names never descended into.
    pub prune: Vec<String>,
    pub limit: Option<usize>,
    pub include_hidden: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
}

/// Directories that are never worth walking unless asked for by name.
///
/// Without this, one `find .` in a JS project walks a hundred thousand files
/// and returns nothing the agent wanted.
pub const DEFAULT_PRUNE: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".turbo", "vendor", "__pycache__",
    ".venv", "venv", ".mypy_cache", ".pytest_cache", ".gradle", "Pods", ".cargo", ".svelte-kit",
];

pub fn find(root: &Path, options: &FindOptions) -> Output {
    let mut results: Vec<String> = Vec::new();
    let mut truncated = false;

    let prune: Vec<&str> = if options.prune.is_empty() {
        DEFAULT_PRUNE.to_vec()
    } else {
        options.prune.iter().map(String::as_str).collect()
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    walk(root, root, options, &prune, 0, now, &mut results, &mut truncated);
    results.sort();

    let mut out = from_lines(&results);
    if truncated {
        out.push_str(&format!(
            "... stopped at {} results; narrow the pattern for the rest\n",
            results.len()
        ));
    }
    Output::ok(out)
}

#[allow(clippy::too_many_arguments)]
fn walk(
    root: &Path,
    current: &Path,
    options: &FindOptions,
    prune: &[&str],
    depth: usize,
    now: u64,
    results: &mut Vec<String>,
    truncated: &mut bool,
) {
    if *truncated {
        return;
    }
    if let Some(max) = options.max_depth {
        if depth > max {
            return;
        }
    }

    let Ok(entries) = fs::read_dir(current) else { return };

    for entry in entries.flatten() {
        if let Some(limit) = options.limit {
            if results.len() >= limit {
                *truncated = true;
                return;
            }
        }

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        if !options.include_hidden && name.starts_with('.') && options.name.as_deref() != Some(&name)
        {
            continue;
        }

        let Ok(metadata) = fs::symlink_metadata(&path) else { continue };
        let is_dir = metadata.is_dir();
        let is_symlink = metadata.file_type().is_symlink();

        if is_dir && prune.contains(&name.as_str()) {
            continue;
        }

        let relative = path.strip_prefix(root).unwrap_or(&path);
        // Forward slashes in output regardless of platform: the agent's globs,
        // its .gitignore, and its diffs all speak POSIX separators.
        let display = relative.to_string_lossy().replace('\\', "/");

        if depth + 1 >= options.min_depth && matches(&name, &display, &metadata, options, now, is_dir, is_symlink) {
            results.push(display.clone());
        }

        // Symlinked directories are not followed: a link back up the tree makes
        // the walk infinite.
        if is_dir && !is_symlink {
            walk(root, &path, options, prune, depth + 1, now, results, truncated);
        }
    }
}

fn matches(
    name: &str,
    relative: &str,
    metadata: &fs::Metadata,
    options: &FindOptions,
    now: u64,
    is_dir: bool,
    is_symlink: bool,
) -> bool {
    if let Some(kind) = options.kind {
        let actual = if is_symlink {
            EntryKind::Symlink
        } else if is_dir {
            EntryKind::Directory
        } else {
            EntryKind::File
        };
        if actual != kind {
            return false;
        }
    }

    if let Some(pattern) = &options.name {
        if !glob_match(pattern, name) {
            return false;
        }
    }

    if let Some(pattern) = &options.path {
        if !glob_match(pattern, relative) {
            return false;
        }
    }

    if let Some(minimum) = options.larger_than {
        if metadata.len() < minimum {
            return false;
        }
    }

    if let Some(window) = options.newer_than_seconds {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if now.saturating_sub(modified) > window {
            return false;
        }
    }

    true
}

/// Glob matching with `*`, `?`, `[...]`, and `**`.
///
/// `*` stops at a separator and `**` crosses them, which is the distinction
/// every .gitignore and tsconfig depends on.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    glob_from(&pattern, 0, &text, 0)
}

fn glob_from(pattern: &[char], p: usize, text: &[char], t: usize) -> bool {
    if p >= pattern.len() {
        return t >= text.len();
    }

    match pattern[p] {
        '*' => {
            // `**` matches across separators; a single `*` does not.
            let crosses = pattern.get(p + 1) == Some(&'*');
            let next = if crosses {
                // Skip the second star and any separator glued to it, so
                // `src/**/x` also matches `src/x`.
                let mut skip = p + 2;
                if pattern.get(skip) == Some(&'/') {
                    skip += 1;
                }
                skip
            } else {
                p + 1
            };

            if crosses && glob_from(pattern, next, text, t) {
                return true;
            }

            for end in t..=text.len() {
                if !crosses && text[t..end].contains(&'/') {
                    break;
                }
                if glob_from(pattern, next, text, end) {
                    return true;
                }
            }
            false
        }

        '?' => t < text.len() && text[t] != '/' && glob_from(pattern, p + 1, text, t + 1),

        '[' => {
            if t >= text.len() {
                return false;
            }
            let mut index = p + 1;
            let negated = pattern.get(index) == Some(&'!') || pattern.get(index) == Some(&'^');
            if negated {
                index += 1;
            }

            let mut hit = false;
            let mut first = true;
            while index < pattern.len() && (pattern[index] != ']' || first) {
                first = false;
                if pattern.get(index + 1) == Some(&'-')
                    && pattern.get(index + 2).is_some_and(|c| *c != ']')
                {
                    let low = pattern[index];
                    let high = pattern[index + 2];
                    if text[t] >= low && text[t] <= high {
                        hit = true;
                    }
                    index += 3;
                } else {
                    if pattern[index] == text[t] {
                        hit = true;
                    }
                    index += 1;
                }
            }

            if index >= pattern.len() {
                return false; // unclosed `[`
            }
            hit != negated && glob_from(pattern, index + 1, text, t + 1)
        }

        '\\' if p + 1 < pattern.len() => {
            t < text.len() && text[t] == pattern[p + 1] && glob_from(pattern, p + 2, text, t + 1)
        }

        literal => t < text.len() && text[t] == literal && glob_from(pattern, p + 1, text, t + 1),
    }
}

// ---- xargs ----------------------------------------------------------------

/// Splits input into argument batches the way `xargs` does.
///
/// Returns the batches rather than running them: execution belongs to the
/// shell, and keeping this pure makes the batching testable.
pub fn xargs_batches(input: &str, max_args: usize, null_separated: bool) -> Vec<Vec<String>> {
    let items: Vec<String> = if null_separated {
        input.split('\0').filter(|s| !s.is_empty()).map(String::from).collect()
    } else {
        // Whitespace-separated, but quotes group — `xargs` honours them, and a
        // path with a space is otherwise torn in half.
        split_respecting_quotes(input)
    };

    if items.is_empty() {
        return Vec::new();
    }
    let size = max_args.max(1);
    items.chunks(size).map(<[String]>::to_vec).collect()
}

fn split_respecting_quotes(input: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for c in input.chars() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }
        match c {
            '\\' if quote != Some('\'') => escaped = true,
            '\'' | '"' if quote.is_none() => quote = Some(c),
            c if Some(c) == quote => quote = None,
            c if c.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    items.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        items.push(current);
    }
    items
}

// ---- bc -------------------------------------------------------------------

/// An arithmetic expression evaluator.
///
/// Shell arithmetic is where an agent silently gets a wrong answer: `$((...))`
/// is integer-only and truncates, and `expr` has its own quirks. This is plain
/// f64 with the usual precedence, and it says when it cannot parse.
pub fn bc(expression: &str) -> Output {
    let mut evaluator = Arithmetic { chars: expression.chars().collect(), position: 0 };
    match evaluator.expression() {
        Ok(value) => {
            evaluator.skip_whitespace();
            if evaluator.position < evaluator.chars.len() {
                return Output::fail(
                    format!(
                        "bc: unexpected `{}` at position {}",
                        evaluator.chars[evaluator.position], evaluator.position
                    ),
                    1,
                );
            }
            Output::ok(format!("{}\n", crate::json::format_number(value)))
        }
        Err(message) => Output::fail(format!("bc: {message}"), 1),
    }
}

struct Arithmetic {
    chars: Vec<char>,
    position: usize,
}

impl Arithmetic {
    fn skip_whitespace(&mut self) {
        while matches!(self.chars.get(self.position), Some(c) if c.is_whitespace()) {
            self.position += 1;
        }
    }

    fn peek(&mut self) -> Option<char> {
        self.skip_whitespace();
        self.chars.get(self.position).copied()
    }

    fn expression(&mut self) -> Result<f64, String> {
        let mut left = self.term()?;
        loop {
            match self.peek() {
                Some('+') => {
                    self.position += 1;
                    left += self.term()?;
                }
                Some('-') => {
                    self.position += 1;
                    left -= self.term()?;
                }
                _ => return Ok(left),
            }
        }
    }

    fn term(&mut self) -> Result<f64, String> {
        let mut left = self.power()?;
        loop {
            match self.peek() {
                Some('*') => {
                    self.position += 1;
                    left *= self.power()?;
                }
                Some('/') => {
                    self.position += 1;
                    let divisor = self.power()?;
                    if divisor == 0.0 {
                        return Err("division by zero".to_string());
                    }
                    left /= divisor;
                }
                Some('%') => {
                    self.position += 1;
                    let divisor = self.power()?;
                    if divisor == 0.0 {
                        return Err("modulo by zero".to_string());
                    }
                    left %= divisor;
                }
                _ => return Ok(left),
            }
        }
    }

    fn power(&mut self) -> Result<f64, String> {
        let base = self.unary()?;
        if self.peek() == Some('^') {
            self.position += 1;
            // Right-associative: 2^3^2 is 2^9, not 8^2.
            let exponent = self.power()?;
            return Ok(base.powf(exponent));
        }
        Ok(base)
    }

    fn unary(&mut self) -> Result<f64, String> {
        match self.peek() {
            Some('-') => {
                self.position += 1;
                Ok(-self.unary()?)
            }
            Some('+') => {
                self.position += 1;
                self.unary()
            }
            _ => self.primary(),
        }
    }

    fn primary(&mut self) -> Result<f64, String> {
        match self.peek() {
            Some('(') => {
                self.position += 1;
                let value = self.expression()?;
                if self.peek() != Some(')') {
                    return Err("unclosed `(`".to_string());
                }
                self.position += 1;
                Ok(value)
            }

            Some(c) if c.is_ascii_digit() || c == '.' => {
                let start = self.position;
                while matches!(self.chars.get(self.position), Some(c) if c.is_ascii_digit() || *c == '.')
                {
                    self.position += 1;
                }
                let text: String = self.chars[start..self.position].iter().collect();
                text.parse::<f64>().map_err(|_| format!("bad number: {text}"))
            }

            Some(c) if c.is_alphabetic() => {
                let start = self.position;
                while matches!(self.chars.get(self.position), Some(c) if c.is_alphanumeric()) {
                    self.position += 1;
                }
                let name: String = self.chars[start..self.position].iter().collect();

                if self.peek() == Some('(') {
                    self.position += 1;
                    let argument = self.expression()?;
                    if self.peek() != Some(')') {
                        return Err(format!("unclosed `(` in {name}(...)"));
                    }
                    self.position += 1;
                    return apply(&name, argument);
                }

                match name.as_str() {
                    "pi" => Ok(std::f64::consts::PI),
                    "e" => Ok(std::f64::consts::E),
                    other => Err(format!("unknown name: {other}")),
                }
            }

            Some(c) => Err(format!("unexpected `{c}`")),
            None => Err("unexpected end of expression".to_string()),
        }
    }
}

fn apply(name: &str, argument: f64) -> Result<f64, String> {
    match name {
        "sqrt" if argument < 0.0 => Err("sqrt of a negative number".to_string()),
        "sqrt" => Ok(argument.sqrt()),
        "abs" => Ok(argument.abs()),
        "floor" => Ok(argument.floor()),
        "ceil" => Ok(argument.ceil()),
        "round" => Ok(argument.round()),
        "ln" if argument <= 0.0 => Err("ln of a non-positive number".to_string()),
        "ln" => Ok(argument.ln()),
        "log" if argument <= 0.0 => Err("log of a non-positive number".to_string()),
        "log" => Ok(argument.log10()),
        "exp" => Ok(argument.exp()),
        "sin" => Ok(argument.sin()),
        "cos" => Ok(argument.cos()),
        "tan" => Ok(argument.tan()),
        other => Err(format!("unknown function: {other}")),
    }
}

// ---- diff -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Same(String),
    Added(String),
    Removed(String),
}

/// A line diff via the longest common subsequence.
///
/// O(n*m) in memory, which is fine for source files and wrong for a 500 MB log.
/// The caller is expected to have refused that file already.
pub fn diff_lines(before: &str, after: &str) -> Vec<Change> {
    let a = to_lines(before);
    let b = to_lines(after);

    // The LCS table: lengths[i][j] is the LCS of a[i..] and b[j..].
    let mut lengths = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lengths[i][j] = if a[i] == b[j] {
                lengths[i + 1][j + 1] + 1
            } else {
                lengths[i + 1][j].max(lengths[i][j + 1])
            };
        }
    }

    let mut changes = Vec::new();
    let (mut i, mut j) = (0, 0);

    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            changes.push(Change::Same(a[i].to_string()));
            i += 1;
            j += 1;
        } else if lengths[i + 1][j] >= lengths[i][j + 1] {
            changes.push(Change::Removed(a[i].to_string()));
            i += 1;
        } else {
            changes.push(Change::Added(b[j].to_string()));
            j += 1;
        }
    }
    while i < a.len() {
        changes.push(Change::Removed(a[i].to_string()));
        i += 1;
    }
    while j < b.len() {
        changes.push(Change::Added(b[j].to_string()));
        j += 1;
    }

    changes
}

/// A unified diff, the format `git apply` and every review tool reads.
pub fn unified_diff(before: &str, after: &str, from: &str, to: &str, context: usize) -> String {
    let changes = diff_lines(before, after);
    if changes.iter().all(|change| matches!(change, Change::Same(_))) {
        return String::new();
    }

    // Group changes into hunks, keeping `context` unchanged lines around each.
    let interesting: Vec<usize> = changes
        .iter()
        .enumerate()
        .filter(|(_, change)| !matches!(change, Change::Same(_)))
        .map(|(index, _)| index)
        .collect();

    let mut hunks: Vec<(usize, usize)> = Vec::new();
    for index in interesting {
        let start = index.saturating_sub(context);
        let end = (index + context + 1).min(changes.len());
        match hunks.last_mut() {
            // Overlapping windows merge, or the diff shows the same lines twice.
            Some(last) if start <= last.1 => last.1 = end,
            _ => hunks.push((start, end)),
        }
    }

    let mut out = format!("--- {from}\n+++ {to}\n");
    let mut before_line = 1usize;
    let mut after_line = 1usize;
    let mut consumed = 0usize;

    for (start, end) in hunks {
        // Advance the line counters over everything skipped since the last hunk.
        for change in &changes[consumed..start] {
            match change {
                Change::Same(_) => {
                    before_line += 1;
                    after_line += 1;
                }
                Change::Removed(_) => before_line += 1,
                Change::Added(_) => after_line += 1,
            }
        }
        consumed = end;

        let slice = &changes[start..end];
        let before_count = slice
            .iter()
            .filter(|c| matches!(c, Change::Same(_) | Change::Removed(_)))
            .count();
        let after_count = slice
            .iter()
            .filter(|c| matches!(c, Change::Same(_) | Change::Added(_)))
            .count();

        out.push_str(&format!(
            "@@ -{before_line},{before_count} +{after_line},{after_count} @@\n"
        ));

        for change in slice {
            match change {
                Change::Same(line) => {
                    out.push_str(&format!(" {line}\n"));
                    before_line += 1;
                    after_line += 1;
                }
                Change::Removed(line) => {
                    out.push_str(&format!("-{line}\n"));
                    before_line += 1;
                }
                Change::Added(line) => {
                    out.push_str(&format!("+{line}\n"));
                    after_line += 1;
                }
            }
        }
    }

    out
}

/// Applies a unified diff.
///
/// Hunks are located by their context rather than trusting the line numbers in
/// the header: a patch generated against a slightly older file still applies,
/// and one that cannot be located fails loudly instead of corrupting the file.
pub fn apply_patch(original: &str, patch: &str) -> Result<String, String> {
    let mut lines: Vec<String> = to_lines(original).into_iter().map(String::from).collect();
    let patch_lines = to_lines(patch);
    let mut index = 0;
    let mut applied = 0;

    while index < patch_lines.len() {
        let line = patch_lines[index];

        if !line.starts_with("@@") {
            index += 1;
            continue;
        }
        index += 1;

        let mut removals: Vec<String> = Vec::new();
        let mut replacement: Vec<String> = Vec::new();

        while index < patch_lines.len() && !patch_lines[index].starts_with("@@") {
            let hunk_line = patch_lines[index];
            match hunk_line.chars().next() {
                Some(' ') => {
                    removals.push(hunk_line[1..].to_string());
                    replacement.push(hunk_line[1..].to_string());
                }
                Some('-') => removals.push(hunk_line[1..].to_string()),
                Some('+') => replacement.push(hunk_line[1..].to_string()),
                // A bare empty line in a patch means an unchanged empty line.
                None => {
                    removals.push(String::new());
                    replacement.push(String::new());
                }
                // `---`/`+++` headers and `\ No newline` markers.
                _ => {}
            }
            index += 1;
        }

        if removals.is_empty() {
            // Pure insertion with no anchor: append.
            lines.extend(replacement);
            applied += 1;
            continue;
        }

        let position = find_slice(&lines, &removals).ok_or_else(|| {
            format!(
                "hunk {} does not match the file; its first line is {:?}",
                applied + 1,
                removals.first().map(String::as_str).unwrap_or("")
            )
        })?;

        lines.splice(position..position + removals.len(), replacement);
        applied += 1;
    }

    if applied == 0 {
        return Err("the patch contains no hunks".to_string());
    }
    Ok(from_lines(&lines))
}

fn find_slice(haystack: &[String], needle: &[String]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|start| &haystack[*start..start + needle.len()] == needle)
}

// ---- date, env ------------------------------------------------------------

/// `date` with strftime-style formatting, in UTC.
pub fn date(format: &str, epoch_seconds: Option<u64>) -> Output {
    let seconds = epoch_seconds.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    });
    let (year, month, day, hour, minute, second) = civil_from_epoch(seconds);

    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];

    let mut out = String::new();
    let mut chars = format.chars().peekable();

    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('Y') => out.push_str(&format!("{year:04}")),
            Some('m') => out.push_str(&format!("{month:02}")),
            Some('d') => out.push_str(&format!("{day:02}")),
            Some('H') => out.push_str(&format!("{hour:02}")),
            Some('M') => out.push_str(&format!("{minute:02}")),
            Some('S') => out.push_str(&format!("{second:02}")),
            Some('b') => out.push_str(MONTHS[(month as usize - 1).min(11)]),
            // 1970-01-01 was a Thursday, which is why the table starts there.
            Some('a') => out.push_str(DAYS[((seconds / 86_400) % 7) as usize]),
            Some('s') => out.push_str(&seconds.to_string()),
            Some('F') => out.push_str(&format!("{year:04}-{month:02}-{day:02}")),
            Some('T') => out.push_str(&format!("{hour:02}:{minute:02}:{second:02}")),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }

    out.push('\n');
    Output::ok(out)
}

/// An ISO-8601 timestamp in UTC.
pub fn iso8601(epoch_seconds: u64) -> String {
    let (year, month, day, hour, minute, second) = civil_from_epoch(epoch_seconds);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// `env` / `printenv`, with secret values masked.
///
/// Printing the environment is how an API key ends up in a transcript that gets
/// pasted into an issue. Masking by default costs nothing.
pub fn env(filter: Option<&str>, reveal: bool) -> Output {
    let mut lines: Vec<String> = std::env::vars()
        .filter(|(name, _)| filter.is_none_or(|needle| name.contains(needle)))
        .map(|(name, value)| {
            let shown = if reveal || !looks_secret(&name) { value } else { mask(&value) };
            format!("{name}={shown}")
        })
        .collect();
    lines.sort();
    Output::ok(from_lines(&lines))
}

/// Whether a variable name suggests it holds a credential.
pub fn looks_secret(name: &str) -> bool {
    const MARKERS: [&str; 9] =
        ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "AUTH", "PRIVATE", "SESSION"];
    let upper = name.to_uppercase();
    MARKERS.iter().any(|marker| upper.contains(marker))
}

/// Masks a value, keeping enough to recognise which one it is.
pub fn mask(value: &str) -> String {
    let count = value.chars().count();
    if count <= 8 {
        return "*".repeat(count.max(1));
    }
    let head: String = value.chars().take(4).collect();
    let tail: String = value.chars().skip(count - 4).collect();
    format!("{head}...{tail} ({count} chars)")
}

// ---- ripgrep-style recursive search ---------------------------------------

#[derive(Debug, Clone)]
pub struct Hit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

/// Recursive content search: `grep -r` without the fork.
pub fn search(
    root: &Path,
    pattern: &str,
    glob: Option<&str>,
    ignore_case: bool,
    limit: usize,
) -> Result<Vec<Hit>, String> {
    let regex = Regex::new(pattern, ignore_case)?;
    let mut hits = Vec::new();

    let files = find(
        root,
        &FindOptions { kind: Some(EntryKind::File), path: glob.map(String::from), ..Default::default() },
    );

    for relative in to_lines(&files.stdout) {
        if hits.len() >= limit {
            break;
        }
        if relative.starts_with("...") {
            continue;
        }

        let path = root.join(relative);
        let Ok(bytes) = fs::read(&path) else { continue };
        // Skipping binaries is not an optimisation: a match inside a compiled
        // object is noise, and printing the line around it is garbage.
        if is_binary(&bytes) {
            continue;
        }

        let content = String::from_utf8_lossy(&bytes);
        for (index, line) in content.lines().enumerate() {
            if regex.is_match(line) {
                hits.push(Hit {
                    path: relative.to_string(),
                    line: index + 1,
                    // Long minified lines would flood the output.
                    text: truncate(line, 400),
                });
                if hits.len() >= limit {
                    break;
                }
            }
        }
    }

    Ok(hits)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}... [{} chars truncated]", text.chars().count() - limit)
}

/// Renders hits as `path:line:text`, the format every editor can jump from.
pub fn render_hits(hits: &[Hit]) -> String {
    let lines: Vec<String> =
        hits.iter().map(|hit| format!("{}:{}:{}", hit.path, hit.line, hit.text)).collect();
    from_lines(&lines)
}

/// Every path under a root, respecting the default prune list.
pub fn list_files(root: &Path, limit: Option<usize>) -> Vec<PathBuf> {
    let output = find(
        root,
        &FindOptions { kind: Some(EntryKind::File), limit, ..Default::default() },
    );
    to_lines(&output.stdout)
        .into_iter()
        .filter(|line| !line.starts_with("..."))
        .map(|line| root.join(line))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs_distinguish_one_star_from_two() {
        assert!(glob_match("*.ts", "index.ts"));
        assert!(!glob_match("*.ts", "src/index.ts"));
        assert!(glob_match("**/*.ts", "src/deep/index.ts"));
        assert!(glob_match("src/**/*.ts", "src/a/b/c.ts"));
        // `src/**/x` must also match `src/x` — the case a naive `**` misses.
        assert!(glob_match("src/**/x.ts", "src/x.ts"));
    }

    #[test]
    fn globs_handle_classes_and_escapes() {
        assert!(glob_match("file[0-9].txt", "file3.txt"));
        assert!(!glob_match("file[0-9].txt", "filex.txt"));
        assert!(glob_match("file[!0-9].txt", "filex.txt"));
        assert!(glob_match(r"a\*b", "a*b"));
        assert!(!glob_match(r"a\*b", "axxb"));
    }

    #[test]
    fn xargs_keeps_quoted_paths_together() {
        let batches = xargs_batches("a.txt 'b c.txt' d.txt", 10, false);
        assert_eq!(batches[0], vec!["a.txt", "b c.txt", "d.txt"]);
    }

    #[test]
    fn xargs_batches_by_size() {
        let batches = xargs_batches("1 2 3 4 5", 2, false);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[2], vec!["5"]);
    }

    #[test]
    fn arithmetic_respects_precedence() {
        assert_eq!(bc("2 + 3 * 4").stdout.trim(), "14");
        assert_eq!(bc("(2 + 3) * 4").stdout.trim(), "20");
        assert_eq!(bc("-3 + 1").stdout.trim(), "-2");
        assert_eq!(bc("10 / 4").stdout.trim(), "2.5");
    }

    #[test]
    fn exponentiation_is_right_associative() {
        // 2^(3^2) = 512, not (2^3)^2 = 64.
        assert_eq!(bc("2^3^2").stdout.trim(), "512");
    }

    #[test]
    fn arithmetic_reports_division_by_zero() {
        let output = bc("1 / 0");
        assert_eq!(output.code, 1);
        assert!(output.stderr.contains("zero"));
    }

    #[test]
    fn arithmetic_functions() {
        assert_eq!(bc("sqrt(16)").stdout.trim(), "4");
        assert_eq!(bc("floor(3.7)").stdout.trim(), "3");
        assert!(bc("sqrt(-1)").code != 0);
    }

    #[test]
    fn diff_finds_the_minimal_change() {
        let changes = diff_lines("a\nb\nc\n", "a\nx\nc\n");
        assert_eq!(changes.len(), 4);
        assert!(changes.contains(&Change::Removed("b".into())));
        assert!(changes.contains(&Change::Added("x".into())));
    }

    #[test]
    fn identical_files_produce_no_diff() {
        assert_eq!(unified_diff("a\nb\n", "a\nb\n", "x", "y", 3), "");
    }

    #[test]
    fn unified_diff_round_trips_through_apply() {
        let before = "one\ntwo\nthree\nfour\nfive\n";
        let after = "one\nTWO\nthree\nfour\nFIVE\n";
        let patch = unified_diff(before, after, "a", "b", 2);
        assert_eq!(apply_patch(before, &patch).unwrap(), after);
    }

    #[test]
    fn a_patch_that_does_not_match_fails_loudly() {
        let patch = unified_diff("a\nb\n", "a\nc\n", "x", "y", 1);
        let error = apply_patch("completely\ndifferent\n", &patch).unwrap_err();
        assert!(error.contains("does not match"), "{error}");
    }

    #[test]
    fn date_formats() {
        assert_eq!(date("%Y-%m-%d", Some(0)).stdout.trim(), "1970-01-01");
        assert_eq!(date("%F %T", Some(1_700_000_000)).stdout.trim(), "2023-11-14 22:13:20");
        assert_eq!(date("%a", Some(0)).stdout.trim(), "Thu");
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn secret_variables_are_masked_by_default() {
        assert!(looks_secret("OPENROUTER_API_KEY"));
        assert!(looks_secret("github_token"));
        assert!(!looks_secret("PATH"));

        let masked = mask("sk-or-v1-abcdefghijklmnop");
        assert!(!masked.contains("abcdefghij"));
        assert!(masked.starts_with("sk-o"));
    }
}
