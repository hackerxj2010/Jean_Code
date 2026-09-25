//! Word expansion: variables, tilde, braces, globs, and field splitting.
//!
//! The order is fixed by POSIX and is not arbitrary — each stage's output is
//! the next stage's input, and reordering them changes results. Brace expansion
//! happens before variables (so `{a,$b}` expands the brace first), and field
//! splitting happens *after* variable expansion but only for unquoted pieces,
//! which is the entire difference between `$files` and `"$files"`.

use crate::lexer::{Piece, Word};
use pi_builtins::data::glob_match;
use std::collections::HashMap;
use std::path::Path;

/// Everything expansion needs to read.
pub struct Context<'a> {
    pub variables: &'a HashMap<String, String>,
    pub cwd: &'a Path,
    pub home: &'a Path,
    /// The exit code of the last command, for `$?`.
    pub last_status: i32,
    /// Positional parameters, for `$1`, `$@`.
    pub positional: &'a [String],
    /// No field splitting and no globbing — inside `[[ ]]` and for `case`
    /// patterns, where `*.rs` is a pattern to match, not files to list.
    pub noglob: bool,
}

/// Expands one word into zero or more fields.
///
/// Zero is possible and correct: an unquoted `$empty` expands to nothing at
/// all, which is why `rm -rf $DIR/` is so dangerous and `rm -rf "$DIR"/` is not.
pub fn expand_word<F>(word: &Word, context: &Context, run_command: &mut F) -> Result<Vec<String>, String>
where
    F: FnMut(&str) -> Result<String, String>,
{
    // Stage 1: brace expansion, on the literal text, before anything else.
    let braced = expand_braces(&word_shape(word));

    let mut fields: Vec<String> = Vec::new();

    for shape in braced {
        // Rebuild the word from the brace-expanded shape, preserving quoting.
        let rebuilt = reshape(word, &shape);
        let mut current = String::new();
        let mut split_points: Vec<usize> = Vec::new();
        let mut globbable = false;
        // Whether any piece was quoted. An unquoted expansion that comes back
        // empty produces *no* field at all, while a quoted one produces one
        // empty field — the difference between `rm $UNSET` (deletes nothing)
        // and `rm "$UNSET"` (an error naming the empty argument).
        let mut quoted_anywhere = false;

        for piece in &rebuilt.pieces {
            match piece {
                Piece::Literal(text) => {
                    quoted_anywhere = true;
                    current.push_str(text);
                }

                Piece::Quoted(text) => {
                    // Expanded, never split, never globbed.
                    quoted_anywhere = true;
                    current.push_str(&expand_variables(text, context)?);
                }

                Piece::Bare(text) => {
                    let expanded = expand_tilde(&expand_variables(text, context)?, context);
                    // Record where splitting may happen: only inside text that
                    // came from an unquoted expansion.
                    if expanded.contains(|c: char| c == ' ' || c == '\t' || c == '\n') {
                        split_points.push(current.len());
                    }
                    if expanded.contains(['*', '?', '[']) {
                        globbable = true;
                    }
                    current.push_str(&expanded);
                }

                Piece::Command(command) | Piece::QuotedCommand(command) => {
                    let output = run_command(command)?;
                    // Trailing newlines are stripped, as every shell does —
                    // otherwise `x=$(pwd)` carries a newline into every use.
                    let output = output.trim_end_matches('\n');
                    if matches!(piece, Piece::QuotedCommand(_)) {
                        quoted_anywhere = true;
                    } else if output.contains(|c: char| c == ' ' || c == '\t' || c == '\n') {
                        // Unquoted, its words are separate arguments:
                        // `for f in $(ls)` loops over each file.
                        split_points.push(current.len());
                    }
                    current.push_str(output);
                }

                Piece::Arithmetic(expression) => {
                    // Substitutions and `$x` references first; bare names are
                    // the evaluator's.
                    let substituted = substitute_commands(expression, run_command)?;
                    let resolved = expand_variables(&substituted, context)?;
                    let value = crate::arith::evaluate(&resolved, &mut crate::arith::ReadOnly(context.variables))?;
                    current.push_str(&value.to_string());
                }
            }
        }

        if current.is_empty() && !quoted_anywhere {
            continue;
        }

        if context.noglob {
            fields.push(current);
            continue;
        }

        // Stage 2: field splitting, for unquoted expansions only.
        let split: Vec<String> = if split_points.is_empty() {
            vec![current]
        } else {
            current
                .split_whitespace()
                .map(String::from)
                .collect()
        };

        // Stage 3: globbing. A pattern that matches nothing stays literal,
        // which is what bash does without `nullglob`.
        for field in split {
            // Only a pattern that was unquoted globs: `'*'` is an asterisk.
            if globbable {
                let matched = expand_glob(&field, context.cwd);
                if matched.is_empty() {
                    fields.push(field);
                } else {
                    fields.extend(matched);
                }
            } else {
                fields.push(field);
            }
        }
    }

    Ok(fields)
}

