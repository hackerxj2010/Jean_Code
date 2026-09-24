//! The executor: runs a parsed command tree against a session.
//!
//! Builtins run in-process; anything else is spawned. The distinction matters
//! for more than speed — a builtin can change the session's own state, which a
//! subprocess cannot. `cd` is the canonical case: forking a process that
//! changes its own directory and exits accomplishes nothing.

use crate::expand::{expand_word, Context};
use crate::lexer::Word;
use crate::parser::{Command, Node, Redirect};
use crate::session::Session;
use pi_builtins::Output;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;

/// The result of running a whole command line.
#[derive(Debug, Clone, Default)]
pub struct Run {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    /// Commands that were refused, with the reason.
    pub refused: Vec<String>,
    /// Background jobs started by this run.
    pub jobs: Vec<u32>,
    /// A shell-level failure, as distinct from a command exiting non-zero.
    ///
    /// `$(false)` is not fatal — the substitution yields empty output and the
    /// outer command runs, which is what every shell does. Running out of
    /// substitution depth *is* fatal: swallowing it would turn a runaway
    /// expression into a command that silently ran with a missing argument.
    pub fatal: bool,
}

impl Run {
    fn from(output: Output) -> Self {
        Run { stdout: output.stdout, stderr: output.stderr, code: output.code, ..Default::default() }
    }

    fn merge(&mut self, other: Run) {
        self.stdout.push_str(&other.stdout);
        self.stderr.push_str(&other.stderr);
        self.code = other.code;
        self.refused.extend(other.refused);
        self.jobs.extend(other.jobs);
        self.fatal |= other.fatal;
    }
}

/// How deep command substitution may nest before the shell gives up.
///
/// `x=$(echo $x)` in a script is a fork bomb without a limit like this.
const MAX_SUBSTITUTION_DEPTH: usize = 16;

/// Runs a command tree.
pub fn run(node: &Node, session: &mut Session, stdin: &str) -> Run {
    run_at(node, session, stdin, 0)
}

fn run_at(node: &Node, session: &mut Session, stdin: &str, depth: usize) -> Run {
    if depth > MAX_SUBSTITUTION_DEPTH {
        return Run {
            stderr: "command substitution nested too deeply\n".to_string(),
            code: 1,
            fatal: true,
            ..Default::default()
        };
    }

    match node {
        Node::Command(command) => run_command(command, session, stdin, depth),

        Node::Pipeline(commands) => {
            let mut piped = stdin.to_string();
            let mut result = Run::default();

            for (index, command) in commands.iter().enumerate() {
                let stage = run_command(command, session, &piped, depth);

                // Stderr from every stage surfaces; stdout only from the last,
                // because the rest of it went down the pipe.
                result.stderr.push_str(&stage.stderr);
                result.refused.extend(stage.refused.clone());
                result.code = stage.code;

                if index + 1 == commands.len() {
                    result.stdout = stage.stdout;
                } else {
                    // A failing stage still feeds what it produced downstream,
                    // which is what a real pipeline does.
                    piped = stage.stdout;
                }
            }
            result
        }

        Node::And(left, right) => {
            let mut result = run_at(left, session, stdin, depth);
            if result.code == 0 {
                result.merge(run_at(right, session, stdin, depth));
            }
            result
        }

        Node::Or(left, right) => {
            let mut result = run_at(left, session, stdin, depth);
            if result.code != 0 {
                let recovered = run_at(right, session, stdin, depth);
                // The left side's stderr is kept: it explains why the fallback
                // ran, and dropping it hides the actual failure.
                result.merge(recovered);
            }
            result
        }

        Node::Sequence(left, right) => {
            let mut result = run_at(left, session, stdin, depth);
            result.merge(run_at(right, session, stdin, depth));
            result
        }

        Node::Subshell(inner) => {
            // A subshell gets a copy: its `cd` and `export` must not escape.
            let mut copy = session.clone();
            let result = run_at(inner, &mut copy, stdin, depth);
            session.last_status = result.code;
            result
        }

        Node::Background(inner) => {
            // Backgrounding a builtin has nothing to background: run it and say
            // so, rather than silently dropping the output.
            let result = run_at(inner, session, stdin, depth);
            Run {
                stdout: result.stdout,
                stderr: result.stderr,
                code: 0,
                refused: result.refused,
                jobs: result.jobs,
                fatal: result.fatal,
            }
        }
    }
}

