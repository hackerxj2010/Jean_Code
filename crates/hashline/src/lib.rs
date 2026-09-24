//! # hashline
//!
//! Content-hash anchored patch language and applier.
//!
//! A hashline patch never refers to a line number. Every hunk is anchored to a
//! short hash of the *normalized content* of one line. That buys three things
//! the architecture calls for:
//!
//! * **Fewer output tokens.** The model emits an 8-hex anchor plus the changed
//!   lines, not a line-numbered context window around them.
//! * **No whitespace battles.** Anchors are computed over whitespace-normalized
//!   text, so re-indentation upstream of an edit does not invalidate it. The
//!   applier re-indents inserted lines to match what is actually in the file.
//! * **Stale-anchor recovery.** If the file moved on since the model read it,
//!   the applier falls back through anchor text, then hunk context, instead of
//!   failing with a "string not found" loop.
//!
//! ## Wire format
//!
//! ```text
//! anchor: h:3f8a2b1c -> "export class RateLimiter {"
//! patch: |-|
//!   - private counter = 0;
//!   + private counter = new Map<string, number>();
//!     constructor() {}
//! ```
//!
//! Leading `-` deletes, `+` inserts, anything else is context that must match.

pub mod sha256;

use std::collections::HashMap;
use std::fmt;

/// Number of hex digits kept from the SHA-256 digest of a normalized line.
pub const ANCHOR_LEN: usize = 8;

/// A single line operation inside a hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    /// Line must be present and is left alone.
    Keep(String),
    /// Line must be present and is removed.
    Del(String),
    /// Line is inserted at this position.
    Add(String),
}

/// One anchored hunk: where to land, and what to do once landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// Short content hash of the anchor line, without the `h:` prefix.
    pub anchor: String,
    /// The anchor line's text as the model last saw it. Used for recovery and
    /// for disambiguating an anchor that matches more than one line.
    pub anchor_text: Option<String>,
    /// Operations applied from the anchor line onward.
    pub ops: Vec<Op>,
}

/// How the applier located the anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// Exactly one line carried the anchor hash.
    Exact,
    /// Several lines carried it; context or anchor text picked the winner.
    Disambiguated,
    /// No line carried it; the anchor text matched after normalization.
    RecoveredByText,
    /// No line carried it; the hunk's own context lines located the site.
    RecoveredByContext,
}

impl fmt::Display for Resolution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Resolution::Exact => "exact",
            Resolution::Disambiguated => "disambiguated",
            Resolution::RecoveredByText => "recovered-by-text",
            Resolution::RecoveredByContext => "recovered-by-context",
        };
        f.write_str(s)
    }
}

/// Why a hunk could not be applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyError {
    /// The anchor was not found and no recovery strategy located the site.
    AnchorNotFound {
        anchor: String,
        anchor_text: Option<String>,
    },
    /// The anchor landed, but the hunk's context/deletions did not match the
    /// file there. `expected` is the first line the hunk demanded.
    ContextMismatch {
        anchor: String,
        line: usize,
        expected: String,
        found: Option<String>,
    },
    /// The anchor matched several lines and nothing distinguished them.
    AmbiguousAnchor { anchor: String, matches: Vec<usize> },
    /// The patch text could not be parsed.
    Parse(String),
}

impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApplyError::AnchorNotFound {
                anchor,
                anchor_text,
            } => match anchor_text {
                Some(t) => write!(f, "anchor h:{anchor} not found (last seen as {t:?})"),
                None => write!(f, "anchor h:{anchor} not found"),
            },
            ApplyError::ContextMismatch {
                anchor,
                line,
                expected,
                found,
            } => write!(
                f,
                "hunk h:{anchor} landed at line {} but expected {expected:?}, found {:?}",
                line + 1,
                found.as_deref().unwrap_or("<end of file>")
            ),
            ApplyError::AmbiguousAnchor { anchor, matches } => write!(
                f,
                "anchor h:{anchor} matches {} lines ({:?}); add anchor text or context to disambiguate",
                matches.len(),
                matches.iter().map(|i| i + 1).collect::<Vec<_>>()
            ),
            ApplyError::Parse(msg) => write!(f, "malformed hashline patch: {msg}"),
        }
    }
}