/// Replaces each `$(...)` in `text` with its command's output, as arithmetic
/// needs before it can evaluate `$(( $(wc -l < f) + 1 ))`.
fn substitute_commands<F>(text: &str, run_command: &mut F) -> Result<String, String>
where
    F: FnMut(&str) -> Result<String, String>,
{
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' && chars.get(i + 1) == Some(&'(') && chars.get(i + 2) != Some(&'(') {
            let mut depth = 0;
            let mut end = i + 1;
            while end < chars.len() {
                match chars[end] {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                end += 1;
            }
            if end >= chars.len() {
                return Err("unterminated `$(` in arithmetic".to_string());
            }
            let command: String = chars[i + 2..end].iter().collect();
            out.push_str(run_command(&command)?.trim());
            i = end + 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    Ok(out)
}

/// The word's literal shape, for brace expansion to work on.
fn word_shape(word: &Word) -> String {
    word.pieces
        .iter()
        .map(|piece| match piece {
            Piece::Bare(text) => text.clone(),
            // Quoted text cannot contain a brace expansion, so it is masked out
            // with a placeholder that the reshape puts back.
            Piece::Quoted(_) | Piece::Literal(_) | Piece::Command(_) | Piece::QuotedCommand(_) | Piece::Arithmetic(_) => {
                "\u{0}".to_string()
            }
        })
        .collect()
}

/// Rebuilds a word after brace expansion replaced its bare text.
fn reshape(original: &Word, shape: &str) -> Word {
    let mut parts = shape.split('\u{0}');
    let mut pieces = Vec::new();

    for piece in &original.pieces {
        match piece {
            Piece::Bare(_) => {
                if let Some(text) = parts.next() {
                    if !text.is_empty() {
                        pieces.push(Piece::Bare(text.to_string()));
                    }
                }
            }
            other => {
                // Consume the placeholder that stood in for this piece.
                let _ = parts.next();
                pieces.push(other.clone());
            }
        }
    }

    // A word made only of bare text has one trailing part left.
    if let Some(text) = parts.next() {
        if !text.is_empty() {
            pieces.push(Piece::Bare(text.to_string()));
        }
    }

    Word { pieces }
}

/// `{a,b}c` becomes `ac bc`; `{1..3}` becomes `1 2 3`.
pub fn expand_braces(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();

    // Find the first balanced brace group.
    let Some(open) = chars.iter().position(|c| *c == '{') else {
        return vec![text.to_string()];
    };

    let mut depth = 0;
    let mut close = None;
    for (index, c) in chars.iter().enumerate().skip(open) {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(index);
                    break;
                }
            }
            _ => {}
        }
    }

    let Some(close) = close else { return vec![text.to_string()] };

    let prefix: String = chars[..open].iter().collect();
    let body: String = chars[open + 1..close].iter().collect();
    let suffix: String = chars[close + 1..].iter().collect();

    let alternatives = if let Some(range) = numeric_range(&body) {
        range
    } else {
        let split = split_top_level(&body);
        // `{a}` with no comma is not an expansion — it stays literal, which is
        // what makes `${x}` and `awk '{print}'` survive. The group is kept as
        // text and only the suffix is expanded further; recursing on the whole
        // string here would hand the same input straight back and never end.
        if split.len() < 2 {
            let head = format!("{prefix}{{{body}}}");
            return expand_braces(&suffix)
                .into_iter()
                .map(|tail| format!("{head}{tail}"))
                .collect();
        }
        split
    };

    let mut out = Vec::new();
    for alternative in alternatives {
        // The suffix can contain further groups, so recurse on the whole result.
        out.extend(expand_braces(&format!("{prefix}{alternative}{suffix}")));
    }
    out
}

