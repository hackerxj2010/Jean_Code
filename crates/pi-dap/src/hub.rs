//! Every debug session, and the operations an agent asks of them.
//!
//! The hub picks the adapter for a program, finds or installs it, starts
//! the session, and speaks for all sessions through one JSON interface — what
//! the bridge exposes as `dap.*`. Lines are one-based, as DAP and every
//! editor count them.
//!
//! The shape of the answers is chosen for an agent: `start`, `control`, and
//! `wait` all come back with a snapshot — where the program stopped, the
//! stack with the source line of each frame, and the variables of the frame
//! it stopped in — because that is what the next decision depends on, and
//! asking for each piece separately would cost a turn apiece.

use crate::adapters::{builtin_adapters, project_python, AdapterSpec};
use crate::session::{BreakpointSpec, DapError, Session};
use pi_lsp::detect;
use pi_lsp::install::Toolbox;
use pi_lsp::json::{array, int, object, string, Json, JsonExt};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone)]
struct Config {
    project_root: PathBuf,
    user_adapters: Json,
    auto_install: bool,
    toolbox: Toolbox,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            project_root: std::env::current_dir().unwrap_or_default(),
            user_adapters: Json::Null,
            auto_install: !pi_lsp::install::downloads_disabled(),
            toolbox: Toolbox::new(Toolbox::default_dir()),
        }
    }
}

struct Entry {
    session: Session,
    program: Option<String>,
    /// How much output the caller has already been given.
    cursor: u64,
}

pub struct Hub {
    config: Mutex<Config>,
    sessions: Mutex<BTreeMap<String, Entry>>,
    next: AtomicU64,
    installs: Mutex<Vec<String>>,
}

static HUB: OnceLock<Hub> = OnceLock::new();

pub fn hub() -> &'static Hub {
    HUB.get_or_init(Hub::new)
}

fn err(error: DapError) -> String {
    error.to_string()
}

fn millis(params: &Json, key: &str, default: u64) -> Duration {
    Duration::from_millis(params.f64_at(key).filter(|v| *v >= 0.0).map_or(default, |v| v as u64))
}

/// Whether `python` can import debugpy.
fn has_debugpy(python: &Path) -> bool {
    let mut command = Command::new(python);
    command.args(["-c", "import debugpy"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.status().is_ok_and(|status| status.success())
}

/// `${key}` replaced in every string of a launch configuration.
fn substitute(value: &Json, key: &str, replacement: &str) -> Json {
    match value {
        Json::String(text) => Json::String(text.replace(key, replacement)),
        Json::Array(items) => Json::Array(items.iter().map(|item| substitute(item, key, replacement)).collect()),
        Json::Object(map) => Json::Object(map.iter().map(|(k, item)| (k.clone(), substitute(item, key, replacement))).collect()),
        other => other.clone(),
    }
}

/// Breakpoints as `[{path, lines: [n | {line, condition, hitCondition, logMessage}]}]`.
/// The exception filters that mean `mode` for an adapter offering
/// `available`: every adapter names "break on uncaught" differently.
fn exception_filters(available: &[Json], mode: &str) -> Vec<String> {
    let names = available.iter().filter_map(|f| f.str_at("filter"));
    match mode {
        "none" => Vec::new(),
        "all" => names.map(String::from).collect(),
        _ => names
            .filter(|filter| filter.to_lowercase().contains("uncaught") || *filter == "userUnhandled" || *filter == "rust_panic")
            .map(String::from)
            .collect(),
    }
}

fn parse_breakpoints(value: Option<&Json>, cwd: &Path) -> Vec<(PathBuf, Vec<BreakpointSpec>)> {
    value
        .map(|list| list.items().to_vec())
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let path = PathBuf::from(entry.str_at("path")?);
            let path = if path.is_absolute() { path } else { cwd.join(path) };
            let specs = entry.at("lines").or_else(|| entry.at("breakpoints")).map(|l| l.items().iter().filter_map(BreakpointSpec::parse).collect()).unwrap_or_default();
            Some((path, specs))
        })
        .collect()
}

impl Hub {
    pub fn new() -> Hub {
        Hub { config: Mutex::new(Config::default()), sessions: Mutex::new(BTreeMap::new()), next: AtomicU64::new(1), installs: Mutex::new(Vec::new()) }
    }

    fn config(&self) -> Config {
        lock(&self.config).clone()
    }

