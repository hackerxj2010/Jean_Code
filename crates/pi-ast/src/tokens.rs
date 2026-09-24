//! A source tokenizer shared by every language this crate handles.
//!
//! Structural search does not need a full parser. What it needs is to know
//! where strings, comments, and brackets are, so that a pattern matches code
//! rather than text: `foo(` inside a comment is not a call, and a `}` inside a
//! string does not close a block. That distinction is most of the value, and it
//! costs one tokenizer instead of one parser per language.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Identifier,
    Number,
    /// Any string or character literal, including template literals.
    Str,
    Comment,
    /// One of `([{`
    Open,
    /// One of `)]}`
    Close,
    /// Everything else: operators, separators.
    Punctuation,
    /// A newline, kept because indentation-sensitive languages need it.
    Newline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: Kind,
    pub text: String,
    /// Byte offset into the source.
    pub start: usize,
    pub end: usize,
    /// 1-based line number, for reporting.
    pub line: usize,
    /// Column of the first character, in characters not bytes.
    pub column: usize,
}

impl Token {
    pub fn is_trivia(&self) -> bool {
        matches!(self.kind, Kind::Comment | Kind::Newline)
    }

    /// The bracket this token closes, if it is an opener.
    pub fn closer(&self) -> Option<&'static str> {
        match self.text.as_str() {
            "(" => Some(")"),
            "[" => Some("]"),
            "{" => Some("}"),
            _ => None,
        }
    }
}

/// How one language differs from the others.
#[derive(Debug, Clone)]
pub struct Syntax {
    pub name: &'static str,
    /// Comment markers that run to the end of the line.
    pub line_comments: &'static [&'static str],
    /// Paired block-comment markers.
    pub block_comments: &'static [(&'static str, &'static str)],
    /// Quote characters that open a string.
    pub quotes: &'static [char],
    /// Whether a backslash escapes inside a string. False for languages where
    /// it does not, so a Windows path in a raw string is not mis-scanned.
    pub backslash_escapes: bool,
    /// Whether nested block comments are allowed. Rust says yes, C says no, and
    /// getting it wrong truncates a file at the first inner `*/`.
    pub nested_block_comments: bool,
    /// Characters that may appear inside an identifier beyond alphanumerics.
    pub identifier_extra: &'static [char],
}

pub const RUST: Syntax = Syntax {
    name: "rust",
    line_comments: &["//"],
    block_comments: &[("/*", "*/")],
    quotes: &['"', '\''],
    backslash_escapes: true,
    nested_block_comments: true,
    identifier_extra: &['_'],
};

pub const TYPESCRIPT: Syntax = Syntax {
    name: "typescript",
    line_comments: &["//"],
    block_comments: &[("/*", "*/")],
    quotes: &['"', '\'', '`'],
    backslash_escapes: true,
    nested_block_comments: false,
    identifier_extra: &['_', '$'],
};

pub const PYTHON: Syntax = Syntax {
    name: "python",
    line_comments: &["#"],
    // Triple-quoted strings are handled by the quote scanner, not as comments:
    // treating a docstring as a comment loses it from the token stream, and
    // patterns that match on docstrings then fail.
    block_comments: &[],
    quotes: &['"', '\''],
    backslash_escapes: true,
    nested_block_comments: false,
    identifier_extra: &['_'],
};

pub const GO: Syntax = Syntax {
    name: "go",
    line_comments: &["//"],
    block_comments: &[("/*", "*/")],
    quotes: &['"', '\'', '`'],
    backslash_escapes: true,
    nested_block_comments: false,
    identifier_extra: &['_'],
};

pub const SHELL: Syntax = Syntax {
    name: "shell",
    line_comments: &["#"],
    block_comments: &[],
    quotes: &['"', '\''],
    backslash_escapes: true,
    nested_block_comments: false,
    identifier_extra: &['_'],
};

pub const JSON: Syntax = Syntax {
    name: "json",
    line_comments: &[],
    block_comments: &[],
    quotes: &['"'],
    backslash_escapes: true,
    nested_block_comments: false,
    identifier_extra: &['_'],
};

/// Every syntax this crate knows, for lookup by name or extension.
pub const SYNTAXES: &[Syntax] = &[RUST, TYPESCRIPT, PYTHON, GO, SHELL, JSON];

