//! Structural pattern matching with metavariables.
//!
//! A pattern is written in the target language with holes:
//!
//! ```text
//! console.log($ARG)          matches any single-argument call
//! if ($COND) { $$$BODY }     matches any if statement, capturing the body
//! $OBJ.then($$$).catch($$$)  matches a promise chain, capturing nothing
//! ```
//!
//! `$NAME` matches exactly one *balanced* expression — one token, or a whole
//! bracketed group. `$$$NAME` matches any number of them, including none. A
//! metavariable used twice must match the same text both times, which is what
//! lets `$X === $X` find a tautology.
//!
//! This is not a parser, and it does not need to be. Matching over a token
//! stream that respects brackets, strings, and comments catches the patterns
//! people actually search for, and it works on a file that does not compile —
//! which is exactly when an agent is searching.

use crate::tokens::{significant, tokenize, Kind, Syntax, Token};
use std::collections::HashMap;

/// One element of a compiled pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Element {
    /// A token that must appear as written.
    Exact(String),
    /// An identifier-shaped token, matched by kind rather than text — so a
    /// pattern token `_` can stand for "some identifier".
    AnyIdentifier,
    /// `$NAME` — one balanced expression.
    Single(String),
    /// `$$$NAME` — zero or more balanced expressions.
    Many(String),
}

#[derive(Debug, Clone)]
pub struct Pattern {
    pub elements: Vec<Element>,
    pub source: String,
}

/// Where a pattern matched, and what its metavariables captured.
#[derive(Debug, Clone)]
pub struct Match {
    /// Byte range in the source.
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub text: String,
    pub captures: HashMap<String, String>,
}

/// Compiles a pattern written in the target language.
pub fn compile(pattern: &str, syntax: &Syntax) -> Result<Pattern, String> {
    let tokens = significant(&tokenize(pattern, syntax));
    if tokens.is_empty() {
        return Err("the pattern is empty".to_string());
    }

    let mut elements = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        let token = &tokens[index];

        // `$` tokenizes separately in most languages, so a metavariable arrives
        // as `$` followed by a name — except in TypeScript, where `$` is an
        // identifier character and `$NAME` is one token.
        if token.text == "$" {
            // `$$$NAME`: three dollars, then the name.
            let dollars = count_dollars(&tokens, index);
            let name_index = index + dollars;

            let name = tokens
                .get(name_index)
                .filter(|t| t.kind == Kind::Identifier)
                .map(|t| t.text.clone());

            match (dollars, name) {
                (3, Some(name)) => {
                    elements.push(Element::Many(name));
                    index = name_index + 1;
                    continue;
                }
                // Anonymous `$$$` captures nothing but still matches anything.
                (3, None) => {
                    elements.push(Element::Many(String::new()));
                    index = name_index;
                    continue;
                }
                (1, Some(name)) => {
                    elements.push(Element::Single(name));
                    index = name_index + 1;
                    continue;
                }
                _ => {
                    return Err(format!(
                        "`{}` is not a metavariable; write $NAME or $$$NAME",
                        "$".repeat(dollars)
                    ))
                }
            }
        }

        if let Some(name) = token.text.strip_prefix("$$$") {
            elements.push(Element::Many(name.to_string()));
            index += 1;
            continue;
        }

        if let Some(name) = token.text.strip_prefix('$') {
            if !name.is_empty() {
                elements.push(Element::Single(name.to_string()));
                index += 1;
                continue;
            }
        }

        if token.text == "_" {
            elements.push(Element::AnyIdentifier);
            index += 1;
            continue;
        }

        elements.push(Element::Exact(token.text.clone()));
        index += 1;
    }

    Ok(Pattern { elements, source: pattern.to_string() })
}

fn count_dollars(tokens: &[Token], start: usize) -> usize {
    let mut count = 0;
    while tokens.get(start + count).map(|t| t.text.as_str()) == Some("$") {
        count += 1;
    }
    count
}

