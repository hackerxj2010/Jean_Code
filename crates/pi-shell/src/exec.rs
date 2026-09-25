//! The executor: runs a parsed command tree against a session.
//!
//! Builtins run in-process; anything else is spawned. The distinction matters
//! for more than speed — a builtin can change the session's own state, which a
//! subprocess cannot. `cd` is the canonical case: forking a process that
//! changes its own directory and exits accomplishes nothing.
//!
//! Control flow — `break`, `continue`, `return` — travels up the tree as a
//! [`Flow`] on the result, which every list and loop checks before running
//! the next thing.

use crate::arith::{self, Scope};
use crate::expand::{expand_word, Context};
use crate::lexer::{Piece, Word};
use crate::parser::{Command, Node, Redirect};
use crate::session::{Input, Session};
use pi_builtins::Output;
use std::collections::HashMap;
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
    /// A `break`, `continue`, or `return` on its way up to what it leaves.
    pub flow: Option<Flow>,
}

/// Where control goes instead of the next command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    /// Leave this many enclosing loops.
    Break(u32),
    /// Start the next iteration of the loop this many levels up.
    Continue(u32),
    /// Leave the function.
    Return,
}

impl Run {
    fn from(output: Output) -> Self {
        Run { stdout: output.stdout, stderr: output.stderr, code: output.code, ..Default::default() }
    }

    fn error(message: impl Into<String>, code: i32) -> Self {
        let mut stderr = message.into();
        if !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        Run { stderr, code, ..Default::default() }
    }

    fn fatal(message: impl Into<String>) -> Self {
        Run { fatal: true, ..Run::error(message, 1) }
    }

    fn merge(&mut self, other: Run) {
        self.stdout.push_str(&other.stdout);
        self.stderr.push_str(&other.stderr);
        self.code = other.code;
        self.refused.extend(other.refused);
        self.jobs.extend(other.jobs);
        self.fatal |= other.fatal;
        if other.flow.is_some() {
            self.flow = other.flow;
        }
    }

    /// Whatever should stop the list this is part of from running on.
    fn stops(&self, session: &Session) -> bool {
        self.flow.is_some() || self.fatal || session.exited.is_some()
    }
}

/// How deep command substitution may nest before the shell gives up.
///
/// `x=$(echo $x)` in a script is a fork bomb without a limit like this.
const MAX_SUBSTITUTION_DEPTH: usize = 16;

/// Iterations one loop may run: enough for any real script, and a stop for
/// `while true` without a `break`, which would otherwise hang the shell.
const MAX_ITERATIONS: usize = 1_000_000;

/// How deep function calls may nest; a recursive function without a base
/// case stops here instead of overflowing the stack.
const MAX_CALL_DEPTH: usize = 200;

/// Runs a command tree.
pub fn run(node: &Node, session: &mut Session, stdin: &str) -> Run {
    run_at(node, session, stdin, 0)
}

