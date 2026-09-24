//! Tokenizer for the shell language (architecture §8.1).
//!
//! Quoting is the whole job. Nearly every shell bug an agent hits is a quoting
//! bug: a path with a space torn into two arguments, a `$` inside single quotes
//! expanded anyway, a backslash eaten by one layer too many. So the tokenizer
//! records, per token, which parts were quoted and how — that information has to
//! survive into expansion, because `"$x"` and `$x` differ only in that.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    /// A word, with its quoting recorded piece by piece.
    Word(Word),
    /// `|`
    Pipe,
    /// `||`
    Or,
    /// `&&`
    And,
    /// `;`
    Semicolon,
    /// `&` — run the preceding command in the background.
    Background,
    /// `<`
    RedirectIn,
    /// `>`
    RedirectOut,
    /// `>>`
    RedirectAppend,
    /// `2>`
    RedirectErr,
    /// `2>&1`
    MergeErr,
    /// `<<` with its delimiter.
    Heredoc(String),
    /// `(`
    OpenParen,
    /// `)`
    CloseParen,
    /// `{`
    OpenBrace,
    /// `}`
    CloseBrace,
    /// A newline, which terminates a command like `;` does.
    Newline,
}

/// A word as a sequence of differently-quoted pieces.
///
/// `pre"fix"$var` is three pieces, and only the third expands.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Word {
    pub pieces: Vec<Piece>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    /// Unquoted: expands, splits on whitespace, and globs.
    Bare(String),
    /// Double-quoted: expands, but does not split or glob.
    Quoted(String),
    /// Single-quoted: entirely literal.
    Literal(String),
    /// `$(...)` or backticks.
    Command(String),
    /// `$((...))`
    Arithmetic(String),
}

impl Word {
    pub fn bare(text: impl Into<String>) -> Self {
        Word { pieces: vec![Piece::Bare(text.into())] }
    }

    /// The word with no expansion applied — what it looks like literally.
    pub fn as_literal(&self) -> String {
        self.pieces
            .iter()
            .map(|piece| match piece {
                Piece::Bare(text) | Piece::Quoted(text) | Piece::Literal(text) => text.clone(),
                Piece::Command(text) => format!("$({text})"),
                Piece::Arithmetic(text) => format!("$(({text}))"),
            })
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.pieces.is_empty()
    }
}

pub struct Lexer {
    chars: Vec<char>,
    position: usize,
}

/// Tokenizes a shell command line.
pub fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    Lexer { chars: input.chars().collect(), position: 0 }.run()
}

