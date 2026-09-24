//! Turns tokens into a command tree.
//!
//! The grammar, loosest to tightest:
//!
//! ```text
//! list      := andor (( ';' | '&' | newline ) andor)*
//! andor     := pipeline (( '&&' | '||' ) pipeline)*
//! pipeline  := command ('|' command)*
//! command   := assignment* word* redirect*
//! ```
//!
//! Precedence matters more than it looks: `a && b | c` is `a && (b | c)`, and
//! getting it backwards silently changes what runs.

use crate::lexer::{Token, Word};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    /// A single command with its arguments and redirections.
    Command(Command),
    /// `left | right`
    Pipeline(Vec<Command>),
    /// `left && right`
    And(Box<Node>, Box<Node>),
    /// `left || right`
    Or(Box<Node>, Box<Node>),
    /// `left ; right`
    Sequence(Box<Node>, Box<Node>),
    /// `command &`
    Background(Box<Node>),
    /// `( ... )` — runs with a copy of the environment.
    Subshell(Box<Node>),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Command {
    /// `VAR=value` prefixes, which apply only to this command.
    pub assignments: Vec<(String, Word)>,
    pub words: Vec<Word>,
    pub redirects: Vec<Redirect>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Redirect {
    In(Word),
    Out(Word),
    Append(Word),
    Err(Word),
    /// `2>&1`
    MergeErr,
    /// `<<DELIM` — the body is filled in by the caller, which owns the input.
    Heredoc { delimiter: String, body: String },
}

impl Command {
    /// The command name, before expansion.
    pub fn name(&self) -> Option<String> {
        self.words.first().map(Word::as_literal)
    }

    /// A command with no words but with assignments is `VAR=value` on its own,
    /// which sets the variable in the current shell rather than running
    /// anything.
    pub fn is_assignment_only(&self) -> bool {
        self.words.is_empty() && !self.assignments.is_empty()
    }
}

pub fn parse(tokens: &[Token]) -> Result<Option<Node>, String> {
    let mut parser = Parser { tokens, position: 0 };
    let node = parser.list()?;
    if parser.position < tokens.len() {
        return Err(format!("unexpected {:?}", tokens[parser.position]));
    }
    Ok(node)
}

struct Parser<'a> {
    tokens: &'a [Token],
    position: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&'a Token> {
        self.tokens.get(self.position)
    }

    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Some(Token::Newline)) {
            self.position += 1;
        }
    }

    fn list(&mut self) -> Result<Option<Node>, String> {
        self.skip_newlines();
        if self.peek().is_none() {
            return Ok(None);
        }

        let mut left = self.and_or()?;

        loop {
            match self.peek() {
                Some(Token::Semicolon) | Some(Token::Newline) => {
                    self.position += 1;
                    self.skip_newlines();
                    // A trailing separator is not an error, so a line ending in
                    // `;` parses.
                    if self.peek().is_none() || matches!(self.peek(), Some(Token::CloseParen)) {
                        return Ok(Some(left));
                    }
                    let right = self.and_or()?;
                    left = Node::Sequence(Box::new(left), Box::new(right));
                }
                Some(Token::Background) => {
                    self.position += 1;
                    left = Node::Background(Box::new(left));
                    self.skip_newlines();
                    if self.peek().is_none() || matches!(self.peek(), Some(Token::CloseParen)) {
                        return Ok(Some(left));
                    }
                    let right = self.and_or()?;
                    left = Node::Sequence(Box::new(left), Box::new(right));
                }
                _ => return Ok(Some(left)),
            }
        }
    }

    fn and_or(&mut self) -> Result<Node, String> {
        let mut left = self.pipeline()?;

        loop {
            let combine = match self.peek() {
                Some(Token::And) => true,
                Some(Token::Or) => false,
                _ => return Ok(left),
            };
            self.position += 1;
            self.skip_newlines();

            let right = self.pipeline()?;
            left = if combine {
                Node::And(Box::new(left), Box::new(right))
            } else {
                Node::Or(Box::new(left), Box::new(right))
            };
        }
    }

    fn pipeline(&mut self) -> Result<Node, String> {
        // A subshell is a whole node, not a command, so it cannot join a
        // pipeline of plain commands without wrapping.
        if matches!(self.peek(), Some(Token::OpenParen)) {
            self.position += 1;
            let inner = self.list()?.ok_or("empty subshell")?;
            if !matches!(self.peek(), Some(Token::CloseParen)) {
                return Err("unclosed `(`".to_string());
            }
            self.position += 1;
            return Ok(Node::Subshell(Box::new(inner)));
        }

        let mut commands = vec![self.command()?];

        while matches!(self.peek(), Some(Token::Pipe)) {
            self.position += 1;
            self.skip_newlines();
            commands.push(self.command()?);
        }

        Ok(if commands.len() == 1 {
            Node::Command(commands.pop().unwrap())
        } else {
            Node::Pipeline(commands)
        })
    }

    fn command(&mut self) -> Result<Command, String> {
        let mut command = Command::default();

        loop {
            match self.peek() {
                Some(Token::Word(word)) => {
                    self.position += 1;

                    // `VAR=value` counts as an assignment only before the first
                    // word: `env FOO=bar` passes it as an argument instead.
                    if command.words.is_empty() {
                        if let Some((name, value)) = as_assignment(word) {
                            command.assignments.push((name, value));
                            continue;
                        }
                    }
                    command.words.push(word.clone());
                }

                Some(Token::RedirectIn) => {
                    self.position += 1;
                    command.redirects.push(Redirect::In(self.redirect_target()?));
                }
                Some(Token::RedirectOut) => {
                    self.position += 1;
                    command.redirects.push(Redirect::Out(self.redirect_target()?));
                }
                Some(Token::RedirectAppend) => {
                    self.position += 1;
                    command.redirects.push(Redirect::Append(self.redirect_target()?));
                }
                Some(Token::RedirectErr) => {
                    self.position += 1;
                    command.redirects.push(Redirect::Err(self.redirect_target()?));
                }
                Some(Token::MergeErr) => {
                    self.position += 1;
                    command.redirects.push(Redirect::MergeErr);
                }
                Some(Token::Heredoc(delimiter)) => {
                    self.position += 1;
                    command.redirects.push(Redirect::Heredoc {
                        delimiter: delimiter.clone(),
                        body: String::new(),
                    });
                }

                _ => break,
            }
        }

        if command.words.is_empty() && command.assignments.is_empty() {
            return Err(match self.peek() {
                Some(token) => format!("expected a command, found {token:?}"),
                None => "expected a command".to_string(),
            });
        }

        Ok(command)
    }

    fn redirect_target(&mut self) -> Result<Word, String> {
        match self.peek() {
            Some(Token::Word(word)) => {
                self.position += 1;
                Ok(word.clone())
            }
            other => Err(format!("expected a filename after a redirect, found {other:?}")),
        }
    }
}