fn run_at(node: &Node, session: &mut Session, stdin: &str, depth: usize) -> Run {
    if depth > MAX_SUBSTITUTION_DEPTH {
        return Run::fatal("command substitution nested too deeply");
    }

    let result = match node {
        Node::Command(command) => {
            let result = run_command(command, session, stdin, depth);
            errexit(session, &result);
            result
        }

        Node::Pipeline(stages) => {
            let mut piped = stdin.to_string();
            let mut result = Run::default();
            let mut failed = 0;
            // One stage failing is the pipeline's business, not `set -e`'s.
            session.condition_depth += 1;
            for (index, stage) in stages.iter().enumerate() {
                // A later stage reads the pipe, not what the loop around the
                // pipeline was fed.
                let saved = if index > 0 { session.input.take() } else { None };
                let run = run_at(stage, session, &piped, depth);
                if index > 0 {
                    session.input = saved;
                }

                // Stderr from every stage surfaces; stdout only from the last,
                // because the rest of it went down the pipe.
                result.stderr.push_str(&run.stderr);
                result.refused.extend(run.refused);
                result.jobs.extend(run.jobs);
                result.fatal |= run.fatal;
                result.code = run.code;
                if run.code != 0 {
                    failed = run.code;
                }
                if index + 1 == stages.len() {
                    result.stdout = run.stdout;
                } else {
                    // A failing stage still feeds what it produced downstream,
                    // which is what a real pipeline does.
                    piped = run.stdout;
                }
            }
            session.condition_depth -= 1;
            if session.pipefail && failed != 0 {
                result.code = failed;
            }
            errexit(session, &result);
            result
        }

        Node::And(left, right) => {
            let mut result = condition(left, session, stdin, depth);
            if result.code == 0 && !result.stops(session) {
                result.merge(run_at(right, session, stdin, depth));
            }
            result
        }

        Node::Or(left, right) => {
            let mut result = condition(left, session, stdin, depth);
            if result.code != 0 && !result.stops(session) {
                let recovered = run_at(right, session, stdin, depth);
                // The left side's stderr is kept: it explains why the fallback
                // ran, and dropping it hides the actual failure.
                result.merge(recovered);
            }
            result
        }

        Node::Sequence(left, right) => {
            let mut result = run_at(left, session, stdin, depth);
            if !result.stops(session) {
                result.merge(run_at(right, session, stdin, depth));
            }
            result
        }

        Node::Not(inner) => {
            let mut result = condition(inner, session, stdin, depth);
            result.code = i32::from(result.code == 0);
            result
        }

        Node::Subshell(inner) => {
            // A subshell gets a copy: its `cd`, `export`, and `exit` must not
            // escape.
            let mut copy = session.clone();
            let mut result = run_at(inner, &mut copy, stdin, depth);
            result.flow = None;
            if let Some(code) = copy.exited {
                result.code = code;
            }
            errexit(session, &result);
            result
        }

        Node::Background(inner) => {
            // Backgrounding a builtin has nothing to background: run it and say
            // so, rather than silently dropping the output.
            let result = run_at(inner, session, stdin, depth);
            Run { code: 0, flow: None, ..result }
        }

        Node::Group(inner) => feeding(session, stdin, |session| run_at(inner, session, stdin, depth)),

        Node::Function { name, body } => {
            session.functions.insert(name.clone(), (**body).clone());
            Run::default()
        }

        Node::If { branches, otherwise } => feeding(session, stdin, |session| {
            let mut result = Run::default();
            for (test, body) in branches {
                let check = condition(test, session, stdin, depth);
                let passed = check.code == 0;
                result.merge(check);
                if result.stops(session) {
                    return result;
                }
                if passed {
                    result.merge(run_at(body, session, stdin, depth));
                    return result;
                }
            }
            match otherwise {
                Some(body) => result.merge(run_at(body, session, stdin, depth)),
                // No branch ran: `if` succeeds, whatever its tests said.
                None => result.code = 0,
            }
            result
        }),

        Node::For { name, items, body } => {
            let values = match items {
                Some(words) => {
                    let mut values = Vec::new();
                    for word in words {
                        match expand(word, session, depth, false) {
                            Ok(fields) => values.extend(fields),
                            Err(message) => return Run::fatal(message),
                        }
                    }
                    values
                }
                None => session.positional.clone(),
            };
            feeding(session, stdin, |session| {
                let mut result = Run::default();
                for (count, value) in values.into_iter().enumerate() {
                    if count >= MAX_ITERATIONS {
                        result.merge(Run::error(format!("for: stopped after {MAX_ITERATIONS} iterations"), 1));
                        break;
                    }
                    if out_of_time(session, &mut result) {
                        break;
                    }
                    session.variables.insert(name.clone(), value);
                    let step = run_at(body, session, stdin, depth);
                    if !absorb(&mut result, step) || result.fatal || session.exited.is_some() {
                        break;
                    }
                }
                result
            })
        }

        Node::Loop { condition: test, body, until } => feeding(session, stdin, |session| {
            let mut result = Run::default();
            let mut iterations = 0;
            loop {
                let mut check = condition(test, session, stdin, depth);
                let passed = (check.code == 0) != *until;
                let code = result.code;
                check.flow = None;
                result.merge(check);
                // A loop's status is its body's, not its test's.
                result.code = code;
                if result.fatal || session.exited.is_some() || !passed {
                    break;
                }
                iterations += 1;
                if iterations > MAX_ITERATIONS {
                    result.merge(Run::error(format!("loop stopped after {MAX_ITERATIONS} iterations"), 1));
                    break;
                }
                if out_of_time(session, &mut result) {
                    break;
                }
                let step = run_at(body, session, stdin, depth);
                if !absorb(&mut result, step) || result.fatal || session.exited.is_some() {
                    break;
                }
            }
            result
        }),

        Node::Case { subject, arms } => feeding(session, stdin, |session| {
            let value = match expand(subject, session, depth, true) {
                Ok(fields) => fields.join(" "),
                Err(message) => return Run::fatal(message),
            };
            for arm in arms {
                for pattern in &arm.patterns {
                    let pattern = match expand(pattern, session, depth, true) {
                        Ok(fields) => fields.join(" "),
                        Err(message) => return Run::fatal(message),
                    };
                    if pi_builtins::data::glob_match(&pattern, &value) {
                        return match &arm.body {
                            Some(body) => run_at(body, session, stdin, depth),
                            None => Run::default(),
                        };
                    }
                }
            }
            Run::default()
        }),

        Node::Redirected(inner, redirects) => {
            let prepared = match prepare(redirects, session, depth) {
                Ok(prepared) => prepared,
                Err(failure) => return failure,
            };
            let result = match prepared.input.clone() {
                Some(text) => {
                    // A redirected compound reads its own stream from the start.
                    let saved = session.input.replace(Input::new(text.clone()));
                    let result = run_at(inner, session, &text, depth);
                    session.input = saved;
                    result
                }
                None => run_at(inner, session, stdin, depth),
            };
            finish(prepared, result)
        }
    };

    session.last_status = result.code;
    result
}