/// Finds every match of a pattern in source.
pub fn search(source: &str, pattern: &Pattern, syntax: &Syntax) -> Vec<Match> {
    let all = tokenize(source, syntax);
    let tokens = significant(&all);
    let mut matches = Vec::new();
    let mut start = 0;

    while start < tokens.len() {
        let mut captures = HashMap::new();
        if let Some(end) = match_at(&pattern.elements, &tokens, start, &mut captures) {
            // `end` is exclusive; an empty match would loop forever.
            if end > start {
                let first = &tokens[start];
                let last = &tokens[end - 1];
                matches.push(Match {
                    start: first.start,
                    end: last.end,
                    line: first.line,
                    text: source[first.start..last.end].to_string(),
                    captures,
                });
                // Non-overlapping: continuing from `end` is what makes a
                // rewrite of every match well-defined.
                start = end;
                continue;
            }
        }
        start += 1;
    }

    matches
}

/// Matches `elements` against `tokens` starting at `index`, returning the index
/// just past the match.
fn match_at(
    elements: &[Element],
    tokens: &[Token],
    index: usize,
    captures: &mut HashMap<String, String>,
) -> Option<usize> {
    let Some((first, rest)) = elements.split_first() else { return Some(index) };

    match first {
        Element::Exact(text) => {
            if tokens.get(index)?.text != *text {
                return None;
            }
            match_at(rest, tokens, index + 1, captures)
        }

        Element::AnyIdentifier => {
            if tokens.get(index)?.kind != Kind::Identifier {
                return None;
            }
            match_at(rest, tokens, index + 1, captures)
        }

        Element::Single(name) => {
            // One *expression*, which is not one token: `g(1, 2)` is a name
            // followed by a bracket group, and `$ARG` has to take both or
            // `f($ARG)` fails on every call whose argument is itself a call.
            // Shortest first, extending only when the rest of the pattern does
            // not fit — greedy would swallow the closing bracket.
            let mut end = balanced_end(tokens, index)?;

            loop {
                let text = span_text(tokens, index, end);

                // A repeated metavariable must capture the same text: `$X == $X`
                // is a tautology check, not a wildcard pair.
                let consistent = captures.get(name).is_none_or(|previous| *previous == text);

                if consistent {
                    let restore = captures.get(name).cloned();
                    captures.insert(name.clone(), text);

                    if let Some(final_end) = match_at(rest, tokens, end, captures) {
                        return Some(final_end);
                    }

                    // Backtracking has to undo the capture, or a failed branch
                    // leaks its binding into the next attempt.
                    match restore {
                        Some(previous) => {
                            captures.insert(name.clone(), previous);
                        }
                        None => {
                            captures.remove(name);
                        }
                    }
                }

                match balanced_end(tokens, end) {
                    Some(next) if next > end => end = next,
                    _ => return None,
                }
            }
        }

        Element::Many(name) => {
            // Try the shortest run first: a greedy `$$$` would swallow the
            // closing bracket the rest of the pattern needs.
            let mut end = index;
            loop {
                let text = span_text(tokens, index, end);
                let restore = captures.get(name).cloned();

                let consistent = match captures.get(name) {
                    Some(previous) if name.is_empty() => {
                        let _ = previous;
                        true
                    }
                    Some(previous) => *previous == text,
                    None => true,
                };

                if consistent {
                    if !name.is_empty() {
                        captures.insert(name.clone(), text);
                    }
                    if let Some(final_end) = match_at(rest, tokens, end, captures) {
                        return Some(final_end);
                    }
                    match restore {
                        Some(previous) => {
                            captures.insert(name.clone(), previous);
                        }
                        None => {
                            captures.remove(name);
                        }
                    }
                }

                match balanced_end(tokens, end) {
                    Some(next) if next > end => end = next,
                    _ => return None,
                }
            }
        }
    }
}

/// The index just past one balanced expression starting at `index`.
///
/// A bracket group counts as one expression, which is what makes `f($ARG)`
/// match `f(g(1, 2))` — the argument is a whole call, not the first token of
/// one.
fn balanced_end(tokens: &[Token], index: usize) -> Option<usize> {
    let token = tokens.get(index)?;

    if token.kind != Kind::Open {
        // A closing bracket is not an expression: stopping here is what keeps
        // `$$$` from consuming the `)` its pattern still needs.
        if token.kind == Kind::Close {
            return None;
        }
        return Some(index + 1);
    }

    let mut depth = 0;
    let mut end = index;

    while end < tokens.len() {
        match tokens[end].kind {
            Kind::Open => depth += 1,
            Kind::Close => {
                depth -= 1;
                if depth == 0 {
                    return Some(end + 1);
                }
            }
            _ => {}
        }
        end += 1;
    }

    // Unbalanced source: the group runs to the end.
    Some(tokens.len())
}