impl Lexer {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.position).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.position + offset).copied()
    }

    fn run(&mut self) -> Result<Vec<Token>, String> {
        let mut tokens = Vec::new();

        while let Some(c) = self.peek() {
            // Blank space between tokens, but not a newline, which is a token.
            if c == ' ' || c == '\t' || c == '\r' {
                self.position += 1;
                continue;
            }

            if c == '\n' {
                self.position += 1;
                tokens.push(Token::Newline);
                continue;
            }

            // A comment runs to the end of the line — but only when `#` starts a
            // word. `foo#bar` and `#!/bin/sh` inside a word are not comments.
            if c == '#' && self.at_word_start(&tokens) {
                while matches!(self.peek(), Some(c) if c != '\n') {
                    self.position += 1;
                }
                continue;
            }

            if let Some(token) = self.operator()? {
                tokens.push(token);
                continue;
            }

            let word = self.word()?;
            // A word can come out empty — `ls \<newline> -la` consumes the
            // continuation and produces nothing. Pushing it would give the
            // parser a phantom argument.
            if !word.is_empty() {
                tokens.push(Token::Word(word));
            }
        }

        Ok(tokens)
    }

    /// Whether the lexer is positioned where a new word would start.
    fn at_word_start(&self, tokens: &[Token]) -> bool {
        // A `#` right after another word is part of that word, since the
        // previous character was not whitespace.
        match self.position {
            0 => true,
            position => {
                let previous = self.chars[position - 1];
                previous.is_whitespace() || matches!(tokens.last(), None | Some(Token::Newline))
            }
        }
    }

    fn operator(&mut self) -> Result<Option<Token>, String> {
        let c = self.peek().unwrap();

        // Two-character operators first: `&` would otherwise consume the `&` of
        // `&&`, and `>` the `>` of `>>`.
        let two: Option<Token> = match (c, self.peek_at(1)) {
            ('|', Some('|')) => Some(Token::Or),
            ('&', Some('&')) => Some(Token::And),
            ('>', Some('>')) => Some(Token::RedirectAppend),
            ('2', Some('>')) => {
                // `2>&1` is three more characters; `2>` is two.
                if self.peek_at(2) == Some('&') && self.peek_at(3) == Some('1') {
                    self.position += 4;
                    return Ok(Some(Token::MergeErr));
                }
                Some(Token::RedirectErr)
            }
            ('<', Some('<')) => {
                self.position += 2;
                let delimiter = self.heredoc_delimiter();
                return Ok(Some(Token::Heredoc(delimiter)));
            }
            _ => None,
        };

        if let Some(token) = two {
            self.position += 2;
            return Ok(Some(token));
        }

        let one = match c {
            '|' => Token::Pipe,
            ';' => Token::Semicolon,
            '&' => Token::Background,
            '<' => Token::RedirectIn,
            '>' => Token::RedirectOut,
            '(' => Token::OpenParen,
            ')' => Token::CloseParen,
            _ => return Ok(None),
        };

        self.position += 1;
        Ok(Some(one))
    }

    fn heredoc_delimiter(&mut self) -> String {
        while matches!(self.peek(), Some(' ') | Some('\t')) {
            self.position += 1;
        }
        let mut delimiter = String::new();
        while let Some(c) = self.peek() {
            if c.is_whitespace() {
                break;
            }
            // A quoted delimiter (`<<'EOF'`) means the body is literal; the
            // quotes are stripped here and the parser decides what that means.
            if c != '\'' && c != '"' {
                delimiter.push(c);
            }
            self.position += 1;
        }
        delimiter
    }

    fn word(&mut self) -> Result<Word, String> {
        let mut pieces: Vec<Piece> = Vec::new();
        let mut current = String::new();

        macro_rules! flush {
            () => {
                if !current.is_empty() {
                    pieces.push(Piece::Bare(std::mem::take(&mut current)));
                }
            };
        }

        while let Some(c) = self.peek() {
            match c {
                // Whitespace and operators end the word.
                ' ' | '\t' | '\r' | '\n' | '|' | ';' | '&' | '<' | '>' | '(' | ')' => break,

                '\'' => {
                    flush!();
                    self.position += 1;
                    let mut literal = String::new();
                    loop {
                        match self.peek() {
                            Some('\'') => {
                                self.position += 1;
                                break;
                            }
                            // Nothing escapes inside single quotes, not even a
                            // backslash. That is the guarantee they exist for.
                            Some(c) => {
                                literal.push(c);
                                self.position += 1;
                            }
                            None => return Err("unterminated single quote".to_string()),
                        }
                    }
                    pieces.push(Piece::Literal(literal));
                }

                '"' => {
                    flush!();
                    self.position += 1;
                    let mut quoted = String::new();
                    loop {
                        match self.peek() {
                            Some('"') => {
                                self.position += 1;
                                break;
                            }
                            Some('\\') => {
                                self.position += 1;
                                // Inside double quotes a backslash only escapes
                                // these four; before anything else it stays.
                                match self.peek() {
                                    Some(next @ ('"' | '\\' | '$' | '`')) => {
                                        quoted.push(next);
                                        self.position += 1;
                                    }
                                    Some(next) => {
                                        quoted.push('\\');
                                        quoted.push(next);
                                        self.position += 1;
                                    }
                                    None => return Err("unterminated double quote".to_string()),
                                }
                            }
                            Some('$') if self.peek_at(1) == Some('(') => {
                                // A substitution inside quotes still runs, but
                                // its output must not be split into words.
                                if !quoted.is_empty() {
                                    pieces.push(Piece::Quoted(std::mem::take(&mut quoted)));
                                }
                                pieces.push(self.substitution()?);
                            }
                            Some(c) => {
                                quoted.push(c);
                                self.position += 1;
                            }
                            None => return Err("unterminated double quote".to_string()),
                        }
                    }
                    pieces.push(Piece::Quoted(quoted));
                }

                '$' if self.peek_at(1) == Some('(') => {
                    flush!();
                    pieces.push(self.substitution()?);
                }

                '`' => {
                    flush!();
                    self.position += 1;
                    let mut command = String::new();
                    loop {
                        match self.peek() {
                            Some('`') => {
                                self.position += 1;
                                break;
                            }
                            Some(c) => {
                                command.push(c);
                                self.position += 1;
                            }
                            None => return Err("unterminated backtick".to_string()),
                        }
                    }
                    pieces.push(Piece::Command(command));
                }

                '\\' => {
                    self.position += 1;
                    match self.peek() {
                        // A backslash-newline is a line continuation and
                        // disappears entirely.
                        Some('\n') => self.position += 1,
                        Some(next) => {
                            // The escaped character becomes literal, so it must
                            // not be re-expanded or re-globbed later.
                            flush!();
                            pieces.push(Piece::Literal(next.to_string()));
                            self.position += 1;
                        }
                        None => return Err("command ends with a backslash".to_string()),
                    }
                }

                c => {
                    current.push(c);
                    self.position += 1;
                }
            }
        }

        flush!();
        Ok(Word { pieces })
    }

    /// Reads `$(...)` or `$((...))` with the `$` current.
    fn substitution(&mut self) -> Result<Piece, String> {
        self.position += 2; // `$(`

        let arithmetic = self.peek() == Some('(');
        if arithmetic {
            self.position += 1;
        }

        let mut body = String::new();
        let mut depth = 1;

        while let Some(c) = self.peek() {
            match c {
                '(' => {
                    depth += 1;
                    body.push(c);
                }
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        self.position += 1;
                        if arithmetic {
                            // `$((...))` closes with two parens.
                            if self.peek() != Some(')') {
                                return Err("expected `))`".to_string());
                            }
                            self.position += 1;
                            return Ok(Piece::Arithmetic(body));
                        }
                        return Ok(Piece::Command(body));
                    }
                    body.push(c);
                }
                c => body.push(c),
            }
            self.position += 1;
        }

        Err("unterminated command substitution".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(input: &str) -> Vec<String> {
        tokenize(input)
            .unwrap()
            .into_iter()
            .filter_map(|token| match token {
                Token::Word(word) => Some(word.as_literal()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn splits_on_whitespace() {
        assert_eq!(words("ls -la src"), vec!["ls", "-la", "src"]);
    }

    #[test]
    fn quotes_keep_a_path_with_spaces_together() {
        // The single most common shell bug an agent produces.
        assert_eq!(words(r#"cat "my file.txt""#), vec!["cat", "my file.txt"]);
        assert_eq!(words("cat 'my file.txt'"), vec!["cat", "my file.txt"]);
    }

    #[test]
    fn single_quotes_are_entirely_literal() {
        let tokens = tokenize(r"echo '$HOME \n'").unwrap();
        match &tokens[1] {
            Token::Word(word) => {
                assert_eq!(word.pieces, vec![Piece::Literal(r"$HOME \n".to_string())]);
            }
            other => panic!("expected a word, got {other:?}"),
        }
    }

    #[test]
    fn double_quotes_escape_only_four_characters() {
        let tokens = tokenize(r#"echo "a\"b\\c\nd""#).unwrap();
        match &tokens[1] {
            // `\n` stays as backslash-n: the shell does not interpret it, and a
            // tokenizer that does breaks every regex passed through a command.
            Token::Word(word) => {
                let literal = word.as_literal();
                // `\"` and `\\` collapse; `\n` does not.
                assert!(literal.starts_with("a\"b"), "{literal}");
                assert!(literal.ends_with("c\\nd"), "{literal}");
            }
            other => panic!("expected a word, got {other:?}"),
        }
    }

    #[test]
    fn adjacent_pieces_form_one_word() {
        let tokens = tokenize(r#"pre"fix"post"#).unwrap();
        match &tokens[0] {
            Token::Word(word) => {
                assert_eq!(word.pieces.len(), 3);
                assert_eq!(word.as_literal(), "prefixpost");
            }
            other => panic!("expected a word, got {other:?}"),
        }
    }

    #[test]
    fn operators_are_distinguished_from_their_prefixes() {
        assert_eq!(tokenize("a && b").unwrap()[1], Token::And);
        assert_eq!(tokenize("a & b").unwrap()[1], Token::Background);
        assert_eq!(tokenize("a || b").unwrap()[1], Token::Or);
        assert_eq!(tokenize("a | b").unwrap()[1], Token::Pipe);
        assert_eq!(tokenize("a > b").unwrap()[1], Token::RedirectOut);
        assert_eq!(tokenize("a >> b").unwrap()[1], Token::RedirectAppend);
        assert_eq!(tokenize("a 2> b").unwrap()[1], Token::RedirectErr);
        assert_eq!(tokenize("a 2>&1").unwrap()[1], Token::MergeErr);
    }

    #[test]
    fn command_substitution_is_captured_whole() {
        let tokens = tokenize("echo $(ls -la | wc -l)").unwrap();
        match &tokens[1] {
            Token::Word(word) => {
                assert_eq!(word.pieces, vec![Piece::Command("ls -la | wc -l".to_string())]);
            }
            other => panic!("expected a word, got {other:?}"),
        }
    }

    #[test]
    fn nested_substitution_parens_balance() {
        let tokens = tokenize("echo $(echo $(echo x))").unwrap();
        match &tokens[1] {
            Token::Word(word) => {
                assert_eq!(word.pieces, vec![Piece::Command("echo $(echo x)".to_string())]);
            }
            other => panic!("expected a word, got {other:?}"),
        }
    }

    #[test]
    fn arithmetic_is_not_mistaken_for_a_subshell() {
        let tokens = tokenize("echo $((1 + 2))").unwrap();
        match &tokens[1] {
            Token::Word(word) => {
                assert_eq!(word.pieces, vec![Piece::Arithmetic("1 + 2".to_string())]);
            }
            other => panic!("expected a word, got {other:?}"),
        }
    }

    #[test]
    fn a_comment_only_counts_at_a_word_boundary() {
        assert_eq!(words("ls # a comment"), vec!["ls"]);
        // `#` mid-word is part of the word: a URL fragment, a colour, an anchor.
        assert_eq!(words("echo a#b"), vec!["echo", "a#b"]);
    }

    #[test]
    fn a_line_continuation_disappears() {
        assert_eq!(words("ls \\\n  -la"), vec!["ls", "-la"]);
    }

    #[test]
    fn an_escaped_character_becomes_literal() {
        let tokens = tokenize(r"echo \$HOME").unwrap();
        match &tokens[1] {
            Token::Word(word) => {
                // The `$` must be Literal, or expansion would still see it.
                assert!(word.pieces.contains(&Piece::Literal("$".to_string())));
            }
            other => panic!("expected a word, got {other:?}"),
        }
    }

    #[test]
    fn heredocs_record_their_delimiter() {
        assert_eq!(tokenize("cat << EOF").unwrap()[1], Token::Heredoc("EOF".to_string()));
        assert_eq!(tokenize("cat <<'EOF'").unwrap()[1], Token::Heredoc("EOF".to_string()));
    }

    #[test]
    fn unterminated_quotes_are_an_error() {
        assert!(tokenize(r#"echo "unclosed"#).is_err());
        assert!(tokenize("echo 'unclosed").is_err());
        assert!(tokenize("echo $(unclosed").is_err());
        assert!(tokenize(r"echo \").is_err());
    }

    #[test]
    fn newlines_separate_commands() {
        let tokens = tokenize("a\nb").unwrap();
        assert_eq!(tokens[1], Token::Newline);
    }
}