/// Runs a test: an `if` or `while` condition, the left of `&&` / `||`, a
/// `!` — where a failure is an answer, not an error for `set -e`.
fn condition(node: &Node, session: &mut Session, stdin: &str, depth: usize) -> Run {
    session.condition_depth += 1;
    let result = run_at(node, session, stdin, depth);
    session.condition_depth -= 1;
    result
}

/// `set -e`: a command that fails outside a condition ends the script.
fn errexit(session: &mut Session, result: &Run) {
    if session.errexit && session.condition_depth == 0 && result.code != 0 && result.flow.is_none() && session.exited.is_none() {
        session.exited = Some(result.code);
    }
}

/// Makes `stdin` the input of the compound command `run` executes, for the
/// `read`s inside it — unless it already reads an enclosing stream.
fn feeding(session: &mut Session, stdin: &str, run: impl FnOnce(&mut Session) -> Run) -> Run {
    if stdin.is_empty() || session.input.is_some() {
        return run(session);
    }
    session.input = Some(Input::new(stdin.to_string()));
    let result = run(session);
    session.input = None;
    result
}

/// Whether the script has run past its time, checked by every loop.
fn out_of_time(session: &Session, result: &mut Run) -> bool {
    if session.deadline.is_some_and(|deadline| std::time::Instant::now() > deadline) {
        result.merge(Run::error(format!("loop stopped: the script ran past its {}s limit", session.time_limit.as_secs()), 124));
        return true;
    }
    false
}

/// Adds one iteration's result to a loop's, and says whether to go on.
fn absorb(result: &mut Run, mut step: Run) -> bool {
    let flow = step.flow.take();
    result.merge(step);
    match flow {
        None => true,
        Some(Flow::Continue(levels)) if levels <= 1 => true,
        Some(Flow::Break(levels)) if levels <= 1 => false,
        Some(Flow::Continue(levels)) => {
            result.flow = Some(Flow::Continue(levels - 1));
            false
        }
        Some(Flow::Break(levels)) => {
            result.flow = Some(Flow::Break(levels - 1));
            false
        }
        Some(Flow::Return) => {
            result.flow = Some(Flow::Return);
            false
        }
    }
}

// ---- redirections -----------------------------------------------------------

/// Redirections resolved before a command runs — a failure to open the output
/// file means the command must not run at all.
#[derive(Default)]
struct Prepared {
    input: Option<String>,
    output: Option<(PathBuf, bool)>,
    error: Option<PathBuf>,
    merge_error: bool,
}

