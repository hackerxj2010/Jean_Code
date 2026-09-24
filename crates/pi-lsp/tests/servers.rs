//! The hub against real processes: a mock server that implements every
//! operation deterministically, and — when it is installed — the real
//! TypeScript language server.

use pi_lsp::detect;
use pi_lsp::json::{array, int, object, string, Json, JsonExt};
use pi_lsp::Hub;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn bun() -> Option<PathBuf> {
    detect::which("bun", &[], &[])
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/mock-lsp-full.mjs").canonicalize().expect("fixture exists")
}

fn project(name: &str, files: &[(&str, &str)]) -> PathBuf {
    // Under the build directory rather than the system temp: a language
    // server resolves its runtime by walking up from the project, and the
    // system temp sits under a home directory that may hold anything.
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("pi-lsp-it-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    for (path, content) in files {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, content).unwrap();
    }
    root.canonicalize().unwrap()
}

fn text(path: &Path) -> String {
    fs::read_to_string(path).unwrap().replace("\r\n", "\n")
}

fn mock_hub(root: &Path) -> Hub {
    let hub = Hub::new();
    let bun = bun().expect("bun");
    let config = object([
        ("projectRoot", string(root.to_string_lossy())),
        ("autoInstall", Json::Bool(false)),
        (
            "servers",
            object([(
                "mock",
                object([
                    ("command", array([string(bun.to_string_lossy()), string(fixture().to_string_lossy())])),
                    ("extensions", array([string("mock")])),
                    ("settings", object([("mock", object([("flavor", string("tested"))]))])),
                ]),
            )]),
        ),
    ]);
    hub.call("configure", &config).unwrap();
    hub
}

fn at(path: &Path, line: i64, symbol: &str) -> Json {
    object([("path", string(path.to_string_lossy())), ("line", int(line)), ("symbol", string(symbol))])
}

fn with(mut value: Json, key: &str, extra: Json) -> Json {
    value.set(key, extra);
    value
}

fn file(path: &Path) -> Json {
    object([("path", string(path.to_string_lossy()))])
}

#[test]
fn diagnostics_are_waited_for_and_follow_the_file() {
    let Some(_) = bun() else { return };
    let root = project("diag", &[("a.mock", "def alpha\nuse ERROR here\nWARN\n")]);
    let a = root.join("a.mock");
    let hub = mock_hub(&root);

    let result = hub.call("diagnostics", &file(&a)).unwrap();
    let diagnostics = result.at("diagnostics").unwrap().items().to_vec();
    assert_eq!(diagnostics.len(), 2, "{result:?}");
    assert_eq!(diagnostics[0].str_at("severity"), Some("error"), "errors first");
    assert_eq!(diagnostics[0].str_at("server"), Some("mock"));
    assert_eq!(result.str_at("files.0.servers.0.freshness"), Some("current"));

    // The agent fixes the file on disk; the next call sees the new content.
    fs::write(&a, "def alpha\nuse alpha\nWARN\n").unwrap();
    let result = hub.call("diagnostics", &file(&a)).unwrap();
    let diagnostics = result.at("diagnostics").unwrap().items().to_vec();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].str_at("message"), Some("found WARN"));

    let errors_only = hub.call("diagnostics", &with(file(&a), "severity", string("error"))).unwrap();
    assert!(errors_only.at("diagnostics").unwrap().items().is_empty());
    hub.shutdown();
}