/// Picks a syntax from a file extension.
pub fn syntax_for(path: &str) -> Syntax {
    let extension = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match extension.as_str() {
        "rs" => RUST,
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "java" | "c" | "h" | "cpp" | "hpp"
        | "cs" | "swift" | "kt" | "scala" | "php" => TYPESCRIPT,
        "py" | "pyi" => PYTHON,
        "go" => GO,
        "sh" | "bash" | "zsh" => SHELL,
        "json" => JSON,
        // An unknown extension gets the C-family rules, which are the most
        // common and degrade gracefully: at worst a `#` comment is tokenized
        // as punctuation.
        _ => TYPESCRIPT,
    }
}

/// Tokenizes source.
pub fn tokenize(source: &str, syntax: &Syntax) -> Vec<Token> {
    let chars: Vec<char> = source.chars().collect();
    // Byte offsets per character index, so tokens can carry real byte spans.
    let mut offsets: Vec<usize> = Vec::with_capacity(chars.len() + 1);
    let mut running = 0;
    for c in &chars {
        offsets.push(running);
        running += c.len_utf8();
    }
    offsets.push(running);

    let mut tokens = Vec::new();
    let mut index = 0;
    let mut line = 1;
    let mut line_start = 0;

    while index < chars.len() {
        let c = chars[index];
        let column = index - line_start + 1;

        if c == '\n' {
            tokens.push(Token {
                kind: Kind::Newline,
                text: "\n".to_string(),
                start: offsets[index],
                end: offsets[index + 1],
                line,
                column,
            });
            index += 1;
            line += 1;
            line_start = index;
            continue;
        }

        if c.is_whitespace() {
            index += 1;
            continue;
        }

        // Comments before operators: `//` must not tokenize as two slashes.
        if let Some(end) = line_comment_end(&chars, index, syntax) {
            push(&mut tokens, Kind::Comment, &chars, index, end, &offsets, line, column);
            index = end;
            continue;
        }

        if let Some((end, lines)) = block_comment_end(&chars, index, syntax) {
            push(&mut tokens, Kind::Comment, &chars, index, end, &offsets, line, column);
            index = end;
            line += lines;
            continue;
        }

        if syntax.quotes.contains(&c) {
            let (end, lines) = string_end(&chars, index, syntax);
            push(&mut tokens, Kind::Str, &chars, index, end, &offsets, line, column);
            index = end;
            line += lines;
            continue;
        }

        if c.is_ascii_digit() {
            let mut end = index;
            while end < chars.len()
                && (chars[end].is_alphanumeric() || chars[end] == '.' || chars[end] == '_')
            {
                end += 1;
            }
            push(&mut tokens, Kind::Number, &chars, index, end, &offsets, line, column);
            index = end;
            continue;
        }

        if c.is_alphabetic() || syntax.identifier_extra.contains(&c) {
            let mut end = index;
            while end < chars.len()
                && (chars[end].is_alphanumeric() || syntax.identifier_extra.contains(&chars[end]))
            {
                end += 1;
            }
            push(&mut tokens, Kind::Identifier, &chars, index, end, &offsets, line, column);
            index = end;
            continue;
        }

        let kind = match c {
            '(' | '[' | '{' => Kind::Open,
            ')' | ']' | '}' => Kind::Close,
            _ => Kind::Punctuation,
        };

        // Multi-character operators are kept whole so a pattern can match `=>`
        // or `===` without also matching `=` `=` `=`.
        let end = if kind == Kind::Punctuation {
            operator_end(&chars, index)
        } else {
            index + 1
        };

        push(&mut tokens, kind, &chars, index, end, &offsets, line, column);
        index = end;
    }

    tokens
}

#[allow(clippy::too_many_arguments)]
fn push(
    tokens: &mut Vec<Token>,
    kind: Kind,
    chars: &[char],
    start: usize,
    end: usize,
    offsets: &[usize],
    line: usize,
    column: usize,
) {
    tokens.push(Token {
        kind,
        text: chars[start..end].iter().collect(),
        start: offsets[start],
        end: offsets[end],
        line,
        column,
    });
}

