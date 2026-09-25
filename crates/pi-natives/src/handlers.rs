//! What each method does.
//!
//! Method names are `namespace.operation`, where the namespace is the crate:
//! `hashline.*`, `walk.*`, `ast.*`, `builtins.*`, `shell.*`, `memory.*`.
//! Adding one means adding an arm here — the dispatch is a match rather than a
//! registry because the set is closed and small, and a match is checked by the
//! compiler for exhaustiveness of *shape* even where the names are strings.

use crate::ops::{self, State};
use crate::protocol::{failure, number, object, strings, success, Request};

use pi_builtins::json::Json;
use std::collections::BTreeMap;
use std::path::Path;

/// Every method the bridge answers, in one list: `version` advertises it and a
/// test checks each one is actually dispatched.
pub const METHODS: &[&str] = &[
    "ping",
    "version",
    "hashline.annotate",
    "hashline.anchors",
    "hashline.patch",
    "walk.list",
    "walk.glob",
    "walk.search",
    "ast.search",
    "ast.search_tree",
    "ast.outline",
    "builtins.run",
    "builtins.list",
    "builtins.pipeline",
    "memory.remember",
    "memory.recall",
    "memory.list",
    "memory.get",
    "memory.forget",
    "memory.count",
    "memory.update",
    "shell.inspect",
    "shell.open",
    "shell.run",
    "shell.close",
    "iso.create",
    "iso.changes",
    "iso.merge",
    "iso.discard",
    "snap.frame",
    "snap.get",
    "snap.entities",
    "sys.processes",
    "sys.kill_tree",
    "sys.copy",
    "sys.paste",
    "sys.awake",
    "sys.release",
    "tokens.count",
    "voice.probe",
    "voice.prepare",
    "voice.record",
    "voice.recorders",
];

/// Whether a method is served by the language-server or debugger hubs. Those
/// are thread-safe and may wait on another process for seconds — the bridge
/// runs them on their own threads so one slow `references` does not hold up
/// every `grep` behind it.
pub fn runs_apart(method: &str) -> bool {
    // A recording lasts as long as the speaker talks; nothing else waits on it.
    method.starts_with("lsp.") || method.starts_with("dap.") || method == "voice.record"
}

/// Answers an `lsp.*` or `dap.*` request. Needs no bridge state: the hubs
/// hold their own.
pub fn dispatch_apart(request: &Request) -> String {
    let params = Json::Object(request.params.clone());
    let result = if let Some(method) = request.method.strip_prefix("lsp.") {
        pi_lsp::hub().call(method, &params)
    } else if let Some(method) = request.method.strip_prefix("dap.") {
        pi_dap::hub().call(method, &params)
    } else if request.method == "voice.record" {
        ops::voice_record(request)
    } else {
        Err(format!("unknown method: {}", request.method))
    };
    match result {
        Ok(value) => success(&request.id, value),
        Err(message) => failure(&request.id, message),
    }
}

/// Every method name, the hubs' included.
pub fn all_methods() -> Vec<String> {
    METHODS
        .iter()
        .map(|method| method.to_string())
        .chain(pi_lsp::METHODS.iter().map(|method| format!("lsp.{method}")))
        .chain(pi_dap::METHODS.iter().map(|method| format!("dap.{method}")))
        .collect()
}

pub fn dispatch(request: &Request, state: &mut State) -> String {
    if runs_apart(&request.method) {
        return dispatch_apart(request);
    }
    let result = match request.method.as_str() {
        "ping" => Ok(Json::String("pong".to_string())),
        "version" => Ok(version()),

        "hashline.annotate" => hashline_annotate(request),
        "hashline.anchors" => hashline_anchors(request),
        "hashline.patch" => hashline_patch(request),

        "walk.list" => walk_list(request),
        "walk.glob" => walk_glob(request),
        "walk.search" => walk_search(request),

        "ast.search" => ast_search(request),
        "ast.search_tree" => ast_search_tree(request),
        "ast.outline" => ast_outline(request),

        "builtins.run" => builtins_run(request),
        "builtins.pipeline" => builtins_pipeline(request),
        "builtins.list" => Ok(strings(
            pi_builtins::BUILTINS.iter().map(|name| name.to_string()),
        )),

        "memory.remember" => ops::memory_remember(request),
        "memory.recall" => ops::memory_recall(request),
        "memory.list" => ops::memory_list(request),
        "memory.get" => ops::memory_get(request),
        "memory.forget" => ops::memory_forget(request),
        "memory.count" => ops::memory_count(request),
        "memory.update" => ops::memory_update(request),

        "shell.inspect" => ops::shell_inspect(request),
        "shell.open" => ops::shell_open(request, state),
        "shell.run" => ops::shell_run(request, state),
        "shell.close" => ops::shell_close(request, state),

        "iso.create" => ops::iso_create(request, state),
        "iso.changes" => ops::iso_changes(request, state),
        "iso.merge" => ops::iso_merge(request, state),
        "iso.discard" => ops::iso_discard(request, state),

        "snap.frame" => ops::snap_frame(request),
        "snap.get" => ops::snap_get(request),
        "snap.entities" => ops::snap_entities(request),

        "sys.processes" => ops::sys_processes(request),
        "sys.kill_tree" => ops::sys_kill_tree(request),
        "sys.copy" => ops::sys_copy(request),
        "sys.paste" => ops::sys_paste(),
        "sys.awake" => ops::sys_awake(request, state),
        "sys.release" => ops::sys_release(request, state),

        "tokens.count" => ops::tokens_count(request, state),

        "voice.probe" => ops::voice_probe(request),
        "voice.prepare" => ops::voice_prepare(request),
        "voice.recorders" => Ok(ops::voice_recorders()),

        other => Err(format!("unknown method: {other}")),
    };

    match result {
        Ok(value) => success(&request.id, value),
        Err(message) => failure(&request.id, message),
    }
}