impl std::error::Error for ApplyError {}

/// The result of applying one or more hunks.
#[derive(Debug, Clone)]
pub struct Applied {
    /// The rewritten file content.
    pub content: String,
    /// How each hunk was resolved, in the order the hunks were supplied.
    pub resolutions: Vec<Resolution>,
    /// Net line count delta.
    pub delta: isize,
}

/// Normalizes a line for hashing: strips leading/trailing whitespace and
/// collapses internal whitespace runs to a single space.
///
/// This is what makes anchors survive re-indentation and tab/space churn.
pub fn normalize(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut pending_space = false;
    for ch in line.trim_matches(is_space).chars() {
        if is_space(ch) {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(ch);
    }
    out
}

/// Whitespace exactly as JavaScript's `\s` and `String.prototype.trim` see it.
///
/// The TypeScript port hashes with those, and an anchor must be the same on
/// both sides. Rust's `char::is_whitespace` differs on two code points: it
/// counts U+0085 (NEL), which JavaScript does not, and misses U+FEFF (the byte
/// order mark), which JavaScript counts — so the first line of a file saved
/// with a BOM would otherwise get a different anchor depending on who read it.
fn is_space(ch: char) -> bool {
    ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}')
}

/// Computes the anchor for a line: first [`ANCHOR_LEN`] hex digits of the
/// SHA-256 of its normalized form.
pub fn anchor_of(line: &str) -> String {
    let normalized = normalize(line);
    let digest = sha256::digest(normalized.as_bytes());
    sha256::hex(&digest)[..ANCHOR_LEN].to_string()
}

/// An anchor -> line-index map over a file, built once and reused across hunks.
#[derive(Debug, Clone)]
pub struct Index {
    lines: Vec<String>,
    by_anchor: HashMap<String, Vec<usize>>,
    /// Trailing newline in the source, preserved on render.
    trailing_newline: bool,
}

impl Index {
    /// Builds an index over file content.
    pub fn new(content: &str) -> Self {
        let trailing_newline = content.ends_with('\n');
        let body = if trailing_newline {
            &content[..content.len() - 1]
        } else {
            content
        };
        let lines: Vec<String> = if body.is_empty() && trailing_newline {
            vec![String::new()]
        } else if body.is_empty() {
            Vec::new()
        } else {
            body.split('\n')
                .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
                .collect()
        };

        let mut by_anchor: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, line) in lines.iter().enumerate() {
            by_anchor.entry(anchor_of(line)).or_default().push(i);
        }

        Self {
            lines,
            by_anchor,
            trailing_newline,
        }
    }

    /// The file's lines, without terminators.
    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    /// Every line index carrying `anchor`.
    pub fn matches(&self, anchor: &str) -> &[usize] {
        self.by_anchor.get(anchor).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Renders the file with an anchor gutter, which is the form the agent
    /// reads so it can cite anchors back in a patch.
    ///
    /// ```text
    /// h:3f8a2b1c │ export class RateLimiter {
    /// h:9c1de470 │   private counter = 0;
    /// ```
    pub fn annotate(&self) -> String {
        let mut out = String::new();
        for line in &self.lines {
            out.push_str("h:");
            out.push_str(&anchor_of(line));
            out.push_str(" \u{2502} ");
            out.push_str(line);
            out.push('\n');
        }
        out
    }

    fn render(&self, lines: &[String]) -> String {
        let mut out = lines.join("\n");
        if self.trailing_newline && !out.is_empty() {
            out.push('\n');
        } else if self.trailing_newline && out.is_empty() {
            out.push('\n');
        }
        out
    }
}