#[test]
fn navigation_follows_the_language() {
    let Some(_) = bun() else { return };
    let root = project("nav", &[("a.mock", "def alpha\n  def inner\nuse alpha\n"), ("b.mock", "use alpha\nalpha calls beta\ndef beta\n")]);
    let (a, b) = (root.join("a.mock"), root.join("b.mock"));
    let hub = mock_hub(&root);
    // The mock only knows open files; a real server reads the rest from disk.
    hub.call("touch", &with(file(&a), "open", Json::Bool(true))).unwrap();
    hub.call("touch", &with(file(&b), "open", Json::Bool(true))).unwrap();

    let hover = hub.call("hover", &at(&b, 0, "alpha")).unwrap();
    let hover_text = hover.str_at("text").unwrap();
    assert!(hover_text.contains("def alpha"), "{hover_text}");
    assert!(hover_text.contains("configured: tested"), "the server read its settings through workspace/configuration");

    let definition = hub.call("definition", &at(&b, 0, "alpha")).unwrap();
    assert_eq!(definition.str_at("locations.0.text"), Some("def alpha"));
    assert!(definition.str_at("locations.0.path").unwrap().ends_with("a.mock"));

    let typed = hub.call("definition", &with(at(&b, 0, "alpha"), "kind", string("type"))).unwrap();
    assert_eq!(typed.u32_at("locations.0.character"), Some(4), "a LocationLink's selection range, not its whole range");

    let references = hub.call("references", &with(at(&b, 0, "alpha"), "includeDeclaration", Json::Bool(true))).unwrap();
    assert_eq!(references.at("locations").unwrap().items().len(), 4);
    let without = hub.call("references", &at(&b, 0, "alpha")).unwrap();
    assert_eq!(without.at("locations").unwrap().items().len(), 3);

    let symbols = hub.call("symbols", &file(&a)).unwrap();
    let list = symbols.at("symbols").unwrap().items().to_vec();
    assert_eq!(list.len(), 2);
    assert_eq!(list[1].str_at("container"), Some("alpha"));
    assert_eq!(list[1].u32_at("depth"), Some(1));

    let found = hub.call("workspace_symbols", &object([("query", string("al"))])).unwrap();
    assert_eq!(found.str_at("symbols.0.name"), Some("alpha"));

    let completion = hub.call("completion", &object([("path", string(b.to_string_lossy())), ("line", int(0)), ("character", int(0))])).unwrap();
    let labels: Vec<&str> = completion.at("items").unwrap().items().iter().filter_map(|item| item.str_at("label")).collect();
    assert!(labels.contains(&"alpha") && labels.contains(&"beta"), "{labels:?}");

    let signature = hub.call("signature", &at(&b, 1, "beta")).unwrap();
    assert_eq!(signature.str_at("0.parameters.0"), Some("first"), "offset labels resolved");
    assert_eq!(signature.u32_at("0.activeParameter"), Some(1));

    let highlights = hub.call("highlights", &at(&a, 0, "alpha")).unwrap();
    assert_eq!(highlights.items().len(), 2);
    assert_eq!(highlights.str_at("0.kind"), Some("write"));

    let hints = hub.call("inlay_hints", &file(&a)).unwrap();
    assert_eq!(hints.items().len(), 2);

    let incoming = hub.call("calls", &at(&b, 2, "beta")).unwrap();
    assert_eq!(incoming.str_at("results.0.name"), Some("alpha"));
    let outgoing = hub.call("calls", &with(at(&a, 0, "alpha"), "direction", string("outgoing"))).unwrap();
    assert_eq!(outgoing.str_at("results.0.name"), Some("beta"));

    let missing = hub.call("hover", &at(&b, 0, "nothing")).unwrap_err();
    assert!(missing.contains("not on line 1"), "{missing}");
    hub.shutdown();
}

#[test]
fn a_rename_is_applied_across_files() {
    let Some(_) = bun() else { return };
    let root = project("rename", &[("a.mock", "def alpha\nuse alpha\n"), ("b.mock", "use alpha\n")]);
    let (a, b) = (root.join("a.mock"), root.join("b.mock"));
    let hub = mock_hub(&root);
    hub.call("touch", &with(file(&b), "open", Json::Bool(true))).unwrap();

    let preview = hub.call("rename", &with(with(at(&a, 0, "alpha"), "newName", string("omega")), "apply", Json::Bool(false))).unwrap();
    assert_eq!(preview.at("changes").unwrap().items().len(), 2);
    assert!(text(&a).contains("alpha"), "a preview writes nothing");

    let applied = hub.call("rename", &with(at(&a, 0, "alpha"), "newName", string("omega"))).unwrap();
    assert_eq!(applied.bool_at("applied"), Some(true));
    assert_eq!(text(&a), "def omega\nuse omega\n");
    assert_eq!(text(&b), "use omega\n");

    let refused = hub.call("rename", &with(at(&a, 1, "use"), "newName", string("x"))).unwrap_err();
    assert!(refused.contains("cannot be renamed"), "{refused}");
    hub.shutdown();
}

#[test]
fn code_actions_resolve_and_commands_edit_through_the_client() {
    let Some(_) = bun() else { return };
    let root = project("actions", &[("c.mock", "use ERROR\nuse ERROR\n")]);
    let c = root.join("c.mock");
    let hub = mock_hub(&root);

    let offered = hub.call("code_actions", &object([("path", string(c.to_string_lossy())), ("line", int(0))])).unwrap();
    let titles: Vec<&str> = offered.at("actions").unwrap().items().iter().filter_map(|a| a.str_at("title")).collect();
    assert!(titles.contains(&"Replace ERROR with OK") && titles.contains(&"Fix all"), "{titles:?}");

    // Needs `codeAction/resolve` to get its edit.
    let one = hub
        .call("code_actions", &object([("path", string(c.to_string_lossy())), ("line", int(0)), ("apply", string("replace error"))]))
        .unwrap();
    assert_eq!(one.str_at("applied"), Some("Replace ERROR with OK"));
    assert_eq!(text(&c), "use OK\nuse ERROR\n");
    // Asked straight after the edit: the answer is about the new text, not
    // the diagnostics cached from before it.
    let now = hub.call("diagnostics", &object([("path", string(c.to_string_lossy()))])).unwrap();
    assert_eq!(now.at("diagnostics").unwrap().items().len(), 1, "{now:?}");
    assert_eq!(now.u32_at("diagnostics.0.range.start.line"), Some(1));

    // A command whose edit arrives as `workspace/applyEdit` from the server.
    let all = hub.call("code_actions", &object([("path", string(c.to_string_lossy())), ("line", int(1)), ("apply", string("Fix all"))])).unwrap();
    assert_eq!(text(&c), "use OK\nuse OK\n");
    assert!(!all.at("changes").unwrap().items().is_empty(), "the command's edit is reported");
    hub.shutdown();
}

