//! # pi-ast
//!
//! Structural code search and rewriting (architecture §6.14).
//!
//! Text search finds `foo(` in a comment, in a string, and in `foofoo(`.
//! Structural search finds calls to `foo`. The difference matters most for the
//! operations an agent performs constantly — renaming, finding every call site,
//! checking whether a pattern still exists after an edit — where a false
//! positive means editing code that should not change.
//!
//! ```
//! use pi_ast::{search_source, syntax_for};
//!
//! let source = "console.log(a);\n// console.log(b);\nconsole.log(c);";
//! let hits = search_source(source, "console.log($ARG)", &syntax_for("x.ts")).unwrap();
//! // The commented-out call is not a call.
//! assert_eq!(hits.len(), 2);
//! ```

pub mod outline;
pub mod pattern;
pub mod tokens;

pub use pattern::{compile, rewrite, search, Match, Pattern};
pub use tokens::{syntax_for, tokenize, Syntax, Token};

use std::path::Path;

/// Searches one source string.
pub fn search_source(source: &str, pattern: &str, syntax: &Syntax) -> Result<Vec<Match>, String> {
    let compiled = compile(pattern, syntax)?;
    Ok(search(source, &compiled, syntax))
}

/// A match with the file it came from.
#[derive(Debug, Clone)]
pub struct FileMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
    pub captures: std::collections::HashMap<String, String>,
}

/// Searches every file under a root, choosing the syntax per file extension.
///
/// A pattern is compiled once per syntax rather than once per file: compiling
/// is cheap, but a thousand-file tree makes it measurable.
pub fn search_tree(
    root: &Path,
    pattern: &str,
    glob: Option<&str>,
    limit: usize,
) -> Result<Vec<FileMatch>, String> {
    let files = pi_builtins::data::find(
        root,
        &pi_builtins::data::FindOptions {
            kind: Some(pi_builtins::data::EntryKind::File),
            path: glob.map(String::from),
            limit: Some(20_000),
            ..Default::default()
        },
    );
    let listed: Vec<String> = files
        .stdout
        .lines()
        .filter(|line| !line.starts_with("..."))
        .map(String::from)
        .collect();
    search_files(root, &listed, pattern, limit)
}

/// Searches the given files, relative to `root`, choosing the syntax per file
/// extension. For a caller that has already decided which files count — a
/// gitignore-aware walk, say — rather than taking every file under the root.
pub fn search_files(
    root: &Path,
    files: &[String],
    pattern: &str,
    limit: usize,
) -> Result<Vec<FileMatch>, String> {
    let mut compiled: Vec<(&'static str, Pattern, Syntax)> = Vec::new();
    let mut results = Vec::new();

    for relative in files {
        let relative = relative.as_str();
        if results.len() >= limit {
            break;
        }

        let syntax = syntax_for(relative);
        if !compiled.iter().any(|(name, _, _)| *name == syntax.name) {
            // A pattern that will not compile for one syntax may still compile
            // for another, so a failure here skips that syntax rather than
            // failing the whole search.
            match compile(pattern, &syntax) {
                Ok(parsed) => compiled.push((syntax.name, parsed, syntax.clone())),
                Err(_) => continue,
            }
        }

        let Some((_, parsed, syntax)) = compiled.iter().find(|(name, _, _)| *name == syntax.name)
        else {
            continue;
        };

        let path = root.join(relative);
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if pi_builtins::files::is_binary(&bytes) {
            continue;
        }
        let source = String::from_utf8_lossy(&bytes);

        for hit in search(&source, parsed, syntax) {
            results.push(FileMatch {
                path: relative.to_string(),
                line: hit.line,
                text: hit.text,
                captures: hit.captures,
            });
            if results.len() >= limit {
                break;
            }
        }
    }

    Ok(results)
}

/// Renders matches as `path:line: text`, one per line.
pub fn render(matches: &[FileMatch]) -> String {
    let mut out = String::new();
    for hit in matches {
        // A multi-line match is collapsed: the point of the listing is to show
        // where things are, and a fifty-line function body in the middle of it
        // buries the next result.
        let single_line = hit.text.replace('\n', " ");
        let condensed = collapse_spaces(&single_line);
        let shown = if condensed.chars().count() > 160 {
            let head: String = condensed.chars().take(157).collect();
            format!("{head}...")
        } else {
            condensed
        };
        out.push_str(&format!("{}:{}: {shown}\n", hit.path, hit.line));
    }
    out
}

fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous_space = false;
    for c in text.chars() {
        let space = c.is_whitespace();
        if space && previous_space {
            continue;
        }
        out.push(if space { ' ' } else { c });
        previous_space = space;
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp() -> std::path::PathBuf {
        // The clock alone is not unique: tests run in parallel, and two can
        // read the same instant and share — and pollute — one directory.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "pi-ast-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn searches_one_source_string() {
        let hits = search_source("f(1); f(2);", "f($A)", &syntax_for("x.ts")).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn searches_a_tree_and_reports_paths() {
        let root = temp();
        fs::write(root.join("a.ts"), "console.log(one);\n").unwrap();
        fs::write(root.join("b.ts"), "// console.log(two);\nconsole.log(three);\n").unwrap();
        fs::write(root.join("c.txt"), "console.log(not code);\n").unwrap();

        let hits = search_tree(&root, "console.log($ARG)", Some("*.ts"), 100).unwrap();
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(hits.iter().any(|hit| hit.captures["ARG"] == "one"));
        assert!(hits.iter().any(|hit| hit.captures["ARG"] == "three"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_language_specific_pattern_applies_per_file() {
        let root = temp();
        // `#` is a comment in Python and not in TypeScript. The same pattern
        // must respect each file's rules.
        fs::write(root.join("a.py"), "# call(hidden)\ncall(visible)\n").unwrap();
        fs::write(root.join("b.ts"), "call(shown)\n").unwrap();

        let hits = search_tree(&root, "call($A)", None, 100).unwrap();
        let captured: Vec<&String> = hits.iter().map(|hit| &hit.captures["A"]).collect();
        assert!(captured.contains(&&"visible".to_string()));
        assert!(captured.contains(&&"shown".to_string()));
        assert!(!captured.contains(&&"hidden".to_string()));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_limit_is_respected() {
        let root = temp();
        let many = (0..50).map(|n| format!("f({n});")).collect::<Vec<_>>().join("\n");
        fs::write(root.join("many.ts"), many).unwrap();

        let hits = search_tree(&root, "f($A)", None, 10).unwrap();
        assert_eq!(hits.len(), 10);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rendering_collapses_a_multiline_match() {
        let matches = vec![FileMatch {
            path: "a.ts".to_string(),
            line: 3,
            text: "if (x) {\n    y();\n}".to_string(),
            captures: Default::default(),
        }];
        let rendered = render(&matches);
        assert!(!rendered.trim_end().contains('\n'));
        assert!(rendered.starts_with("a.ts:3: "));
    }

    #[test]
    fn a_binary_file_is_skipped_rather_than_scanned() {
        let root = temp();
        fs::write(root.join("blob.ts"), [0x00, 0x01, 0x02]).unwrap();
        fs::write(root.join("real.ts"), "f(1);\n").unwrap();

        let hits = search_tree(&root, "f($A)", None, 100).unwrap();
        assert_eq!(hits.len(), 1);

        fs::remove_dir_all(&root).ok();
    }
}