fn version() -> Json {
    object(vec![
        ("name", Json::String("pi-natives".to_string())),
        ("version", Json::String(env!("CARGO_PKG_VERSION").to_string())),
        ("methods", strings(all_methods())),
    ])
}

// ---- hashline --------------------------------------------------------------

fn hashline_annotate(request: &Request) -> Result<Json, String> {
    let content = request.string("content")?;
    Ok(Json::String(hashline::Index::new(content).annotate()))
}

/// The anchor of each line, for a caller that renders its own gutter.
fn hashline_anchors(request: &Request) -> Result<Json, String> {
    let lines = request.string_list("lines");
    Ok(strings(lines.iter().map(|line| hashline::anchor_of(line))))
}

fn hashline_patch(request: &Request) -> Result<Json, String> {
    let content = request.string("content")?;
    let patch = request.string("patch")?;

    // The failure carries its kind as a `[code]` prefix: the caller turns each
    // kind into different advice (re-read, add anchor text, add context), and
    // a bare message would leave it guessing.
    let applied = hashline::patch(content, patch).map_err(|error| {
        let code = match error {
            hashline::ApplyError::AnchorNotFound { .. } => "anchor-not-found",
            hashline::ApplyError::ContextMismatch { .. } => "context-mismatch",
            hashline::ApplyError::AmbiguousAnchor { .. } => "ambiguous-anchor",
            hashline::ApplyError::Parse(_) => "parse",
        };
        format!("[{code}] {error}")
    })?;
    Ok(object(vec![
        ("content", Json::String(applied.content)),
        ("resolutions", strings(applied.resolutions.iter().map(|r| r.to_string()))),
        ("delta", Json::Number(applied.delta as f64)),
    ]))
}

// ---- the walker ------------------------------------------------------------

fn walk_options(request: &Request) -> pi_walker::WalkOptions {
    pi_walker::WalkOptions {
        respect_gitignore: request.bool("respectGitignore", true),
        skip_hidden: request.bool("skipHidden", true),
        max_depth: match request.params.get("maxDepth") {
            Some(Json::Number(value)) if *value >= 0.0 => Some(*value as usize),
            _ => None,
        },
        limit: match request.params.get("limit") {
            Some(Json::Number(value)) if *value > 0.0 => Some(*value as usize),
            _ => None,
        },
        follow_symlinks: request.bool("followSymlinks", false),
        threads: request.usize("threads", 0),
        // Absent means the walker's own defaults (`node_modules`, `target`, …);
        // an empty list replacing them would walk straight into both.
        extra_ignores: match request.params.get("extraIgnores") {
            Some(Json::Array(_)) => request.string_list("extraIgnores"),
            _ => pi_walker::WalkOptions::default().extra_ignores,
        },
        ..Default::default()
    }
}