/// Splits `NAME=value` into its parts, if the word is a valid assignment.
fn as_assignment(word: &Word) -> Option<(String, Word)> {
    use crate::lexer::Piece;

    // The `=` has to be in the first, unquoted piece: `"a=b"` is a word, and
    // `a="b c"` is an assignment whose value is quoted.
    let Piece::Bare(first) = word.pieces.first()? else { return None };
    let (name, rest) = first.split_once('=')?;

    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }
    // A leading digit would make it a word, not a name: `2=x` is not valid.
    if name.chars().next()?.is_ascii_digit() {
        return None;
    }

    let mut pieces: Vec<Piece> = Vec::new();
    if !rest.is_empty() {
        pieces.push(Piece::Bare(rest.to_string()));
    }
    pieces.extend(word.pieces.iter().skip(1).cloned());

    Some((name.to_string(), Word { pieces }))
}

/// Attaches heredoc bodies, which the lexer cannot see because they live on
/// the lines after the command.
///
/// Returns the remaining input, so a caller feeding a script line by line knows
/// how much was consumed.
pub fn attach_heredocs(node: &mut Node, remaining: &str) -> String {
    let mut lines: Vec<&str> = remaining.split('\n').collect();
    fill(node, &mut lines);
    lines.join("\n")
}

fn fill(node: &mut Node, lines: &mut Vec<&str>) {
    match node {
        Node::Command(command) => fill_command(command, lines),
        Node::Pipeline(commands) => {
            for command in commands {
                fill_command(command, lines);
            }
        }
        Node::And(left, right) | Node::Or(left, right) | Node::Sequence(left, right) => {
            fill(left, lines);
            fill(right, lines);
        }
        Node::Background(inner) | Node::Subshell(inner) => fill(inner, lines),
    }
}

