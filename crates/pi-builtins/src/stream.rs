//! `sed`, `awk`, and `grep` (architecture §8.2).
//!
//! Each implements the subset that shell pipelines actually use, and says so
//! rather than pretending to be the whole tool. A partial implementation that
//! reports what it cannot do is far more useful than one that silently
//! mis-handles a construct — the second kind produces wrong output that looks
//! right.

use crate::text::{from_lines, to_lines, Output};
use crate::regex::Regex;

// ---- sed ------------------------------------------------------------------

/// A parsed `sed` script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Script {
    /// `s/pattern/replacement/flags`
    Substitute { pattern: String, replacement: String, global: bool, ignore_case: bool },
    /// `/pattern/d`
    Delete { pattern: String },
    /// `/pattern/p`
    Print { pattern: String },
    /// `Nd` — delete one line by number.
    DeleteLine { line: usize },
}

/// Parses a `sed` script.
///
/// The hold space and branching are not supported. An agent that needs those is
/// better served writing a script it can read back than composing a sed program
/// it cannot easily verify.
pub fn parse_script(script: &str) -> Result<Script, String> {
    let trimmed = script.trim();

    if let Some(rest) = trimmed.strip_prefix('s') {
        let delimiter = rest.chars().next().ok_or("sed: `s` needs a delimiter")?;
        let parts = split_unescaped(&rest[delimiter.len_utf8()..], delimiter);
        if parts.len() < 2 {
            return Err(format!("sed: malformed substitution: {script}"));
        }

        let flags = parts.get(2).map(String::as_str).unwrap_or("");
        return Ok(Script::Substitute {
            pattern: parts[0].clone(),
            replacement: parts[1].clone(),
            global: flags.contains('g'),
            ignore_case: flags.contains('i'),
        });
    }

    if let Some(rest) = trimmed.strip_prefix('/') {
        if let Some(pattern) = rest.strip_suffix("/d") {
            return Ok(Script::Delete { pattern: pattern.to_string() });
        }
        if let Some(pattern) = rest.strip_suffix("/p") {
            return Ok(Script::Print { pattern: pattern.to_string() });
        }
    }

    if let Some(number) = trimmed.strip_suffix('d') {
        if let Ok(line) = number.parse::<usize>() {
            return Ok(Script::DeleteLine { line });
        }
    }

    Err(format!("sed: unsupported script: {script}"))
}

