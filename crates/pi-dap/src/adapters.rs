//! The debug adapter registry.
//!
//! Each adapter is described by the files it debugs, how it is reached — its
//! own stdio, or a TCP port it listens on — the launch configuration it
//! expects, and how to install it. Adapters disagree on nearly everything
//! about launching: the key that names the program, whether the program is a
//! source file or a binary, how output is captured. Those differences live
//! here, in data, so the session code speaks plain DAP to all of them.

use pi_lsp::json::{self, literal, merge, string, Json, JsonExt};
use pi_lsp::servers::{Asset, Install};
use std::path::{Path, PathBuf};

/// How the client reaches the adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Transport {
    /// DAP on the adapter's stdin and stdout.
    Stdio,
    /// The adapter listens on a port it is given as `{port}` in its command.
    Tcp,
}

#[derive(Clone, Debug)]
pub struct AdapterSpec {
    pub id: String,
    pub name: String,
    /// Extensions without the dot.
    pub extensions: Vec<String>,
    /// The adapter command. `{port}` is a free port; `{adapter}` is the path
    /// of an installed adapter script, for adapters run by an interpreter.
    pub command: Vec<String>,
    pub transport: Transport,
    /// The launch configuration every launch starts from.
    pub defaults: Json,
    /// Which binary to look for to decide whether the adapter is installed.
    pub probe: String,
    pub install: Option<Install>,
    /// Starts child sessions through `startDebugging` (js-debug does: the
    /// first session is a launcher, the program runs in a child).
    pub child_sessions: bool,
    pub disabled: bool,
}

impl AdapterSpec {
    fn new(id: &str, name: &str, command: &[&str], extensions: &[&str], transport: Transport, defaults: &str) -> Self {
        AdapterSpec {
            id: id.into(),
            name: name.into(),
            extensions: extensions.iter().map(|e| e.to_string()).collect(),
            command: command.iter().map(|c| c.to_string()).collect(),
            transport,
            defaults: literal(defaults),
            probe: command.first().copied().unwrap_or_default().to_string(),
            install: None,
            child_sessions: false,
            disabled: false,
        }
    }

    fn probe(mut self, binary: &str) -> Self {
        self.probe = binary.into();
        self
    }

    fn install(mut self, install: Install) -> Self {
        self.install = Some(install);
        self
    }

    fn children(mut self) -> Self {
        self.child_sessions = true;
        self
    }

    pub fn handles(&self, path: &Path) -> bool {
        let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        !extension.is_empty() && self.extensions.iter().any(|known| *known == extension)
    }

    /// Layers a user's `debuggers.<id>` entry over this one.
    pub fn with_config(mut self, config: &Json) -> Self {
        if let Some(command) = config.at("command") {
            let mut parts: Vec<String> = match command {
                Json::String(single) => vec![single.clone()],
                list => list.items().iter().filter_map(Json::as_str).map(String::from).collect(),
            };
            if let Some(args) = config.at("args") {
                parts.extend(args.items().iter().filter_map(Json::as_str).map(String::from));
            }
            if !parts.is_empty() {
                self.probe = parts[0].clone();
                self.command = parts;
            }
        }
        if let Some(extensions) = config.at("extensions") {
            self.extensions = extensions.items().iter().filter_map(Json::as_str).map(|e| e.trim_start_matches('.').to_lowercase()).collect();
        }
        match config.str_at("transport") {
            Some("tcp") => self.transport = Transport::Tcp,
            Some("stdio") => self.transport = Transport::Stdio,
            _ => {}
        }
        if let Some(defaults) = config.at("defaults") {
            self.defaults = merge(&self.defaults, defaults);
        }
        if let Some(children) = config.bool_at("childSessions") {
            self.child_sessions = children;
        }
        if let Some(disabled) = config.bool_at("disabled") {
            self.disabled = disabled;
        }
        self
    }

    pub fn from_config(id: &str, config: &Json) -> Option<Self> {
        let spec = AdapterSpec::new(id, id, &[], &[], Transport::Stdio, "{}").with_config(config);
        (!spec.command.is_empty()).then_some(spec)
    }