fn line_comment_end(chars: &[char], index: usize, syntax: &Syntax) -> Option<usize> {
    for marker in syntax.line_comments {
        if starts_with(chars, index, marker) {
            let mut end = index;
            while end < chars.len() && chars[end] != '\n' {
                end += 1;
            }
            return Some(end);
        }
    }
    None
}

fn block_comment_end(chars: &[char], index: usize, syntax: &Syntax) -> Option<(usize, usize)> {
    for (open, close) in syntax.block_comments {
        if !starts_with(chars, index, open) {
            continue;
        }

        let mut end = index + open.chars().count();
        let mut depth = 1;
        let mut lines = 0;

        while end < chars.len() {
            if chars[end] == '\n' {
                lines += 1;
            }
            if syntax.nested_block_comments && starts_with(chars, end, open) {
                depth += 1;
                end += open.chars().count();
                continue;
            }
            if starts_with(chars, end, close) {
                depth -= 1;
                end += close.chars().count();
                if depth == 0 {
                    return Some((end, lines));
                }
                continue;
            }
            end += 1;
        }
        // An unterminated comment runs to the end of the file, which is what
        // every compiler reports too.
        return Some((chars.len(), lines));
    }
    None
}

fn string_end(chars: &[char], index: usize, syntax: &Syntax) -> (usize, usize) {
    let quote = chars[index];

    // A triple quote opens a multi-line string in Python and is the one case
    // where the closing delimiter is longer than one character.
    let triple = chars.get(index + 1) == Some(&quote) && chars.get(index + 2) == Some(&quote);
    let delimiter_length = if triple { 3 } else { 1 };

    let mut end = index + delimiter_length;
    let mut lines = 0;

    while end < chars.len() {
        let c = chars[end];

        if c == '\n' {
            lines += 1;
            // A single-quoted string does not span lines in most languages; if
            // one does, the file was already malformed and stopping here keeps
            // the damage to one line instead of the rest of the file.
            if !triple && quote != '`' {
                return (end, lines);
            }
        }

        if syntax.backslash_escapes && c == '\\' {
            end += 2;
            continue;
        }

        if c == quote {
            if !triple {
                return (end + 1, lines);
            }
            if chars.get(end + 1) == Some(&quote) && chars.get(end + 2) == Some(&quote) {
                return (end + 3, lines);
            }
        }

        end += 1;
    }

    (chars.len(), lines)
}

/// Greedily matches the longest known operator.
fn operator_end(chars: &[char], index: usize) -> usize {
    const OPERATORS: &[&str] = &[
        "<<=", ">>=", "===", "!==", "**=", "...", "&&=", "||=", "??=", "<=>", "->>",
        "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "=>", "->", "::", "++", "--", "+=", "-=",
        "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**", "..",
    ];

    for operator in OPERATORS {
        if starts_with(chars, index, operator) {
            return index + operator.chars().count();
        }
    }
    index + 1
}

fn starts_with(chars: &[char], index: usize, needle: &str) -> bool {
    let needle: Vec<char> = needle.chars().collect();
    if index + needle.len() > chars.len() {
        return false;
    }
    chars[index..index + needle.len()] == needle[..]
}