fn fill_command(command: &mut Command, lines: &mut Vec<&str>) {
    for redirect in &mut command.redirects {
        let Redirect::Heredoc { delimiter, body } = redirect else { continue };

        let mut collected = String::new();
        while !lines.is_empty() {
            let line = lines.remove(0);
            // The delimiter is matched after trimming, so an indented `EOF`
            // still closes the heredoc — the mistake that otherwise swallows
            // the rest of the script.
            if line.trim() == delimiter {
                break;
            }
            collected.push_str(line);
            collected.push('\n');
        }
        *body = collected;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::tokenize;

    fn tree(input: &str) -> Node {
        parse(&tokenize(input).unwrap()).unwrap().unwrap()
    }

    #[test]
    fn a_bare_command() {
        let node = tree("ls -la");
        match node {
            Node::Command(command) => {
                assert_eq!(command.name(), Some("ls".to_string()));
                assert_eq!(command.words.len(), 2);
            }
            other => panic!("expected a command, got {other:?}"),
        }
    }

    #[test]
    fn a_pipeline_collects_every_stage() {
        match tree("cat x | grep y | wc -l") {
            Node::Pipeline(commands) => assert_eq!(commands.len(), 3),
            other => panic!("expected a pipeline, got {other:?}"),
        }
    }

    #[test]
    fn a_pipe_binds_tighter_than_and() {
        // `a && b | c` must be `a && (b | c)`, not `(a && b) | c`.
        match tree("a && b | c") {
            Node::And(_, right) => match *right {
                Node::Pipeline(commands) => assert_eq!(commands.len(), 2),
                other => panic!("expected a pipeline on the right, got {other:?}"),
            },
            other => panic!("expected an And, got {other:?}"),
        }
    }

    #[test]
    fn and_or_are_left_associative() {
        // `a || b && c` is `(a || b) && c`.
        match tree("a || b && c") {
            Node::And(left, _) => assert!(matches!(*left, Node::Or(_, _))),
            other => panic!("expected an And at the root, got {other:?}"),
        }
    }

    #[test]
    fn assignments_are_recognised_only_in_prefix_position() {
        match tree("FOO=bar ls") {
            Node::Command(command) => {
                assert_eq!(command.assignments.len(), 1);
                assert_eq!(command.assignments[0].0, "FOO");
                assert_eq!(command.name(), Some("ls".to_string()));
            }
            other => panic!("expected a command, got {other:?}"),
        }

        // After the command name it is an argument, which is what `env` needs.
        match tree("env FOO=bar") {
            Node::Command(command) => {
                assert!(command.assignments.is_empty());
                assert_eq!(command.words.len(), 2);
            }
            other => panic!("expected a command, got {other:?}"),
        }
    }

    #[test]
    fn a_bare_assignment_has_no_command() {
        match tree("FOO=bar") {
            Node::Command(command) => assert!(command.is_assignment_only()),
            other => panic!("expected a command, got {other:?}"),
        }
    }

    #[test]
    fn a_quoted_equals_is_not_an_assignment() {
        match tree(r#""FOO=bar""#) {
            Node::Command(command) => {
                assert!(command.assignments.is_empty());
                assert_eq!(command.name(), Some("FOO=bar".to_string()));
            }
            other => panic!("expected a command, got {other:?}"),
        }
    }

    #[test]
    fn redirects_attach_to_their_command() {
        match tree("echo hi > out.txt 2> err.txt") {
            Node::Command(command) => {
                assert_eq!(command.redirects.len(), 2);
                assert!(matches!(command.redirects[0], Redirect::Out(_)));
                assert!(matches!(command.redirects[1], Redirect::Err(_)));
            }
            other => panic!("expected a command, got {other:?}"),
        }
    }

    #[test]
    fn subshells_parse_as_one_node() {
        match tree("(cd /tmp && ls)") {
            Node::Subshell(inner) => assert!(matches!(*inner, Node::And(_, _))),
            other => panic!("expected a subshell, got {other:?}"),
        }
    }

    #[test]
    fn newlines_and_semicolons_both_sequence() {
        assert!(matches!(tree("a; b"), Node::Sequence(_, _)));
        assert!(matches!(tree("a\nb"), Node::Sequence(_, _)));
    }

    #[test]
    fn a_trailing_separator_is_allowed() {
        assert!(matches!(tree("ls;"), Node::Command(_)));
        assert!(matches!(tree("ls\n"), Node::Command(_)));
    }

    #[test]
    fn background_wraps_the_command() {
        assert!(matches!(tree("sleep 1 &"), Node::Background(_)));
    }

    #[test]
    fn empty_input_is_not_an_error() {
        assert!(parse(&tokenize("").unwrap()).unwrap().is_none());
        assert!(parse(&tokenize("  \n  ").unwrap()).unwrap().is_none());
    }

    #[test]
    fn a_dangling_operator_is_rejected() {
        assert!(parse(&tokenize("ls |").unwrap()).is_err());
        assert!(parse(&tokenize("&& ls").unwrap()).is_err());
        assert!(parse(&tokenize("echo >").unwrap()).is_err());
    }

    #[test]
    fn heredoc_bodies_are_filled_from_the_following_lines() {
        let mut node = tree("cat << EOF");
        let rest = attach_heredocs(&mut node, "line one\nline two\nEOF\necho after");

        match &node {
            Node::Command(command) => match &command.redirects[0] {
                Redirect::Heredoc { body, .. } => assert_eq!(body, "line one\nline two\n"),
                other => panic!("expected a heredoc, got {other:?}"),
            },
            other => panic!("expected a command, got {other:?}"),
        }
        assert_eq!(rest, "echo after");
    }

    #[test]
    fn an_indented_heredoc_delimiter_still_closes() {
        let mut node = tree("cat << EOF");
        attach_heredocs(&mut node, "body\n   EOF\n");
        match &node {
            Node::Command(command) => match &command.redirects[0] {
                Redirect::Heredoc { body, .. } => assert_eq!(body, "body\n"),
                other => panic!("expected a heredoc, got {other:?}"),
            },
            other => panic!("expected a command, got {other:?}"),
        }
    }
}
