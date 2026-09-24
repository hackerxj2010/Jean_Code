//! Glob and gitignore pattern matching.
//!
//! Supports the subset of the gitignore spec that actually shows up in real
//! repositories: `*`, `?`, `**`, character classes, leading `/` for anchoring,
//! trailing `/` for directory-only, and `!` for negation.

/// A single compiled pattern.
#[derive(Debug, Clone)]
pub struct Pattern {
    /// The pattern with `!`, anchoring `/`, and trailing `/` stripped.
    body: String,
    /// `!foo` — a match un-ignores the path.
    pub negated: bool,
    /// `foo/` — matches directories only.
    pub dir_only: bool,
    /// Contains a `/` other than a trailing one, so it matches against the full
    /// relative path rather than just the basename.
    anchored: bool,
}

impl Pattern {
    /// Compiles one gitignore-style line. Returns `None` for blanks and comments.
    pub fn parse(line: &str) -> Option<Self> {
        let line = line.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            return None;
        }

        let mut body = line;
        let mut negated = false;
        if let Some(rest) = body.strip_prefix('!') {
            negated = true;
            body = rest;
        }

        let mut dir_only = false;
        if let Some(rest) = body.strip_suffix('/') {
            dir_only = true;
            body = rest;
        }

        let anchored = body.contains('/');
        let body = body.strip_prefix('/').unwrap_or(body);

        if body.is_empty() {
            return None;
        }

        Some(Self {
            body: body.to_string(),
            negated,
            dir_only,
            anchored,
        })
    }

    /// Builds a plain (non-gitignore) glob for matching relative paths.
    pub fn glob(pattern: &str) -> Self {
        Self {
            body: pattern.trim_start_matches("./").to_string(),
            negated: false,
            dir_only: false,
            anchored: true,
        }
    }

    /// Tests `rel_path` (forward-slash separated, relative to the ignore file's
    /// directory). `is_dir` gates `dir_only` patterns.
    pub fn matches(&self, rel_path: &str, is_dir: bool) -> bool {
        if self.dir_only && !is_dir {
            return false;
        }
        if self.anchored {
            if glob_match(&self.body, rel_path) {
                return true;
            }
            // An anchored pattern also covers everything beneath a matched dir.
            return prefix_dir_match(&self.body, rel_path);
        }
        // Unanchored: match any path component tail, so `node_modules` catches
        // `a/b/node_modules` as gitignore requires.
        rel_path
            .split('/')
            .any(|seg| glob_match(&self.body, seg))
            || glob_match(&self.body, rel_path)
    }
}

/// True when `path` sits underneath a directory matched by `pattern`.
fn prefix_dir_match(pattern: &str, path: &str) -> bool {
    let mut acc = String::new();
    for seg in path.split('/') {
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(seg);
        if glob_match(pattern, &acc) {
            return true;
        }
    }
    false
}

/// Glob matcher supporting `*` (no `/`), `**` (any, including `/`), `?`, and
/// `[...]` classes. Iterative backtracking; no regex, no allocation.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    match_from(&p, 0, &t, 0)
}