/// `1..5` or `a..e`, with an optional step.
fn numeric_range(body: &str) -> Option<Vec<String>> {
    let parts: Vec<&str> = body.split("..").collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }

    if let (Ok(from), Ok(to)) = (parts[0].parse::<i64>(), parts[1].parse::<i64>()) {
        let step: i64 = parts.get(2).and_then(|s| s.parse::<i64>().ok()).unwrap_or(1).abs().max(1);
        let mut out = Vec::new();
        if from <= to {
            let mut value = from;
            while value <= to {
                out.push(value.to_string());
                value += step;
            }
        } else {
            let mut value = from;
            while value >= to {
                out.push(value.to_string());
                value -= step;
            }
        }
        return Some(out);
    }

    // Character ranges: `{a..e}`.
    let from = parts[0].chars().next()?;
    let to = parts[1].chars().next()?;
    if parts[0].chars().count() != 1 || parts[1].chars().count() != 1 {
        return None;
    }

    let (low, high, reversed) =
        if from <= to { (from, to, false) } else { (to, from, true) };
    let mut out: Vec<String> =
        (low..=high).map(|c| c.to_string()).collect();
    if reversed {
        out.reverse();
    }
    Some(out)
}

/// Splits on commas that are not inside a nested brace group.
fn split_top_level(body: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0;

    for c in body.chars() {
        match c {
            '{' => {
                depth += 1;
                current.push(c);
            }
            '}' => {
                depth -= 1;
                current.push(c);
            }
            ',' if depth == 0 => parts.push(std::mem::take(&mut current)),
            c => current.push(c),
        }
    }
    parts.push(current);
    parts
}

/// `$VAR`, `${VAR}`, `${VAR:-default}`, `$?`, `$1`, `$@`, `$#`.
pub fn expand_variables(text: &str, context: &Context) -> Result<String, String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut index = 0;

    while index < chars.len() {
        if chars[index] != '$' {
            out.push(chars[index]);
            index += 1;
            continue;
        }

        // A `$` at the very end is a literal dollar sign.
        let Some(next) = chars.get(index + 1) else {
            out.push('$');
            index += 1;
            continue;
        };

        if *next == '{' {
            let Some(close) = find_close(&chars, index + 1) else {
                return Err("unclosed `${`".to_string());
            };
            let body: String = chars[index + 2..close].iter().collect();
            out.push_str(&expand_braced_parameter(&body, context)?);
            index = close + 1;
            continue;
        }

        // Special parameters.
        match next {
            '?' => {
                out.push_str(&context.last_status.to_string());
                index += 2;
                continue;
            }
            '#' => {
                out.push_str(&context.positional.len().to_string());
                index += 2;
                continue;
            }
            '@' | '*' => {
                out.push_str(&context.positional.join(" "));
                index += 2;
                continue;
            }
            '$' => {
                out.push_str(&std::process::id().to_string());
                index += 2;
                continue;
            }
            c if c.is_ascii_digit() => {
                let position = c.to_digit(10).unwrap() as usize;
                // `$0` is the shell's own name; `$1` is the first argument.
                if position > 0 {
                    out.push_str(
                        context.positional.get(position - 1).map(String::as_str).unwrap_or(""),
                    );
                }
                index += 2;
                continue;
            }
            c if !c.is_alphabetic() && *c != '_' => {
                // `$` followed by punctuation is a literal `$`, which is what
                // makes `echo $5.00` and regex `$` work.
                out.push('$');
                index += 1;
                continue;
            }
            _ => {}
        }

        let start = index + 1;
        let mut end = start;
        while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
            end += 1;
        }
        let name: String = chars[start..end].iter().collect();
        out.push_str(&lookup(&name, context));
        index = end;
    }

    Ok(out)
}