fn run_command(command: &Command, session: &mut Session, stdin: &str, depth: usize) -> Run {
    // `VAR=value` on its own sets the session variable.
    if command.is_assignment_only() {
        for (name, value) in &command.assignments {
            match expand_one(value, session, depth) {
                Ok(expanded) => {
                    session.variables.insert(name.clone(), expanded);
                }
                Err(message) => {
                    // An expansion failure is a shell error, not a command exit
                    // code: the word could not be built, so nothing ran. It has
                    // to stay fatal or an enclosing substitution swallows it.
                    return Run { stderr: format!("{message}\n"), code: 1, fatal: true, ..Default::default() }
                }
            }
        }
        session.last_status = 0;
        return Run::default();
    }

    // Expand the words. A failure here is the command not running at all.
    let mut arguments: Vec<String> = Vec::new();
    for word in &command.words {
        match expand(word, session, depth) {
            Ok(fields) => arguments.extend(fields),
            Err(message) => {
                session.last_status = 1;
                return Run { stderr: format!("{message}\n"), code: 1, fatal: true, ..Default::default() };
            }
        }
    }

    if arguments.is_empty() {
        return Run::default();
    }

    let name = arguments.remove(0);

    // Redirections are resolved before the command runs, because a failure to
    // open the output file means the command must not run at all.
    let mut input = stdin.to_string();
    let mut redirect_target: Option<(PathBuf, bool)> = None;
    let mut error_target: Option<PathBuf> = None;
    let mut merge_error = false;

    for redirect in &command.redirects {
        match redirect {
            Redirect::In(word) => match expand_one(word, session, depth) {
                Ok(path) => match fs::read_to_string(session.resolve(&path)) {
                    Ok(content) => input = content,
                    Err(error) => {
                        session.last_status = 1;
                        return Run {
                            stderr: format!("{path}: {error}\n"),
                            code: 1,
                            ..Default::default()
                        };
                    }
                },
                Err(message) => {
                    // An expansion failure is a shell error, not a command exit
                    // code: the word could not be built, so nothing ran. It has
                    // to stay fatal or an enclosing substitution swallows it.
                    return Run { stderr: format!("{message}\n"), code: 1, fatal: true, ..Default::default() }
                }
            },

            Redirect::Out(word) | Redirect::Append(word) => {
                let append = matches!(redirect, Redirect::Append(_));
                match expand_one(word, session, depth) {
                    Ok(path) => redirect_target = Some((session.resolve(&path), append)),
                    Err(message) => {
                        // An expansion failure is a shell error, not a command exit
                    // code: the word could not be built, so nothing ran. It has
                    // to stay fatal or an enclosing substitution swallows it.
                    return Run { stderr: format!("{message}\n"), code: 1, fatal: true, ..Default::default() }
                    }
                }
            }

            Redirect::Err(word) => match expand_one(word, session, depth) {
                Ok(path) => error_target = Some(session.resolve(&path)),
                Err(message) => {
                    // An expansion failure is a shell error, not a command exit
                    // code: the word could not be built, so nothing ran. It has
                    // to stay fatal or an enclosing substitution swallows it.
                    return Run { stderr: format!("{message}\n"), code: 1, fatal: true, ..Default::default() }
                }
            },

            Redirect::MergeErr => merge_error = true,

            Redirect::Heredoc { body, .. } => {
                // An unquoted heredoc expands; the lexer stripped the quotes, so
                // this expands always. A caller wanting a literal body should
                // pass it as a file.
                input = expand_text(body, session, depth).unwrap_or_else(|_| body.clone());
            }
        }
    }

    // Per-command assignments apply only for the duration of this command.
    let saved: Vec<(String, Option<String>)> = command
        .assignments
        .iter()
        .map(|(name, _)| (name.clone(), session.variables.get(name).cloned()))
        .collect();

    for (name, value) in &command.assignments {
        if let Ok(expanded) = expand_one(value, session, depth) {
            session.variables.insert(name.clone(), expanded);
        }
    }

    let mut output = execute(&name, &arguments, &input, session);

    for (name, previous) in saved {
        match previous {
            Some(value) => session.variables.insert(name, value),
            None => session.variables.remove(&name),
        };
    }

    if merge_error {
        // `2>&1` folds stderr into stdout, in that order: the command's own
        // ordering is lost either way, and stdout-first matches what a terminal
        // shows for a command that writes its error last.
        output.stdout.push_str(&std::mem::take(&mut output.stderr));
    }

    if let Some(path) = error_target {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, std::mem::take(&mut output.stderr));
    }

    if let Some((path, append)) = redirect_target {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let written = if append {
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut file| file.write_all(output.stdout.as_bytes()))
        } else {
            fs::write(&path, &output.stdout)
        };

        match written {
            Ok(()) => output.stdout = String::new(),
            Err(error) => {
                output.stderr.push_str(&format!("{}: {error}\n", path.display()));
                output.code = 1;
            }
        }
    }

    session.last_status = output.code;
    output
}

