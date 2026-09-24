//! # pi-builtins
//!
//! The 58 coreutils Jean Code runs in-process rather than forking: file ops
//! (`ls`, `cat`, `cp`, `mv`, `rm`, ...), text (`sed`, `awk`, `grep`, `tr`, ...),
//! and data (`jq`, `xargs`, `find`, `bc`, ...).
//!
//! Three reasons these are builtins rather than execs:
//!
//! 1. **Determinism.** `sort` on a Turkish locale reorders `i` and `I`, and a
//!    pipeline whose output depends on the machine's locale is not a pipeline
//!    an agent can reason about. Everything here compares bytes.
//! 2. **Portability.** Windows has no `ls`, and the one Git Bash ships behaves
//!    differently from GNU coreutils, which behaves differently from BSD. One
//!    implementation removes the whole class of "works on my machine".
//! 3. **Cost.** A fork per pipeline stage is milliseconds each; an agent runs
//!    thousands of them.

pub mod data;
pub mod files;
pub mod hash;
pub mod json;
pub mod regex;
pub mod stream;
pub mod text;

pub use text::Output;

use std::path::PathBuf;

/// Names of every builtin this crate provides, in dispatch order.
pub const BUILTINS: &[&str] = &[
    "ls", "cat", "cp", "mv", "rm", "mkdir", "touch", "chmod", "chown", "stat", "file", "wc",
    "head", "tail", "sort", "uniq", "diff", "patch", "sed", "awk", "grep", "tr", "cut", "paste",
    "join", "comm", "fold", "fmt", "expand", "unexpand", "pr", "column", "jq", "xargs", "find",
    "basename", "dirname", "readlink", "realpath", "mktemp", "shuf", "seq", "bc", "date", "env",
    "printenv", "tee", "yes", "echo", "pwd", "test", "true", "false", "sleep", "cksum", "md5sum",
    "sha256sum", "nl",
];

/// Whether a command name is handled in-process.
pub fn is_builtin(name: &str) -> bool {
    BUILTINS.contains(&name)
}

/// A parsed invocation: the flags separated from the positional arguments.
///
/// Flag parsing is done once here rather than in each builtin, because every
/// builtin getting it slightly differently is exactly the inconsistency this
/// crate exists to remove.
#[derive(Debug, Clone, Default)]
pub struct Invocation {
    pub name: String,
    /// Short flags, one character each: `-la` becomes `l` and `a`.
    pub flags: Vec<char>,
    /// Long flags and their optional values: `--color=never`.
    pub options: Vec<(String, Option<String>)>,
    pub positional: Vec<String>,
}

impl Invocation {
    pub fn parse(name: &str, arguments: &[String]) -> Self {
        let mut invocation = Invocation { name: name.to_string(), ..Default::default() };
        let mut literal = false;

        for argument in arguments {
            // Everything after `--` is positional, which is how a file named
            // `-rf` is passed safely.
            if literal {
                invocation.positional.push(argument.clone());
                continue;
            }

            if argument == "--" {
                literal = true;
                continue;
            }

            if let Some(long) = argument.strip_prefix("--") {
                match long.split_once('=') {
                    Some((key, value)) => {
                        invocation.options.push((key.to_string(), Some(value.to_string())))
                    }
                    None => invocation.options.push((long.to_string(), None)),
                }
                continue;
            }

            // A lone `-` means stdin, not a flag.
            if argument.len() > 1 && argument.starts_with('-') {
                invocation.flags.extend(argument.chars().skip(1));
                continue;
            }

            invocation.positional.push(argument.clone());
        }

        invocation
    }

    pub fn has(&self, flag: char) -> bool {
        self.flags.contains(&flag)
    }

    pub fn option(&self, name: &str) -> Option<&str> {
        self.options
            .iter()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| value.as_deref())
    }

    pub fn has_option(&self, name: &str) -> bool {
        self.options.iter().any(|(key, _)| key == name)
    }

    /// A numeric value carried by a flag, as `head -n 20` and `head -20` both do.
    pub fn count(&self, flag: char, long: &str, default: usize) -> usize {
        if let Some(value) = self.option(long) {
            return value.parse().unwrap_or(default);
        }
        // `-n 20`: the value follows as a positional, so pull it back out.
        if self.has(flag) {
            if let Some(first) = self.positional.first() {
                if let Ok(parsed) = first.parse::<usize>() {
                    return parsed;
                }
            }
        }
        default
    }

    fn paths(&self, skip: usize) -> Vec<PathBuf> {
        self.positional.iter().skip(skip).map(PathBuf::from).collect()
    }
}