fn span_text(tokens: &[Token], start: usize, end: usize) -> String {
    if start >= end {
        return String::new();
    }
    let mut out = String::new();
    for (offset, token) in tokens[start..end].iter().enumerate() {
        if offset > 0 && needs_space(&tokens[start + offset - 1], token) {
            out.push(' ');
        }
        out.push_str(&token.text);
    }
    out
}

/// Whether two adjacent tokens need a space between them when rendered.
///
/// Reconstructed text is shown to a person, so `foo ( a , b )` would be a poor
/// showing of `foo(a, b)`.
fn needs_space(previous: &Token, next: &Token) -> bool {
    /// Words that take a space before a bracket, so `if (x)` does not render
    /// as `if(x)` while `foo(x)` still renders as a call.
    const SPACED_KEYWORDS: &[&str] = &[
        "if", "for", "while", "switch", "catch", "return", "match", "in", "of", "new", "await",
        "yield", "typeof", "instanceof", "delete", "throw", "else", "do", "case", "with",
    ];

    // Nothing sits before a closer or a separator.
    if matches!(next.text.as_str(), "," | ";" | ")" | "]" | ":" | "." | "?" | "!") {
        return false;
    }

    // Nothing sits after an opener or a member access.
    if matches!(previous.text.as_str(), "(" | "[" | ".") {
        return false;
    }

    if matches!(next.text.as_str(), "(" | "[") {
        // A bracket binds tight to what it follows — unless that was a keyword,
        // or a closing bracket that ended a separate expression.
        if previous.kind == Kind::Identifier {
            return SPACED_KEYWORDS.contains(&previous.text.as_str());
        }
        return !matches!(previous.text.as_str(), ")" | "]");
    }

    true
}

/// Replaces every match, substituting captured metavariables into `template`.
pub fn rewrite(source: &str, pattern: &Pattern, template: &str, syntax: &Syntax) -> String {
    let matches = search(source, pattern, syntax);
    if matches.is_empty() {
        return source.to_string();
    }

    let mut out = String::with_capacity(source.len());
    let mut last = 0;

    for hit in &matches {
        out.push_str(&source[last..hit.start]);
        out.push_str(&fill(template, &hit.captures));
        last = hit.end;
    }
    out.push_str(&source[last..]);
    out
}