/// Runs one resolved command: a shell builtin, a `pi-builtins` coreutil, or a
/// spawned process.
fn execute(name: &str, arguments: &[String], stdin: &str, session: &mut Session) -> Run {
    // Shell builtins first: these need the session and cannot be a subprocess.
    match name {
        "cd" => return Run::from(session.cd(arguments.first().map(String::as_str))),
        "export" => return Run::from(session.export(arguments)),
        "unset" => {
            for name in arguments {
                session.variables.remove(name);
            }
            return Run::default();
        }
        "alias" => return Run::from(session.alias(arguments)),
        "exit" => {
            let code = arguments.first().and_then(|a| a.parse().ok()).unwrap_or(0);
            session.exited = Some(code);
            return Run { code, ..Default::default() };
        }
        "source" | "." => {
            return Run {
                stderr: "source: not supported; the session already persists variables\n"
                    .to_string(),
                code: 1,
                ..Default::default()
            }
        }
        "which" => {
            let target = arguments.first().map(String::as_str).unwrap_or("");
            return if pi_builtins::is_builtin(target) {
                Run { stdout: format!("{target}: shell builtin\n"), ..Default::default() }
            } else {
                match which(target, session) {
                    Some(path) => {
                        Run { stdout: format!("{}\n", path.display()), ..Default::default() }
                    }
                    None => Run {
                        stderr: format!("{target} not found\n"),
                        code: 1,
                        ..Default::default()
                    },
                }
            };
        }
        _ => {}
    }

    // An alias expands once, not recursively: `alias ls='ls -la'` must not loop.
    if let Some(expansion) = session.aliases.get(name).cloned() {
        let mut parts = expansion.split_whitespace();
        if let Some(head) = parts.next() {
            let mut combined: Vec<String> = parts.map(String::from).collect();
            combined.extend_from_slice(arguments);
            if head != name {
                return execute(head, &combined, stdin, session);
            }
            // A self-referential alias falls through to the real command.
            return run_external(name, &combined, stdin, session);
        }
    }

    if pi_builtins::is_builtin(name) {
        let previous = std::env::current_dir().ok();
        // The builtins resolve relative paths against the process cwd, so the
        // session's cwd has to be real for the duration of the call.
        let _ = std::env::set_current_dir(&session.cwd);
        let output = pi_builtins::dispatch(name, arguments, stdin);
        if let Some(previous) = previous {
            let _ = std::env::set_current_dir(previous);
        }
        return Run::from(output);
    }

    run_external(name, arguments, stdin, session)
}