fn prepare(redirects: &[Redirect], session: &mut Session, depth: usize) -> Result<Prepared, Run> {
    let mut prepared = Prepared::default();
    // An expansion failure is a shell error, not a command exit code: the word
    // could not be built, so nothing ran. It has to stay fatal or an
    // enclosing substitution swallows it.
    let one = |word: &Word, session: &mut Session| expand_one(word, session, depth).map_err(Run::fatal);
    for redirect in redirects {
        match redirect {
            Redirect::In(word) => {
                let path = one(word, session)?;
                match fs::read_to_string(session.resolve(&path)) {
                    Ok(content) => prepared.input = Some(content),
                    Err(error) => {
                        session.last_status = 1;
                        return Err(Run::error(format!("{path}: {error}"), 1));
                    }
                }
            }
            Redirect::Out(word) | Redirect::Append(word) => {
                let path = one(word, session)?;
                prepared.output = Some((session.resolve(&path), matches!(redirect, Redirect::Append(_))));
            }
            Redirect::Err(word) => {
                let path = one(word, session)?;
                prepared.error = Some(session.resolve(&path));
            }
            Redirect::MergeErr => prepared.merge_error = true,
            Redirect::Heredoc { body, literal, .. } => {
                let text = if *literal { body.clone() } else { expand_text(body, session).unwrap_or_else(|_| body.clone()) };
                prepared.input = Some(text);
            }
            Redirect::HereString(word) => {
                let text = one(word, session)?;
                prepared.input = Some(format!("{text}\n"));
            }
        }
    }
    Ok(prepared)
}

fn finish(prepared: Prepared, mut output: Run) -> Run {
    if prepared.merge_error {
        // `2>&1` folds stderr into stdout, in that order: the command's own
        // ordering is lost either way, and stdout-first matches what a terminal
        // shows for a command that writes its error last.
        output.stdout.push_str(&std::mem::take(&mut output.stderr));
    }

    if let Some(path) = prepared.error {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, std::mem::take(&mut output.stderr));
    }

    if let Some((path, append)) = prepared.output {
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
    output
}

// ---- simple commands --------------------------------------------------------

/// Commands that never read their input: handed none, rather than a copy of
/// a loop's whole remaining stream each time they run.
const NO_INPUT: &[&str] = &[
    ":", "true", "false", "echo", "printf", "test", "[", "[[", "cd", "export", "unset", "alias", "exit", "local", "set",
    "shift", "return", "break", "continue", "let", "declare", "typeset", "which", "type", "command", "wait", "ls", "cp",
    "mv", "rm", "mkdir", "touch", "chmod", "chown", "stat", "file", "basename", "dirname", "readlink", "realpath",
    "mktemp", "seq", "date", "env", "printenv", "yes", "pwd", "sleep", "find", "diff",
];

fn run_command(command: &Command, session: &mut Session, stdin: &str, depth: usize) -> Run {
    // `VAR=value` on its own sets the session variable.
    if command.is_assignment_only() {
        for (name, value) in &command.assignments {
            match expand_one(value, session, depth) {
                Ok(expanded) => {
                    session.variables.insert(name.clone(), expanded);
                }
                Err(message) => return Run::fatal(message),
            }
        }
        session.last_status = 0;
        return Run::default();
    }

    // Inside `[[ ]]` nothing is split or globbed: `*.rs` is a pattern.
    let literal = command.words.first().is_some_and(|word| word.as_literal() == "[[");

    // Expand the words. A failure here is the command not running at all.
    let mut arguments: Vec<String> = Vec::new();
    for word in &command.words {
        match expand(word, session, depth, literal) {
            Ok(fields) => arguments.extend(fields),
            Err(message) => {
                session.last_status = 1;
                return Run::fatal(message);
            }
        }
    }

    if arguments.is_empty() {
        return Run::default();
    }

    let name = arguments.remove(0);

    let prepared = match prepare(&command.redirects, session, depth) {
        Ok(prepared) => prepared,
        Err(failure) => return failure,
    };

    // Per-command assignments apply only for the duration of this command.
    let saved: Vec<(String, Option<String>)> =
        command.assignments.iter().map(|(name, _)| (name.clone(), session.variables.get(name).cloned())).collect();
    for (name, value) in &command.assignments {
        if let Ok(expanded) = expand_one(value, session, depth) {
            session.variables.insert(name.clone(), expanded);
        }
    }

    let output = if name == "read" {
        read(&arguments, prepared.input.as_deref(), stdin, session)
    } else {
        // What the command reads: its own redirection, else what is left of
        // the stream the enclosing loop reads, else what it was piped.
        let input = match &prepared.input {
            Some(text) => text.clone(),
            None if NO_INPUT.contains(&name.as_str()) && !session.functions.contains_key(&name) => String::new(),
            None => session.input.as_ref().map_or_else(|| stdin.to_string(), |input| input.remaining().to_string()),
        };
        execute(&name, &arguments, &input, session, depth)
    };

    for (name, previous) in saved {
        match previous {
            Some(value) => session.variables.insert(name, value),
            None => session.variables.remove(&name),
        };
    }

    let output = finish(prepared, output);
    session.last_status = output.code;
    output
}

