//! Extracting the things a turn referred to.
//!
//! These are what an agent looks up later — "which file was that", "what was
//! the error code", "did I already run that command". They are short, so
//! keeping them in full costs almost nothing, and losing them is what makes a
//! summarized context useless.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum EntityKind {
    /// Ordered by how useful each is to recover, because the list is truncated.
    Error,
    File,
    Command,
    Symbol,
    Url,
    Identifier,
}

impl EntityKind {
    pub fn label(&self) -> &'static str {
        match self {
            EntityKind::Error => "error",
            EntityKind::File => "file",
            EntityKind::Command => "cmd",
            EntityKind::Symbol => "sym",
            EntityKind::Url => "url",
            EntityKind::Identifier => "id",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entity {
    pub kind: EntityKind,
    pub text: String,
    /// How many times it appeared, so the frequently-referenced survive
    /// truncation.
    pub count: usize,
}

/// Extracts entities from text, most important first.
pub fn extract(text: &str) -> Vec<Entity> {
    let mut found: Vec<Entity> = Vec::new();

    for candidate in file_paths(text) {
        add(&mut found, EntityKind::File, candidate);
    }
    for candidate in errors(text) {
        add(&mut found, EntityKind::Error, candidate);
    }
    for candidate in commands(text) {
        add(&mut found, EntityKind::Command, candidate);
    }
    for candidate in urls(text) {
        add(&mut found, EntityKind::Url, candidate);
    }

    // Sort by kind, then by how often it appeared: a file mentioned nine times
    // is the one the turn was about.
    found.sort_by(|a, b| a.kind.cmp(&b.kind).then(b.count.cmp(&a.count)).then(a.text.cmp(&b.text)));
    found
}

fn add(found: &mut Vec<Entity>, kind: EntityKind, text: String) {
    if text.is_empty() {
        return;
    }
    if let Some(existing) = found.iter_mut().find(|e| e.kind == kind && e.text == text) {
        existing.count += 1;
        return;
    }
    found.push(Entity { kind, text, count: 1 });
}

/// Words that look like file paths.
fn file_paths(text: &str) -> Vec<String> {
    const EXTENSIONS: &[&str] = &[
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".c", ".h", ".cpp", ".rb",
        ".php", ".swift", ".kt", ".sh", ".json", ".toml", ".yaml", ".yml", ".md", ".txt", ".html",
        ".css", ".sql", ".lock", ".cfg", ".ini", ".xml", ".vue", ".svelte",
    ];

    let mut paths = Vec::new();

    for raw in text.split(|c: char| c.is_whitespace()) {
        // Strip the punctuation a path picks up from prose: quotes, a trailing
        // comma, the parentheses around an aside.
        let word = raw.trim_matches(|c: char| {
            matches!(c, '"' | '\'' | '`' | '(' | ')' | '[' | ']' | ',' | ';' | ':' | '.' | '*')
                || c == '\u{2018}'
                || c == '\u{2019}'
        });

        if word.is_empty() || word.len() > 200 {
            continue;
        }

        // A path either has a known extension or contains a separator with a
        // plausible shape. Requiring one of the two keeps ordinary prose out.
        let has_extension = EXTENSIONS.iter().any(|extension| {
            word.to_lowercase().ends_with(extension)
                // `file.ts:42` from a compiler message is still a path.
                || word.to_lowercase().contains(&format!("{extension}:"))
        });

        if !has_extension {
            continue;
        }

        // Drop a `:line:column` suffix: the path is the entity, and three
        // mentions of the same file at different lines are one file.
        let cleaned = strip_position(word);
        if cleaned.chars().any(|c| c.is_alphanumeric()) {
            paths.push(cleaned);
        }
    }

    paths
}

fn strip_position(word: &str) -> String {
    let parts: Vec<&str> = word.split(':').collect();
    // A Windows path starts with a drive letter, so the first colon is not a
    // position marker: `C:\src\main.rs:42` must keep the drive.
    let start = if parts.len() > 1 && parts[0].len() == 1 { 2 } else { 1 };

    let mut kept: Vec<&str> = parts[..start.min(parts.len())].to_vec();
    for part in parts.iter().skip(start) {
        if part.parse::<usize>().is_ok() {
            break;
        }
        kept.push(part);
    }
    kept.join(":")
}

/// Error codes and messages worth keeping verbatim.
fn errors(text: &str) -> Vec<String> {
    let mut found = Vec::new();

    for line in text.lines() {
        let lower = line.to_lowercase();

        // Rust and TypeScript error codes: `E0308`, `TS2345`.
        for word in line.split(|c: char| !c.is_alphanumeric()) {
            let looks_like_code = (word.starts_with('E') || word.starts_with("TS"))
                && word.len() >= 4
                && word.len() <= 8
                && word.chars().skip(if word.starts_with("TS") { 2 } else { 1 }).all(|c| c.is_ascii_digit());
            if looks_like_code {
                found.push(word.to_string());
            }
        }

        // A line that announces a failure, kept whole and trimmed.
        if lower.starts_with("error")
            || lower.starts_with("failed")
            || lower.contains("panicked at")
            || lower.contains("exception:")
        {
            let condensed: String = line.trim().chars().take(160).collect();
            found.push(condensed);
        }
    }

    found
}

/// Commands that were run.
fn commands(text: &str) -> Vec<String> {
    const TOOLS: &[&str] = &[
        "cargo", "npm", "bun", "pnpm", "yarn", "git", "python", "python3", "node", "go", "make",
        "docker", "kubectl", "pytest", "jest", "tsc", "eslint", "ruff", "gradle", "mvn", "deno",
    ];

    let mut found = Vec::new();

    // Backtick-quoted spans are the strongest signal a command was named.
    for span in between(text, '`') {
        let first = span.split_whitespace().next().unwrap_or("");
        if TOOLS.contains(&first) {
            found.push(span.chars().take(80).collect());
        }
    }

    for line in text.lines() {
        let trimmed = line.trim().trim_start_matches("$ ").trim_start_matches("> ");

        // A tool name anywhere in the line starts a command, not just at the
        // start: "I ran npm install" names a command as much as a bare prompt
        // line does, and prose is how an agent's own turns describe its work.
        for (offset, word) in trimmed.char_indices() {
            let _ = word;
            if offset > 0 && !trimmed[..offset].ends_with(char::is_whitespace) {
                continue;
            }
            let rest = &trimmed[offset..];
            let first = rest.split_whitespace().next().unwrap_or("");
            if TOOLS.contains(&first) {
                found.push(rest.chars().take(80).collect());
                break;
            }
        }
    }

    found
}

fn urls(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for word in text.split_whitespace() {
        let trimmed = word.trim_matches(|c: char| matches!(c, '<' | '>' | '"' | '\'' | '(' | ')' | ',' | '.'));
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            found.push(trimmed.chars().take(200).collect());
        }
    }
    found
}

/// The spans between paired occurrences of a delimiter.
fn between(text: &str, delimiter: char) -> Vec<String> {
    let mut spans = Vec::new();
    let mut current: Option<String> = None;

    for c in text.chars() {
        if c == delimiter {
            match current.take() {
                Some(span) => spans.push(span),
                None => current = Some(String::new()),
            }
            continue;
        }
        if let Some(span) = current.as_mut() {
            // A newline inside a backtick span means it was not a code span
            // after all; abandon it rather than swallowing the paragraph.
            if c == '\n' {
                current = None;
            } else {
                span.push(c);
            }
        }
    }

    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(text: &str, kind: EntityKind) -> Vec<String> {
        extract(text)
            .into_iter()
            .filter(|entity| entity.kind == kind)
            .map(|entity| entity.text)
            .collect()
    }

    #[test]
    fn finds_file_paths() {
        let found = texts("Edited src/main.rs and lib/util.ts today.", EntityKind::File);
        assert!(found.contains(&"src/main.rs".to_string()));
        assert!(found.contains(&"lib/util.ts".to_string()));
    }

    #[test]
    fn strips_a_line_and_column_suffix() {
        // `main.rs:42:8` and `main.rs:91` are one file, not three entities.
        let found = texts("main.rs:42:8 and main.rs:91 both failed", EntityKind::File);
        assert_eq!(found, vec!["main.rs".to_string()]);
    }

    #[test]
    fn keeps_a_windows_drive_letter() {
        let found = texts(r"C:\projects\src\main.rs:42 failed", EntityKind::File);
        assert!(found[0].starts_with("C:"), "{found:?}");
    }

    #[test]
    fn strips_surrounding_punctuation() {
        let found = texts("see `src/a.ts`, then (src/b.ts).", EntityKind::File);
        assert!(found.contains(&"src/a.ts".to_string()), "{found:?}");
        assert!(found.contains(&"src/b.ts".to_string()), "{found:?}");
    }

    #[test]
    fn ordinary_prose_is_not_a_path() {
        let found = texts("The quick brown fox. It jumped. Then it slept.", EntityKind::File);
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn finds_error_codes_and_lines() {
        let found = texts(
            "error[E0308]: mismatched types\nAll good here\nTS2345: argument type",
            EntityKind::Error,
        );
        assert!(found.iter().any(|text| text.contains("E0308")), "{found:?}");
        assert!(found.iter().any(|text| text.contains("TS2345")), "{found:?}");
    }

    #[test]
    fn finds_commands() {
        let found = texts("I ran `cargo test --workspace` and then npm install", EntityKind::Command);
        assert!(found.iter().any(|text| text.contains("cargo test")), "{found:?}");
        assert!(found.iter().any(|text| text.contains("npm install")), "{found:?}");
    }

    #[test]
    fn a_backtick_span_does_not_swallow_a_paragraph() {
        // One stray backtick would otherwise capture everything after it.
        let found = texts("A stray ` here\nand cargo build on the next line", EntityKind::Command);
        assert!(found.iter().all(|text| !text.contains("stray")), "{found:?}");
    }

    #[test]
    fn finds_urls() {
        let found = texts("See https://example.com/docs for details.", EntityKind::Url);
        assert_eq!(found, vec!["https://example.com/docs".to_string()]);
    }

    #[test]
    fn repeated_mentions_are_counted_not_duplicated() {
        let found = extract("src/a.ts is broken. Fix src/a.ts. Then check src/a.ts again.");
        let file = found.iter().find(|entity| entity.text == "src/a.ts").unwrap();
        assert_eq!(file.count, 3);
        assert_eq!(found.iter().filter(|e| e.text == "src/a.ts").count(), 1);
    }

    #[test]
    fn errors_sort_before_files() {
        // The list is truncated, so what comes first is what survives.
        let found = extract("error[E0308]: bad\nEdited src/main.rs");
        assert_eq!(found[0].kind, EntityKind::Error);
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(extract("").is_empty());
    }
}