    fn adapters(&self) -> Vec<AdapterSpec> {
        let config = self.config();
        let mut adapters: Vec<AdapterSpec> = builtin_adapters()
            .into_iter()
            .map(|spec| match config.user_adapters.at(&spec.id) {
                Some(overrides) => spec.with_config(overrides),
                None => spec,
            })
            .collect();
        if let Json::Object(user) = &config.user_adapters {
            for (id, entry) in user {
                if !adapters.iter().any(|spec| spec.id == *id) {
                    if let Some(spec) = AdapterSpec::from_config(id, entry) {
                        adapters.push(spec);
                    }
                }
            }
        }
        adapters.into_iter().filter(|spec| !spec.disabled).collect()
    }

    fn session(&self, params: &Json) -> Result<Session, String> {
        let sessions = lock(&self.sessions);
        match params.str_at("session") {
            Some(id) => sessions.get(id).map(|entry| entry.session.clone()).ok_or_else(|| format!("no debug session `{id}`")),
            // The live one: an agent debugging one program should not have to
            // repeat its id, nor have a finished run get in the way of the next.
            None => {
                let live: Vec<&Entry> = sessions.values().filter(|entry| !entry.session.target().status().finished()).collect();
                match live.as_slice() {
                    [only] => Ok(only.session.clone()),
                    [] => sessions
                        .iter()
                        .max_by_key(|(id, _)| id.trim_start_matches("dbg-").parse::<u64>().unwrap_or(0))
                        .map(|(_, entry)| entry.session.clone())
                        .ok_or_else(|| "no debug session is running; start one first".to_string()),
                    many => Err(format!(
                        "several sessions are running ({}); give `session`",
                        many.iter().map(|entry| entry.session.id().to_string()).collect::<Vec<_>>().join(", ")
                    )),
                }
            }
        }
    }

    /// The command that starts `spec`, and the Python a debugpy session
    /// should run the program with — installing the adapter if it is
    /// missing and installs are allowed.
    fn resolve(&self, spec: &AdapterSpec, cwd: &Path, config: &Config) -> Result<(Vec<String>, Option<PathBuf>), String> {
        let first = detect::project_bin_dirs(cwd, &config.project_root);
        let last = config.toolbox.bin_dirs();

        if spec.id == "debugpy" {
            let debuggee = project_python(cwd).or_else(|| project_python(&config.project_root));
            let system = ["python3", "python", "py"].iter().find_map(|name| detect::which(name, &[], &[]));
            let installed = spec.install.as_ref().and_then(|install| config.toolbox.locate(&spec.id, install));
            let adapter_python = [debuggee.clone(), system.clone(), installed.clone()]
                .into_iter()
                .flatten()
                .find(|python| has_debugpy(python))
                .map(Ok)
                .unwrap_or_else(|| self.install(spec, config))?;
            let mut command = vec![adapter_python.to_string_lossy().to_string()];
            command.extend(spec.command.iter().skip(1).cloned());
            return Ok((command, debuggee.or(system)));
        }

        let installed = spec.install.as_ref().and_then(|install| config.toolbox.locate(&spec.id, install));
        if spec.command.iter().any(|part| part == "{adapter}") {
            // An adapter script run by an interpreter: the script is what
            // has to be installed, the interpreter what has to be found.
            let script = installed.map(Ok).unwrap_or_else(|| self.install(spec, config))?;
            let interpreter = spec.command.first().cloned().unwrap_or_default();
            let interpreter = detect::which(&interpreter, &first, &last).ok_or_else(|| format!("`{interpreter}` is needed to run the {} adapter", spec.name))?;
            let command = spec
                .command
                .iter()
                .enumerate()
                .map(|(index, part)| if index == 0 { interpreter.to_string_lossy().to_string() } else { part.replace("{adapter}", &script.to_string_lossy()) })
                .collect();
            return Ok((command, None));
        }

        let binary = detect::which(&spec.probe, &first, &last).or(installed).map(Ok).unwrap_or_else(|| self.install(spec, config))?;
        let mut command = vec![binary.to_string_lossy().to_string()];
        command.extend(spec.command.iter().skip(1).cloned());
        Ok((command, None))
    }