/// Applies `hunks` to `content`, left to right.
///
/// Hunks are resolved against the *original* index but applied cumulatively, so
/// a later hunk anchored below an earlier insertion still lands correctly.
pub fn apply(content: &str, hunks: &[Hunk]) -> Result<Applied, ApplyError> {
    let index = Index::new(content);
    let mut lines = index.lines.clone();
    let mut resolutions = Vec::with_capacity(hunks.len());
    // Running offset from earlier hunks that changed the line count above us.
    let mut offset: isize = 0;

    for hunk in hunks {
        let (start, resolution) = locate(&index, &lines, hunk, offset)?;
        let before = lines.len() as isize;
        splice(&mut lines, start, hunk)?;
        offset += lines.len() as isize - before;
        resolutions.push(resolution);
    }

    let delta = lines.len() as isize - index.lines.len() as isize;
    Ok(Applied {
        content: index.render(&lines),
        resolutions,
        delta,
    })
}

/// Finds the line index in the *current* buffer where `hunk` should land.
fn locate(
    index: &Index,
    current: &[String],
    hunk: &Hunk,
    offset: isize,
) -> Result<(usize, Resolution), ApplyError> {
    let candidates = index.matches(&hunk.anchor);

    // Fast path: the anchor is unique in the file as read.
    if candidates.len() == 1 {
        let shifted = shift(candidates[0], offset, current.len());
        if verify(current, shifted, hunk) {
            return Ok((shifted, Resolution::Exact));
        }
        // The offset guess was wrong (a hunk above resized things unevenly).
        // Re-find the anchor in the live buffer before giving up.
        if let Some(live) = find_by_anchor(current, &hunk.anchor, hunk) {
            return Ok((live, Resolution::Exact));
        }
    }

    // Several lines share the anchor: let anchor text and hunk context decide.
    if candidates.len() > 1 {
        let mut viable: Vec<usize> = Vec::new();
        for &c in candidates {
            let shifted = shift(c, offset, current.len());
            if verify(current, shifted, hunk) {
                viable.push(shifted);
            }
        }
        match viable.len() {
            1 => return Ok((viable[0], Resolution::Disambiguated)),
            0 => {}
            _ => {
                return Err(ApplyError::AmbiguousAnchor {
                    anchor: hunk.anchor.clone(),
                    matches: viable,
                })
            }
        }
    }

    // Stale anchor. Recovery 1: the anchor line's text, normalized.
    if let Some(text) = &hunk.anchor_text {
        let target = normalize(text);
        let hits: Vec<usize> = current
            .iter()
            .enumerate()
            .filter(|(_, l)| normalize(l) == target)
            .map(|(i, _)| i)
            .collect();
        if hits.len() == 1 && verify(current, hits[0], hunk) {
            return Ok((hits[0], Resolution::RecoveredByText));
        }
        for &h in &hits {
            if verify(current, h, hunk) {
                return Ok((h, Resolution::RecoveredByText));
            }
        }
    }

    // Recovery 2: the hunk's own body. Slide the required lines (context +
    // deletions) over the file and take the single position that matches.
    let required: Vec<String> = hunk
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Keep(l) | Op::Del(l) => Some(normalize(l)),
            Op::Add(_) => None,
        })
        .collect();

    if !required.is_empty() {
        let mut hits = Vec::new();
        for start in 0..=current.len().saturating_sub(required.len()) {
            let matched = required
                .iter()
                .enumerate()
                .all(|(k, want)| current.get(start + k).map(|l| normalize(l)).as_ref() == Some(want));
            if matched {
                hits.push(start);
            }
        }
        if hits.len() == 1 {
            return Ok((hits[0], Resolution::RecoveredByContext));
        }
    }

    Err(ApplyError::AnchorNotFound {
        anchor: hunk.anchor.clone(),
        anchor_text: hunk.anchor_text.clone(),
    })
}

fn find_by_anchor(current: &[String], anchor: &str, hunk: &Hunk) -> Option<usize> {
    let hits: Vec<usize> = current
        .iter()
        .enumerate()
        .filter(|(_, l)| anchor_of(l) == anchor)
        .map(|(i, _)| i)
        .collect();
    hits.into_iter().find(|&h| verify(current, h, hunk))
}