/// Splits on an unescaped delimiter.
fn split_unescaped(text: &str, delimiter: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut escaped = false;

    for c in text.chars() {
        if escaped {
            // The escape is kept: `\1` in a replacement means a backreference,
            // and dropping the backslash here would lose it.
            if c != delimiter {
                current.push('\\');
            }
            current.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == delimiter {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    parts.push(current);
    parts
}

pub fn sed(text: &str, script: &str) -> Output {
    let parsed = match parse_script(script) {
        Ok(parsed) => parsed,
        Err(message) => return Output::fail(message, 1),
    };

    match parsed {
        Script::Substitute { pattern, replacement, global, ignore_case } => {
            let regex = match Regex::new(&pattern, ignore_case) {
                Ok(regex) => regex,
                Err(message) => return Output::fail(format!("sed: {message}"), 1),
            };
            let lines: Vec<String> = to_lines(text)
                .into_iter()
                .map(|line| regex.replace(line, &replacement, global))
                .collect();
            Output::ok(from_lines(&lines))
        }

        Script::Delete { pattern } => {
            let regex = match Regex::new(&pattern, false) {
                Ok(regex) => regex,
                Err(message) => return Output::fail(format!("sed: {message}"), 1),
            };
            let lines: Vec<&str> =
                to_lines(text).into_iter().filter(|line| !regex.is_match(line)).collect();
            Output::ok(from_lines(&lines))
        }

        Script::Print { pattern } => {
            let regex = match Regex::new(&pattern, false) {
                Ok(regex) => regex,
                Err(message) => return Output::fail(format!("sed: {message}"), 1),
            };
            let lines: Vec<&str> =
                to_lines(text).into_iter().filter(|line| regex.is_match(line)).collect();
            Output::ok(from_lines(&lines))
        }

        Script::DeleteLine { line } => {
            let lines: Vec<&str> = to_lines(text)
                .into_iter()
                .enumerate()
                .filter(|(index, _)| index + 1 != line)
                .map(|(_, l)| l)
                .collect();
            Output::ok(from_lines(&lines))
        }
    }
}

// ---- awk ------------------------------------------------------------------

/// An `awk` program: an optional pattern and an optional action.
#[derive(Debug, Clone)]
pub struct Program {
    pub pattern: Option<String>,
    pub print: Option<Vec<Term>>,
}

/// One term of a `print` statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Term {
    /// `$0` — the whole line.
    Line,
    /// `$1`, `$2`, …
    Field(usize),
    /// `NF` — how many fields this line has.
    FieldCount,
    /// `NR` — the record number.
    RecordNumber,
    Literal(String),
}

pub fn parse_program(program: &str) -> Result<Program, String> {
    let trimmed = program.trim();

    let (pattern, action) = if let Some(rest) = trimmed.strip_prefix('/') {
        let end = rest.find('/').ok_or("awk: unterminated pattern")?;
        (Some(rest[..end].to_string()), rest[end + 1..].trim().to_string())
    } else {
        (None, trimmed.to_string())
    };

    if action.is_empty() {
        return Ok(Program { pattern, print: None });
    }

    let body = action
        .strip_prefix('{')
        .and_then(|a| a.strip_suffix('}'))
        .ok_or_else(|| format!("awk: expected an action in braces: {action}"))?
        .trim();

    let expression = body
        .strip_prefix("print")
        .ok_or_else(|| format!("awk: only `print` is supported: {body}"))?
        .trim();

    if expression.is_empty() {
        return Ok(Program { pattern, print: Some(vec![Term::Line]) });
    }

    let terms = expression
        .split(',')
        .map(|term| {
            let term = term.trim();
            if term == "$0" {
                return Term::Line;
            }
            if term == "NF" {
                return Term::FieldCount;
            }
            if term == "NR" {
                return Term::RecordNumber;
            }
            if let Some(number) = term.strip_prefix('$') {
                if let Ok(index) = number.parse::<usize>() {
                    return Term::Field(index);
                }
            }
            if term.len() >= 2 && term.starts_with('"') && term.ends_with('"') {
                return Term::Literal(term[1..term.len() - 1].to_string());
            }
            Term::Literal(term.to_string())
        })
        .collect();

    Ok(Program { pattern, print: Some(terms) })
}

pub fn awk(text: &str, program: &str, separator: Option<char>) -> Output {
    let parsed = match parse_program(program) {
        Ok(parsed) => parsed,
        Err(message) => return Output::fail(message, 1),
    };

    let regex = match &parsed.pattern {
        Some(pattern) => match Regex::new(pattern, false) {
            Ok(regex) => Some(regex),
            Err(message) => return Output::fail(format!("awk: {message}"), 1),
        },
        None => None,
    };

    let mut out: Vec<String> = Vec::new();

    for (index, line) in to_lines(text).into_iter().enumerate() {
        if let Some(regex) = &regex {
            if !regex.is_match(line) {
                continue;
            }
        }

        let Some(terms) = &parsed.print else {
            out.push(line.to_string());
            continue;
        };

        let fields: Vec<&str> = match separator {
            Some(sep) => line.split(sep).collect(),
            None => line.split_whitespace().collect(),
        };

        let rendered: Vec<String> = terms
            .iter()
            .map(|term| match term {
                Term::Line => line.to_string(),
                Term::Field(n) => fields.get(n.saturating_sub(1)).unwrap_or(&"").to_string(),
                Term::FieldCount => fields.len().to_string(),
                Term::RecordNumber => (index + 1).to_string(),
                Term::Literal(value) => value.clone(),
            })
            .collect();

        out.push(rendered.join(" "));
    }

    Output::ok(from_lines(&out))
}

// ---- grep -----------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct GrepOptions {
    pub ignore_case: bool,
    pub invert: bool,
    pub count: bool,
    pub line_numbers: bool,
    /// Match the whole line, as `grep -x` does.
    pub whole_line: bool,
    /// Treat the pattern as literal text, as `grep -F` does.
    pub fixed: bool,
}

pub fn grep(text: &str, pattern: &str, options: &GrepOptions) -> Output {
    let matcher: Box<dyn Fn(&str) -> bool> = if options.fixed {
        let needle =
            if options.ignore_case { pattern.to_lowercase() } else { pattern.to_string() };
        let ignore_case = options.ignore_case;
        let whole = options.whole_line;
        Box::new(move |line: &str| {
            let haystack = if ignore_case { line.to_lowercase() } else { line.to_string() };
            if whole {
                haystack == needle
            } else {
                haystack.contains(&needle)
            }
        })
    } else {
        let regex = match Regex::new(pattern, options.ignore_case) {
            Ok(regex) => regex,
            Err(message) => return Output::fail(format!("grep: {message}"), 2),
        };
        let whole = options.whole_line;
        Box::new(move |line: &str| {
            if whole {
                regex.matches_whole(line)
            } else {
                regex.is_match(line)
            }
        })
    };

    let mut matched: Vec<String> = Vec::new();
    for (index, line) in to_lines(text).into_iter().enumerate() {
        let hit = matcher(line) != options.invert;
        if !hit {
            continue;
        }
        matched.push(if options.line_numbers {
            format!("{}:{line}", index + 1)
        } else {
            line.to_string()
        });
    }

    if options.count {
        return Output::ok(format!("{}\n", matched.len()));
    }

    // Exit 1 on no match: pipelines branch on this, and returning success for
    // "found nothing" makes `grep -q` useless.
    Output {
        stdout: from_lines(&matched),
        stderr: String::new(),
        code: if matched.is_empty() { 1 } else { 0 },
    }
}