    fn install(&self, spec: &AdapterSpec, config: &Config) -> Result<PathBuf, String> {
        let install = spec.install.as_ref().ok_or_else(|| format!("{} is not installed", spec.name))?;
        if !config.auto_install || !install.automatic() {
            return Err(format!("{} is not installed ({})", spec.name, install.describe()));
        }
        let mut log = Vec::new();
        match config.toolbox.install(&spec.id, install, &mut log) {
            Ok(path) => {
                lock(&self.installs).push(format!("installed {} ({})", spec.id, install.describe()));
                Ok(path)
            }
            Err(error) => {
                lock(&self.installs).push(format!("could not install {}: {error}", spec.id));
                Err(format!("{} is not installed and installing it failed: {error}", spec.name))
            }
        }
    }

    /// The adapter for a program: the one named, or the first that handles
    /// its extension — installed ones before ones that would need installing.
    fn choose(&self, params: &Json, program: Option<&Path>, cwd: &Path) -> Result<AdapterSpec, String> {
        let adapters = self.adapters();
        if let Some(id) = params.str_at("adapter") {
            return adapters.into_iter().find(|spec| spec.id == id).ok_or_else(|| format!("no debug adapter called `{id}`"));
        }
        let program = program.ok_or("give `program`, or name the `adapter`")?;
        let probe_file = if program.is_dir() {
            // A directory: debug it as the project it is.
            [("Cargo.toml", "main.rs"), ("go.mod", "main.go"), ("package.json", "index.js"), ("pyproject.toml", "main.py")]
                .iter()
                .find(|(marker, _)| program.join(marker).exists())
                .map(|(_, stand_in)| program.join(stand_in))
                .unwrap_or_else(|| program.to_path_buf())
        } else if program.file_name().is_some_and(|name| name == "Cargo.toml") {
            program.with_file_name("main.rs")
        } else {
            program.to_path_buf()
        };
        let config = self.config();
        let candidates: Vec<AdapterSpec> = adapters.into_iter().filter(|spec| spec.handles(&probe_file)).collect();
        if candidates.is_empty() {
            return Err(format!("no debug adapter handles {}; name one with `adapter`", program.display()));
        }
        let available = candidates.iter().find(|spec| {
            let first = detect::project_bin_dirs(cwd, &config.project_root);
            detect::which(&spec.probe, &first, &config.toolbox.bin_dirs()).is_some()
                || spec.install.as_ref().is_some_and(|install| config.toolbox.locate(&spec.id, install).is_some())
                || (spec.id == "debugpy")
        });
        Ok(available.cloned().unwrap_or_else(|| candidates[0].clone()))
    }

    fn start(&self, params: &Json) -> Result<Json, String> {
        let config = self.config();
        let program = params.str_at("program").map(|p| {
            let path = PathBuf::from(p);
            if path.is_absolute() { path } else { config.project_root.join(path) }
        });
        let cwd = params.str_at("cwd").map(PathBuf::from).unwrap_or_else(|| config.project_root.clone());
        let spec = self.choose(params, program.as_deref(), &cwd)?;
        let id = format!("dbg-{}", self.next.fetch_add(1, Ordering::SeqCst));

        let session = match params.str_at("address") {
            // Attach to an adapter already listening.
            Some(address) => Session::connect(address, &spec.id, &id, &cwd).map_err(err)?,
            None => {
                let (command, python) = self.resolve(&spec, &cwd, &config)?;
                let session = Session::start(&spec, &command, &cwd, &[], &id).map_err(err)?;
                let args: Vec<String> = params.at("args").map(|a| a.items().iter().filter_map(Json::as_str).map(String::from).collect()).unwrap_or_default();
                let mut extra = params.at("config").cloned().unwrap_or(Json::Null);
                if params.bool_at("stopOnEntry") == Some(true) {
                    if matches!(extra, Json::Null) {
                        extra = pi_lsp::json::empty();
                    }
                    extra.set("stopOnEntry", Json::Bool(true));
                }
                let env = params.at("env").cloned().unwrap_or(Json::Null);
                let launch = substitute(&spec.launch_config(program.as_deref(), &args, &cwd, &env, &extra, python.as_deref()), "${cwd}", &cwd.to_string_lossy());
                let request = params.str_at("request").unwrap_or_else(|| launch.str_at("request").unwrap_or("launch")).to_string();
                session.launch_started(&request, launch, params, &cwd)?;
                session
            }
        };

        lock(&self.sessions).insert(id.clone(), Entry { session: session.clone(), program: program.map(|p| p.to_string_lossy().to_string()), cursor: 0 });
        let waited = millis(params, "waitMs", 15_000);
        session.wait(waited);
        self.answer(&id, &session, params)
    }