fn find_close(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    for (index, c) in chars.iter().enumerate().skip(open) {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

/// `${VAR}`, `${VAR:-default}`, `${VAR:=default}`, `${VAR:?message}`,
/// `${VAR:+alternate}`, `${#VAR}`.
fn expand_braced_parameter(body: &str, context: &Context) -> Result<String, String> {
    if let Some(name) = body.strip_prefix('#') {
        return Ok(lookup(name, context).chars().count().to_string());
    }

    const MODIFIERS: [(&str, Modifier); 4] = [
        (":-", Modifier::Default),
        (":=", Modifier::Assign),
        (":?", Modifier::Error),
        (":+", Modifier::Alternate),
    ];

    for (marker, kind) in MODIFIERS {
        let Some((name, argument)) = body.split_once(marker) else { continue };
        let value = lookup(name, context);

        return Ok(match kind {
            // `:-` and friends treat empty and unset alike, which is the
            // behaviour that makes them useful for defaults.
            Modifier::Default | Modifier::Assign => {
                if value.is_empty() {
                    expand_variables(argument, context)?
                } else {
                    value
                }
            }
            Modifier::Alternate => {
                if value.is_empty() {
                    String::new()
                } else {
                    expand_variables(argument, context)?
                }
            }
            Modifier::Error => {
                if value.is_empty() {
                    return Err(format!(
                        "{name}: {}",
                        if argument.is_empty() { "parameter is unset" } else { argument }
                    ));
                }
                value
            }
        });
    }

    Ok(lookup(body, context))
}

#[derive(Clone, Copy)]
enum Modifier {
    Default,
    Assign,
    Error,
    Alternate,
}

fn lookup(name: &str, context: &Context) -> String {
    context.variables.get(name).cloned().unwrap_or_default()
}

/// `~` and `~/path` become the home directory. `~user` is left alone: resolving
/// another user's home needs a passwd lookup this crate will not do.
pub fn expand_tilde(text: &str, context: &Context) -> String {
    if text == "~" {
        return context.home.display().to_string();
    }
    if let Some(rest) = text.strip_prefix("~/") {
        return context.home.join(rest).display().to_string();
    }
    text.to_string()
}

/// Expands a glob against the filesystem, returning sorted relative paths.
pub fn expand_glob(pattern: &str, cwd: &Path) -> Vec<String> {
    if !pattern.contains(['*', '?', '[']) {
        return Vec::new();
    }

    // A pattern with a leading directory is matched against paths relative to
    // it, so `src/*.ts` does not have to walk the whole tree.
    let (root, relative_pattern) = match pattern.rfind('/') {
        Some(index) if !pattern[..index].contains(['*', '?', '[']) => {
            (cwd.join(&pattern[..index]), pattern[index + 1..].to_string())
        }
        _ => (cwd.to_path_buf(), pattern.to_string()),
    };

    let deep = relative_pattern.contains("**") || pattern.contains("**");
    let mut matched: Vec<String> = Vec::new();

    if deep {
        let files = pi_builtins::data::find(
            &root,
            &pi_builtins::data::FindOptions {
                path: Some(relative_pattern.clone()),
                limit: Some(5000),
                ..pi_builtins::data::FindOptions::default()
            },
        );
        for line in files.stdout.lines() {
            if line.starts_with("...") {
                continue;
            }
            matched.push(prefixed(pattern, line));
        }
    } else {
        let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // A glob does not match a dotfile unless the pattern starts with a
            // dot, which is why `rm *` leaves `.git` alone.
            if name.starts_with('.') && !relative_pattern.starts_with('.') {
                continue;
            }
            if glob_match(&relative_pattern, &name) {
                matched.push(prefixed(pattern, &name));
            }
        }
    }

    matched.sort();
    matched
}

/// Re-attaches the directory part the pattern carried.
fn prefixed(pattern: &str, name: &str) -> String {
    match pattern.rfind('/') {
        Some(index) if !pattern[..index].contains(['*', '?', '[']) => {
            format!("{}/{name}", &pattern[..index])
        }
        _ => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::tokenize;
    use crate::lexer::Token;

    fn context<'a>(
        variables: &'a HashMap<String, String>,
        positional: &'a [String],
    ) -> Context<'a> {
        Context {
            variables,
            cwd: Path::new("."),
            home: Path::new("/home/jean"),
            last_status: 0,
            positional,
            noglob: false,
        }
    }

    fn expand(input: &str, variables: &[(&str, &str)]) -> Vec<String> {
        let map: HashMap<String, String> = variables
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let empty: Vec<String> = Vec::new();
        let context = context(&map, &empty);

        let tokens = tokenize(input).unwrap();
        let Token::Word(word) = &tokens[0] else { panic!("expected a word") };
        expand_word(word, &context, &mut |_| Ok(String::new())).unwrap()
    }

    #[test]
    fn variables_expand() {
        assert_eq!(expand("$NAME", &[("NAME", "jean")]), vec!["jean"]);
        assert_eq!(expand("${NAME}", &[("NAME", "jean")]), vec!["jean"]);
        assert_eq!(expand("pre${NAME}post", &[("NAME", "x")]), vec!["prexpost"]);
    }

    #[test]
    fn an_unset_variable_expands_to_nothing() {
        // Not to the literal text, and not to an error: to nothing. This is the
        // behaviour behind `rm -rf $UNSET/build` deleting the wrong thing.
        assert_eq!(expand("$MISSING", &[]), Vec::<String>::new());
    }

    #[test]
    fn quoting_preserves_an_empty_field() {
        assert_eq!(expand(r#""$MISSING""#, &[]), vec![""]);
    }

    #[test]
    fn unquoted_expansion_splits_on_whitespace() {
        assert_eq!(expand("$FILES", &[("FILES", "a.txt b.txt")]), vec!["a.txt", "b.txt"]);
    }

    #[test]
    fn quoted_expansion_does_not_split() {
        assert_eq!(expand(r#""$FILES""#, &[("FILES", "a.txt b.txt")]), vec!["a.txt b.txt"]);
    }

    #[test]
    fn single_quotes_block_expansion_entirely() {
        assert_eq!(expand("'$NAME'", &[("NAME", "jean")]), vec!["$NAME"]);
    }

    #[test]
    fn defaults_apply_to_unset_and_empty_alike() {
        assert_eq!(expand("${X:-fallback}", &[]), vec!["fallback"]);
        assert_eq!(expand("${X:-fallback}", &[("X", "")]), vec!["fallback"]);
        assert_eq!(expand("${X:-fallback}", &[("X", "set")]), vec!["set"]);
        assert_eq!(expand("${X:+alternate}", &[("X", "set")]), vec!["alternate"]);
        assert_eq!(expand("${X:+alternate}", &[]), Vec::<String>::new());
    }

    #[test]
    fn parameter_length() {
        assert_eq!(expand("${#NAME}", &[("NAME", "jean")]), vec!["4"]);
    }

    #[test]
    fn a_dollar_before_punctuation_stays_literal() {
        // `echo $5.00` and a regex ending in `$` both depend on this.
        assert_eq!(expand("cost$", &[]), vec!["cost$"]);
    }

    #[test]
    fn brace_lists_expand() {
        assert_eq!(expand_braces("a{1,2}b"), vec!["a1b", "a2b"]);
        assert_eq!(expand_braces("{a,b}{c,d}"), vec!["ac", "ad", "bc", "bd"]);
    }

    #[test]
    fn brace_ranges_expand_in_both_directions() {
        assert_eq!(expand_braces("{1..4}"), vec!["1", "2", "3", "4"]);
        assert_eq!(expand_braces("{4..1}"), vec!["4", "3", "2", "1"]);
        assert_eq!(expand_braces("{1..6..2}"), vec!["1", "3", "5"]);
        assert_eq!(expand_braces("{a..d}"), vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn a_brace_without_a_comma_stays_literal() {
        // Otherwise `awk '{print}'` and `${VAR}` would be mangled.
        assert_eq!(expand_braces("{print}"), vec!["{print}"]);
        assert_eq!(expand_braces("x{y}z"), vec!["x{y}z"]);
    }

    #[test]
    fn tilde_expands_only_at_the_start() {
        let map = HashMap::new();
        let empty: Vec<String> = Vec::new();
        let context = context(&map, &empty);
        assert_eq!(expand_tilde("~", &context), "/home/jean");
        assert!(expand_tilde("~/src", &context).ends_with("src"));
        // Mid-word it is a literal character, as in a backup filename.
        assert_eq!(expand_tilde("file~", &context), "file~");
    }

    #[test]
    fn special_parameters() {
        let map = HashMap::new();
        let positional = vec!["first".to_string(), "second".to_string()];
        let mut context = context(&map, &positional);
        context.last_status = 3;

        assert_eq!(expand_variables("$?", &context).unwrap(), "3");
        assert_eq!(expand_variables("$1", &context).unwrap(), "first");
        assert_eq!(expand_variables("$#", &context).unwrap(), "2");
        assert_eq!(expand_variables("$@", &context).unwrap(), "first second");
    }

    #[test]
    fn a_glob_that_matches_nothing_stays_literal() {
        // Without this, `grep "*.ts" file` would lose its pattern.
        assert_eq!(expand("*.nonexistent-extension", &[]), vec!["*.nonexistent-extension"]);
    }

    #[test]
    fn an_unclosed_brace_parameter_is_an_error() {
        let map = HashMap::new();
        let empty: Vec<String> = Vec::new();
        let context = context(&map, &empty);
        assert!(expand_variables("${unclosed", &context).is_err());
    }
}