    /// The launch configuration for `program`: the adapter's defaults, the
    /// program under the key this adapter reads, then the caller's own keys
    /// on top of everything.
    pub fn launch_config(&self, program: Option<&Path>, args: &[String], cwd: &Path, env: &Json, extra: &Json, python: Option<&Path>) -> Json {
        let mut config = self.defaults.clone();
        if matches!(config, Json::Null) {
            config = json::empty();
        }
        config.set("cwd", string(cwd.to_string_lossy()));
        if !args.is_empty() {
            config.set("args", json::strings(args));
        }
        if let Json::Object(map) = env {
            if !map.is_empty() {
                config.set("env", env.clone());
            }
        }
        if let Some(program) = program {
            // A native adapter's program is already a binary: the hub builds
            // sources first (see `build`).
            config.set("program", string(program.to_string_lossy()));
            // Node runs TypeScript itself since 23.6; js-debug only has to
            // not stop it.
            if self.id == "js-debug" && matches!(program.extension().and_then(|e| e.to_str()), Some("ts" | "mts" | "cts")) {
                config.set("runtimeArgs", json::strings(["--experimental-strip-types", "--no-warnings"]));
            }
        }
        if let (Some(python), "debugpy") = (python, self.id.as_str()) {
            config.set("python", string(python.to_string_lossy()));
        }
        merge(&config, extra)
    }
}