    /// A snapshot plus the output produced since the caller last read it.
    fn answer(&self, id: &str, session: &Session, params: &Json) -> Result<Json, String> {
        let depth = params.u32_at("depth").unwrap_or(1).min(4);
        let levels = params.u32_at("levels").unwrap_or(20).min(200);
        let frame = params.u32_at("frame").unwrap_or(0) as usize;
        let mut snapshot = session.snapshot(frame, depth, levels);
        let cursor = lock(&self.sessions).get(id).map_or(0, |entry| entry.cursor);
        let (lines, next) = session.output_since(cursor);
        if let Some(entry) = lock(&self.sessions).get_mut(id) {
            entry.cursor = next;
        }
        let text: String = lines.iter().map(|(_, text)| text.as_str()).collect();
        let tail: String = text.chars().rev().take(6000).collect::<Vec<_>>().into_iter().rev().collect();
        snapshot.set("output", string(tail));
        snapshot.set("session", string(id));
        Ok(snapshot)
    }

    fn breakpoints(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?;
        let path = params.str_at("path").ok_or("`path` is required")?;
        let path = match PathBuf::from(path) {
            absolute if absolute.is_absolute() => absolute,
            relative => self.config().project_root.join(relative),
        };
        let given: Vec<BreakpointSpec> = params.at("lines").map(|l| l.items().iter().filter_map(BreakpointSpec::parse).collect()).unwrap_or_default();
        // DAP sets a file's breakpoints as a whole; `add` and `remove` edit
        // the set the session already holds, so the caller need not repeat it.
        let lines = match params.str_at("mode").unwrap_or("replace") {
            "replace" => given,
            mode @ ("add" | "remove") => {
                let mut current = session.breakpoints_in(&path);
                current.retain(|known| !given.iter().any(|spec| spec.line == known.line));
                if mode == "add" {
                    current.extend(given);
                    current.sort_by_key(|spec| spec.line);
                }
                current
            }
            other => return Err(format!("unknown mode `{other}`: use add, remove, or replace")),
        };
        let mut results = Vec::new();
        // Every session gets them: js-debug runs the program in a child.
        let target = session.target();
        results.push(session.set_breakpoints(&path, &lines).map_err(err)?);
        if !target.same(&session) {
            if let Ok(verified) = target.set_breakpoints(&path, &lines) {
                results.push(verified);
            }
        }
        Ok(results.pop().unwrap_or(Json::Null))
    }

    fn exceptions(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?.target();
        let available = session.capabilities().at("exceptionBreakpointFilters").map(|f| f.items().to_vec()).unwrap_or_default();
        let filters: Vec<String> = match params.at("filters") {
            Some(Json::Array(items)) => items.iter().filter_map(Json::as_str).map(String::from).collect(),
            _ => exception_filters(&available, params.str_at("mode").unwrap_or("uncaught")),
        };
        session.set_exception_breakpoints(Some(&filters)).map_err(err)?;
        Ok(object([
            ("filters", pi_lsp::json::strings(&filters)),
            ("available", array(available.iter().map(|f| object([("filter", f.at("filter").cloned().unwrap_or(Json::Null)), ("label", f.at("label").cloned().unwrap_or(Json::Null))])))),
        ]))
    }

    fn control(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?;
        let action = params.str_at("action").ok_or("`action` is required")?;
        let target = session.target();
        target.control(action, params.i64_at("thread")).map_err(err)?;
        if action != "pause" {
            // Let the stop from the previous position clear before waiting.
            std::thread::sleep(Duration::from_millis(20));
        }
        session.wait(millis(params, "waitMs", 10_000));
        let id = session.id().to_string();
        self.answer(&id, &session, params)
    }

    fn wait(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?;
        session.wait(millis(params, "timeoutMs", 10_000));
        let id = session.id().to_string();
        self.answer(&id, &session, params)
    }

    fn inspect(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?;
        let id = session.id().to_string();
        self.answer(&id, &session, params)
    }

    fn frame_id(&self, session: &Session, params: &Json) -> Option<i64> {
        let thread = params.i64_at("thread").or_else(|| session.stopped_thread())?;
        let frames = session.stack(thread, params.u32_at("frame").unwrap_or(0) + 1).ok()?;
        frames.get(params.u32_at("frame").unwrap_or(0) as usize).and_then(|frame| frame.i64_at("id"))
    }