#[test]
fn formatting_and_moving_a_file_update_the_disk() {
    let Some(_) = bun() else { return };
    let root = project("format", &[("d.mock", "def x   \nuse x\t\n"), ("e.mock", "import \"f.mock\"\n"), ("f.mock", "def f\n")]);
    let (d, e, f) = (root.join("d.mock"), root.join("e.mock"), root.join("f.mock"));
    let hub = mock_hub(&root);

    let formatted = hub.call("format", &file(&d)).unwrap();
    assert_eq!(text(&d), "def x\nuse x\n");
    assert!(formatted.str_at("change.diff").unwrap().contains("-def x"));

    hub.call("touch", &with(file(&e), "open", Json::Bool(true))).unwrap();
    let g = root.join("sub").join("g.mock");
    let moved = hub.call("rename_file", &object([("from", string(f.to_string_lossy())), ("to", string(g.to_string_lossy()))])).unwrap();
    assert!(!f.exists() && g.exists());
    assert_eq!(text(&e), "import \"g.mock\"\n", "the import followed the file: {moved:?}");
    hub.shutdown();
}

#[test]
fn status_reports_and_a_crashed_server_restarts() {
    let Some(_) = bun() else { return };
    let root = project("status", &[("ok.mock", "def a\n"), ("boom.mock", "CRASH\n")]);
    let hub = mock_hub(&root);
    hub.call("diagnostics", &file(&root.join("ok.mock"))).unwrap();

    let status = hub.call("status", &Json::Null).unwrap();
    assert_eq!(status.str_at("running.0.name"), Some("mock-lsp"));
    let servers = hub.call("servers", &object([("path", string("x.mock"))])).unwrap();
    assert_eq!(servers.str_at("0.status"), Some("running"));

    // Opening this file kills the server.
    let _ = hub.call("diagnostics", &with(file(&root.join("boom.mock")), "waitMs", int(500)));
    std::thread::sleep(Duration::from_millis(300));
    // The next request starts a fresh one.
    let result = hub.call("hover", &at(&root.join("ok.mock"), 0, "a")).unwrap();
    assert!(result.str_at("text").unwrap().contains("def a"));
    hub.shutdown();
}

/// The real TypeScript server, when this machine has it.
#[test]
fn the_real_typescript_server() {
    if detect::which("typescript-language-server", &[], &[]).is_none() {
        eprintln!("typescript-language-server not installed; skipping");
        return;
    }
    let root = project(
        "ts",
        &[
            ("tsconfig.json", r#"{"compilerOptions":{"strict":true,"target":"ES2022","module":"ESNext","moduleResolution":"bundler"}}"#),
            ("a.ts", "export function add(a: number, b: number): number {\n  return a + b\n}\nconst bad: number = \"x\"\n"),
            ("b.ts", "import { add } from './a'\nexport const total = add(1, 2)\n"),
        ],
    );
    let (a, b) = (root.join("a.ts"), root.join("b.ts"));
    let hub = Hub::new();
    hub.call("configure", &object([("projectRoot", string(root.to_string_lossy())), ("autoInstall", Json::Bool(false))])).unwrap();

    let diagnostics = hub.call("diagnostics", &with(file(&a), "waitMs", int(20000))).unwrap();
    let messages: Vec<&str> = diagnostics.at("diagnostics").unwrap().items().iter().filter_map(|d| d.str_at("message")).collect();
    assert!(messages.iter().any(|m| m.contains("not assignable")), "{diagnostics:?}");

    let definition = hub.call("definition", &at(&b, 1, "add")).unwrap();
    assert!(definition.str_at("locations.0.path").unwrap().ends_with("a.ts"), "{definition:?}");
    assert_eq!(definition.u32_at("locations.0.line"), Some(0));

    let hover = hub.call("hover", &at(&b, 1, "add")).unwrap();
    assert!(hover.str_at("text").unwrap().contains("add(a: number, b: number): number"), "{hover:?}");

    let references = hub.call("references", &with(at(&a, 0, "add"), "includeDeclaration", Json::Bool(true))).unwrap();
    let files: std::collections::HashSet<&str> = references.at("locations").unwrap().items().iter().filter_map(|l| l.str_at("path")).collect();
    assert_eq!(files.len(), 2, "{references:?}");

    hub.call("rename", &with(at(&a, 0, "add"), "newName", string("sum"))).unwrap();
    assert!(text(&a).contains("export function sum"));
    assert!(text(&b).contains("sum(1, 2)"));
    hub.shutdown();
    fs::remove_dir_all(&root).ok();
}