/// Every bundled adapter.
pub fn builtin_adapters() -> Vec<AdapterSpec> {
    let python = if cfg!(windows) { "python" } else { "python3" };
    vec![
        AdapterSpec::new(
            "debugpy",
            "Python (debugpy)",
            &[python, "-m", "debugpy.adapter"],
            &["py"],
            Transport::Stdio,
            r#"{"type":"python","request":"launch","console":"internalConsole","justMyCode":true,"redirectOutput":true,"showReturnValue":true}"#,
        )
        .probe("debugpy")
        .install(Install::Pip { packages: vec!["debugpy".into()], bin: "python".into() }),
        AdapterSpec::new(
            "js-debug",
            "JavaScript / TypeScript (js-debug)",
            &["node", "{adapter}", "{port}", "127.0.0.1"],
            &["js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx"],
            Transport::Tcp,
            r#"{"type":"pwa-node","request":"launch","console":"internalConsole","outputCapture":"std","skipFiles":["<node_internals>/**"],"sourceMaps":true,"resolveSourceMapLocations":["**","!**/node_modules/**"]}"#,
        )
        .probe("dapDebugServer.js")
        .children()
        .install(Install::Github {
            repo: "microsoft/vscode-js-debug".into(),
            assets: vec![Asset { os: "any", arch: "any", pattern: "js-debug-dap-v*.tar.gz".into() }],
            bin: "dapDebugServer.js".into(),
        }),
        AdapterSpec::new(
            "delve",
            "Go (Delve)",
            &["dlv", "dap", "--listen=127.0.0.1:{port}"],
            &["go"],
            Transport::Tcp,
            r#"{"type":"go","request":"launch","mode":"debug"}"#,
        )
        .install(Install::Go { module: "github.com/go-delve/delve/cmd/dlv@latest".into(), bin: "dlv".into() }),
        AdapterSpec::new(
            "codelldb",
            "Rust / C / C++ (CodeLLDB)",
            &["codelldb", "--port", "{port}"],
            &["rs", "c", "cc", "cpp", "cxx", "zig", "swift", "m"],
            Transport::Tcp,
            r#"{"type":"lldb","request":"launch","stopOnEntry":false,"terminal":"console","sourceLanguages":["rust"]}"#,
        )
        .install(Install::Github {
            repo: "vadimcn/codelldb".into(),
            assets: vec![
                Asset { os: "windows", arch: "x86_64", pattern: "codelldb-win32-x64.vsix".into() },
                Asset { os: "linux", arch: "x86_64", pattern: "codelldb-linux-x64.vsix".into() },
                Asset { os: "linux", arch: "aarch64", pattern: "codelldb-linux-arm64.vsix".into() },
                Asset { os: "macos", arch: "x86_64", pattern: "codelldb-darwin-x64.vsix".into() },
                Asset { os: "macos", arch: "aarch64", pattern: "codelldb-darwin-arm64.vsix".into() },
            ],
            bin: "codelldb".into(),
        }),
        AdapterSpec::new("lldb-dap", "LLDB (lldb-dap)", &["lldb-dap"], &["c", "cc", "cpp", "cxx", "rs", "m", "mm", "swift"], Transport::Stdio, r#"{"request":"launch","stopOnEntry":false}"#)
            .install(Install::Manual { hint: "install LLVM (lldb-dap ships with it)".into() }),
        AdapterSpec::new("gdb", "GDB", &["gdb", "--interpreter=dap", "--quiet"], &["c", "cc", "cpp", "cxx", "rs", "f90", "ada"], Transport::Stdio, r#"{"request":"launch"}"#)
            .install(Install::Manual { hint: "install GDB 14 or newer".into() }),
        AdapterSpec::new(
            "netcoredbg",
            "C# (netcoredbg)",
            &["netcoredbg", "--interpreter=vscode"],
            &["cs", "fs", "vb"],
            Transport::Stdio,
            r#"{"type":"coreclr","request":"launch","console":"internalConsole","justMyCode":true}"#,
        )
        .install(Install::Github {
            repo: "Samsung/netcoredbg".into(),
            assets: vec![
                Asset { os: "windows", arch: "any", pattern: "netcoredbg-win64.zip".into() },
                Asset { os: "linux", arch: "x86_64", pattern: "netcoredbg-linux-amd64.tar.gz".into() },
                Asset { os: "linux", arch: "aarch64", pattern: "netcoredbg-linux-arm64.tar.gz".into() },
                Asset { os: "macos", arch: "any", pattern: "netcoredbg-osx-amd64.tar.gz".into() },
            ],
            bin: "netcoredbg".into(),
        }),
        AdapterSpec::new(
            "elixir-ls",
            "Elixir (ElixirLS)",
            &[if cfg!(windows) { "debug_adapter.bat" } else { "debug_adapter.sh" }],
            &["ex", "exs"],
            Transport::Stdio,
            r#"{"type":"mix_task","request":"launch","task":"run","projectDir":"${cwd}"}"#,
        )
        .install(Install::Github {
            repo: "elixir-lsp/elixir-ls".into(),
            assets: vec![Asset { os: "any", arch: "any", pattern: "elixir-ls-v*.zip".into() }],
            bin: if cfg!(windows) { "debug_adapter.bat".into() } else { "debug_adapter.sh".into() },
        }),
        AdapterSpec::new("dart", "Dart", &["dart", "debug_adapter"], &["dart"], Transport::Stdio, r#"{"type":"dart","request":"launch"}"#)
            .install(Install::Manual { hint: "install the Dart or Flutter SDK".into() }),
        AdapterSpec::new("php", "PHP (Xdebug)", &["node", "{adapter}"], &["php"], Transport::Stdio, r#"{"type":"php","request":"launch","port":9003}"#)
            .probe("phpDebug.js")
            .install(Install::Manual { hint: "install vscode-php-debug and Xdebug".into() }),
    ]
}

/// The Python a project runs with: its own virtualenv when it has one.
pub fn project_python(root: &Path) -> Option<PathBuf> {
    for venv in [".venv", "venv", "env"] {
        let candidate = if cfg!(windows) {
            root.join(venv).join("Scripts").join("python.exe")
        } else {
            root.join(venv).join("bin").join("python")
        };
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapters_are_unique_and_pick_files() {
        let adapters = builtin_adapters();
        let mut ids: Vec<&str> = adapters.iter().map(|a| a.id.as_str()).collect();
        ids.sort();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len());
        let find = |id: &str| adapters.iter().find(|a| a.id == id).unwrap();
        assert!(find("debugpy").handles(Path::new("app/main.py")));
        assert!(find("js-debug").handles(Path::new("src/index.ts")));
        assert!(!find("delve").handles(Path::new("main.rs")));
    }

    #[test]
    fn a_launch_configuration_layers_defaults_program_and_overrides() {
        let adapters = builtin_adapters();
        let debugpy = adapters.iter().find(|a| a.id == "debugpy").unwrap();
        let config = debugpy.launch_config(
            Some(Path::new("/p/main.py")),
            &["--flag".into()],
            Path::new("/p"),
            &literal(r#"{"A":"1"}"#),
            &literal(r#"{"justMyCode":false}"#),
            Some(Path::new("/p/.venv/bin/python")),
        );
        assert_eq!(config.str_at("type"), Some("python"));
        assert!(config.str_at("program").unwrap().ends_with("main.py"));
        assert_eq!(config.str_at("args.0"), Some("--flag"));
        assert_eq!(config.str_at("env.A"), Some("1"));
        assert_eq!(config.bool_at("justMyCode"), Some(false), "the caller's keys win");
        assert!(config.str_at("python").is_some());

        let js = adapters.iter().find(|a| a.id == "js-debug").unwrap();
        let ts = js.launch_config(Some(Path::new("/p/a.ts")), &[], Path::new("/p"), &Json::Null, &Json::Null, None);
        assert_eq!(ts.str_at("runtimeArgs.0"), Some("--experimental-strip-types"));
    }

    #[test]
    fn an_adapter_can_come_from_config() {
        let spec = AdapterSpec::from_config("mine", &literal(r#"{"command":["my-dap","--port","{port}"],"transport":"tcp","extensions":[".zz"],"defaults":{"type":"z"}}"#)).unwrap();
        assert_eq!(spec.transport, Transport::Tcp);
        assert!(spec.handles(Path::new("x.zz")));
        assert_eq!(spec.defaults.str_at("type"), Some("z"));
    }
}