    fn evaluate(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?.target();
        let expression = params.str_at("expression").ok_or("`expression` is required")?;
        let frame = self.frame_id(&session, params);
        let context = params.str_at("context").unwrap_or("repl");
        session.evaluate(expression, frame, context, params.u32_at("depth").unwrap_or(1)).map_err(err)
    }

    fn variables(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?.target();
        let reference = params.i64_at("reference").ok_or("`reference` is required")?;
        session.variables(reference, params.u32_at("depth").unwrap_or(1), params.u32_at("limit").unwrap_or(100) as usize).map_err(err)
    }

    fn set_variable(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?.target();
        let reference = params.i64_at("reference").ok_or("`reference` is required")?;
        let name = params.str_at("name").ok_or("`name` is required")?;
        let value = params.str_at("value").ok_or("`value` is required")?;
        session.set_variable(reference, name, value).map_err(err)
    }

    fn threads(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?.target();
        Ok(array(session.threads().map_err(err)?.into_iter().map(|(id, name)| object([("id", int(id)), ("name", string(name))]))))
    }

    fn stack(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?.target();
        let thread = params.i64_at("thread").or_else(|| session.stopped_thread()).ok_or("no thread")?;
        Ok(array(session.stack(thread, params.u32_at("levels").unwrap_or(50)).map_err(err)?))
    }

    fn output(&self, params: &Json) -> Result<Json, String> {
        let session = self.session(params)?;
        let id = session.id().to_string();
        let since = params.f64_at("since").map(|v| v as u64).unwrap_or_else(|| lock(&self.sessions).get(&id).map_or(0, |entry| entry.cursor));
        let (lines, next) = session.output_since(since);
        if let Some(entry) = lock(&self.sessions).get_mut(&id) {
            entry.cursor = next;
        }
        Ok(object([
            ("lines", array(lines.into_iter().map(|(category, text)| object([("category", string(category)), ("text", string(text))])))),
            ("cursor", int(next as i64)),
        ]))
    }

    fn sessions(&self) -> Json {
        array(lock(&self.sessions).iter().map(|(id, entry)| {
            let target = entry.session.target();
            object([
                ("id", string(id)),
                ("adapter", string(entry.session.adapter())),
                ("program", entry.program.clone().map_or(Json::Null, string)),
                ("status", string(target.status().label())),
                ("pid", entry.session.pid().map_or(Json::Null, |pid| int(pid.into()))),
                ("uptimeSeconds", int(entry.session.uptime().as_secs() as i64)),
                ("events", pi_lsp::json::strings(target.recent_events().iter().rev().take(10).rev())),
                ("stderr", pi_lsp::json::strings(entry.session.stderr_tail())),
            ])
        }))
    }

    fn list_adapters(&self, params: &Json) -> Json {
        let config = self.config();
        let only = params.str_at("path").map(PathBuf::from);
        array(self.adapters().into_iter().filter(|spec| only.as_ref().is_none_or(|path| spec.handles(path))).map(|spec| {
            let first = detect::project_bin_dirs(&config.project_root, &config.project_root);
            let found = detect::which(&spec.probe, &first, &config.toolbox.bin_dirs())
                .or_else(|| spec.install.as_ref().and_then(|install| config.toolbox.locate(&spec.id, install)));
            let status = if found.is_some() {
                "installed"
            } else if spec.install.as_ref().is_some_and(|i| i.automatic() && config.toolbox.cannot_install(i).is_none()) && config.auto_install {
                "installable"
            } else {
                "missing"
            };
            object([
                ("id", string(&spec.id)),
                ("name", string(&spec.name)),
                ("extensions", pi_lsp::json::strings(&spec.extensions)),
                ("transport", string(match spec.transport {
                    crate::adapters::Transport::Stdio => "stdio",
                    crate::adapters::Transport::Tcp => "tcp",
                })),
                ("status", string(status)),
                ("path", found.map_or(Json::Null, |p| string(p.to_string_lossy()))),
                ("install", spec.install.as_ref().map_or(Json::Null, |i| string(i.describe()))),
            ])
        }))
    }

