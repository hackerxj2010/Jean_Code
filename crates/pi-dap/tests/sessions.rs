//! Debug sessions against a mock adapter that runs a made-up program, over
//! stdio, over TCP, and with js-debug-style child sessions.

use pi_dap::Hub;
use pi_lsp::detect;
use pi_lsp::json::{array, int, object, string, Json, JsonExt};
use std::fs;
use std::path::{Path, PathBuf};

fn bun() -> Option<PathBuf> {
    detect::which("bun", &[], &[])
}

fn fixture() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mock-dap-full.mjs").canonicalize().unwrap().to_string_lossy().to_string()
}

fn workspace(name: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("pi-dap-it-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn hub(root: &Path) -> Hub {
    let hub = Hub::new();
    let bun = bun().unwrap().to_string_lossy().to_string();
    let adapters = object([
        (
            "mock",
            object([
                ("command", array([string(&bun), string(fixture())])),
                ("transport", string("stdio")),
                ("extensions", array([string("prog")])),
                ("defaults", object([("type", string("mock")), ("request", string("launch"))])),
            ]),
        ),
        (
            "mocktcp",
            object([
                ("command", array([string(&bun), string(fixture()), string("--port"), string("{port}")])),
                ("transport", string("tcp")),
                ("extensions", array([string("tprog")])),
            ]),
        ),
        (
            "mockkids",
            object([
                ("command", array([string(&bun), string(fixture()), string("--port"), string("{port}"), string("--children")])),
                ("transport", string("tcp")),
                ("childSessions", Json::Bool(true)),
                ("extensions", array([string("kprog")])),
            ]),
        ),
    ]);
    hub.call("configure", &object([("projectRoot", string(root.to_string_lossy())), ("autoInstall", Json::Bool(false)), ("adapters", adapters)])).unwrap();
    hub
}

const PROGRAM: &str = "print start\nset x\nprint middle\nset y\nprint end\n";

fn program(root: &Path, name: &str, text: &str) -> String {
    let path = root.join(name);
    fs::write(&path, text).unwrap();
    path.to_string_lossy().to_string()
}

fn start(hub: &Hub, program: &str, breakpoints: Json, extra: &[(&str, Json)]) -> Json {
    let mut params = object([("program", string(program)), ("breakpoints", breakpoints), ("waitMs", int(10_000))]);
    for (key, value) in extra {
        params.set(key, value.clone());
    }
    hub.call("start", &params).unwrap()
}

fn lines(program: &str, lines: Json) -> Json {
    array([object([("path", string(program)), ("lines", lines)])])
}

fn local(snapshot: &Json, name: &str) -> Option<String> {
    snapshot
        .at("scopes.0.variables")?
        .items()
        .iter()
        .find(|v| v.str_at("name") == Some(name))
        .and_then(|v| v.str_at("value").map(String::from))
}

#[test]
fn a_program_runs_to_its_breakpoint_and_shows_where_it_is() {
    let Some(_) = bun() else { return };
    let root = workspace("breakpoint");
    let hub = hub(&root);
    let prog = program(&root, "main.prog", PROGRAM);

    let stopped = start(&hub, &prog, lines(&prog, array([int(3)])), &[]);
    assert_eq!(stopped.str_at("status"), Some("stopped"), "{stopped:?}");
    assert_eq!(stopped.str_at("reason"), Some("breakpoint"));
    assert_eq!(stopped.i64_at("frames.0.line"), Some(3));
    assert_eq!(stopped.str_at("frames.0.text"), Some("print middle"), "the source line of the frame");
    assert_eq!(local(&stopped, "line").as_deref(), Some("3"));
    assert!(stopped.str_at("output").unwrap().contains("start"));
    // Expanded one level: the dict's members are there.
    let data = stopped.at("scopes.0.variables").unwrap().items().iter().find(|v| v.str_at("name") == Some("data")).cloned().unwrap();
    assert_eq!(data.str_at("children.0.name"), Some("a"));
    // The expensive scope is listed, not fetched.
    assert!(stopped.at("scopes.1.variables").unwrap().is_null());

    let stepped = hub.call("control", &object([("action", string("next"))])).unwrap();
    assert_eq!(stepped.str_at("reason"), Some("step"));
    assert_eq!(stepped.i64_at("frames.0.line"), Some(4));

    let finished = hub.call("control", &object([("action", string("continue"))])).unwrap();
    assert_eq!(finished.str_at("status"), Some("exited"), "{finished:?}");
    assert_eq!(finished.i64_at("exitCode"), Some(0));
    assert!(finished.str_at("output").unwrap().contains("end"), "only new output: {finished:?}");
    assert!(!finished.str_at("output").unwrap().contains("start"));
    hub.shutdown();
}

#[test]
fn conditions_and_logpoints_decide_where_it_stops() {
    let Some(_) = bun() else { return };
    let root = workspace("conditions");
    let hub = hub(&root);
    let prog = program(&root, "main.prog", PROGRAM);
    let breakpoints = lines(
        &prog,
        array([
            object([("line", int(2)), ("logMessage", string("passing line {line}"))]),
            object([("line", int(3)), ("condition", string("line > 3"))]),
            object([("line", int(4)), ("condition", string("line >= 4"))]),
        ]),
    );
    let stopped = start(&hub, &prog, breakpoints, &[]);
    assert_eq!(stopped.i64_at("frames.0.line"), Some(4), "line 3's condition is false: {stopped:?}");
    assert!(stopped.str_at("output").unwrap().contains("passing line 2"), "the logpoint printed and did not stop");
    hub.shutdown();
}

#[test]
fn values_can_be_evaluated_and_changed() {
    let Some(_) = bun() else { return };
    let root = workspace("evaluate");
    let hub = hub(&root);
    let prog = program(&root, "main.prog", PROGRAM);
    let entry = start(&hub, &prog, array([]), &[("stopOnEntry", Json::Bool(true))]);
    assert_eq!(entry.str_at("reason"), Some("entry"));
    assert_eq!(entry.i64_at("frames.0.line"), Some(1));

    let value = hub.call("evaluate", &object([("expression", string("line + 41"))])).unwrap();
    assert_eq!(value.str_at("result"), Some("42"));
    let missing = hub.call("evaluate", &object([("expression", string("nope"))])).unwrap_err();
    assert!(missing.contains("not defined"), "{missing}");

    hub.call("set_variable", &object([("reference", int(1)), ("name", string("counter")), ("value", string("99"))])).unwrap();
    assert_eq!(hub.call("evaluate", &object([("expression", string("counter"))])).unwrap().str_at("result"), Some("99"));

    let children = hub.call("variables", &object([("reference", int(3)), ("depth", int(1))])).unwrap();
    assert_eq!(children.str_at("1.name"), Some("b"));
    assert_eq!(children.str_at("1.children.1.value"), Some("2"));
    hub.shutdown();
}

#[test]
fn uncaught_exceptions_stop_by_default_and_can_be_let_through() {
    let Some(_) = bun() else { return };
    let root = workspace("exceptions");
    let hub = hub(&root);
    let prog = program(&root, "boom.prog", "print before\nset x\ncrash\nprint never\n");

    let caught = start(&hub, &prog, array([]), &[]);
    assert_eq!(caught.str_at("reason"), Some("exception"), "{caught:?}");
    assert_eq!(caught.str_at("description"), Some("Exception: crash"));
    assert_eq!(caught.i64_at("frames.0.line"), Some(3));
    hub.shutdown();

    let through = start(&hub, &prog, array([]), &[("exceptions", array([]))]);
    assert_eq!(through.str_at("status"), Some("exited"));
    assert_eq!(through.i64_at("exitCode"), Some(1));
    assert!(through.str_at("output").unwrap().contains("Traceback"));
    hub.shutdown();
}

#[test]
fn breakpoints_are_edited_one_at_a_time_on_the_live_session() {
    let Some(_) = bun() else { return };
    let root = workspace("editing");
    let hub = hub(&root);
    let prog = program(&root, "main.prog", PROGRAM);

    // A finished run does not get in the way of the next one.
    let first = start(&hub, &prog, array([]), &[]);
    assert_eq!(first.str_at("status"), Some("exited"), "{first:?}");
    let entry = start(&hub, &prog, array([]), &[("stopOnEntry", Json::Bool(true))]);
    assert_eq!(entry.str_at("reason"), Some("entry"));

    let edit = |mode: &str, line: i64| hub.call("breakpoints", &object([("path", string(&prog)), ("lines", array([int(line)])), ("mode", string(mode))])).unwrap();
    edit("add", 3);
    let both = edit("add", 4);
    assert_eq!(both.items().len(), 2, "adding keeps the one already there: {both:?}");
    let left = edit("remove", 3);
    assert_eq!(left.items().len(), 1);
    assert_eq!(left.i64_at("0.line"), Some(4));

    let stopped = hub.call("control", &object([("action", string("continue"))])).unwrap();
    assert_eq!(stopped.i64_at("frames.0.line"), Some(4), "line 3 was removed: {stopped:?}");
    hub.shutdown();

    // An exception mode, in this adapter's terms, from the start.
    let boom = program(&root, "boom.prog", "print before\ncrash\n");
    let through = start(&hub, &boom, array([]), &[("exceptions", string("none"))]);
    assert_eq!(through.str_at("status"), Some("exited"), "{through:?}");
    let caught = start(&hub, &boom, array([]), &[("exceptions", string("uncaught"))]);
    assert_eq!(caught.str_at("reason"), Some("exception"), "{caught:?}");
    hub.shutdown();
}

#[test]
fn a_tcp_adapter_debugs_the_same_way() {
    let Some(_) = bun() else { return };
    let root = workspace("tcp");
    let hub = hub(&root);
    let prog = program(&root, "main.tprog", PROGRAM);
    let stopped = start(&hub, &prog, lines(&prog, array([int(3)])), &[]);
    assert_eq!(stopped.i64_at("frames.0.line"), Some(3), "{stopped:?}");
    let finished = hub.call("control", &object([("action", string("continue"))])).unwrap();
    assert_eq!(finished.str_at("status"), Some("exited"));
    hub.shutdown();
}

#[test]
fn a_child_session_receives_the_breakpoints_and_is_the_one_inspected() {
    let Some(_) = bun() else { return };
    let root = workspace("children");
    let hub = hub(&root);
    let prog = program(&root, "main.kprog", PROGRAM);
    let stopped = start(&hub, &prog, lines(&prog, array([int(4)])), &[]);
    assert_eq!(stopped.str_at("status"), Some("stopped"), "{stopped:?}");
    assert_eq!(stopped.i64_at("frames.0.line"), Some(4), "the child session stopped at the parent's breakpoint");
    let finished = hub.call("control", &object([("action", string("continue"))])).unwrap();
    assert_eq!(finished.str_at("status"), Some("exited"), "{finished:?}");
    hub.shutdown();
}

#[test]
fn run_in_terminal_starts_the_program_here_and_captures_it() {
    let Some(_) = bun() else { return };
    if detect::which("node", &[], &[]).is_none() {
        return;
    }
    let root = workspace("terminal");
    let hub = hub(&root);
    let prog = program(&root, "main.prog", PROGRAM);
    let done = start(&hub, &prog, array([]), &[("config", object([("console", string("integratedTerminal"))]))]);
    std::thread::sleep(std::time::Duration::from_millis(500));
    let output = hub.call("output", &object([("since", int(0))])).unwrap();
    let text: String = output.at("lines").unwrap().items().iter().filter_map(|l| l.str_at("text")).collect();
    assert!(text.contains("from terminal"), "{done:?} {output:?}");
    hub.shutdown();
}

#[test]
fn stopping_kills_the_adapter_and_everything_under_it() {
    let Some(_) = bun() else { return };
    let root = workspace("stop");
    let hub = hub(&root);
    let prog = program(&root, "main.prog", PROGRAM);
    start(&hub, &prog, array([]), &[("stopOnEntry", Json::Bool(true))]);
    let sessions = hub.call("sessions", &Json::Null).unwrap();
    let pid = sessions.u32_at("0.pid").expect("adapter pid");
    assert!(pi_sys::process::exists(pid));

    let stopped = hub.call("stop", &Json::Null).unwrap();
    assert_eq!(stopped.items().len(), 1);
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(!pi_sys::process::exists(pid), "the adapter is gone");
    assert!(hub.call("sessions", &Json::Null).unwrap().items().is_empty());
}

#[test]
fn the_adapter_list_covers_the_mainstream_and_config() {
    let root = workspace("list");
    let hub = if bun().is_some() { hub(&root) } else { Hub::new() };
    let adapters = hub.call("adapters", &Json::Null).unwrap();
    let ids: Vec<&str> = adapters.items().iter().filter_map(|a| a.str_at("id")).collect();
    for expected in ["debugpy", "js-debug", "delve", "codelldb", "lldb-dap", "gdb", "netcoredbg"] {
        assert!(ids.contains(&expected), "{expected} missing from {ids:?}");
    }
    let for_python = hub.call("adapters", &object([("path", string("x.py"))])).unwrap();
    assert_eq!(for_python.str_at("0.id"), Some("debugpy"));
}
