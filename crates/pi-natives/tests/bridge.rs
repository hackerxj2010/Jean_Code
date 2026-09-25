//! Every stateful and newly-bridged operation, driven through `dispatch` the
//! way the TypeScript side drives it: one JSON request in, one JSON line out.

use pi_builtins::json::{self, Json};
use pi_natives::handlers::dispatch;
use pi_natives::ops::State;
use pi_natives::protocol::Request;
use std::path::PathBuf;

fn call(state: &mut State, method: &str, params: &str) -> Json {
    let line = format!(r#"{{"id":"t","method":"{method}","params":{params}}}"#);
    let response = dispatch(&Request::parse(&line).expect("request parses"), state);
    let Json::Object(map) = json::parse(&response).expect("response parses") else {
        panic!("not an object: {response}")
    };
    match map.get("ok") {
        Some(Json::Bool(true)) => map.get("result").cloned().unwrap_or(Json::Null),
        _ => panic!("{method} failed: {response}"),
    }
}

fn call_err(state: &mut State, method: &str, params: &str) -> String {
    let line = format!(r#"{{"id":"t","method":"{method}","params":{params}}}"#);
    let response = dispatch(&Request::parse(&line).expect("request parses"), state);
    assert!(response.contains("\"ok\":false"), "{method} should fail: {response}");
    response
}

fn temp(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pi-natives-{name}-{}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn quoted(path: &std::path::Path) -> String {
    Json::String(path.to_string_lossy().to_string()).to_compact()
}

fn field<'a>(value: &'a Json, key: &str) -> &'a Json {
    let Json::Object(map) = value else { panic!("not an object") };
    map.get(key).unwrap_or_else(|| panic!("missing {key}"))
}

fn text(value: &Json, key: &str) -> String {
    field(value, key).as_str().unwrap_or_default().to_string()
}

#[test]
fn shell_inspect_sees_every_command_and_the_constructs_it_cannot_run() {
    let mut state = State::default();
    let result = call(&mut state, "shell.inspect", r#"{"command":"cd build && rm -rf dist | tee log"}"#);
    let Json::Array(commands) = field(&result, "commands") else { panic!() };
    let lines: Vec<String> = commands.iter().map(|c| text(c, "line")).collect();
    assert_eq!(lines, vec!["cd build", "rm -rf dist", "tee log"]);
    assert_eq!(field(&result, "needsSystemShell"), &Json::Null);

    // A loop is run here, and what it runs is seen; arrays are not.
    let looped = call(&mut state, "shell.inspect", r#"{"command":"for f in *; do rm $f; done"}"#);
    assert_eq!(field(&looped, "needsSystemShell"), &Json::Null);
    let Json::Array(inside) = field(&looped, "commands") else { panic!() };
    assert_eq!(inside.iter().map(|c| text(c, "line")).collect::<Vec<_>>(), vec!["rm $f"]);
    let arrays = call(&mut state, "shell.inspect", r#"{"command":"files=(a b)"}"#);
    assert!(text(&arrays, "needsSystemShell").contains("arrays"));
}

#[test]
fn a_shell_session_keeps_its_variables_and_directory_between_calls() {
    let mut state = State::default();
    let root = temp("shell");
    std::fs::create_dir_all(root.join("sub")).unwrap();
    let opened = call(&mut state, "shell.open", &format!(r#"{{"cwd":{}}}"#, quoted(&root)));
    let id = text(&opened, "id");

    call(&mut state, "shell.run", &format!(r#"{{"session":"{id}","command":"export GREETING=hello && cd sub"}}"#));
    let echoed = call(&mut state, "shell.run", &format!(r#"{{"session":"{id}","command":"echo $GREETING"}}"#));
    assert_eq!(text(&echoed, "stdout").trim(), "hello");
    assert!(text(&echoed, "cwd").ends_with("sub"), "{}", text(&echoed, "cwd"));

    // Loops and functions run; what the shell cannot run is refused rather
    // than half-run.
    let looped = call(&mut state, "shell.run", &format!(r#"{{"session":"{id}","command":"for i in 1 2 3; do echo $i; done"}}"#));
    assert_eq!(text(&looped, "stdout"), "1
2
3
");
    call_err(&mut state, "shell.run", &format!(r#"{{"session":"{id}","command":"files=(a b c)"}}"#));

    assert_eq!(call(&mut state, "shell.close", &format!(r#"{{"session":"{id}"}}"#)), Json::Bool(true));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn an_isolated_view_merges_back_only_what_changed() {
    let mut state = State::default();
    let source = temp("iso-src");
    std::fs::write(source.join("a.txt"), "a").unwrap();
    std::fs::create_dir_all(source.join("node_modules")).unwrap();
    std::fs::write(source.join("node_modules/dep.js"), "dep").unwrap();
    let destination = temp("iso-view").join("view");

    let created = call(
        &mut state,
        "iso.create",
        &format!(r#"{{"source":{},"destination":{},"exclude":["node_modules",".git"]}}"#, quoted(&source), quoted(&destination)),
    );
    let id = text(&created, "id");
    assert!(!destination.join("node_modules").exists());

    std::fs::write(destination.join("a.txt"), "changed").unwrap();
    let merged = call(&mut state, "iso.merge", &format!(r#"{{"id":"{id}"}}"#));
    assert_eq!(field(&merged, "applied"), &Json::Number(1.0));
    assert_eq!(std::fs::read_to_string(source.join("a.txt")).unwrap(), "changed");
    assert_eq!(call(&mut state, "iso.discard", &format!(r#"{{"id":"{id}"}}"#)), Json::Bool(true));
    std::fs::remove_dir_all(&source).ok();
}

#[test]
fn a_compacted_frame_can_be_recovered_in_full() {
    let mut state = State::default();
    let store = temp("snap");
    let frame = call(
        &mut state,
        "snap.frame",
        &format!(
            r#"{{"store":{},"turns":[{{"role":"user","text":"fix src/auth/login.ts"}},{{"role":"tool","text":"Error: TypeError at src/auth/login.ts:42"}}]}}"#,
            quoted(&store)
        ),
    );
    let hash = text(&frame, "hash");
    let Json::Array(entities) = field(&frame, "entities") else { panic!() };
    assert!(entities.iter().any(|e| text(e, "text").contains("src/auth/login.ts")));

    let full = call(&mut state, "snap.get", &format!(r#"{{"store":{},"hash":"{hash}"}}"#, quoted(&store)));
    assert!(full.as_str().unwrap().contains("TypeError at src/auth/login.ts:42"));
    std::fs::remove_dir_all(&store).ok();
}

#[test]
fn tokens_are_counted_for_one_text_or_many() {
    let mut state = State::default();
    let one = call(&mut state, "tokens.count", r#"{"text":"The quick brown fox jumps over the lazy dog."}"#);
    let Json::Number(count) = field(&one, "tokens") else { panic!() };
    assert!(*count > 5.0 && *count < 20.0, "{count}");

    let many = call(&mut state, "tokens.count", r#"{"texts":["a","hello world, again"]}"#);
    let Json::Array(counts) = many else { panic!() };
    assert_eq!(counts.len(), 2);
}

#[test]
fn audio_is_probed_and_prepared_for_transcription() {
    let mut state = State::default();
    let dir = temp("voice");
    // One second of silence, half a second of tone, one second of silence.
    let rate = 44_100u32;
    let mut samples = vec![0i16; rate as usize];
    samples.extend((0..rate / 2).map(|i| ((i as f32 * 0.05).sin() * 12_000.0) as i16));
    samples.extend(vec![0i16; rate as usize]);
    let frame = pi_voice::Frame::new(samples, rate, 1);
    let path = dir.join("clip.wav");
    std::fs::write(&path, pi_voice::encode(&frame)).unwrap();

    let probed = call(&mut state, "voice.probe", &format!(r#"{{"path":{}}}"#, quoted(&path)));
    assert_eq!(field(&probed, "sampleRate"), &Json::Number(44_100.0));
    let Json::Array(speech) = field(&probed, "speech") else { panic!() };
    assert_eq!(speech.len(), 1, "one burst of sound: {speech:?}");

    let out = dir.join("prepared.wav");
    let prepared = call(&mut state, "voice.prepare", &format!(r#"{{"path":{},"output":{}}}"#, quoted(&path), quoted(&out)));
    assert_eq!(field(&prepared, "sampleRate"), &Json::Number(16_000.0));
    let Json::Number(duration) = field(&prepared, "durationMs") else { panic!() };
    assert!(*duration < 2500.0, "silence was trimmed: {duration}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn memory_is_scoped_to_its_project() {
    let mut state = State::default();
    let dir = temp("memory");
    let log = quoted(&dir.join("memory.log"));
    call(&mut state, "memory.remember", &format!(r#"{{"path":{log},"name":"a","kind":"pattern","text":"zebra deploys use blue green","project":"P1"}}"#));
    call(&mut state, "memory.remember", &format!(r#"{{"path":{log},"name":"b","kind":"project","text":"zebra lives in project two","project":"P2"}}"#));
    call(&mut state, "memory.remember", &format!(r#"{{"path":{log},"name":"c","kind":"user","text":"zebra fan everywhere"}}"#));

    let recalled = call(&mut state, "memory.recall", &format!(r#"{{"path":{log},"query":"zebra","project":"P1","limit":10}}"#));
    let Json::Array(hits) = recalled else { panic!() };
    let names: Vec<String> = hits.iter().map(|h| text(h, "name")).collect();
    assert!(names.contains(&"a".to_string()));
    assert!(names.contains(&"c".to_string()), "global memories apply everywhere");
    assert!(!names.contains(&"b".to_string()), "another project's memory stays there");

    assert_eq!(call(&mut state, "memory.count", &format!(r#"{{"path":{log}}}"#)), Json::Number(3.0));
    let Json::Number(id) = field(&hits[0], "id") else { panic!() };
    assert_eq!(call(&mut state, "memory.forget", &format!(r#"{{"path":{log},"id":{id}}}"#)), Json::Bool(true));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_process_tree_is_listed_and_killed() {
    let mut state = State::default();
    let mut child = if cfg!(windows) {
        std::process::Command::new("cmd").args(["/C", "ping -n 30 127.0.0.1 > NUL"]).spawn()
    } else {
        std::process::Command::new("sh").args(["-c", "sleep 30"]).spawn()
    }
    .expect("spawns");
    let pid = child.id();

    let all = call(&mut state, "sys.processes", "{}");
    let Json::Array(list) = all else { panic!() };
    assert!(list.iter().any(|p| field(p, "pid") == &Json::Number(f64::from(pid))));

    let report = call(&mut state, "sys.kill_tree", &format!(r#"{{"pid":{pid}}}"#));
    assert!(!text(&report, "summary").is_empty());
    let _ = child.wait();
    assert!(!pi_sys::process::exists(pid), "the process is gone");
}

#[test]
fn a_literal_search_finds_lines_across_a_tree() {
    let mut state = State::default();
    let root = temp("search");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/a.ts"), "const rateLimiter = 1\nother\n").unwrap();
    std::fs::write(root.join("src/b.md"), "RateLimiter docs\n").unwrap();
    let found = call(&mut state, "walk.search", &format!(r#"{{"root":{},"pattern":"ratelimiter"}}"#, quoted(&root)));
    let Json::Array(hits) = found else { panic!() };
    assert_eq!(hits.len(), 2, "case-insensitive by default: {hits:?}");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn anchors_match_the_hashline_crate() {
    let mut state = State::default();
    let result = call(&mut state, "hashline.anchors", r#"{"lines":["  let x = 1;","let x = 1;"]}"#);
    let Json::Array(anchors) = result else { panic!() };
    // Whitespace-normalized: both lines hash the same.
    assert_eq!(anchors[0], anchors[1]);
    assert_eq!(anchors[0].as_str().unwrap(), hashline::anchor_of("let x = 1;"));
}

#[test]
fn a_glob_limit_caps_results_not_the_traversal() {
    let mut state = State::default();
    let root = temp("glob-limit");
    // Forty non-matching files sort ahead of the match, so a walk capped at
    // the result limit would stop before reaching it.
    std::fs::create_dir_all(root.join("aaa")).unwrap();
    for i in 0..40 {
        std::fs::write(root.join(format!("aaa/f{i}.txt")), "x").unwrap();
    }
    std::fs::create_dir_all(root.join("zzz")).unwrap();
    std::fs::write(root.join("zzz/target.rs"), "fn main() {}").unwrap();

    let found = call(&mut state, "walk.glob", &format!(r#"{{"root":{},"pattern":"**/*.rs","limit":5}}"#, quoted(&root)));
    let Json::Array(paths) = field(&found, "paths") else { panic!() };
    assert_eq!(paths.len(), 1, "{paths:?}");

    let hits = call(&mut state, "walk.search", &format!(r#"{{"root":{},"pattern":"fn main","limit":5}}"#, quoted(&root)));
    let Json::Array(hits) = hits else { panic!() };
    assert_eq!(hits.len(), 1);

    let files = call(&mut state, "walk.list", &format!(r#"{{"root":{},"filesOnly":true}}"#, quoted(&root)));
    let Json::Array(listed) = field(&files, "paths") else { panic!() };
    assert_eq!(listed.len(), 41, "directories are left out");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn a_memory_update_supersedes_under_the_same_name() {
    let mut state = State::default();
    let dir = temp("memory-update");
    let log = quoted(&dir.join("memory.log"));
    let first = call(&mut state, "memory.remember", &format!(r#"{{"path":{log},"name":"deploy","kind":"project","text":"deploys go through staging","project":"P"}}"#));
    let Json::Number(id) = field(&first, "id") else { panic!() };
    let updated = call(&mut state, "memory.update", &format!(r#"{{"path":{log},"id":{id},"text":"deploys go straight to prod"}}"#));
    assert_eq!(text(&updated, "name"), "deploy");
    assert_eq!(text(&updated, "project"), "P");
    assert_eq!(call(&mut state, "memory.count", &format!(r#"{{"path":{log}}}"#)), Json::Number(1.0));

    call(&mut state, "memory.remember", &format!(r#"{{"path":{log},"name":"g","kind":"user","text":"deploys are scary"}}"#));
    let strict = call(&mut state, "memory.recall", &format!(r#"{{"path":{log},"query":"deploys","project":"P","strict":true}}"#));
    let Json::Array(hits) = strict else { panic!() };
    assert_eq!(hits.len(), 1, "strict scope leaves global memories out");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_pipeline_runs_every_stage_in_one_call() {
    let mut state = State::default();
    let result = call(
        &mut state,
        "builtins.pipeline",
        r#"{"stdin":"b,2\na,1\nc,3\n","stages":[{"name":"sort","args":["--key=2","--field-separator=,","-n"]},{"name":"cut","args":["-d",",","-f","1"]},{"name":"tr","args":["a-z","A-Z"]}]}"#,
    );
    assert_eq!(text(&result, "stdout"), "A\nB\nC\n");

    // grep finding nothing is an empty result, not a failure.
    let none = call(&mut state, "builtins.pipeline", r#"{"stdin":"x\n","stages":[{"name":"grep","args":["--","zzz"]},{"name":"wc","args":["-l"]}]}"#);
    assert_eq!(field(&none, "code"), &Json::Number(0.0));
    assert_eq!(text(&none, "stdout").trim(), "0");

    let failed = call(&mut state, "builtins.pipeline", r#"{"stdin":"x","stages":[{"name":"jq","args":["--","."]}]}"#);
    assert_eq!(field(&failed, "failedStage"), &Json::Number(0.0));
}