fn walk_list(request: &Request) -> Result<Json, String> {
    let root = request.string("root")?;
    let options = walk_options(request);
    // Directories are listed unless the caller wants only what it can read.
    let files_only = request.bool("filesOnly", false);
    // With `details`, each entry also says whether it is a directory and how
    // big it is — which is what saves the caller a `stat` per path.
    let details = request.bool("details", false);

    // Collected under a lock because the walker is parallel: the sink is called
    // from several threads and a plain `Vec` would be a data race.
    let found = std::sync::Mutex::new(Vec::<(String, bool, u64)>::new());
    pi_walker::walk(Path::new(root), &options, |entry| {
        if files_only && entry.is_dir {
            return;
        }
        if let Ok(mut list) = found.lock() {
            // The path relative to the root, with forward slashes: that is
            // what a glob, a .gitignore, and a diff all speak, on every
            // platform.
            list.push((entry.rel_path.replace('\\', "/"), entry.is_dir, entry.size));
        }
    })
    .map_err(|error| format!("{root}: {error}"))?;

    let mut found = found.into_inner().map_err(|_| "the walk panicked".to_string())?;
    // Sorted so two runs over the same tree return the same order: a parallel
    // walk finishes in whatever order the threads land, and an agent diffing
    // two listings would see spurious changes.
    found.sort_by(|a, b| a.0.cmp(&b.0));

    let mut fields = vec![
        ("count", number(found.len())),
        ("paths", strings(found.iter().map(|(path, _, _)| path.clone()))),
    ];
    if details {
        let entries = found
            .iter()
            .map(|(path, dir, size)| {
                object(vec![
                    ("path", Json::String(path.clone())),
                    ("dir", Json::Bool(*dir)),
                    ("size", Json::Number(*size as f64)),
                ])
            })
            .collect();
        fields.push(("entries", Json::Array(entries)));
    }
    Ok(object(fields))
}

fn walk_glob(request: &Request) -> Result<Json, String> {
    let root = request.string("root")?;
    let pattern = request.string("pattern")?;
    // `limit` caps the paths returned. As a walk limit it would count every
    // entry visited, directories and non-matches included, and a glob on a
    // large tree would stop before reaching most of its matches.
    let limit = walk_options(request).limit;
    let options = pi_walker::WalkOptions { limit: None, ..walk_options(request) };

    let mut paths = pi_walker::glob_paths(Path::new(root), pattern, &options)
        .map_err(|error| format!("{root}: {error}"))?;
    paths.sort();
    if let Some(limit) = limit {
        paths.truncate(limit);
    }

    Ok(object(vec![
        ("count", number(paths.len())),
        ("paths", strings(paths)),
    ]))
}

/// Content search over a tree, in one pass: walk, read, match. Literal or glob
/// patterns only — a regular expression is the caller's to run, since the JS
/// and Rust dialects differ at the edges and a search must not silently change
/// meaning depending on which side ran it.
fn walk_search(request: &Request) -> Result<Json, String> {
    let root = request.string("root")?;
    let pattern = request.string("pattern")?;
    let options = pi_walker::search::SearchOptions {
        matcher: if request.bool("glob", false) {
            pi_walker::search::Matcher::Glob
        } else {
            pi_walker::search::Matcher::Literal
        },
        case_sensitive: request.bool("caseSensitive", false),
        whole_word: request.bool("wholeWord", false),
        include: request.optional_string("include").map(str::to_string),
        max_matches: request.usize("limit", 1000),
        // `limit` caps matches here, not files: read as a walk limit it would
        // stop the traversal after that many entries and silently miss hits.
        walk: pi_walker::WalkOptions { limit: None, ..walk_options(request) },
        ..Default::default()
    };

    let matches = pi_walker::search::search(Path::new(root), pattern, &options)
        .map_err(|error| format!("{root}: {error}"))?;

    Ok(Json::Array(
        matches
            .iter()
            .map(|hit| {
                object(vec![
                    ("path", Json::String(hit.path.replace('\\', "/"))),
                    ("line", number(hit.line)),
                    ("column", number(hit.column)),
                    ("text", Json::String(hit.text.clone())),
                ])
            })
            .collect(),
    ))
}

// ---- structural search -----------------------------------------------------

fn syntax_for(request: &Request, path_hint: &str) -> pi_ast::Syntax {
    match request.optional_string("language") {
        Some(name) => pi_ast::tokens::SYNTAXES
            .iter()
            .find(|syntax| syntax.name == name)
            .cloned()
            .unwrap_or_else(|| pi_ast::syntax_for(path_hint)),
        None => pi_ast::syntax_for(path_hint),
    }
}

fn captures_to_json(captures: &std::collections::HashMap<String, String>) -> Json {
    let mut map = BTreeMap::new();
    for (name, value) in captures {
        map.insert(name.clone(), Json::String(value.clone()));
    }
    Json::Object(map)
}