fn shift(idx: usize, offset: isize, len: usize) -> usize {
    let shifted = idx as isize + offset;
    shifted.clamp(0, len as isize) as usize
}

/// True if the hunk's context and deletions match the buffer starting at `start`.
fn verify(current: &[String], start: usize, hunk: &Hunk) -> bool {
    let mut cursor = start;
    for op in &hunk.ops {
        match op {
            Op::Add(_) => {}
            Op::Keep(want) | Op::Del(want) => {
                match current.get(cursor) {
                    Some(have) if normalize(have) == normalize(want) => cursor += 1,
                    _ => return false,
                };
            }
        }
    }
    true
}

/// Rewrites `lines` in place, applying `hunk` from `start`.
///
/// Inserted lines inherit the indentation actually present in the file at the
/// landing site, offset by the indentation the patch itself expressed. That is
/// what lets a patch written against 2-space source land in 4-space source.
fn splice(lines: &mut Vec<String>, start: usize, hunk: &Hunk) -> Result<(), ApplyError> {
    let reindent = indent_delta(lines, start, hunk);

    let mut out: Vec<String> = Vec::with_capacity(hunk.ops.len());
    let mut cursor = start;

    for op in &hunk.ops {
        match op {
            Op::Keep(want) => {
                let have = lines.get(cursor).cloned();
                match &have {
                    Some(h) if normalize(h) == normalize(want) => {
                        out.push(h.clone());
                        cursor += 1;
                    }
                    _ => {
                        return Err(ApplyError::ContextMismatch {
                            anchor: hunk.anchor.clone(),
                            line: cursor,
                            expected: want.clone(),
                            found: have,
                        })
                    }
                }
            }
            Op::Del(want) => {
                let have = lines.get(cursor).cloned();
                match &have {
                    Some(h) if normalize(h) == normalize(want) => {
                        cursor += 1;
                    }
                    _ => {
                        return Err(ApplyError::ContextMismatch {
                            anchor: hunk.anchor.clone(),
                            line: cursor,
                            expected: want.clone(),
                            found: have,
                        })
                    }
                }
            }
            Op::Add(text) => out.push(apply_indent(text, &reindent)),
        }
    }

    lines.splice(start..cursor, out);
    Ok(())
}