/// Runs a builtin.
///
/// `stdin` is the piped input, empty when there is none. Returning an `Output`
/// rather than writing to the process's streams is what lets the shell compose
/// these into a pipeline without touching the OS.
pub fn dispatch(name: &str, arguments: &[String], stdin: &str) -> Output {
    let arguments = with_valued_flags_joined(name, arguments);
    let call = Invocation::parse(name, &arguments);

    // Where a builtin reads from a file when given one and from stdin when not,
    // this resolves the input once.
    let input = || -> Result<String, Output> {
        if call.positional.is_empty() {
            return Ok(stdin.to_string());
        }
        let mut combined = String::new();
        for path in call.paths(0) {
            match files::read_text(&path, Some(64 * 1024 * 1024)) {
                Ok(text) => combined.push_str(&text),
                Err(message) => {
                    return Err(Output::fail(format!("{name}: {}: {message}", path.display()), 1))
                }
            }
        }
        Ok(combined)
    };

    macro_rules! text_input {
        () => {
            match input() {
                Ok(text) => text,
                Err(output) => return output,
            }
        };
    }

    match name {
        // ---- file listing and reading ----
        "ls" => {
            let root = call
                .positional
                .first()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            files::ls(
                &root,
                &files::LsOptions {
                    all: call.has('a') || call.has_option("all"),
                    long: call.has('l'),
                    recursive: call.has('R') || call.has_option("recursive"),
                    by_time: call.has('t'),
                    by_size: call.has('S'),
                    reverse: call.has('r'),
                    classify: call.has('F'),
                    limit: call.option("limit").and_then(|v| v.parse().ok()).or(Some(1000)),
                },
            )
        }

        "cat" => {
            if call.positional.is_empty() {
                return Output::ok(stdin.to_string());
            }
            files::cat(
                &call.paths(0),
                &files::CatOptions {
                    number_lines: call.has('n'),
                    squeeze_blank: call.has('s'),
                    show_ends: call.has('E'),
                    max_bytes: Some(64 * 1024 * 1024),
                },
            )
        }

        "cp" => {
            if call.positional.len() < 2 {
                return Output::fail("cp: need a source and a destination", 2);
            }
            let source = PathBuf::from(&call.positional[0]);
            let destination = PathBuf::from(&call.positional[1]);
            files::cp(
                &source,
                &destination,
                &files::CopyOptions {
                    recursive: call.has('r') || call.has('R'),
                    no_clobber: call.has('n'),
                    dry_run: call.has_option("dry-run"),
                },
            )
        }

        "mv" => {
            if call.positional.len() < 2 {
                return Output::fail("mv: need a source and a destination", 2);
            }
            files::mv(
                &PathBuf::from(&call.positional[0]),
                &PathBuf::from(&call.positional[1]),
                call.has('n'),
            )
        }

        "rm" => files::rm(
            &call.paths(0),
            &files::RemoveOptions {
                recursive: call.has('r') || call.has('R'),
                force: call.has('f'),
                dry_run: call.has_option("dry-run"),
            },
        ),

        "mkdir" => files::mkdir(&call.paths(0), call.has('p')),
        "touch" => files::touch(&call.paths(0)),

        "stat" => match call.positional.first() {
            Some(path) => files::stat(&PathBuf::from(path)),
            None => Output::fail("stat: need a path", 2),
        },

        "file" => match call.positional.first() {
            Some(path) => files::file_kind(&PathBuf::from(path)),
            None => Output::fail("file: need a path", 2),
        },

        // `chmod`/`chown` are Unix-only concepts; on Windows they would be a
        // lie. Reporting that beats pretending to succeed.
        "chmod" | "chown" => Output::fail(
            format!("{name}: not supported in-process; run the system command if you need it"),
            1,
        ),

        "readlink" => match call.positional.first() {
            Some(path) => match std::fs::read_link(path) {
                Ok(target) => Output::ok(format!("{}\n", target.display())),
                Err(error) => Output::fail(format!("readlink: {path}: {error}"), 1),
            },
            None => Output::fail("readlink: need a path", 2),
        },

        "realpath" => match call.positional.first() {
            Some(path) => files::realpath(&PathBuf::from(path)),
            None => files::realpath(&PathBuf::from(".")),
        },

        "basename" => Output::ok(format!(
            "{}\n",
            files::basename(
                call.positional.first().map(String::as_str).unwrap_or(""),
                call.positional.get(1).map(String::as_str),
            )
        )),

        "dirname" => Output::ok(format!(
            "{}\n",
            files::dirname(call.positional.first().map(String::as_str).unwrap_or(""))
        )),

        "mktemp" => files::mktemp(call.option("prefix").unwrap_or("jean-"), call.has('d')),

        "tee" => files::tee(stdin, &call.paths(0), call.has('a')),

        // ---- text ----
        "wc" => {
            let text = text_input!();
            let counts = text::wc(&text);
            Output::ok(if call.has('l') {
                format!("{}\n", counts.lines)
            } else if call.has('w') {
                format!("{}\n", counts.words)
            } else if call.has('c') {
                format!("{}\n", counts.bytes)
            } else {
                format!("{:>8}{:>8}{:>8}\n", counts.lines, counts.words, counts.bytes)
            })
        }

        "head" => {
            let count = numeric_count(&call, 10);
            let text = read_after_count(&call, stdin, name);
            match text {
                Ok(text) => text::head(&text, count, call.has('c')),
                Err(output) => output,
            }
        }

        "tail" => {
            let count = numeric_count(&call, 10);
            let text = read_after_count(&call, stdin, name);
            match text {
                Ok(text) => text::tail(&text, count, call.has('c')),
                Err(output) => output,
            }
        }

        "sort" => {
            let text = text_input!();
            text::sort(
                &text,
                &text::SortOptions {
                    numeric: call.has('n'),
                    reverse: call.has('r'),
                    unique: call.has('u'),
                    ignore_case: call.has('f'),
                    key: call.option("key").and_then(|v| v.parse().ok()),
                    separator: call.option("field-separator").and_then(|v| v.chars().next()),
                },
            )
        }

        "uniq" => {
            let text = text_input!();
            text::uniq(
                &text,
                &text::UniqOptions {
                    count: call.has('c'),
                    duplicates_only: call.has('d'),
                    unique_only: call.has('u'),
                    ignore_case: call.has('i'),
                },
            )
        }

        "nl" => {
            let text = text_input!();
            text::nl(&text, 1, !call.has('a'))
        }

        "rev" => {
            let text = text_input!();
            text::rev(&text)
        }

        "column" => {
            let text = text_input!();
            text::column(&text)
        }

        "fold" => {
            let text = text_input!();
            text::fold(&text, call.count('w', "width", 80), call.has('s'))
        }

        "fmt" => {
            let text = text_input!();
            text::fmt(&text, call.count('w', "width", 75))
        }

        "expand" => {
            let text = text_input!();
            text::expand(&text, call.count('t', "tabs", 8))
        }

        "unexpand" => {
            let text = text_input!();
            text::unexpand(&text, call.count('t', "tabs", 8))
        }

        "cut" => {
            let text = text_input!();
            let fields = call
                .option("fields")
                .or_else(|| call.option("characters"))
                .map(String::from)
                .unwrap_or_default();
            let selected = parse_ranges(&fields);
            let by_characters = call.has('c') || call.has_option("characters");
            text::cut(
                &text,
                &text::CutOptions {
                    fields: (!by_characters).then(|| selected.clone()),
                    characters: by_characters.then_some(selected),
                    delimiter: call.option("delimiter").and_then(|v| v.chars().next()),
                    output_delimiter: call.option("output-delimiter").map(String::from),
                    only_delimited: call.has('s'),
                },
            )
        }

        "tr" => {
            // `tr` only ever reads stdin: its arguments are the two character
            // sets, and reading them as files is how `tr a-z A-Z` used to fail.
            let text = stdin.to_string();
            let from = call.positional.first().map(String::as_str).unwrap_or("");
            let to = call.positional.get(1).map(String::as_str).unwrap_or("");
            text::tr(
                &text,
                from,
                to,
                &text::TrOptions {
                    delete: call.has('d'),
                    squeeze: call.has('s'),
                    complement: call.has('c'),
                },
            )
        }

        "paste" => {
            let contents: Vec<String> = call
                .paths(0)
                .iter()
                .map(|path| files::read_text(path, None).unwrap_or_default())
                .collect();
            let borrowed: Vec<&str> = contents.iter().map(String::as_str).collect();
            text::paste(
                &borrowed,
                call.option("delimiters").and_then(|v| v.chars().next()).unwrap_or('\t'),
            )
        }

        "join" | "comm" => {
            if call.positional.len() < 2 {
                return Output::fail(format!("{name}: need two files"), 2);
            }
            let left = files::read_text(&PathBuf::from(&call.positional[0]), None);
            let right = files::read_text(&PathBuf::from(&call.positional[1]), None);
            match (left, right) {
                (Ok(left), Ok(right)) => {
                    if name == "join" {
                        text::join(&left, &right, 1, 1, ' ')
                    } else {
                        text::comm(&left, &right, (call.has('1'), call.has('2'), call.has('3')))
                    }
                }
                (Err(message), _) | (_, Err(message)) => {
                    Output::fail(format!("{name}: {message}"), 1)
                }
            }
        }

        "seq" => {
            let numbers: Vec<f64> =
                call.positional.iter().filter_map(|arg| arg.parse().ok()).collect();
            match numbers.len() {
                1 => text::seq(1.0, numbers[0], 1.0),
                2 => text::seq(numbers[0], numbers[1], 1.0),
                3 => text::seq(numbers[0], numbers[2], numbers[1]),
                _ => Output::fail("seq: need one to three numbers", 2),
            }
        }

        "shuf" => {
            let text = text_input!();
            text::shuf(&text, call.option("head-count").and_then(|v| v.parse().ok()), seed())
        }

        "yes" => text::yes(
            call.positional.first().map(String::as_str).unwrap_or("y"),
            call.option("count").and_then(|v| v.parse().ok()).unwrap_or(100),
        ),

        // ---- stream editors ----
        "sed" => {
            let script = match call.positional.first() {
                Some(script) => script.clone(),
                None => return Output::fail("sed: need a script", 2),
            };
            let text = if call.positional.len() > 1 {
                match files::read_text(&PathBuf::from(&call.positional[1]), None) {
                    Ok(text) => text,
                    Err(message) => return Output::fail(format!("sed: {message}"), 1),
                }
            } else {
                stdin.to_string()
            };
            stream::sed(&text, &script)
        }

        "awk" => {
            let program = match call.positional.first() {
                Some(program) => program.clone(),
                None => return Output::fail("awk: need a program", 2),
            };
            let text = if call.positional.len() > 1 {
                match files::read_text(&PathBuf::from(&call.positional[1]), None) {
                    Ok(text) => text,
                    Err(message) => return Output::fail(format!("awk: {message}"), 1),
                }
            } else {
                stdin.to_string()
            };
            stream::awk(&text, &program, call.option("field-separator").and_then(|v| v.chars().next()))
        }

        "grep" => {
            let pattern = match call.positional.first() {
                Some(pattern) => pattern.clone(),
                None => return Output::fail("grep: need a pattern", 2),
            };

            let options = stream::GrepOptions {
                ignore_case: call.has('i'),
                invert: call.has('v'),
                count: call.has('c'),
                line_numbers: call.has('n'),
                whole_line: call.has('x'),
                fixed: call.has('F'),
            };

            // `-r` searches a tree; without it, files or stdin.
            if call.has('r') || call.has('R') {
                let root = call
                    .positional
                    .get(1)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("."));
                return match data::search(&root, &pattern, call.option("glob"), options.ignore_case, 500) {
                    Ok(hits) => Output {
                        stdout: data::render_hits(&hits),
                        stderr: String::new(),
                        code: if hits.is_empty() { 1 } else { 0 },
                    },
                    Err(message) => Output::fail(format!("grep: {message}"), 2),
                };
            }

            let text = if call.positional.len() > 1 {
                let mut combined = String::new();
                for path in call.paths(1) {
                    match files::read_text(&path, None) {
                        Ok(text) => combined.push_str(&text),
                        Err(message) => {
                            return Output::fail(
                                format!("grep: {}: {message}", path.display()),
                                2,
                            )
                        }
                    }
                }
                combined
            } else {
                stdin.to_string()
            };

            stream::grep(&text, &pattern, &options)
        }

        // ---- data ----
        "jq" => {
            let filter = call.positional.first().map(String::as_str).unwrap_or(".");
            let document = if call.positional.len() > 1 {
                match files::read_text(&PathBuf::from(&call.positional[1]), None) {
                    Ok(text) => text,
                    Err(message) => return Output::fail(format!("jq: {message}"), 1),
                }
            } else {
                stdin.to_string()
            };
            match json::jq(&document, filter, call.has('c')) {
                Ok(out) => Output::ok(out),
                Err(message) => Output::fail(format!("jq: {message}"), 1),
            }
        }

        "find" => {
            let root = call
                .positional
                .first()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            data::find(
                &root,
                &data::FindOptions {
                    name: call.option("name").map(String::from),
                    path: call.option("path").map(String::from),
                    kind: match call.option("type") {
                        Some("f") => Some(data::EntryKind::File),
                        Some("d") => Some(data::EntryKind::Directory),
                        Some("l") => Some(data::EntryKind::Symlink),
                        _ => None,
                    },
                    max_depth: call.option("maxdepth").and_then(|v| v.parse().ok()),
                    min_depth: call.option("mindepth").and_then(|v| v.parse().ok()).unwrap_or(0),
                    limit: call.option("limit").and_then(|v| v.parse().ok()).or(Some(2000)),
                    include_hidden: call.has_option("hidden"),
                    ..Default::default()
                },
            )
        }

        "xargs" => {
            let batches = data::xargs_batches(
                stdin,
                call.option("max-args").and_then(|v| v.parse().ok()).unwrap_or(usize::MAX),
                call.has('0'),
            );
            // Batching only: running the command is the shell's job, and doing
            // it here would bypass the permission layer.
            let lines: Vec<String> = batches.iter().map(|batch| batch.join(" ")).collect();
            Output::ok(text::from_lines(&lines))
        }

        "bc" => {
            let expression = if call.positional.is_empty() {
                stdin.trim().to_string()
            } else {
                call.positional.join(" ")
            };
            data::bc(&expression)
        }

        "diff" => {
            if call.positional.len() < 2 {
                return Output::fail("diff: need two files", 2);
            }
            let left = files::read_text(&PathBuf::from(&call.positional[0]), None);
            let right = files::read_text(&PathBuf::from(&call.positional[1]), None);
            match (left, right) {
                (Ok(left), Ok(right)) => {
                    let patch = data::unified_diff(
                        &left,
                        &right,
                        &call.positional[0],
                        &call.positional[1],
                        call.count('U', "unified", 3),
                    );
                    Output {
                        code: if patch.is_empty() { 0 } else { 1 },
                        stdout: patch,
                        stderr: String::new(),
                    }
                }
                (Err(message), _) | (_, Err(message)) => {
                    Output::fail(format!("diff: {message}"), 2)
                }
            }
        }

        "patch" => {
            let target = match call.positional.first() {
                Some(target) => PathBuf::from(target),
                None => return Output::fail("patch: need a file", 2),
            };
            let original = match files::read_text(&target, None) {
                Ok(text) => text,
                Err(message) => return Output::fail(format!("patch: {message}"), 1),
            };
            match data::apply_patch(&original, stdin) {
                Ok(patched) => match std::fs::write(&target, patched) {
                    Ok(()) => Output::ok(format!("patched {}\n", target.display())),
                    Err(error) => Output::fail(format!("patch: {error}"), 1),
                },
                Err(message) => Output::fail(format!("patch: {message}"), 1),
            }
        }

        "date" => data::date(
            call.positional
                .first()
                .map(|arg| arg.trim_start_matches('+'))
                .unwrap_or("%F %T"),
            call.option("date").and_then(|v| v.parse().ok()),
        ),

        "env" | "printenv" => data::env(call.positional.first().map(String::as_str), call.has_option("reveal")),

        // ---- hashing ----
        "cksum" | "md5sum" | "sha256sum" => {
            let text = text_input!();
            let bytes = text.as_bytes();
            let digest = match name {
                "cksum" => hash::crc32(bytes).to_string(),
                "md5sum" => hash::md5_hex(bytes),
                _ => hash::sha256_hex(bytes),
            };
            let label = call.positional.first().map(String::as_str).unwrap_or("-");
            Output::ok(format!("{digest}  {label}\n"))
        }

        // ---- trivial ----
        "echo" => {
            let joined = call.positional.join(" ");
            Output::ok(if call.has('n') { joined } else { format!("{joined}\n") })
        }

        "pwd" => match std::env::current_dir() {
            Ok(path) => Output::ok(format!("{}\n", files::strip_extended_prefix(&path))),
            Err(error) => Output::fail(format!("pwd: {error}"), 1),
        },

        "true" => Output::ok(String::new()),
        "false" => Output::fail(String::new(), 1),

        "sleep" => {
            let seconds: f64 = call
                .positional
                .first()
                .and_then(|arg| arg.parse().ok())
                .unwrap_or(0.0);
            // Capped: an agent that types `sleep 3600` has made a mistake, and
            // blocking the shell for an hour turns it into a hang report.
            let capped = seconds.min(60.0).max(0.0);
            std::thread::sleep(std::time::Duration::from_secs_f64(capped));
            Output::ok(String::new())
        }

        // `test` takes its raw arguments: `-z` and `-gt` are operators, and the
        // generic flag parser would strip them into `flags` and leave the
        // predicate with nothing to compare.
        "test" | "[" => run_test(&arguments),

        "pr" => {
            let text = text_input!();
            Output::ok(text)
        }

        other => Output::fail(format!("{other}: not a builtin"), 127),
    }
}