fn match_from(p: &[char], mut pi: usize, t: &[char], mut ti: usize) -> bool {
    // Backtrack state for the most recent single `*`.
    let mut star: Option<(usize, usize)> = None;

    while ti < t.len() {
        if pi < p.len() {
            match p[pi] {
                '*' => {
                    // `**` crosses `/`; a lone `*` does not.
                    let double = p.get(pi + 1) == Some(&'*');
                    if double {
                        let mut next = pi + 2;
                        // `**/` may also match zero directories.
                        if p.get(next) == Some(&'/') {
                            if match_from(p, next + 1, t, ti) {
                                return true;
                            }
                            next += 1;
                        }
                        if next >= p.len() {
                            return true;
                        }
                        for skip in ti..=t.len() {
                            if match_from(p, next, t, skip) {
                                return true;
                            }
                        }
                        return false;
                    }
                    star = Some((pi, ti));
                    pi += 1;
                    continue;
                }
                '?' => {
                    if t[ti] != '/' {
                        pi += 1;
                        ti += 1;
                        continue;
                    }
                }
                '[' => {
                    if let Some((matched, next_pi)) = match_class(p, pi, t[ti]) {
                        if matched {
                            pi = next_pi;
                            ti += 1;
                            continue;
                        }
                    }
                }
                c => {
                    if c == t[ti] {
                        pi += 1;
                        ti += 1;
                        continue;
                    }
                }
            }
        }

        // Mismatch: retry the last `*`, consuming one more char (but never `/`).
        match star {
            Some((sp, st)) if t[st] != '/' => {
                pi = sp + 1;
                ti = st + 1;
                star = Some((sp, st + 1));
            }
            _ => return false,
        }
    }

    // Text exhausted; any remaining pattern must be all-`*`.
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Parses a `[abc]` / `[!a-z]` class at `pi`. Returns (matched, index after `]`).
fn match_class(p: &[char], pi: usize, c: char) -> Option<(bool, usize)> {
    let mut i = pi + 1;
    let negate = matches!(p.get(i), Some('!') | Some('^'));
    if negate {
        i += 1;
    }
    let mut matched = false;
    let mut first = true;
    while i < p.len() {
        if p[i] == ']' && !first {
            return Some((matched != negate, i + 1));
        }
        first = false;
        if p.get(i + 1) == Some(&'-') && p.get(i + 2).is_some_and(|&e| e != ']') {
            let (lo, hi) = (p[i], p[i + 2]);
            if c >= lo && c <= hi {
                matched = true;
            }
            i += 3;
        } else {
            if p[i] == c {
                matched = true;
            }
            i += 1;
        }
    }
    None // unterminated class
}

/// An ordered stack of ignore patterns; later patterns win, as in gitignore.
#[derive(Debug, Clone, Default)]
pub struct IgnoreSet {
    patterns: Vec<Pattern>,
}

impl IgnoreSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parses the contents of a `.gitignore` / `.ignore` file.
    pub fn add_file(&mut self, contents: &str) {
        for line in contents.lines() {
            if let Some(p) = Pattern::parse(line) {
                self.patterns.push(p);
            }
        }
    }

    pub fn add(&mut self, pattern: &str) {
        if let Some(p) = Pattern::parse(pattern) {
            self.patterns.push(p);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// True when `rel_path` should be skipped. The last matching pattern wins,
    /// so a later `!keep.me` re-includes a path an earlier rule excluded.
    pub fn is_ignored(&self, rel_path: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for p in &self.patterns {
            if p.matches(rel_path, is_dir) {
                ignored = !p.negated;
            }
        }
        ignored
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn star_does_not_cross_slash() {
        assert!(glob_match("*.ts", "index.ts"));
        assert!(!glob_match("*.ts", "src/index.ts"));
        assert!(glob_match("src/*.ts", "src/index.ts"));
    }

    #[test]
    fn double_star_crosses_slash() {
        assert!(glob_match("**/*.ts", "a/b/c.ts"));
        assert!(glob_match("src/**/*.ts", "src/a/b/c.ts"));
        // `**/` matches zero directories too.
        assert!(glob_match("**/*.ts", "c.ts"));
        assert!(glob_match("src/**", "src/a/b"));
    }

    #[test]
    fn question_and_classes() {
        assert!(glob_match("?.ts", "a.ts"));
        assert!(!glob_match("?.ts", "ab.ts"));
        assert!(glob_match("[abc].ts", "b.ts"));
        assert!(!glob_match("[abc].ts", "d.ts"));
        assert!(glob_match("[a-z].ts", "q.ts"));
        assert!(glob_match("[!a-z].ts", "Q.ts"));
    }

    #[test]
    fn gitignore_unanchored_matches_any_depth() {
        let mut set = IgnoreSet::new();
        set.add_file("node_modules\n*.log\n");
        assert!(set.is_ignored("node_modules", true));
        assert!(set.is_ignored("packages/cli/node_modules", true));
        assert!(set.is_ignored("packages/cli/node_modules/foo/index.js", false));
        assert!(set.is_ignored("debug.log", false));
        assert!(!set.is_ignored("src/index.ts", false));
    }

    #[test]
    fn gitignore_anchoring_and_dir_only() {
        let mut set = IgnoreSet::new();
        set.add_file("/dist\nbuild/\n");
        assert!(set.is_ignored("dist", true));
        assert!(set.is_ignored("dist/app.js", false));
        assert!(!set.is_ignored("packages/dist", true));
        assert!(set.is_ignored("build", true));
        assert!(!set.is_ignored("build", false));
    }

    #[test]
    fn negation_reincludes() {
        let mut set = IgnoreSet::new();
        set.add_file("*.log\n!keep.log\n");
        assert!(set.is_ignored("debug.log", false));
        assert!(!set.is_ignored("keep.log", false));
    }

    #[test]
    fn comments_and_blanks_are_skipped() {
        let mut set = IgnoreSet::new();
        set.add_file("# a comment\n\n  \ntarget\n");
        assert!(set.is_ignored("target", true));
        assert!(!set.is_ignored("# a comment", false));
    }
}