    fn configure(&self, params: &Json) -> Result<Json, String> {
        let mut config = lock(&self.config);
        if let Some(root) = params.str_at("projectRoot") {
            config.project_root = PathBuf::from(root);
        }
        if let Some(adapters) = params.at("adapters") {
            config.user_adapters = adapters.clone();
        }
        if let Some(auto) = params.bool_at("autoInstall") {
            config.auto_install = auto && !pi_lsp::install::downloads_disabled();
        }
        if let Some(dir) = params.str_at("toolsDir") {
            config.toolbox = Toolbox::new(dir);
        }
        Ok(object([("projectRoot", string(config.project_root.to_string_lossy())), ("autoInstall", Json::Bool(config.auto_install))]))
    }

    fn stop(&self, params: &Json) -> Result<Json, String> {
        let ids: Vec<String> = match params.str_at("session") {
            Some(id) => vec![id.to_string()],
            None => lock(&self.sessions).keys().cloned().collect(),
        };
        let mut stopped = Vec::new();
        for id in ids {
            if let Some(entry) = lock(&self.sessions).remove(&id) {
                entry.session.terminate();
                stopped.push(string(id));
            }
        }
        Ok(array(stopped))
    }

    /// Ends every session.
    pub fn shutdown(&self) -> Json {
        self.stop(&Json::Null).unwrap_or(Json::Null)
    }

    pub fn call(&self, method: &str, params: &Json) -> Result<Json, String> {
        match method {
            "configure" => self.configure(params),
            "adapters" => Ok(self.list_adapters(params)),
            "install" => {
                let id = params.str_at("id").ok_or("`id` is required")?;
                let spec = self.adapters().into_iter().find(|spec| spec.id == id).ok_or_else(|| format!("no adapter `{id}`"))?;
                let path = self.install(&spec, &self.config())?;
                Ok(object([("id", string(id)), ("path", string(path.to_string_lossy()))]))
            }
            "start" => self.start(params),
            "breakpoints" => self.breakpoints(params),
            "function_breakpoints" => {
                let names: Vec<String> = params.at("names").map(|n| n.items().iter().filter_map(Json::as_str).map(String::from).collect()).unwrap_or_default();
                self.session(params)?.target().set_function_breakpoints(&names).map_err(err)
            }
            "exceptions" => self.exceptions(params),
            "control" => self.control(params),
            "wait" => self.wait(params),
            "inspect" => self.inspect(params),
            "evaluate" => self.evaluate(params),
            "variables" => self.variables(params),
            "set_variable" => self.set_variable(params),
            "threads" => self.threads(params),
            "stack" => self.stack(params),
            "output" => self.output(params),
            "sessions" => Ok(self.sessions()),
            "stop" => self.stop(params),
            other => Err(format!("unknown dap method: {other}")),
        }
    }
}

impl Default for Hub {
    fn default() -> Self {
        Hub::new()
    }
}

impl Session {
    /// The launch step of [`Hub::start`]: breakpoints from the request, then
    /// the adapter's launch sequence.
    fn launch_started(&self, request: &str, launch: Json, params: &Json, cwd: &Path) -> Result<(), String> {
        let breakpoints = parse_breakpoints(params.at("breakpoints"), cwd);
        let functions: Vec<String> = params.at("functionBreakpoints").map(|n| n.items().iter().filter_map(Json::as_str).map(String::from).collect()).unwrap_or_default();
        let exceptions: Option<Vec<String>> = match params.at("exceptions") {
            // A mode — `uncaught`, `all`, `none` — in this adapter's terms.
            Some(Json::String(mode)) => {
                let available = self.capabilities().at("exceptionBreakpointFilters").map(|f| f.items().to_vec()).unwrap_or_default();
                Some(exception_filters(&available, mode))
            }
            Some(list) => Some(list.items().iter().filter_map(Json::as_str).map(String::from).collect()),
            None => None,
        };
        // Building a Cargo project first can take minutes.
        let timeout = if launch.at("cargo").is_some() { Duration::from_secs(600) } else { millis(params, "launchTimeoutMs", 60_000) };
        self.launch(request, launch, &breakpoints, &functions, exceptions.as_deref(), timeout).map(|_| ()).map_err(|error| {
            self.terminate();
            error.to_string()
        })
    }
}

pub const METHODS: &[&str] = &[
    "configure", "adapters", "install", "start", "breakpoints", "function_breakpoints", "exceptions", "control", "wait",
    "inspect", "evaluate", "variables", "set_variable", "threads", "stack", "output", "sessions", "stop",
];
