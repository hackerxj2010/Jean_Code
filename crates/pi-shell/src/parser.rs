//! Turns tokens into a command tree.
//!
//! The grammar, loosest to tightest:
//!
//! ```text
//! list      := andor (( ';' | '&' | newline ) andor)*
//! andor     := pipeline (( '&&' | '||' ) pipeline)*
//! pipeline  := ['!'] command ('|' command)*
//! command   := compound redirect* | name '(' ')' compound | simple
//! compound  := if | for | while | until | case | '{' list '}' | '(' list ')'
//! simple    := assignment* word* redirect*
//! ```
//!
//! Precedence matters more than it looks: `a && b | c` is `a && (b | c)`, and
//! getting it backwards silently changes what runs.
//!
//! Reserved words — `if`, `then`, `done`, `{`, `}` and the rest — are words
//! the lexer does not know about. They are reserved only where a command
//! starts: `echo done` prints "done", and `done` after a `;` ends a loop.

use crate::lexer::{Piece, Token, Word};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    /// A single command with its arguments and redirections.
    Command(Command),
    /// `left | right | ...`, each stage a command or a compound command.
    Pipeline(Vec<Node>),
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
    /// `! pipeline` — the exit status inverted.
    Not(Box<Node>),
    /// `{ list; }` — runs in the current shell.
    Group(Box<Node>),
    /// `if c; then b; elif c; then b; else b; fi`
    If { branches: Vec<(Node, Node)>, otherwise: Option<Box<Node>> },
    /// `for name [in words]; do body; done` — without `in`, the positional
    /// parameters.
    For { name: String, items: Option<Vec<Word>>, body: Box<Node> },
    /// `while` (or, with `until`, until) the condition succeeds.
    Loop { condition: Box<Node>, body: Box<Node>, until: bool },
    /// `case word in pattern|pattern) list ;; ... esac`
    Case { subject: Word, arms: Vec<CaseArm> },
    /// `name() compound`, or `function name compound`.
    Function { name: String, body: Box<Node> },
    /// A compound command with redirections: `done < file`, `} > log`.
    Redirected(Box<Node>, Vec<Redirect>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseArm {
    pub patterns: Vec<Word>,
    pub body: Option<Node>,
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
    /// `<<DELIM`. The lexer reads the body from the lines that follow; when
    /// they are not in the same input, `attach_heredocs` fills it (`pending`).
    Heredoc { delimiter: String, body: String, literal: bool, pending: bool },
    /// `<<< word`
    HereString(Word),
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

/// The reserved word a token is, if it is one bare word.
pub fn keyword(token: Option<&Token>) -> Option<&str> {
    match token {
        Some(Token::Word(word)) => match word.pieces.as_slice() {
            [Piece::Bare(text)] => Some(text.as_str()),
            _ => None,
        },
        _ => None,
    }
}

/// Words that end a construct, and so cannot start a command.
const CLOSERS: &[&str] = &["then", "elif", "else", "fi", "do", "done", "esac", "}", "in"];

/// A command that does nothing, for a construct with an empty body.
fn noop() -> Node {
    Node::Command(Command { words: vec![Word::bare(":")], ..Default::default() })
}

pub fn parse(tokens: &[Token]) -> Result<Option<Node>, String> {
    let mut parser = Parser { tokens, position: 0 };
    let node = parser.list(&[])?;
    if parser.position < tokens.len() {
        return Err(format!("unexpected {}", describe(&tokens[parser.position])));
    }
    Ok(node)
}

fn describe(token: &Token) -> String {
    match token {
        Token::Word(word) => format!("`{}`", word.as_literal()),
        Token::CloseParen => "`)`".to_string(),
        Token::CaseEnd => "`;;`".to_string(),
        other => format!("{other:?}"),
    }
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

    /// Whether the list being parsed ends here: at the end of input, at a
    /// `)` or `;;`, or at one of the construct's closing words.
    fn at_stop(&self, stop: &[&str]) -> bool {
        match self.peek() {
            None | Some(Token::CloseParen) | Some(Token::CaseEnd) => true,
            token => keyword(token).is_some_and(|word| stop.contains(&word)),
        }
    }

    fn expect(&mut self, word: &str) -> Result<(), String> {
        if keyword(self.peek()) == Some(word) {
            self.position += 1;
            return Ok(());
        }
        Err(match self.peek() {
            Some(token) => format!("expected `{word}`, found {}", describe(token)),
            None => format!("expected `{word}` before the end of input"),
        })
    }

    fn list(&mut self, stop: &[&str]) -> Result<Option<Node>, String> {
        self.skip_newlines();
        if self.at_stop(stop) {
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
                    if self.at_stop(stop) {
                        return Ok(Some(left));
                    }
                    let right = self.and_or()?;
                    left = Node::Sequence(Box::new(left), Box::new(right));
                }
                Some(Token::Background) => {
                    self.position += 1;
                    left = Node::Background(Box::new(left));
                    self.skip_newlines();
                    if self.at_stop(stop) {
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
        if keyword(self.peek()) == Some("!") {
            self.position += 1;
            return Ok(Node::Not(Box::new(self.pipeline()?)));
        }

        let mut stages = vec![self.command_node()?];
        while matches!(self.peek(), Some(Token::Pipe)) {
            self.position += 1;
            self.skip_newlines();
            stages.push(self.command_node()?);
        }

        Ok(if stages.len() == 1 { stages.pop().unwrap() } else { Node::Pipeline(stages) })
    }

    fn command_node(&mut self) -> Result<Node, String> {
        let compound = match self.peek() {
            Some(Token::OpenParen) => Some(self.subshell()?),
            token => match keyword(token) {
                Some("if") => Some(self.if_clause()?),
                Some("for") => Some(self.for_clause()?),
                Some("while") => Some(self.loop_clause(false)?),
                Some("until") => Some(self.loop_clause(true)?),
                Some("case") => Some(self.case_clause()?),
                Some("{") => Some(self.group()?),
                Some("function") => return self.function_keyword(),
                Some(word) if CLOSERS.contains(&word) => return Err(format!("unexpected `{word}`")),
                _ => None,
            },
        };
        if let Some(node) = compound {
            let mut redirects = Vec::new();
            while let Some(redirect) = self.redirect()? {
                redirects.push(redirect);
            }
            return Ok(if redirects.is_empty() { node } else { Node::Redirected(Box::new(node), redirects) });
        }

        // `name() compound`
        if let (Some(Token::Word(word)), Some(Token::OpenParen), Some(Token::CloseParen)) =
            (self.peek(), self.tokens.get(self.position + 1), self.tokens.get(self.position + 2))
        {
            if let Some(name) = function_name(word) {
                self.position += 3;
                self.skip_newlines();
                let body = self.command_node()?;
                return Ok(Node::Function { name, body: Box::new(body) });
            }
        }

        Ok(Node::Command(self.command()?))
    }

    fn subshell(&mut self) -> Result<Node, String> {
        self.position += 1;
        if matches!(self.peek(), Some(Token::OpenParen)) {
            return Err("`((...))` arithmetic commands are not supported; use `let` or `x=$((...))`".to_string());
        }
        let inner = self.list(&[])?.ok_or("empty subshell")?;
        if !matches!(self.peek(), Some(Token::CloseParen)) {
            return Err("unclosed `(`".to_string());
        }
        self.position += 1;
        Ok(Node::Subshell(Box::new(inner)))
    }

    fn group(&mut self) -> Result<Node, String> {
        self.position += 1;
        let inner = self.list(&["}"])?.ok_or("empty `{ }`")?;
        self.expect("}")?;
        Ok(Node::Group(Box::new(inner)))
    }

    fn if_clause(&mut self) -> Result<Node, String> {
        self.position += 1;
        let mut branches = Vec::new();
        let condition = self.list(&["then"])?.ok_or("`if` needs a condition")?;
        self.expect("then")?;
        let body = self.list(&["elif", "else", "fi"])?.unwrap_or_else(noop);
        branches.push((condition, body));
        let mut otherwise = None;
        loop {
            match keyword(self.peek()) {
                Some("elif") => {
                    self.position += 1;
                    let condition = self.list(&["then"])?.ok_or("`elif` needs a condition")?;
                    self.expect("then")?;
                    let body = self.list(&["elif", "else", "fi"])?.unwrap_or_else(noop);
                    branches.push((condition, body));
                }
                Some("else") => {
                    self.position += 1;
                    otherwise = Some(Box::new(self.list(&["fi"])?.unwrap_or_else(noop)));
                    self.expect("fi")?;
                    break;
                }
                Some("fi") => {
                    self.position += 1;
                    break;
                }
                _ => return Err("expected `fi` to close `if`".to_string()),
            }
        }
        Ok(Node::If { branches, otherwise })
    }

    fn for_clause(&mut self) -> Result<Node, String> {
        self.position += 1;
        if matches!(self.peek(), Some(Token::OpenParen)) {
            return Err("C-style `for ((...))` loops are not supported; use `for i in $(seq 1 10)`".to_string());
        }
        let name = match self.peek() {
            Some(Token::Word(word)) => variable_name(word).ok_or_else(|| format!("`{}` is not a valid loop variable", word.as_literal()))?,
            _ => return Err("`for` needs a variable name".to_string()),
        };
        self.position += 1;
        self.skip_newlines();
        let items = if keyword(self.peek()) == Some("in") {
            self.position += 1;
            let mut words = Vec::new();
            while let Some(Token::Word(word)) = self.peek() {
                words.push(word.clone());
                self.position += 1;
            }
            Some(words)
        } else {
            None
        };
        if matches!(self.peek(), Some(Token::Semicolon)) {
            self.position += 1;
        }
        self.skip_newlines();
        self.expect("do")?;
        let body = self.list(&["done"])?.unwrap_or_else(noop);
        self.expect("done")?;
        Ok(Node::For { name, items, body: Box::new(body) })
    }

    fn loop_clause(&mut self, until: bool) -> Result<Node, String> {
        self.position += 1;
        let condition = self.list(&["do"])?.ok_or("a loop needs a condition")?;
        self.expect("do")?;
        let body = self.list(&["done"])?.unwrap_or_else(noop);
        self.expect("done")?;
        Ok(Node::Loop { condition: Box::new(condition), body: Box::new(body), until })
    }

    fn case_clause(&mut self) -> Result<Node, String> {
        self.position += 1;
        let subject = match self.peek() {
            Some(Token::Word(word)) => {
                self.position += 1;
                word.clone()
            }
            _ => return Err("`case` needs a word to match".to_string()),
        };
        self.skip_newlines();
        self.expect("in")?;
        let mut arms = Vec::new();
        loop {
            self.skip_newlines();
            if keyword(self.peek()) == Some("esac") {
                self.position += 1;
                break;
            }
            if self.peek().is_none() {
                return Err("expected `esac` to close `case`".to_string());
            }
            if matches!(self.peek(), Some(Token::OpenParen)) {
                self.position += 1;
            }
            let mut patterns = Vec::new();
            loop {
                match self.peek() {
                    Some(Token::Word(word)) => {
                        patterns.push(word.clone());
                        self.position += 1;
                    }
                    _ => return Err("expected a `case` pattern".to_string()),
                }
                if !matches!(self.peek(), Some(Token::Pipe)) {
                    break;
                }
                self.position += 1;
            }
            if !matches!(self.peek(), Some(Token::CloseParen)) {
                return Err("expected `)` after a `case` pattern".to_string());
            }
            self.position += 1;
            let body = self.list(&["esac"])?;
            arms.push(CaseArm { patterns, body });
            if matches!(self.peek(), Some(Token::CaseEnd)) {
                self.position += 1;
            }
        }
        Ok(Node::Case { subject, arms })
    }

    fn function_keyword(&mut self) -> Result<Node, String> {
        self.position += 1;
        let name = match self.peek() {
            Some(Token::Word(word)) => function_name(word).ok_or("`function` needs a name")?,
            _ => return Err("`function` needs a name".to_string()),
        };
        self.position += 1;
        if matches!(self.peek(), Some(Token::OpenParen)) && matches!(self.tokens.get(self.position + 1), Some(Token::CloseParen)) {
            self.position += 2;
        }
        self.skip_newlines();
        let body = self.command_node()?;
        Ok(Node::Function { name, body: Box::new(body) })
    }

    fn command(&mut self) -> Result<Command, String> {
        let mut command = Command::default();

        loop {
            if let Some(Token::Word(word)) = self.peek() {
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
                continue;
            }
            match self.redirect()? {
                Some(redirect) => command.redirects.push(redirect),
                None => break,
            }
        }

        if command.words.is_empty() && command.assignments.is_empty() {
            return Err(match self.peek() {
                Some(token) => format!("expected a command, found {}", describe(token)),
                None => "expected a command".to_string(),
            });
        }

        Ok(command)
    }

    /// The redirection at the current token, if there is one.
    fn redirect(&mut self) -> Result<Option<Redirect>, String> {
        let redirect = match self.peek() {
            Some(Token::RedirectIn) => {
                self.position += 1;
                Redirect::In(self.redirect_target()?)
            }
            Some(Token::RedirectOut) => {
                self.position += 1;
                Redirect::Out(self.redirect_target()?)
            }
            Some(Token::RedirectAppend) => {
                self.position += 1;
                Redirect::Append(self.redirect_target()?)
            }
            Some(Token::RedirectErr) => {
                self.position += 1;
                Redirect::Err(self.redirect_target()?)
            }
            Some(Token::MergeErr) => {
                self.position += 1;
                Redirect::MergeErr
            }
            Some(Token::HereString) => {
                self.position += 1;
                Redirect::HereString(self.redirect_target()?)
            }
            Some(Token::Heredoc { delimiter, body, literal }) => {
                self.position += 1;
                Redirect::Heredoc {
                    delimiter: delimiter.trim_start_matches('-').to_string(),
                    body: body.clone().unwrap_or_default(),
                    literal: *literal,
                    pending: body.is_none(),
                }
            }
            _ => return Ok(None),
        };
        Ok(Some(redirect))
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

/// The word as a variable name: letters, digits, `_`, not starting with a digit.
fn variable_name(word: &Word) -> Option<String> {
    let [Piece::Bare(text)] = word.pieces.as_slice() else { return None };
    let first = text.chars().next()?;
    ((first.is_alphabetic() || first == '_') && text.chars().all(|c| c.is_alphanumeric() || c == '_')).then(|| text.clone())
}

/// The word as a function name, which bash lets contain `-`, `.`, and `:`.
fn function_name(word: &Word) -> Option<String> {
    let [Piece::Bare(text)] = word.pieces.as_slice() else { return None };
    let first = text.chars().next()?;
    let valid = (first.is_alphabetic() || first == '_') && text.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'));
    (valid && !CLOSERS.contains(&text.as_str())).then(|| text.clone())
}

/// Splits `NAME=value` into its parts, if the word is a valid assignment.
fn as_assignment(word: &Word) -> Option<(String, Word)> {
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

/// Attaches heredoc bodies the lexer could not read because they were not in
/// the same input — a caller feeding a script line by line.
///
/// Returns the remaining input, so the caller knows how much was consumed.
pub fn attach_heredocs(node: &mut Node, remaining: &str) -> String {
    let mut lines: Vec<&str> = remaining.split('\n').collect();
    fill(node, &mut lines);
    lines.join("\n")
}

fn fill(node: &mut Node, lines: &mut Vec<&str>) {
    match node {
        Node::Command(command) => fill_redirects(&mut command.redirects, lines),
        Node::Pipeline(stages) => {
            for stage in stages {
                fill(stage, lines);
            }
        }
        Node::And(left, right) | Node::Or(left, right) | Node::Sequence(left, right) => {
            fill(left, lines);
            fill(right, lines);
        }
        Node::Background(inner) | Node::Subshell(inner) | Node::Not(inner) | Node::Group(inner) => fill(inner, lines),
        Node::Function { body, .. } | Node::For { body, .. } => fill(body, lines),
        Node::Loop { condition, body, .. } => {
            fill(condition, lines);
            fill(body, lines);
        }
        Node::If { branches, otherwise } => {
            for (condition, body) in branches {
                fill(condition, lines);
                fill(body, lines);
            }
            if let Some(otherwise) = otherwise {
                fill(otherwise, lines);
            }
        }
        Node::Case { arms, .. } => {
            for arm in arms {
                if let Some(body) = &mut arm.body {
                    fill(body, lines);
                }
            }
        }
        Node::Redirected(inner, redirects) => {
            fill(inner, lines);
            fill_redirects(redirects, lines);
        }
    }
}

fn fill_redirects(redirects: &mut [Redirect], lines: &mut Vec<&str>) {
    for redirect in redirects {
        let Redirect::Heredoc { delimiter, body, pending, .. } = redirect else { continue };
        if !*pending {
            continue;
        }
        let mut collected = String::new();
        while !lines.is_empty() {
            let line = lines.remove(0);
            // The delimiter is matched after trimming, so an indented `EOF`
            // still closes the heredoc.
            if line.trim() == delimiter {
                break;
            }
            collected.push_str(line);
            collected.push('\n');
        }
        *body = collected;
        *pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::tokenize;

    fn tree(input: &str) -> Node {
        parse(&tokenize(input).unwrap()).unwrap().unwrap()
    }

    fn fails(input: &str) -> String {
        parse(&tokenize(input).unwrap()).unwrap_err()
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
            Node::Pipeline(stages) => assert_eq!(stages.len(), 3),
            other => panic!("expected a pipeline, got {other:?}"),
        }
    }

    #[test]
    fn a_pipe_binds_tighter_than_and() {
        // `a && b | c` must be `a && (b | c)`, not `(a && b) | c`.
        match tree("a && b | c") {
            Node::And(_, right) => match *right {
                Node::Pipeline(stages) => assert_eq!(stages.len(), 2),
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

    #[test]
    fn if_elif_else() {
        match tree("if a; then b; elif c; then d; else e; fi") {
            Node::If { branches, otherwise } => {
                assert_eq!(branches.len(), 2);
                assert!(otherwise.is_some());
            }
            other => panic!("expected an if, got {other:?}"),
        }
        // Over several lines, as a script writes it.
        assert!(matches!(tree("if [ -f x ]\nthen\n  echo yes\nfi"), Node::If { .. }));
    }

    #[test]
    fn loops() {
        match tree("for f in a b c; do echo $f; done") {
            Node::For { name, items, .. } => {
                assert_eq!(name, "f");
                assert_eq!(items.unwrap().len(), 3);
            }
            other => panic!("expected a for loop, got {other:?}"),
        }
        assert!(matches!(tree("for arg; do echo $arg; done"), Node::For { items: None, .. }));
        assert!(matches!(tree("while true; do break; done"), Node::Loop { until: false, .. }));
        assert!(matches!(tree("until false\ndo\n  break\ndone"), Node::Loop { until: true, .. }));
    }

    #[test]
    fn a_loop_can_be_a_pipeline_stage_and_take_redirections() {
        match tree("cat list | while read line; do echo $line; done > out") {
            Node::Pipeline(stages) => assert!(matches!(stages[1], Node::Redirected(..))),
            other => panic!("expected a pipeline, got {other:?}"),
        }
    }

    #[test]
    fn case_arms() {
        match tree("case $x in\n  a|b) echo ab ;;\n  (*.rs) echo rust ;;\n  *) echo other\nesac") {
            Node::Case { arms, .. } => {
                assert_eq!(arms.len(), 3);
                assert_eq!(arms[0].patterns.len(), 2);
            }
            other => panic!("expected a case, got {other:?}"),
        }
    }

    #[test]
    fn functions_and_groups() {
        assert!(matches!(tree("greet() { echo hi; }"), Node::Function { .. }));
        assert!(matches!(tree("function greet { echo hi; }"), Node::Function { .. }));
        assert!(matches!(tree("{ echo a; echo b; } > log"), Node::Redirected(..)));
        assert!(matches!(tree("! grep x"), Node::Not(_)));
    }

    #[test]
    fn reserved_words_only_where_a_command_starts() {
        match tree("echo done then fi") {
            Node::Command(command) => assert_eq!(command.words.len(), 4),
            other => panic!("expected a command, got {other:?}"),
        }
        assert!(fails("fi").contains("unexpected `fi`"));
        assert!(fails("if true; then echo").contains("`fi`"));
        assert!(fails("for x in a b; do echo").contains("`done`"));
    }
}