/// Computes the whitespace prefix to prepend (or strip) from inserted lines.
fn indent_delta(lines: &[String], start: usize, hunk: &Hunk) -> Reindent {
    // Compare the indentation of the first anchored line as the patch wrote it
    // with the indentation of the line actually sitting at the landing site.
    let patch_indent = hunk
        .ops
        .iter()
        .find_map(|op| match op {
            Op::Keep(l) | Op::Del(l) => Some(leading_ws(l).to_string()),
            Op::Add(_) => None,
        })
        .unwrap_or_default();
    let file_indent = lines
        .get(start)
        .map(|l| leading_ws(l).to_string())
        .unwrap_or_default();

    if patch_indent == file_indent {
        Reindent::None
    } else if file_indent.starts_with(&patch_indent) {
        Reindent::Prefix(file_indent[patch_indent.len()..].to_string())
    } else if patch_indent.starts_with(&file_indent) {
        Reindent::Strip(patch_indent.len() - file_indent.len())
    } else {
        Reindent::None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Reindent {
    None,
    /// Prepend this string to every inserted line.
    Prefix(String),
    /// Remove up to this many leading whitespace characters.
    Strip(usize),
}

fn apply_indent(text: &str, reindent: &Reindent) -> String {
    if text.trim().is_empty() {
        return text.to_string();
    }
    match reindent {
        Reindent::None => text.to_string(),
        Reindent::Prefix(p) => format!("{p}{text}"),
        Reindent::Strip(n) => {
            let ws = leading_ws(text);
            let cut = ws.len().min(*n);
            text[cut..].to_string()
        }
    }
}

fn leading_ws(line: &str) -> &str {
    let end = line
        .find(|c: char| !c.is_whitespace())
        .unwrap_or(line.len());
    &line[..end]
}

/// Parses the textual hashline patch format into hunks.
///
/// Accepts one or more blocks of:
///
/// ```text
/// anchor: h:3f8a2b1c -> "export class RateLimiter {"
/// patch: |-|
///   - old line
///   + new line
///     untouched context
/// ```
///
/// The `-> "text"` part is optional (`→` is also accepted). Body indentation is
/// stripped uniformly, so the marker column is the first non-blank character.
pub fn parse(input: &str) -> Result<Vec<Hunk>, ApplyError> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut current: Option<Hunk> = None;
    let mut in_body = false;
    let mut body_indent: Option<usize> = None;

    for raw in input.lines() {
        let trimmed = raw.trim_start();

        if let Some(rest) = trimmed.strip_prefix("anchor:") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            let (anchor, anchor_text) = parse_anchor(rest)?;
            current = Some(Hunk {
                anchor,
                anchor_text,
                ops: Vec::new(),
            });
            in_body = false;
            body_indent = None;
            continue;
        }

        if trimmed.starts_with("patch:") {
            if current.is_none() {
                return Err(ApplyError::Parse("`patch:` before any `anchor:`".into()));
            }
            in_body = true;
            body_indent = None;
            continue;
        }

        if !in_body {
            continue;
        }

        let hunk = current
            .as_mut()
            .ok_or_else(|| ApplyError::Parse("patch body outside a hunk".into()))?;

        if raw.trim().is_empty() && hunk.ops.is_empty() {
            continue;
        }

        // The body's own indentation is whatever the first body line used; every
        // later line is measured against it so nested code keeps its shape.
        let indent = *body_indent.get_or_insert_with(|| raw.len() - raw.trim_start().len());
        let stripped = if raw.len() >= indent && raw[..indent].trim().is_empty() {
            &raw[indent..]
        } else {
            raw.trim_start()
        };

        let op = match stripped.as_bytes().first() {
            Some(b'-') => Op::Del(strip_marker(stripped)),
            Some(b'+') => Op::Add(strip_marker(stripped)),
            _ => Op::Keep(strip_marker(stripped)),
        };
        hunk.ops.push(op);
    }

    if let Some(h) = current.take() {
        hunks.push(h);
    }
    if hunks.is_empty() {
        return Err(ApplyError::Parse("no `anchor:` block found".into()));
    }
    for h in &hunks {
        if h.ops.is_empty() {
            return Err(ApplyError::Parse(format!(
                "hunk h:{} has an empty patch body",
                h.anchor
            )));
        }
    }
    Ok(hunks)
}

/// Removes the `-`/`+` marker and the single space that conventionally follows.
fn strip_marker(line: &str) -> String {
    let rest = match line.as_bytes().first() {
        Some(b'-') | Some(b'+') => &line[1..],
        _ => line,
    };
    rest.strip_prefix(' ').unwrap_or(rest).to_string()
}

fn parse_anchor(rest: &str) -> Result<(String, Option<String>), ApplyError> {
    let rest = rest.trim();
    let (anchor_part, text_part) = match rest.split_once("->") {
        Some((a, t)) => (a, Some(t)),
        None => match rest.split_once('\u{2192}') {
            Some((a, t)) => (a, Some(t)),
            None => (rest, None),
        },
    };

    let anchor = anchor_part
        .trim()
        .trim_start_matches("h:")
        .trim()
        .to_lowercase();
    if anchor.is_empty() || !anchor.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApplyError::Parse(format!(
            "anchor {anchor_part:?} is not a hex hash"
        )));
    }

    let text = text_part.and_then(|t| {
        let t = t.trim();
        let t = t.strip_prefix('"').unwrap_or(t);
        let t = t.strip_suffix('"').unwrap_or(t);
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });

    Ok((anchor, text))
}