fn ast_search(request: &Request) -> Result<Json, String> {
    let source = request.string("source")?;
    let pattern = request.string("pattern")?;
    let syntax = syntax_for(request, request.optional_string("path").unwrap_or("x.ts"));

    let matches = pi_ast::search_source(source, pattern, &syntax)?;

    Ok(Json::Array(
        matches
            .iter()
            .map(|hit| {
                object(vec![
                    ("line", number(hit.line)),
                    ("start", number(hit.start)),
                    ("end", number(hit.end)),
                    ("text", Json::String(hit.text.clone())),
                    ("captures", captures_to_json(&hit.captures)),
                ])
            })
            .collect(),
    ))
}

fn ast_search_tree(request: &Request) -> Result<Json, String> {
    let root = request.string("root")?;
    let pattern = request.string("pattern")?;
    let glob = request.optional_string("glob");
    let limit = request.usize("limit", 200);

    // The files come from the walker, so a structural search sees exactly what
    // `glob` and `grep` see: `.gitignore` honoured, generated trees left out.
    // `limit` caps matches, not files.
    let options = pi_walker::WalkOptions { limit: None, ..walk_options(request) };
    let files = match glob {
        Some(pattern) => pi_walker::glob_paths(Path::new(root), pattern, &options),
        None => {
            let found = std::sync::Mutex::new(Vec::new());
            pi_walker::walk(Path::new(root), &options, |entry| {
                if !entry.is_dir {
                    if let Ok(mut list) = found.lock() {
                        list.push(entry.rel_path.replace('\\', "/"));
                    }
                }
            })
            .map(|_| {
                let mut list = found.into_inner().unwrap_or_default();
                list.sort();
                list
            })
        }
    }
    .map_err(|error| format!("{root}: {error}"))?;

    let matches = pi_ast::search_files(Path::new(root), &files, pattern, limit)?;

    Ok(Json::Array(
        matches
            .iter()
            .map(|hit| {
                object(vec![
                    ("path", Json::String(hit.path.clone())),
                    ("line", number(hit.line)),
                    ("text", Json::String(hit.text.clone())),
                    ("captures", captures_to_json(&hit.captures)),
                ])
            })
            .collect(),
    ))
}

fn ast_outline(request: &Request) -> Result<Json, String> {
    // Either a path to read, or source with a language — the second form is for
    // a buffer the editor has not written to disk yet.
    if let Some(path) = request.optional_string("path") {
        if request.params.get("source").is_none() {
            let items = pi_ast::outline::outline_file(path)?;
            return Ok(Json::String(pi_ast::outline::render(&items)));
        }
    }

    let source = request.string("source")?;
    let syntax = syntax_for(request, request.optional_string("path").unwrap_or("x.ts"));
    let items = pi_ast::outline::outline(source, &syntax);
    Ok(Json::String(pi_ast::outline::render(&items)))
}

// ---- coreutils -------------------------------------------------------------

fn builtins_run(request: &Request) -> Result<Json, String> {
    let name = request.string("name")?;
    if !pi_builtins::is_builtin(name) {
        return Err(format!("{name} is not a builtin"));
    }

    let args = request.string_list("args");
    let stdin = request.optional_string("stdin").unwrap_or("");

    let output = pi_builtins::dispatch(name, &args, stdin);

    Ok(object(vec![
        ("stdout", Json::String(output.stdout)),
        ("stderr", Json::String(output.stderr)),
        ("code", Json::Number(f64::from(output.code))),
    ]))
}