/// Substitutes `$NAME` in a template from the captures.
fn fill(template: &str, captures: &HashMap<String, String>) -> String {
    let chars: Vec<char> = template.chars().collect();
    let mut out = String::new();
    let mut index = 0;

    while index < chars.len() {
        if chars[index] != '$' {
            out.push(chars[index]);
            index += 1;
            continue;
        }

        let dollars = chars[index..].iter().take_while(|c| **c == '$').count();
        let mut end = index + dollars;
        while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
            end += 1;
        }

        let name: String = chars[index + dollars..end].iter().collect();
        match captures.get(&name) {
            Some(value) => out.push_str(value),
            // An unbound name is left as written rather than dropped: silently
            // deleting it would produce code that looks intentional.
            None => out.extend(&chars[index..end]),
        }
        index = end.max(index + 1);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::TYPESCRIPT;

    fn find(source: &str, pattern: &str) -> Vec<Match> {
        let compiled = compile(pattern, &TYPESCRIPT).unwrap();
        search(source, &compiled, &TYPESCRIPT)
    }

    #[test]
    fn a_literal_pattern_matches_exactly() {
        let hits = find("foo(); bar(); foo();", "foo()");
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn a_metavariable_captures_one_argument() {
        let hits = find("console.log(x); console.log(y);", "console.log($ARG)");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].captures["ARG"], "x");
        assert_eq!(hits[1].captures["ARG"], "y");
    }

    #[test]
    fn a_metavariable_matches_a_whole_bracketed_group() {
        // The distinction that makes this structural rather than textual.
        let hits = find("f(g(1, 2))", "f($ARG)");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].captures["ARG"], "g(1, 2)");
    }

    #[test]
    fn a_variadic_metavariable_matches_any_number_of_arguments() {
        let hits = find("call(); call(a); call(a, b, c);", "call($$$ARGS)");
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].captures["ARGS"], "");
        assert_eq!(hits[2].captures["ARGS"], "a, b, c");
    }

    #[test]
    fn a_repeated_metavariable_must_match_the_same_text() {
        // Finds the tautology and not the ordinary comparison.
        let hits = find("if (a === a) {} if (a === b) {}", "$X === $X");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].captures["X"], "a");
    }

    #[test]
    fn a_pattern_does_not_match_inside_a_string() {
        let hits = find(r#"const message = "console.log(x)"; console.log(y);"#, "console.log($A)");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].captures["A"], "y");
    }

    #[test]
    fn a_pattern_does_not_match_inside_a_comment() {
        let hits = find("// console.log(dead)\nconsole.log(live)", "console.log($A)");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].captures["A"], "live");
    }

    #[test]
    fn matching_ignores_formatting() {
        // The whole reason to match tokens rather than text.
        let hits = find("foo(\n  a,\n  b\n)", "foo($$$ARGS)");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].captures["ARGS"], "a, b");
    }

    #[test]
    fn a_block_body_is_captured() {
        let hits = find("if (ready) { start(); stop(); }", "if ($COND) { $$$BODY }");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].captures["COND"], "ready");
        assert!(hits[0].captures["BODY"].contains("start"));
    }

    #[test]
    fn matches_report_their_line() {
        let hits = find("a();\nb();\nfoo();", "foo()");
        assert_eq!(hits[0].line, 3);
    }

    #[test]
    fn matches_index_back_into_the_source() {
        let source = "before foo(1) after";
        let hits = find(source, "foo($A)");
        assert_eq!(&source[hits[0].start..hits[0].end], "foo(1)");
    }

    #[test]
    fn matches_do_not_overlap() {
        let hits = find("f(f(f(x)))", "f($A)");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].captures["A"], "f(f(x))");
    }

    #[test]
    fn rewriting_substitutes_captures() {
        let compiled = compile("console.log($ARG)", &TYPESCRIPT).unwrap();
        let out = rewrite("console.log(x); console.log(y);", &compiled, "logger.debug($ARG)", &TYPESCRIPT);
        assert_eq!(out, "logger.debug(x); logger.debug(y);");
    }

    #[test]
    fn rewriting_leaves_an_unbound_name_alone() {
        let compiled = compile("foo($A)", &TYPESCRIPT).unwrap();
        let out = rewrite("foo(1)", &compiled, "bar($A, $MISSING)", &TYPESCRIPT);
        assert_eq!(out, "bar(1, $MISSING)");
    }

    #[test]
    fn rewriting_a_file_with_no_matches_returns_it_unchanged() {
        let compiled = compile("nothing($A)", &TYPESCRIPT).unwrap();
        let source = "const x = 1;\n";
        assert_eq!(rewrite(source, &compiled, "x", &TYPESCRIPT), source);
    }

    #[test]
    fn an_empty_pattern_is_rejected() {
        assert!(compile("", &TYPESCRIPT).is_err());
        assert!(compile("   \n  ", &TYPESCRIPT).is_err());
    }

    #[test]
    fn unbalanced_source_does_not_hang() {
        // A file mid-edit is exactly when an agent searches it.
        let hits = find("foo(a, b", "foo($$$ARGS)");
        assert!(hits.len() <= 1);
    }

    #[test]
    fn a_pattern_spanning_a_whole_function_matches() {
        let source = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
        let hits = find(source, "export function $NAME($$$PARAMS): $RET { $$$BODY }");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].captures["NAME"], "add");
        assert_eq!(hits[0].captures["RET"], "number");
        assert!(hits[0].captures["PARAMS"].contains("a: number"));
    }

    #[test]
    fn a_pattern_is_literal_about_what_it_omits() {
        // The return type is part of the source, so a pattern that does not
        // mention it does not match. This is a real constraint, not a bug: a
        // pattern that skipped arbitrary tokens would match almost anything.
        let source = "export function add(a: number): number { return a; }";
        assert!(find(source, "export function $NAME($$$P) { $$$B }").is_empty());
    }
}
