//! `pi-natives --builtin <name> [args...]`: one coreutil, run as a command.
//!
//! What the shims Jean puts on the shell's PATH call, so a system shell that
//! has no `jq`, `bc`, or `column` — Git Bash has none of them, a stock macOS
//! has no `jq` — still runs the agent's pipeline, with the same
//! implementation the embedded shell and the `text` tool use. A process start
//! of a few milliseconds, where going through Bun would cost a hundred.

use std::io::{Read, Write};

/// Utilities that read their input from stdin when given no file.
const READS_STDIN: &[&str] = &[
    "cat", "wc", "head", "tail", "sort", "uniq", "cut", "fold", "fmt", "expand", "unexpand", "column", "nl",
    "shuf", "cksum", "md5sum", "sha256sum", "tee", "bc", "pr", "paste",
];
/// Utilities whose first positional argument is a pattern or program, not a file.
const PATTERN_FIRST: &[&str] = &["grep", "sed", "awk", "jq"];
/// Utilities that always read stdin.
const ALWAYS_STDIN: &[&str] = &["tr", "xargs"];

/// Whether this invocation takes its input from stdin. Reading it when the
/// utility would not is how `ls` hangs in a shell whose stdin stays open.
fn wants_stdin(name: &str, args: &[String]) -> bool {
    let call = pi_builtins::Invocation::parse(name, args);
    if call.positional.iter().any(|arg| arg == "-") || ALWAYS_STDIN.contains(&name) {
        return true;
    }
    if PATTERN_FIRST.contains(&name) {
        return call.positional.len() <= 1;
    }
    READS_STDIN.contains(&name) && call.positional.is_empty()
}

/// Runs the builtin and returns the process exit code.
pub fn run(arguments: &[String]) -> i32 {
    let Some((name, args)) = arguments.split_first() else {
        eprintln!("usage: pi-natives --builtin <name> [args...]");
        return 2;
    };
    if !pi_builtins::is_builtin(name) {
        eprintln!("{name}: not a Jean builtin");
        return 127;
    }
    let mut stdin = String::new();
    if wants_stdin(name, args) {
        // From a pipe this reads to its end; at a terminal it waits for the
        // user's end-of-input, as the real utility does.
        let mut bytes = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut bytes);
        stdin = String::from_utf8_lossy(&bytes).into_owned();
    }
    let output = pi_builtins::dispatch(name, args, &stdin);
    let _ = std::io::stdout().write_all(output.stdout.as_bytes());
    let _ = std::io::stderr().write_all(output.stderr.as_bytes());
    let _ = std::io::stdout().flush();
    output.code
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn stdin_is_read_only_when_the_utility_would_read_it() {
        assert!(wants_stdin("wc", &args(&["-l"])));
        assert!(!wants_stdin("wc", &args(&["-l", "file.txt"])));
        assert!(wants_stdin("grep", &args(&["-n", "needle"])));
        assert!(!wants_stdin("grep", &args(&["needle", "a.txt"])));
        assert!(wants_stdin("jq", &args(&[".name"])));
        assert!(wants_stdin("tr", &args(&["a-z", "A-Z"])));
        assert!(wants_stdin("cat", &args(&["-"])));
        assert!(!wants_stdin("ls", &args(&["-la"])));
        assert!(!wants_stdin("seq", &args(&["3"])));
    }
}