/// The tokens with comments and newlines removed, which is what pattern
/// matching runs against.
pub fn significant(tokens: &[Token]) -> Vec<Token> {
    tokens.iter().filter(|token| !token.is_trivia()).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(source: &str, syntax: &Syntax) -> Vec<(Kind, String)> {
        tokenize(source, syntax)
            .into_iter()
            .filter(|token| token.kind != Kind::Newline)
            .map(|token| (token.kind, token.text))
            .collect()
    }

    #[test]
    fn identifiers_numbers_and_punctuation() {
        let tokens = kinds("let x = 42;", &TYPESCRIPT);
        assert_eq!(tokens[0], (Kind::Identifier, "let".to_string()));
        assert_eq!(tokens[1], (Kind::Identifier, "x".to_string()));
        assert_eq!(tokens[2], (Kind::Punctuation, "=".to_string()));
        assert_eq!(tokens[3], (Kind::Number, "42".to_string()));
    }

    #[test]
    fn a_brace_inside_a_string_is_not_a_bracket() {
        // The bug this prevents: a structural search treating `"}"` as closing
        // the enclosing block, and every match after it landing in the wrong
        // scope.
        let tokens = kinds(r#"const x = "}"; y"#, &TYPESCRIPT);
        assert!(tokens.iter().all(|(kind, text)| *kind != Kind::Close || text != "}"));
    }

    #[test]
    fn a_call_inside_a_comment_is_not_code() {
        let tokens = kinds("// foo(bar)\nbaz()", &TYPESCRIPT);
        let identifiers: Vec<&String> = tokens
            .iter()
            .filter(|(kind, _)| *kind == Kind::Identifier)
            .map(|(_, text)| text)
            .collect();
        assert_eq!(identifiers, vec!["baz"]);
    }

    #[test]
    fn escapes_do_not_end_a_string_early() {
        let tokens = kinds(r#"x = "a\"b"; y"#, &TYPESCRIPT);
        let strings: Vec<&String> = tokens
            .iter()
            .filter(|(kind, _)| *kind == Kind::Str)
            .map(|(_, text)| text)
            .collect();
        assert_eq!(strings.len(), 1);
        assert!(strings[0].contains(r#"\""#));
    }

    #[test]
    fn rust_block_comments_nest_and_c_ones_do_not() {
        // `/* /* */ */` is one comment in Rust and two tokens plus junk in C.
        let rust = kinds("/* outer /* inner */ still */ x", &RUST);
        assert_eq!(rust.len(), 2);
        assert_eq!(rust[1], (Kind::Identifier, "x".to_string()));

        let c_like = kinds("/* outer /* inner */ still */ x", &TYPESCRIPT);
        assert!(c_like.len() > 2, "{c_like:?}");
    }

    #[test]
    fn python_docstrings_are_strings_not_comments() {
        let tokens = kinds("def f():\n    \"\"\"Docs.\"\"\"\n    return 1", &PYTHON);
        assert!(tokens.iter().any(|(kind, text)| *kind == Kind::Str && text.contains("Docs")));
    }

    #[test]
    fn template_literals_span_lines() {
        let tokens = kinds("const x = `line one\nline two`;", &TYPESCRIPT);
        let strings: Vec<&String> = tokens
            .iter()
            .filter(|(kind, _)| *kind == Kind::Str)
            .map(|(_, text)| text)
            .collect();
        assert_eq!(strings.len(), 1);
        assert!(strings[0].contains('\n'));
    }

    #[test]
    fn multi_character_operators_stay_whole() {
        let tokens = kinds("a === b => c", &TYPESCRIPT);
        assert!(tokens.iter().any(|(_, text)| text == "==="));
        assert!(tokens.iter().any(|(_, text)| text == "=>"));
    }

    #[test]
    fn byte_offsets_index_back_into_the_source() {
        let source = "let name = value;";
        for token in tokenize(source, &TYPESCRIPT) {
            assert_eq!(&source[token.start..token.end], token.text);
        }
    }

    #[test]
    fn offsets_survive_non_ascii() {
        // A char-index-as-byte-offset bug shows up only here.
        let source = "const emoji = \"héllo 😀\"; x";
        for token in tokenize(source, &TYPESCRIPT) {
            assert_eq!(&source[token.start..token.end], token.text);
        }
    }

    #[test]
    fn line_numbers_count_through_block_comments() {
        let tokens = tokenize("a\n/* one\ntwo */\nb", &TYPESCRIPT);
        let last = tokens.iter().rev().find(|t| t.kind == Kind::Identifier).unwrap();
        assert_eq!(last.text, "b");
        assert_eq!(last.line, 4);
    }

    #[test]
    fn an_unterminated_string_does_not_eat_the_file() {
        let tokens = kinds("x = \"unterminated\ny = 1", &TYPESCRIPT);
        // `y` must still be visible on the next line.
        assert!(tokens.iter().any(|(kind, text)| *kind == Kind::Identifier && text == "y"));
    }

    #[test]
    fn syntax_is_chosen_by_extension() {
        assert_eq!(syntax_for("src/main.rs").name, "rust");
        assert_eq!(syntax_for("app/index.tsx").name, "typescript");
        assert_eq!(syntax_for("script.py").name, "python");
        assert_eq!(syntax_for("main.go").name, "go");
        assert_eq!(syntax_for("Makefile").name, "typescript");
    }
}
