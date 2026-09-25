//! The bridge: makes the Rust core reachable from TypeScript.
//!
//! Reads one JSON request per line on stdin, writes one JSON response per line
//! on stdout. Stays up between calls, so the process cost is paid once per
//! session rather than once per operation.
//!
//! ## Why a subprocess rather than a native addon
//!
//! N-API is the obvious answer and the wrong one here. It needs the `napi`
//! toolchain to build, a prebuilt binary per platform and per Node ABI to
//! distribute, and it brings a dependency tree into a workspace whose whole
//! premise is not having one. A crash in an addon takes the host process with
//! it; a crash here does not.
//!
//! Line-delimited JSON over a pipe is what `@jean/lsp`, `@jean/mcp`, and
//! `@jean/dap` already do for exactly this reason. The cost is a serialisation
//! round trip, which is nothing against walking a tree or parsing a file — the
//! operations this exists to make fast.
//!
//! ## Concurrency
//!
//! Most requests are answered in order, on this thread. Language-server and
//! debugger requests (`lsp.*`, `dap.*`) wait on other processes — a
//! `references` on a large project can take seconds — so each runs on its own
//! thread, and its answer is written whenever it is ready. Replies carry the
//! request's id, and the caller pairs them by id, never by order.
//!
//! Every method has a TypeScript fallback, so this binary is an optimisation,
//! never a requirement.

mod cli;
mod handlers;
mod ops;
mod protocol;

use std::io::{BufRead, BufReader, Stdout, Write};
use std::sync::{Arc, Mutex};
use std::thread;

/// Writes one response line. Flushed per response: the caller is waiting on
/// this line, and a buffered reply is a hang that looks like a slow operation.
fn write(out: &Mutex<Stdout>, response: &str) -> bool {
    let mut stdout = out.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    writeln!(stdout, "{response}").is_ok() && stdout.flush().is_ok()
}

fn main() {
    // `--builtin <name> args...`: one coreutil as a command, for the shims on
    // the shell's PATH (see `cli`). Anything else is the bridge.
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.first().map(String::as_str) == Some("--builtin") {
        std::process::exit(cli::run(&arguments[1..]));
    }

    let stdin = BufReader::new(std::io::stdin());
    let out = Arc::new(Mutex::new(std::io::stdout()));
    // Shell sessions, isolated views, and power assertions outlive the call
    // that made them; they live here for as long as the process does.
    let mut state = ops::State::default();

    for line in stdin.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match protocol::Request::parse(trimmed) {
            Ok(request) if handlers::runs_apart(&request.method) => {
                let out = Arc::clone(&out);
                thread::spawn(move || {
                    write(&out, &handlers::dispatch_apart(&request));
                });
            }
            Ok(request) => {
                if !write(&out, &handlers::dispatch(&request, &mut state)) {
                    // The caller closed the pipe. Nothing left to answer to.
                    break;
                }
            }
            // A malformed line has no id to pair with, so the caller matches it
            // by being the only outstanding request. Better than silence.
            Err(message) => {
                if !write(&out, &protocol::failure("", message)) {
                    break;
                }
            }
        }
    }

    // Nobody is left to ask anything: language servers and debug sessions —
    // debuggees included — must not outlive the bridge that started them.
    pi_lsp::hub().shutdown();
    pi_dap::hub().shutdown();
}