/// `head -20` and `head -n 20` both mean twenty lines.
fn numeric_count(call: &Invocation, default: usize) -> usize {
    // A bare numeric short flag: `-20` parses as flags ['2','0'].
    let from_flags: String = call.flags.iter().filter(|c| c.is_ascii_digit()).collect();
    if !from_flags.is_empty() {
        if let Ok(parsed) = from_flags.parse::<usize>() {
            return parsed;
        }
    }
    if let Some(value) = call.option("lines").or_else(|| call.option("bytes")) {
        if let Ok(parsed) = value.parse::<usize>() {
            return parsed;
        }
    }
    if call.has('n') || call.has('c') {
        if let Some(first) = call.positional.first() {
            if let Ok(parsed) = first.parse::<usize>() {
                return parsed;
            }
        }
    }
    default
}

/// Reads input for `head`/`tail`, skipping a leading count that `-n` consumed.
fn read_after_count(call: &Invocation, stdin: &str, name: &str) -> Result<String, Output> {
    let skip = if (call.has('n') || call.has('c'))
        && call.positional.first().is_some_and(|arg| arg.parse::<usize>().is_ok())
    {
        1
    } else {
        0
    };

    let paths: Vec<PathBuf> = call.positional.iter().skip(skip).map(PathBuf::from).collect();
    if paths.is_empty() {
        return Ok(stdin.to_string());
    }

    let mut combined = String::new();
    for path in paths {
        match files::read_text(&path, Some(256 * 1024 * 1024)) {
            Ok(text) => combined.push_str(&text),
            Err(message) => {
                return Err(Output::fail(format!("{name}: {}: {message}", path.display()), 1))
            }
        }
    }
    Ok(combined)
}