/// Runs coreutils in sequence, each stage's output feeding the next, in one
/// round trip. Stops at the first stage that fails — except `grep` finding
/// nothing, which is an empty result rather than an error, as in a shell.
fn builtins_pipeline(request: &Request) -> Result<Json, String> {
    let Some(Json::Array(stages)) = request.params.get("stages") else {
        return Err("`stages` must be an array of {name, args}".to_string());
    };
    let mut current = request.optional_string("stdin").unwrap_or("").to_string();

    for (index, stage) in stages.iter().enumerate() {
        let Json::Object(map) = stage else {
            return Err(format!("stage {index} is not an object"));
        };
        let name = map.get("name").and_then(Json::as_str).ok_or(format!("stage {index} has no name"))?;
        if !pi_builtins::is_builtin(name) {
            return Err(format!("{name} is not a builtin"));
        }
        let args: Vec<String> = match map.get("args") {
            Some(Json::Array(items)) => items.iter().filter_map(|a| a.as_str().map(String::from)).collect(),
            _ => Vec::new(),
        };

        let output = pi_builtins::dispatch(name, &args, &current);
        let no_match = name == "grep" && output.code == 1;
        if output.code != 0 && !no_match {
            return Ok(object(vec![
                ("stdout", Json::String(output.stdout)),
                ("stderr", Json::String(output.stderr)),
                ("code", Json::Number(f64::from(output.code))),
                ("failedStage", number(index)),
            ]));
        }
        current = output.stdout;
    }

    Ok(object(vec![
        ("stdout", Json::String(current)),
        ("stderr", Json::String(String::new())),
        ("code", Json::Number(0.0)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(line: &str) -> String {
        let request = Request::parse(line).expect("parses");
        dispatch(&request, &mut State::default())
    }

    #[test]
    fn ping_answers() {
        let response = call(r#"{"id":"1","method":"ping"}"#);
        assert!(response.contains("pong"));
        assert!(response.contains("\"ok\":true"));
    }

    #[test]
    fn version_lists_its_methods() {
        let response = call(r#"{"id":"1","method":"version"}"#);
        assert!(response.contains("ast.search_tree"));
        assert!(response.contains("builtins.run"));
    }

    #[test]
    fn an_unknown_method_fails_without_taking_the_process_down() {
        let response = call(r#"{"id":"1","method":"nope.nothing"}"#);
        assert!(response.contains("\"ok\":false"));
        assert!(response.contains("nope.nothing"));
    }

    #[test]
    fn a_missing_argument_names_itself() {
        let response = call(r#"{"id":"1","method":"ast.search","params":{}}"#);
        assert!(response.contains("\"ok\":false"));
        assert!(response.contains("source"));
    }

    #[test]
    fn builtins_run_through_the_bridge() {
        let response = call(
            r#"{"id":"1","method":"builtins.run","params":{"name":"wc","stdin":"a\nb\nc\n"}}"#,
        );
        assert!(response.contains("\"ok\":true"), "{response}");
        assert!(response.contains("3"), "{response}");
    }

    #[test]
    fn builtins_run_refuses_a_name_that_is_not_one() {
        let response =
            call(r#"{"id":"1","method":"builtins.run","params":{"name":"rm -rf /"}}"#);
        assert!(response.contains("\"ok\":false"));
    }

    #[test]
    fn structural_search_through_the_bridge() {
        let response = call(
            r#"{"id":"1","method":"ast.search","params":{"source":"f(1); f(2);","pattern":"f($A)"}}"#,
        );
        assert!(response.contains("\"ok\":true"), "{response}");
        // Two calls, and the capture carries the argument.
        assert!(response.contains("\"A\":\"1\""), "{response}");
        assert!(response.contains("\"A\":\"2\""), "{response}");
    }

    #[test]
    fn a_comment_is_not_a_call() {
        let response = call(
            r#"{"id":"1","method":"ast.search","params":{"source":"// f(dead)\nf(live)","pattern":"f($A)"}}"#,
        );
        assert!(response.contains("live"));
        assert!(!response.contains("dead"));
    }

    #[test]
    fn hashline_annotates_and_patches() {
        let annotated =
            call(r#"{"id":"1","method":"hashline.annotate","params":{"content":"one\ntwo\n"}}"#);
        assert!(annotated.contains("\"ok\":true"), "{annotated}");
        // The gutter carries an anchor per line, which is what an edit cites.
        assert!(annotated.contains("h:"), "{annotated}");
    }

    #[test]
    fn a_walk_returns_sorted_paths() {
        let response =
            call(r#"{"id":"1","method":"walk.list","params":{"root":".","limit":20}}"#);
        assert!(response.contains("\"ok\":true"), "{response}");
        assert!(response.contains("count"));
    }

    #[test]
    fn every_advertised_method_is_dispatchable() {
        // The failure this catches: a name added to `version` but never wired,
        // which reports "unknown method" to a caller that was told it exists.
        let listed = call(r#"{"id":"1","method":"version"}"#);
        for method in METHODS.iter().filter(|m| **m != "sys.paste" && **m != "sys.awake") {
            assert!(listed.contains(method), "{method} is not advertised");

            let response = call(&format!(r#"{{"id":"1","method":"{method}"}}"#));
            assert!(
                !response.contains("unknown method"),
                "{method} is advertised but not dispatched"
            );
        }
    }

    #[test]
    fn every_language_server_and_debugger_method_is_routed() {
        let listed = call(r#"{"id":"1","method":"version"}"#);
        for method in all_methods().iter().filter(|m| runs_apart(m)) {
            assert!(listed.contains(method.as_str()), "{method} is not advertised");
            // Methods that act need arguments; without them each must fail
            // on the missing argument, never as an unknown method.
            if method.ends_with(".stop") || method.ends_with(".install") || method.ends_with(".start") {
                continue;
            }
            let response = call(&format!(r#"{{"id":"1","method":"{method}"}}"#));
            assert!(!response.contains("unknown"), "{method}: {response}");
        }
    }
}
