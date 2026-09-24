//! In-process content search over a walk.
//!
//! Deliberately not a full regex engine — that is what the `regex` crate is
//! for, and it lands here when the workspace takes external dependencies. What
//! this provides is the matcher the agent actually reaches for most: literal
//! and glob-ish patterns, case folding, word boundaries, and binary-file
//! detection, all sharing one traversal with the walker.

use crate::{walk, Entry, Pattern, WalkOptions};
use std::fs;
use std::path::Path;
use std::sync::Mutex;

/// How a pattern is interpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Matcher {
    /// Plain substring.
    Literal,
    /// `*`/`?`/`[..]` glob over the whole line.
    Glob,
}

/// Search knobs.
#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub matcher: Matcher,
    pub case_sensitive: bool,
    /// Require the match to sit on word boundaries.
    pub whole_word: bool,
    /// Only search files whose relative path matches this glob.
    pub include: Option<String>,
    /// Cap on total matches returned.
    pub max_matches: usize,
    /// Files larger than this are skipped (bytes).
    pub max_file_size: u64,
    pub walk: WalkOptions,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            matcher: Matcher::Literal,
            case_sensitive: false,
            whole_word: false,
            include: None,
            max_matches: 1000,
            max_file_size: 4 * 1024 * 1024,
            walk: WalkOptions::default(),
        }
    }
}

/// One matching line.
#[derive(Debug, Clone)]
pub struct Match {
    pub path: String,
    /// 1-based.
    pub line: usize,
    pub text: String,
    pub column: usize,
}

/// Searches `root` for `pattern`, returning matches sorted by path then line.
pub fn search(root: &Path, pattern: &str, opts: &SearchOptions) -> std::io::Result<Vec<Match>> {
    let include = opts.include.as_deref().map(Pattern::glob);
    let needle = if opts.case_sensitive {
        pattern.to_string()
    } else {
        pattern.to_lowercase()
    };
    let hits = Mutex::new(Vec::new());

    walk(root, &opts.walk, |entry: Entry| {
        if entry.is_dir || entry.size > opts.max_file_size {
            return;
        }
        if let Some(inc) = &include {
            if !inc.matches(&entry.rel_path, false) {
                return;
            }
        }
        {
            // Cheap early exit once we already have enough.
            if hits.lock().unwrap().len() >= opts.max_matches {
                return;
            }
        }

        let bytes = match fs::read(&entry.abs_path) {
            Ok(b) => b,
            Err(_) => return,
        };
        if is_binary(&bytes) {
            return;
        }
        let text = match String::from_utf8(bytes) {
            Ok(t) => t,
            Err(_) => return,
        };

        let mut local = Vec::new();
        for (i, line) in text.lines().enumerate() {
            let haystack = if opts.case_sensitive {
                line.to_string()
            } else {
                line.to_lowercase()
            };
            if let Some(col) = find_match(&haystack, &needle, opts) {
                local.push(Match {
                    path: entry.rel_path.clone(),
                    line: i + 1,
                    text: line.to_string(),
                    column: col + 1,
                });
            }
        }
        if !local.is_empty() {
            hits.lock().unwrap().extend(local);
        }
    })?;

    let mut out = hits.into_inner().unwrap();
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    out.truncate(opts.max_matches);
    Ok(out)
}

fn find_match(haystack: &str, needle: &str, opts: &SearchOptions) -> Option<usize> {
    match opts.matcher {
        Matcher::Glob => {
            if crate::glob_match(needle, haystack) {
                Some(0)
            } else {
                None
            }
        }
        Matcher::Literal => {
            let mut from = 0;
            while let Some(rel) = haystack[from..].find(needle) {
                let at = from + rel;
                if !opts.whole_word || is_word_bounded(haystack, at, needle.len()) {
                    return Some(at);
                }
                from = at + 1;
                if from >= haystack.len() {
                    break;
                }
            }
            None
        }
    }
}

fn is_word_bounded(haystack: &str, at: usize, len: usize) -> bool {
    let before = haystack[..at].chars().next_back();
    let after = haystack[at + len..].chars().next();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    !before.is_some_and(word) && !after.is_some_and(word)
}

/// Heuristic used by every serious grep: a NUL byte in the first 8 KiB means
/// binary. Cheap, and wrong about roughly nothing in practice.
pub fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Each test gets its own directory: the test binary runs them in parallel
    /// and a shared fixture path would have them deleting each other's files.
    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pi-search-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(
            dir.join("src/a.ts"),
            "export const rateLimiter = 1;\nconst other = 2;\n",
        )
        .unwrap();
        fs::write(dir.join("src/b.md"), "RateLimiter docs\nunrelated\n").unwrap();
        fs::write(dir.join("src/bin.dat"), [0u8, 1, 2, 3]).unwrap();
        dir
    }

    #[test]
    fn finds_literal_matches_case_insensitively() {
        let dir = fixture("literal");
        let hits = search(&dir, "ratelimiter", &SearchOptions::default()).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "src/a.ts");
        assert_eq!(hits[0].line, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn filters_by_include_glob() {
        let dir = fixture("include");
        let hits = search(
            &dir,
            "ratelimiter",
            &SearchOptions {
                include: Some("**/*.ts".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "src/a.ts");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_binary_files() {
        assert!(is_binary(&[b'a', 0, b'b']));
        assert!(!is_binary(b"plain text"));
    }

    #[test]
    fn whole_word_rejects_substrings() {
        let opts = SearchOptions {
            whole_word: true,
            ..Default::default()
        };
        assert!(find_match("const other = 2;", "other", &opts).is_some());
        assert!(find_match("const others = 2;", "other", &opts).is_none());
    }
}