/// Runs one resolved command: a function, a shell builtin, a `pi-builtins`
/// coreutil, or a spawned process.
fn execute(name: &str, arguments: &[String], stdin: &str, session: &mut Session, depth: usize) -> Run {
    if let Some(body) = session.functions.get(name).cloned() {
        return call(&body, arguments, stdin, session, depth);
    }

    // Shell builtins first: these need the session and cannot be a subprocess.
    match name {
        ":" | "true" => return Run::default(),
        "false" => return Run { code: 1, ..Default::default() },
        "cd" => return Run::from(session.cd(arguments.first().map(String::as_str))),
        "export" => return Run::from(session.export(arguments)),
        "unset" => {
            for name in arguments.iter().filter(|a| !a.starts_with('-')) {
                session.variables.remove(name);
                session.functions.remove(name);
            }
            return Run::default();
        }
        "alias" => return Run::from(session.alias(arguments)),
        "exit" => {
            let code = arguments.first().and_then(|a| a.parse().ok()).unwrap_or(session.last_status);
            session.exited = Some(code);
            return Run { code, ..Default::default() };
        }
        "return" => {
            let code = arguments.first().and_then(|a| a.parse().ok()).unwrap_or(session.last_status);
            return Run { code, flow: Some(Flow::Return), ..Default::default() };
        }
        "break" | "continue" => {
            let levels = arguments.first().and_then(|a| a.parse().ok()).unwrap_or(1u32).max(1);
            let flow = if name == "break" { Flow::Break(levels) } else { Flow::Continue(levels) };
            return Run { flow: Some(flow), ..Default::default() };
        }
        "source" | "." => {
            let Some((path, rest)) = arguments.split_first() else {
                return Run::error(format!("{name}: filename argument required"), 2);
            };
            let script = match fs::read_to_string(session.resolve(path)) {
                Ok(script) => script,
                Err(error) => return Run::error(format!("{name}: {path}: {error}"), 1),
            };
            let saved = (!rest.is_empty()).then(|| std::mem::replace(&mut session.positional, rest.to_vec()));
            let mut result = crate::run(&script, session, stdin);
            if let Some(positional) = saved {
                session.positional = positional;
            }
            if result.flow == Some(Flow::Return) {
                result.flow = None;
            }
            return result;
        }
        "eval" => return crate::run(&arguments.join(" "), session, stdin),
        "test" => return test(arguments, session, false),
        "[" => {
            return match arguments.split_last() {
                Some((last, rest)) if last == "]" => test(rest, session, false),
                _ => Run::error("[: missing `]`", 2),
            }
        }
        "[[" => {
            return match arguments.split_last() {
                Some((last, rest)) if last == "]]" => test(rest, session, true),
                _ => Run::error("[[: missing `]]`", 2),
            }
        }
        "printf" => {
            let (target, format) = match arguments {
                [flag, variable, rest @ ..] if flag == "-v" => (Some(variable.clone()), rest),
                _ => (None, arguments),
            };
            return match crate::builtins::printf(format) {
                Ok(text) => match target {
                    Some(variable) => {
                        session.variables.insert(variable, text);
                        Run::default()
                    }
                    None => Run { stdout: text, ..Default::default() },
                },
                Err(message) => Run::error(format!("printf: {message}"), 1),
            };
        }
        "local" => return local(arguments, session),
        "declare" | "typeset" => return declare(arguments, session),
        "set" => return set(arguments, session),
        "shift" => {
            let count: usize = arguments.first().and_then(|a| a.parse().ok()).unwrap_or(1);
            if count > session.positional.len() {
                return Run { code: 1, ..Default::default() };
            }
            session.positional.drain(..count);
            return Run::default();
        }
        "let" => {
            let mut last = 0;
            for expression in arguments {
                match arith::evaluate(expression, &mut Variables(&mut session.variables)) {
                    Ok(value) => last = value,
                    Err(message) => return Run::error(format!("let: {message}"), 1),
                }
            }
            return Run { code: i32::from(last == 0), ..Default::default() };
        }
        "wait" => return Run::default(),
        "trap" => return Run::error("trap: not supported in the embedded shell", 1),
        "type" => return describe_all(arguments, session),
        "command" if arguments.first().is_some_and(|a| a == "-v" || a == "-V") => return describe_all(&arguments[1..], session),
        "command" => {
            // `command name args`: the command itself, skipping functions.
            let Some((target, rest)) = arguments.split_first() else { return Run::default() };
            let functions = std::mem::take(&mut session.functions);
            let result = execute(target, rest, stdin, session, depth);
            session.functions = functions;
            return result;
        }
        "which" => {
            let target = arguments.first().map(String::as_str).unwrap_or("");
            return if pi_builtins::is_builtin(target) {
                Run { stdout: format!("{target}: shell builtin\n"), ..Default::default() }
            } else {
                match which(target, session) {
                    Some(path) => Run { stdout: format!("{}\n", path.display()), ..Default::default() },
                    None => Run::error(format!("{target} not found"), 1),
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
                return execute(head, &combined, stdin, session, depth);
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

/// Calls a function: its arguments become `$1`…, its `local`s are undone on
/// the way out, and a `return` stops there.
fn call(body: &Node, arguments: &[String], stdin: &str, session: &mut Session, depth: usize) -> Run {
    if session.call_depth >= MAX_CALL_DEPTH {
        return Run::fatal(format!("functions nested more than {MAX_CALL_DEPTH} deep"));
    }
    let positional = std::mem::replace(&mut session.positional, arguments.to_vec());
    session.locals.push(Vec::new());
    session.call_depth += 1;
    let mut result = run_at(body, session, stdin, depth);
    session.call_depth -= 1;
    for (name, previous) in session.locals.pop().unwrap_or_default().into_iter().rev() {
        match previous {
            Some(value) => session.variables.insert(name, value),
            None => session.variables.remove(&name),
        };
    }
    session.positional = positional;
    // A `break` cannot leave a function, and a `return` ends here.
    result.flow = None;
    result
}

fn test(arguments: &[String], session: &Session, double: bool) -> Run {
    match crate::builtins::test(arguments, &session.cwd, double) {
        Ok(true) => Run::default(),
        Ok(false) => Run { code: 1, ..Default::default() },
        Err(message) => Run::error(format!("{}: {message}", if double { "[[" } else { "test" }), 2),
    }
}

/// `read [-r] [-p prompt] [name...]`: one line, from the command's own
/// redirection, else the stream its loop reads, else what it was piped.
fn read(arguments: &[String], redirected: Option<&str>, stdin: &str, session: &mut Session) -> Run {
    let mut raw = false;
    let mut names = Vec::new();
    let mut options = arguments.iter();
    while let Some(argument) = options.next() {
        match argument.as_str() {
            "-r" => raw = true,
            "-p" | "-t" | "-n" | "-N" | "-u" | "-d" => {
                options.next();
            }
            "-s" | "-e" => {}
            "-a" => return Run::error("read: arrays are not supported in the embedded shell", 2),
            other if other.starts_with('-') && other.len() > 1 => raw |= other.contains('r'),
            other => names.push(other.to_string()),
        }
    }
    let first_line = |text: &str| (!text.is_empty()).then(|| text.split('\n').next().unwrap_or_default().trim_end_matches('\r').to_string());
    let line = match (redirected, session.input.as_mut()) {
        (Some(text), _) => first_line(text),
        (None, Some(input)) => input.line(),
        (None, None) => first_line(stdin),
    };
    match line {
        Some(line) => {
            for (name, value) in crate::builtins::read_fields(&line, &names, raw) {
                session.variables.insert(name, value);
            }
            Run::default()
        }
        None => {
            // At the end of input the names are emptied and `read` fails,
            // which is what ends `while read`.
            let names = if names.is_empty() { vec!["REPLY".to_string()] } else { names };
            for name in names {
                session.variables.insert(name, String::new());
            }
            Run { code: 1, ..Default::default() }
        }
    }
}

fn local(arguments: &[String], session: &mut Session) -> Run {
    if session.locals.is_empty() {
        return Run::error("local: can only be used in a function", 1);
    }
    for argument in arguments.iter().filter(|a| !a.starts_with('-')) {
        let (name, value) = match argument.split_once('=') {
            Some((name, value)) => (name.to_string(), Some(value.to_string())),
            None => (argument.clone(), None),
        };
        let previous = session.variables.get(&name).cloned();
        if let Some(frame) = session.locals.last_mut() {
            if !frame.iter().any(|(known, _)| *known == name) {
                frame.push((name.clone(), previous));
            }
        }
        match value {
            Some(value) => session.variables.insert(name, value),
            None => session.variables.remove(&name),
        };
    }
    Run::default()
}

/// `declare` / `typeset`: `-x` exports, and inside a function the names are
/// local, as bash makes them.
fn declare(arguments: &[String], session: &mut Session) -> Run {
    let flags: String = arguments.iter().filter(|a| a.starts_with('-')).flat_map(|a| a.chars().skip(1)).collect();
    if flags.contains('a') || flags.contains('A') {
        return Run::error("declare: arrays are not supported in the embedded shell", 2);
    }
    let names: Vec<String> = arguments.iter().filter(|a| !a.starts_with('-')).cloned().collect();
    if flags.contains('f') {
        let mut listed: Vec<&String> = session.functions.keys().collect();
        listed.sort();
        return Run { stdout: listed.iter().map(|name| format!("{name}\n")).collect(), ..Default::default() };
    }
    if !session.locals.is_empty() && !flags.contains('g') {
        let result = local(&names, session);
        if result.code != 0 {
            return result;
        }
    } else {
        for argument in &names {
            if let Some((name, value)) = argument.split_once('=') {
                session.variables.insert(name.to_string(), value.to_string());
            }
        }
    }
    if flags.contains('x') {
        return Run::from(session.export(&names));
    }
    Run::default()
}

/// `set`: `-e`, `-o pipefail`, `--` and positional parameters. Other flags
/// (`-u`, `-x`, ...) are accepted and have no effect here.
fn set(arguments: &[String], session: &mut Session) -> Run {
    if arguments.is_empty() {
        let mut names: Vec<&String> = session.variables.keys().collect();
        names.sort();
        let stdout = names.iter().map(|name| format!("{name}={}\n", session.variables[*name])).collect();
        return Run { stdout, ..Default::default() };
    }
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        if argument == "--" {
            session.positional = arguments[index + 1..].to_vec();
            return Run::default();
        }
        let on = argument.starts_with('-');
        if !(on || argument.starts_with('+')) || argument.len() < 2 {
            session.positional = arguments[index..].to_vec();
            return Run::default();
        }
        for flag in argument.chars().skip(1) {
            match flag {
                'e' => session.errexit = on,
                'o' => {
                    index += 1;
                    match arguments.get(index).map(String::as_str) {
                        Some("pipefail") => session.pipefail = on,
                        Some("errexit") => session.errexit = on,
                        _ => {}
                    }
                }
                'u' | 'x' | 'v' | 'f' | 'h' | 'B' | 'H' | 'm' | 'b' | 'C' | 'n' | 'a' | 'E' | 'T' | 'P' => {}
                other => return Run::error(format!("set: -{other}: invalid option"), 2),
            }
        }
        index += 1;
    }
    Run::default()
}

/// `type` and `command -v`: what each name would run.
fn describe_all(names: &[String], session: &Session) -> Run {
    let mut result = Run::default();
    for name in names.iter().filter(|a| !a.starts_with('-')) {
        match describe_command(name, session) {
            Some(found) => result.stdout.push_str(&format!("{found}\n")),
            None => result.code = 1,
        }
    }
    result
}

fn describe_command(name: &str, session: &Session) -> Option<String> {
    if session.functions.contains_key(name) {
        return Some(format!("{name} is a function"));
    }
    if let Some(expansion) = session.aliases.get(name) {
        return Some(format!("alias {name}='{expansion}'"));
    }
    const SHELL: &[&str] = &[
        ":", "cd", "export", "unset", "alias", "exit", "return", "break", "continue", "source", ".", "eval", "test", "[",
        "[[", "printf", "local", "declare", "typeset", "set", "shift", "let", "read", "wait", "type", "command", "which",
    ];
    if SHELL.contains(&name) || pi_builtins::is_builtin(name) {
        return Some(name.to_string());
    }
    which(name, session).map(|path| path.display().to_string())
}

/// Arithmetic assignments, written to the session's variables.
struct Variables<'a>(&'a mut HashMap<String, String>);

impl Scope for Variables<'_> {
    fn get(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
    fn set(&mut self, name: &str, value: i64) -> Result<(), String> {
        self.0.insert(name.to_string(), value.to_string());
        Ok(())
    }
}

fn run_external(name: &str, arguments: &[String], stdin: &str, session: &mut Session) -> Run {
    if let Some(reason) = session.policy.refuse(name, arguments) {
        return Run { refused: vec![format!("{name}: {reason}")], ..Run::error(format!("{name}: {reason}"), 126) };
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
            return Run::error(format!("{name}: {error}{hint}"), 127);
        }
    };

    // Written from another thread: a child that fills its output pipe before
    // reading all its input would otherwise wait on us while we wait on it.
    let writer = child.stdin.take().map(|mut handle| {
        let input = stdin.to_string();
        std::thread::spawn(move || {
            // A child that exits before reading gives EPIPE here; that is not
            // a failure of the command, so it is ignored.
            let _ = handle.write_all(input.as_bytes());
        })
    });

    let result = match child.wait_with_output() {
        Ok(output) => Run {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            code: output.status.code().unwrap_or(-1),
            ..Default::default()
        },
        Err(error) => Run::error(format!("{name}: {error}"), 1),
    };
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    result
}

/// Finds an executable on PATH.
fn which(name: &str, session: &Session) -> Option<PathBuf> {
    let path = session.variables.get("PATH").cloned().or_else(|| std::env::var("PATH").ok())?;

    let separator = if cfg!(windows) { ';' } else { ':' };
    // On Windows a bare name needs an extension appended before it resolves.
    let extensions: Vec<&str> = if cfg!(windows) { vec!["", ".exe", ".cmd", ".bat"] } else { vec![""] };

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

fn expand(word: &Word, session: &mut Session, depth: usize, noglob: bool) -> Result<Vec<String>, String> {
    // `"$@"` is each positional parameter as its own word — what makes
    // `for arg in "$@"` see arguments that contain spaces whole.
    if let [Piece::Quoted(text)] = word.pieces.as_slice() {
        if text == "$@" || text == "${@}" {
            return Ok(session.positional.clone());
        }
    }

    // Most words run no command: expand them against the session as it is,
    // without the copy a substitution needs.
    let substitutes = word.pieces.iter().any(|piece| matches!(piece, Piece::Command(_) | Piece::QuotedCommand(_) | Piece::Arithmetic(_)));
    if !substitutes {
        let context = Context {
            variables: &session.variables,
            cwd: &session.cwd,
            home: &session.home,
            last_status: session.last_status,
            positional: &session.positional,
            noglob,
        };
        return expand_word(word, &context, &mut |_| Err("no command to substitute".to_string()));
    }

    // Command substitution needs to run commands, which needs the session — so
    // the session is cloned for the nested run and its variable changes are
    // discarded, exactly as a subshell's are.
    let mut nested = session.clone();
    let variables = session.variables.clone();
    let cwd = session.cwd.clone();
    let home = session.home.clone();
    let positional = session.positional.clone();
    let last_status = session.last_status;

    let context = Context { variables: &variables, cwd: &cwd, home: &home, last_status, positional: &positional, noglob };

    expand_word(word, &context, &mut |command| {
        // Checked here rather than inside the nested run: a substitution that
        // hits the ceiling must fail the word, not quietly expand to nothing.
        if depth >= MAX_SUBSTITUTION_DEPTH {
            return Err(format!("command substitution nested more than {MAX_SUBSTITUTION_DEPTH} deep"));
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
    Ok(expand(word, session, depth, false)?.join(" "))
}

/// Expands variables in a heredoc body.
///
/// Deliberately not tokenized: a heredoc's newlines and runs of spaces are its
/// content, and word-splitting the body would collapse them all into single
/// spaces — turning a two-line document into one line.
fn expand_text(text: &str, session: &mut Session) -> Result<String, String> {
    let context = Context {
        variables: &session.variables,
        cwd: &session.cwd,
        home: &session.home,
        last_status: session.last_status,
        positional: &session.positional,
        noglob: true,
    };
    crate::expand::expand_variables(text, &context)
}