/// A value attached to a short flag, as `cut -f1,3`.
/// The short flags of each builtin that take a value, and the long option each
/// one means. `head` and `tail` are absent: their counts already parse.
fn valued_flags(name: &str) -> &'static [(char, &'static str)] {
    match name {
        "cut" => &[('f', "fields"), ('d', "delimiter"), ('c', "characters")],
        "sort" => &[('k', "key"), ('t', "field-separator")],
        "awk" => &[('F', "field-separator")],
        "fold" | "fmt" => &[('w', "width")],
        "expand" | "unexpand" => &[('t', "tabs")],
        "shuf" => &[('n', "head-count")],
        "paste" => &[('d', "delimiters")],
        _ => &[],
    }
}

/// Rewrites `-k 2`, `-k2`, and `--key 2` as `--key=2`.
///
/// The generic parser cannot know that a flag takes a value, so it files the
/// value under positional arguments — where every builtin that reads files
/// then tries to open `2`, `1,3`, or `:` as a path. `cut -f 1` and
/// `sort -k 2` failed with "file not found" for exactly this reason. Joining
/// the value to a long option first leaves nothing ambiguous to parse.
fn with_valued_flags_joined(name: &str, arguments: &[String]) -> Vec<String> {
    let valued = valued_flags(name);
    if valued.is_empty() {
        return arguments.to_vec();
    }

    let long_of = |flag: char| valued.iter().find(|(short, _)| *short == flag).map(|(_, long)| *long);
    let mut out = Vec::with_capacity(arguments.len());
    let mut index = 0;

    while index < arguments.len() {
        let argument = &arguments[index];
        index += 1;

        if argument == "--" {
            out.extend(arguments[index - 1..].iter().cloned());
            break;
        }

        // `--key 2`
        if let Some(long) = argument.strip_prefix("--") {
            if !long.contains('=') && valued.iter().any(|(_, known)| *known == long) {
                if let Some(value) = arguments.get(index) {
                    out.push(format!("--{long}={value}"));
                    index += 1;
                    continue;
                }
            }
            out.push(argument.clone());
            continue;
        }

        // `-rk2`, `-k 2`, `-d,`: flags before the valued one stay a group.
        if argument.len() > 1 && argument.starts_with('-') {
            let chars: Vec<char> = argument.chars().skip(1).collect();
            if let Some(at) = chars.iter().position(|c| long_of(*c).is_some()) {
                let long = long_of(chars[at]).unwrap_or_default();
                if at > 0 {
                    out.push(format!("-{}", chars[..at].iter().collect::<String>()));
                }
                let attached: String = chars[at + 1..].iter().collect();
                let value = if attached.is_empty() {
                    let next = arguments.get(index).cloned().unwrap_or_default();
                    index += 1;
                    next
                } else {
                    attached
                };
                out.push(format!("--{long}={value}"));
                continue;
            }
        }

        out.push(argument.clone());
    }

    out
}