fn run_external(name: &str, arguments: &[String], stdin: &str, session: &mut Session) -> Run {
    if let Some(reason) = session.policy.refuse(name, arguments) {
        return Run {
            stderr: format!("{name}: {reason}\n"),
            code: 126,
            refused: vec![format!("{name}: {reason}")],
            ..Default::default()
        };
    }

    let mut child = match std::process::Command::new(name)
        .args(arguments)
        .current_dir(&session.cwd)
        .envs(&session.variables)
        .stdin(if stdin.is_empty() { Stdio::null() } else { Stdio::piped() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let hint = if pi_builtins::BUILTINS.contains(&name) {
                String::new()
            } else {
                format!(" (not a builtin either; {} builtins are available)", pi_builtins::BUILTINS.len())
            };
            return Run {
                stderr: format!("{name}: {error}{hint}\n"),
                code: 127,
                ..Default::default()
            };
        }
    };

    if !stdin.is_empty() {
        if let Some(mut handle) = child.stdin.take() {
            // A child that exits before reading gives EPIPE here; that is not a
            // failure of the command, so it is ignored.
            let _ = handle.write_all(stdin.as_bytes());
        }
    }

    match child.wait_with_output() {
        Ok(output) => Run {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            code: output.status.code().unwrap_or(-1),
            ..Default::default()
        },
        Err(error) => Run { stderr: format!("{name}: {error}\n"), code: 1, ..Default::default() },
    }
}

/// Finds an executable on PATH.
fn which(name: &str, session: &Session) -> Option<PathBuf> {
    let path = session
        .variables
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())?;

    let separator = if cfg!(windows) { ';' } else { ':' };
    // On Windows a bare name needs an extension appended before it resolves.
    let extensions: Vec<&str> =
        if cfg!(windows) { vec!["", ".exe", ".cmd", ".bat"] } else { vec![""] };

    for directory in path.split(separator) {
        for extension in &extensions {
            let candidate = PathBuf::from(directory).join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---- expansion glue -------------------------------------------------------

fn expand(word: &Word, session: &mut Session, depth: usize) -> Result<Vec<String>, String> {
    // Command substitution needs to run commands, which needs the session — so
    // the session is cloned for the nested run and its variable changes are
    // discarded, exactly as a subshell's are.
    let mut nested = session.clone();
    let variables = session.variables.clone();
    let cwd = session.cwd.clone();
    let home = session.home.clone();
    let positional = session.positional.clone();
    let last_status = session.last_status;

    let context = Context {
        variables: &variables,
        cwd: &cwd,
        home: &home,
        last_status,
        positional: &positional,
    };

    expand_word(word, &context, &mut |command| {
        // Checked here rather than inside the nested run: a substitution that
        // hits the ceiling must fail the word, not quietly expand to nothing.
        if depth >= MAX_SUBSTITUTION_DEPTH {
            return Err(format!(
                "command substitution nested more than {MAX_SUBSTITUTION_DEPTH} deep"
            ));
        }
        let tokens = crate::lexer::tokenize(command)?;
        let Some(tree) = crate::parser::parse(&tokens)? else { return Ok(String::new()) };
        let result = run_at(&tree, &mut nested, "", depth + 1);
        if result.fatal {
            return Err(result.stderr.trim().to_string());
        }
        Ok(result.stdout)
    })
}

fn expand_one(word: &Word, session: &mut Session, depth: usize) -> Result<String, String> {
    Ok(expand(word, session, depth)?.join(" "))
}

/// Expands variables in a heredoc body.
///
/// Deliberately not tokenized: a heredoc's newlines and runs of spaces are its
/// content, and word-splitting the body would collapse them all into single
/// spaces — turning a two-line document into one line.
fn expand_text(text: &str, session: &mut Session, _depth: usize) -> Result<String, String> {
    let context = Context {
        variables: &session.variables,
        cwd: &session.cwd,
        home: &session.home,
        last_status: session.last_status,
        positional: &session.positional,
    };
    crate::expand::expand_variables(text, &context)
}