/// Convenience: parse a patch and apply it in one call.
pub fn patch(content: &str, patch_text: &str) -> Result<Applied, ApplyError> {
    let hunks = parse(patch_text)?;
    apply(content, &hunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "export class RateLimiter {\n  private counter = 0;\n\n  hit() {\n    this.counter += 1;\n  }\n}\n";

    fn anchor_for(src: &str, needle: &str) -> String {
        let idx = Index::new(src);
        idx.lines()
            .iter()
            .find(|l| l.contains(needle))
            .map(|l| anchor_of(l))
            .expect("line present")
    }

    #[test]
    fn whitespace_is_what_javascript_calls_whitespace() {
        // A byte order mark is trimmed, as `String.prototype.trim` trims it.
        assert_eq!(normalize("\u{feff}const a = 1;"), "const a = 1;");
        // NEL is not whitespace to JavaScript, so it survives here too.
        assert_eq!(normalize("a\u{85}b"), "a\u{85}b");
    }

    #[test]
    fn normalize_is_whitespace_insensitive() {
        assert_eq!(normalize("  let  x =  1  "), "let x = 1");
        assert_eq!(normalize("\tlet x = 1"), "let x = 1");
        assert_eq!(normalize("let x = 1"), normalize("    let    x = 1"));
    }

    #[test]
    fn anchors_are_stable_across_reindentation() {
        assert_eq!(anchor_of("  private counter = 0;"), anchor_of("\t\tprivate counter = 0;"));
    }

    #[test]
    fn applies_a_simple_replacement() {
        let a = anchor_for(SRC, "private counter");
        let hunk = Hunk {
            anchor: a,
            anchor_text: Some("private counter = 0;".into()),
            ops: vec![
                Op::Del("  private counter = 0;".into()),
                Op::Add("  private counter = new Map<string, number>();".into()),
            ],
        };
        let out = apply(SRC, &[hunk]).expect("applies");
        assert!(out.content.contains("new Map<string, number>()"));
        assert!(!out.content.contains("private counter = 0;"));
        assert_eq!(out.resolutions[0], Resolution::Exact);
        assert_eq!(out.delta, 0);
    }

    #[test]
    fn parses_and_applies_the_wire_format() {
        let a = anchor_for(SRC, "hit()");
        let text = format!(
            "anchor: h:{a} -> \"hit() {{\"\npatch: |-|\n    hit() {{\n  -   this.counter += 1;\n  +   this.counter = (this.counter ?? 0) + 1;\n  +   this.lastHit = Date.now();\n"
        );
        let out = patch(SRC, &text).expect("applies");
        assert!(out.content.contains("this.lastHit = Date.now();"));
        assert!(!out.content.contains("this.counter += 1;"));
        assert_eq!(out.delta, 1);
    }

    #[test]
    fn recovers_from_a_stale_anchor_via_anchor_text() {
        // The model read `private counter = 0;` but the file has since gained a
        // type annotation, so the hash no longer matches anything.
        let moved = SRC.replace("private counter = 0;", "private counter = 0;");
        let stale = Hunk {
            anchor: "deadbeef".into(),
            anchor_text: Some("private counter = 0;".into()),
            ops: vec![
                Op::Del("  private counter = 0;".into()),
                Op::Add("  private counter = 1;".into()),
            ],
        };
        let out = apply(&moved, &[stale]).expect("recovers");
        assert_eq!(out.resolutions[0], Resolution::RecoveredByText);
        assert!(out.content.contains("private counter = 1;"));
    }

    #[test]
    fn recovers_from_a_stale_anchor_via_context() {
        let stale = Hunk {
            anchor: "deadbeef".into(),
            anchor_text: None,
            ops: vec![
                Op::Keep("  hit() {".into()),
                Op::Del("    this.counter += 1;".into()),
                Op::Add("    this.counter += 2;".into()),
            ],
        };
        let out = apply(SRC, &[stale]).expect("recovers");
        assert_eq!(out.resolutions[0], Resolution::RecoveredByContext);
        assert!(out.content.contains("this.counter += 2;"));
    }

    #[test]
    fn reindents_inserted_lines_to_match_the_file() {
        // Patch written against 2-space source, file actually uses 4 spaces.
        let file = "class A {\n    hit() {\n        go();\n    }\n}\n";
        let a = anchor_for(file, "go();");
        let hunk = Hunk {
            anchor: a,
            anchor_text: Some("go();".into()),
            ops: vec![
                Op::Keep("    go();".into()),
                Op::Add("    log();".into()),
            ],
        };
        let out = apply(file, &[hunk]).expect("applies");
        assert!(
            out.content.contains("\n        log();\n"),
            "inserted line should inherit 8-space indent, got:\n{}",
            out.content
        );
    }

    #[test]
    fn ambiguous_anchors_are_disambiguated_by_context() {
        let dup = "fn a() {\n  ok();\n}\nfn b() {\n  ok();\n}\n";
        let a = anchor_of("  ok();");
        assert_eq!(Index::new(dup).matches(&a).len(), 2);
        let hunk = Hunk {
            anchor: a,
            anchor_text: Some("ok();".into()),
            ops: vec![
                Op::Del("  ok();".into()),
                Op::Add("  ok2();".into()),
                Op::Keep("}".into()),
                Op::Keep("fn b() {".into()),
            ],
        };
        let out = apply(dup, &[hunk]).expect("applies");
        assert!(out.content.starts_with("fn a() {\n  ok2();\n}"));
        assert_eq!(out.resolutions[0], Resolution::Disambiguated);
    }

    #[test]
    fn multiple_hunks_track_line_drift() {
        let a1 = anchor_for(SRC, "private counter");
        let a2 = anchor_for(SRC, "this.counter += 1;");
        let hunks = vec![
            Hunk {
                anchor: a1,
                anchor_text: None,
                ops: vec![
                    Op::Keep("  private counter = 0;".into()),
                    Op::Add("  private lastHit = 0;".into()),
                    Op::Add("  private window = 60_000;".into()),
                ],
            },
            Hunk {
                anchor: a2,
                anchor_text: None,
                ops: vec![
                    Op::Del("    this.counter += 1;".into()),
                    Op::Add("    this.counter += 1; this.lastHit = Date.now();".into()),
                ],
            },
        ];
        let out = apply(SRC, &hunks).expect("applies");
        assert!(out.content.contains("private window = 60_000;"));
        assert!(out.content.contains("this.lastHit = Date.now();"));
        assert_eq!(out.delta, 2);
    }

    #[test]
    fn reports_context_mismatch_rather_than_corrupting() {
        let a = anchor_for(SRC, "private counter");
        let hunk = Hunk {
            anchor: a,
            anchor_text: None,
            ops: vec![
                Op::Keep("  private counter = 0;".into()),
                Op::Del("  something that is not there;".into()),
            ],
        };
        let err = apply(SRC, &[hunk]).unwrap_err();
        assert!(matches!(err, ApplyError::AnchorNotFound { .. }));
    }

    #[test]
    fn annotate_emits_a_readable_gutter() {
        let idx = Index::new("a\nb\n");
        let rendered = idx.annotate();
        assert!(rendered.starts_with("h:"));
        assert!(rendered.contains("\u{2502} a"));
        assert_eq!(rendered.lines().count(), 2);
    }

    #[test]
    fn round_trips_files_without_a_trailing_newline() {
        let src = "one\ntwo";
        let a = anchor_of("two");
        let hunk = Hunk {
            anchor: a,
            anchor_text: None,
            ops: vec![Op::Del("two".into()), Op::Add("three".into())],
        };
        let out = apply(src, &[hunk]).expect("applies");
        assert_eq!(out.content, "one\nthree");
    }

    #[test]
    fn rejects_malformed_patches() {
        assert!(parse("nothing here").is_err());
        assert!(parse("anchor: h:zzzz\npatch: |-|\n  - x").is_err());
    }
}