/// Parses `1,3-5` into a list of one-based indices.
fn parse_ranges(spec: &str) -> Vec<usize> {
    let mut indices = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match part.split_once('-') {
            Some((from, to)) => {
                let from: usize = from.trim().parse().unwrap_or(1);
                let to: usize = to.trim().parse().unwrap_or(from);
                for index in from..=to.max(from) {
                    indices.push(index);
                }
            }
            None => {
                if let Ok(index) = part.parse() {
                    indices.push(index);
                }
            }
        }
    }
    indices
}

/// `test` / `[` — the file and string predicates.
fn run_test(arguments: &[String]) -> Output {
    let result = match arguments {
        [] => false,
        [single] => !single.is_empty(),
        [operator, operand] => match operator.as_str() {
            "-e" => PathBuf::from(operand).exists(),
            "-f" => PathBuf::from(operand).is_file(),
            "-d" => PathBuf::from(operand).is_dir(),
            "-s" => std::fs::metadata(operand).map(|m| m.len() > 0).unwrap_or(false),
            "-z" => operand.is_empty(),
            "-n" => !operand.is_empty(),
            "-r" => std::fs::File::open(operand).is_ok(),
            _ => false,
        },
        [left, operator, right] => match operator.as_str() {
            "=" | "==" => left == right,
            "!=" => left != right,
            // Numeric comparisons on unparseable input are false rather than an
            // error, which is what `test` itself does.
            "-eq" => numbers(left, right).is_some_and(|(a, b)| a == b),
            "-ne" => numbers(left, right).is_some_and(|(a, b)| a != b),
            "-lt" => numbers(left, right).is_some_and(|(a, b)| a < b),
            "-le" => numbers(left, right).is_some_and(|(a, b)| a <= b),
            "-gt" => numbers(left, right).is_some_and(|(a, b)| a > b),
            "-ge" => numbers(left, right).is_some_and(|(a, b)| a >= b),
            _ => false,
        },
        _ => false,
    };

    if result {
        Output::ok(String::new())
    } else {
        Output::fail(String::new(), 1)
    }
}

fn numbers(left: &str, right: &str) -> Option<(i64, i64)> {
    Some((left.trim().parse().ok()?, right.trim().parse().ok()?))
}

/// A seed for `shuf`, from the clock.
fn seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x2545_F491_4F6C_DD1D)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_flag_value_is_never_read_as_a_file() {
        let run = |name: &str, list: &[&str], stdin: &str| dispatch(name, &args(list), stdin);

        assert_eq!(run("tr", &["a-z", "A-Z"], "hello").stdout, "HELLO");
        assert_eq!(run("cut", &["-f", "2", "-d", ","], "a,b,c
").stdout, "b
");
        assert_eq!(run("cut", &["-d,", "-f1,3"], "a,b,c
").stdout, "a,c
");
        assert_eq!(run("cut", &["-c", "1-2"], "hello
").stdout, "he
");
        assert_eq!(run("sort", &["-k", "2", "-n"], "x 3
y 1
z 2
").stdout, "y 1
z 2
x 3
");
        assert_eq!(run("sort", &["-rk2"], "x 1
y 3
").stdout, "y 3
x 1
");
        assert_eq!(run("awk", &["-F", ":", "{print $2}"], "a:b
").stdout, "b
");
        assert_eq!(run("fold", &["-w", "2"], "abcd
").code, 0);
        assert_eq!(run("shuf", &["-n", "1"], "a
b
").stdout.lines().count(), 1);
    }

    #[test]
    fn builtin_table_matches_the_documented_count() {
        assert_eq!(BUILTINS.len(), 58);
    }

    #[test]
    fn every_listed_builtin_dispatches() {
        // The failure this catches: a name in the table with no arm, which
        // reports `not a builtin` at runtime having promised otherwise.
        for name in BUILTINS {
            let output = dispatch(name, &[], "");
            assert_ne!(output.code, 127, "{name} is listed but not implemented");
        }
    }

    #[test]
    fn flag_parsing_bundles_short_flags() {
        let call = Invocation::parse("ls", &args(["-la", "--color=never", "src"].as_ref()));
        assert!(call.has('l'));
        assert!(call.has('a'));
        assert_eq!(call.option("color"), Some("never"));
        assert_eq!(call.positional, vec!["src"]);
    }

    #[test]
    fn a_double_dash_ends_flag_parsing() {
        // Without this, a file named `-rf` cannot be passed to `rm` at all.
        let call = Invocation::parse("rm", &args(["--", "-rf"].as_ref()));
        assert!(call.flags.is_empty());
        assert_eq!(call.positional, vec!["-rf"]);
    }

    #[test]
    fn a_lone_dash_is_positional() {
        let call = Invocation::parse("cat", &args(["-"].as_ref()));
        assert_eq!(call.positional, vec!["-"]);
    }

    #[test]
    fn ranges_expand() {
        assert_eq!(parse_ranges("1,3-5"), vec![1, 3, 4, 5]);
        assert_eq!(parse_ranges("2"), vec![2]);
        assert_eq!(parse_ranges(""), Vec::<usize>::new());
    }

    #[test]
    fn head_accepts_both_count_spellings() {
        let text = (1..=20).map(|n| n.to_string()).collect::<Vec<_>>().join("\n");
        let bare = dispatch("head", &args(["-3"].as_ref()), &text);
        let explicit = dispatch("head", &args(["-n", "3"].as_ref()), &text);
        assert_eq!(bare.stdout, explicit.stdout);
        assert_eq!(bare.stdout.lines().count(), 3);
    }

    #[test]
    fn grep_exits_nonzero_when_nothing_matches() {
        let found = dispatch("grep", &args(["needle"].as_ref()), "a needle here\n");
        assert_eq!(found.code, 0);
        let missing = dispatch("grep", &args(["needle"].as_ref()), "nothing\n");
        assert_eq!(missing.code, 1);
    }

    #[test]
    fn sed_substitutes_through_dispatch() {
        let output = dispatch("sed", &args(["s/foo/bar/g"].as_ref()), "foo foo\n");
        assert_eq!(output.stdout, "bar bar\n");
    }

    #[test]
    fn awk_prints_a_field() {
        let output = dispatch("awk", &args(["{print $2}"].as_ref()), "a b c\nd e f\n");
        assert_eq!(output.stdout, "b\ne\n");
    }

    #[test]
    fn jq_reads_stdin() {
        let output = dispatch("jq", &args(["-c", ".a"].as_ref()), r#"{"a": [1,2]}"#);
        assert_eq!(output.stdout.trim(), "[1,2]");
    }

    #[test]
    fn test_predicates() {
        assert_eq!(dispatch("test", &args(["-z", ""].as_ref()), "").code, 0);
        assert_eq!(dispatch("test", &args(["-z", "x"].as_ref()), "").code, 1);
        assert_eq!(dispatch("test", &args(["3", "-gt", "2"].as_ref()), "").code, 0);
        assert_eq!(dispatch("test", &args(["a", "=", "a"].as_ref()), "").code, 0);
    }

    #[test]
    fn echo_honours_n() {
        assert_eq!(dispatch("echo", &args(["hi"].as_ref()), "").stdout, "hi\n");
        assert_eq!(dispatch("echo", &args(["-n", "hi"].as_ref()), "").stdout, "hi");
    }

    #[test]
    fn sha256sum_matches_the_hash_module() {
        let output = dispatch("sha256sum", &[], "abc");
        assert!(output.stdout.starts_with("ba7816bf"), "{}", output.stdout);
    }

    #[test]
    fn an_unknown_command_reports_127() {
        assert_eq!(dispatch("definitely-not-a-builtin", &[], "").code, 127);
    }

    #[test]
    fn chmod_says_it_is_unsupported_rather_than_lying() {
        let output = dispatch("chmod", &args(["755", "x"].as_ref()), "");
        assert_ne!(output.code, 0);
        assert!(output.stderr.contains("not supported"));
    }
}
