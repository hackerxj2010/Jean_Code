//! One debug session: an adapter, the program it debugs, and the state the
//! adapter reports as it runs.
//!
//! A reader thread owns the adapter's output. Responses go to the request
//! waiting on them; events update the session — stopped, continued, exited,
//! output — and wake anyone waiting; reverse requests are answered:
//! `runInTerminal` by starting the program here, `startDebugging` by opening
//! a child session, which is how js-debug runs every Node program.
//!
//! The launch sequence is the one the specification requires and adapters
//! enforce: `initialize`, then `launch` without waiting for its answer, then
//! — once the adapter says `initialized` — the breakpoints and
//! `configurationDone`, and only then the answer to `launch`. debugpy does
//! not answer `launch` until `configurationDone` arrives; a client that
//! waits for it first deadlocks.

use crate::adapters::{AdapterSpec, Transport};
use pi_lsp::json::{self, array, int, object, string, Json, JsonExt};
use pi_lsp::transport::{self, StderrTail, Wire};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Debug, PartialEq)]
pub enum DapError {
    Spawn(String),
    Exited(String),
    Timeout(String),
    /// The adapter refused a request, with its reason.
    Adapter(String),
}

impl fmt::Display for DapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DapError::Spawn(message) => write!(f, "could not start the debugger: {message}"),
            DapError::Exited(message) => write!(f, "the debugger exited: {message}"),
            DapError::Timeout(message) => write!(f, "timed out: {message}"),
            DapError::Adapter(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for DapError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Starting,
    Running,
    Stopped,
    Exited,
    Terminated,
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Status::Starting => "starting",
            Status::Running => "running",
            Status::Stopped => "stopped",
            Status::Exited => "exited",
            Status::Terminated => "terminated",
        }
    }

    fn settled(self) -> bool {
        matches!(self, Status::Stopped | Status::Exited | Status::Terminated)
    }

    /// The program has ended, one way or another.
    pub fn finished(self) -> bool {
        matches!(self, Status::Exited | Status::Terminated)
    }
}

/// A source breakpoint as the caller asks for it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BreakpointSpec {
    pub line: u32,
    pub condition: Option<String>,
    pub hit_condition: Option<String>,
    /// A logpoint: prints instead of stopping. `{expression}` interpolates.
    pub log_message: Option<String>,
}

impl BreakpointSpec {
    fn to_json(&self) -> Json {
        let mut value = object([("line", int(self.line.into()))]);
        if let Some(condition) = &self.condition {
            value.set("condition", string(condition));
        }
        if let Some(hit) = &self.hit_condition {
            value.set("hitCondition", string(hit));
        }
        if let Some(message) = &self.log_message {
            value.set("logMessage", string(message));
        }
        value
    }

    pub fn parse(value: &Json) -> Option<BreakpointSpec> {
        let line = match value {
            Json::Number(n) => *n as u32,
            other => other.u32_at("line")?,
        };
        Some(BreakpointSpec {
            line,
            condition: value.str_at("condition").map(String::from),
            hit_condition: value.str_at("hitCondition").map(String::from),
            log_message: value.str_at("logMessage").or_else(|| value.str_at("log")).map(String::from),
        })
    }
}

/// Output the program and the adapter produced, shared between a session
/// and its children so the caller reads it in one place.
#[derive(Default)]
pub struct Output {
    lines: VecDeque<(u64, String, String)>,
    next: u64,
    chars: usize,
}

impl Output {
    const MAX_CHARS: usize = 400_000;

    fn push(&mut self, category: &str, text: &str) {
        self.chars += text.len();
        self.lines.push_back((self.next, category.to_string(), text.to_string()));
        self.next += 1;
        while self.chars > Self::MAX_CHARS {
            match self.lines.pop_front() {
                Some((_, _, dropped)) => self.chars -= dropped.len(),
                None => break,
            }
        }
    }
}

#[derive(Default)]
struct State {
    status: Option<Status>,
    stop: Option<Json>,
    exit_code: Option<i64>,
    initialized: bool,
    threads: Vec<(i64, String)>,
    events: VecDeque<String>,
    breakpoint_events: Vec<Json>,
    spawned: Vec<Child>,
}

struct Inner {
    id: String,
    adapter: String,
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<i64, Sender<Result<Json, DapError>>>>,
    seq: AtomicI64,
    state: Mutex<State>,
    changed: Condvar,
    alive: AtomicBool,
    child: Mutex<Option<Child>>,
    stderr: StderrTail,
    capabilities: Mutex<Json>,
    output: Arc<Mutex<Output>>,
    /// For TCP adapters: where a child session connects.
    port: Option<u16>,
    children: Mutex<Vec<Session>>,
    /// Every breakpoint set on this session, so a child session started
    /// later is configured with the same ones.
    breakpoints: Mutex<Breakpoints>,
    cwd: PathBuf,
    started: Instant,
}

#[derive(Clone, Default)]
struct Breakpoints {
    source: Vec<(PathBuf, Vec<BreakpointSpec>)>,
    functions: Vec<String>,
    exceptions: Option<Vec<String>>,
}

#[derive(Clone)]
pub struct Session {
    inner: Arc<Inner>,
}

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

impl Session {
    /// Starts the adapter and completes `initialize`.
    pub fn start(spec: &AdapterSpec, command: &[String], cwd: &Path, env: &[(String, String)], id: &str) -> Result<Session, DapError> {
        let (wire, port) = match spec.transport {
            Transport::Stdio => (Wire::spawn(command, cwd, env).map_err(|e| DapError::Spawn(format!("{}: {e}", command.join(" "))))?, None),
            Transport::Tcp => {
                let port = transport::free_port().map_err(|e| DapError::Spawn(e.to_string()))?;
                let command = transport::with_port(command, port);
                let wire = Wire::spawn_listening(&command, cwd, env, port, Duration::from_secs(30))
                    .map_err(|e| DapError::Spawn(format!("{}: {e}", command.join(" "))))?;
                (wire, Some(port))
            }
        };
        let session = Session::from_wire(wire, &spec.id, id, port, cwd, Arc::new(Mutex::new(Output::default())));
        session.initialize(&spec.id)?;
        Ok(session)
    }

    /// Connects to an adapter already listening — attaching to a
    /// `debugpy --listen` or a headless Delve.
    pub fn connect(address: &str, adapter: &str, id: &str, cwd: &Path) -> Result<Session, DapError> {
        let wire = Wire::connect(address, Duration::from_secs(10)).map_err(|e| DapError::Spawn(format!("{address}: {e}")))?;
        let session = Session::from_wire(wire, adapter, id, None, cwd, Arc::new(Mutex::new(Output::default())));
        session.initialize(adapter)?;
        Ok(session)
    }

    fn from_wire(wire: Wire, adapter: &str, id: &str, port: Option<u16>, cwd: &Path, output: Arc<Mutex<Output>>) -> Session {
        let Wire { reader, writer, child, stderr } = wire;
        let inner = Arc::new(Inner {
            id: id.to_string(),
            adapter: adapter.to_string(),
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            seq: AtomicI64::new(1),
            state: Mutex::new(State { status: Some(Status::Starting), ..State::default() }),
            changed: Condvar::new(),
            alive: AtomicBool::new(true),
            child: Mutex::new(child),
            stderr,
            capabilities: Mutex::new(Json::Null),
            output,
            port,
            children: Mutex::new(Vec::new()),
            breakpoints: Mutex::new(Breakpoints::default()),
            cwd: cwd.to_path_buf(),
            started: Instant::now(),
        });
        let reader_inner = Arc::clone(&inner);
        let _ = thread::Builder::new().name(format!("dap-{id}")).spawn(move || read_loop(reader_inner, reader));
        Session { inner }
    }

    fn initialize(&self, adapter_id: &str) -> Result<(), DapError> {
        let arguments = object([
            ("clientID", string("jean")),
            ("clientName", string("Jean Code")),
            ("adapterID", string(adapter_id)),
            ("locale", string("en")),
            ("pathFormat", string("path")),
            ("linesStartAt1", Json::Bool(true)),
            ("columnsStartAt1", Json::Bool(true)),
            ("supportsVariableType", Json::Bool(true)),
            ("supportsVariablePaging", Json::Bool(true)),
            ("supportsRunInTerminalRequest", Json::Bool(true)),
            ("supportsStartDebuggingRequest", Json::Bool(true)),
            ("supportsProgressReporting", Json::Bool(false)),
            ("supportsInvalidatedEvent", Json::Bool(false)),
            ("supportsMemoryReferences", Json::Bool(false)),
            ("supportsArgsCanBeInterpretedByShell", Json::Bool(true)),
        ]);
        let capabilities = self.request("initialize", arguments, DEFAULT_TIMEOUT).map_err(|error| {
            let said = self.inner.stderr.last(5).join(" | ");
            if said.is_empty() {
                error
            } else {
                DapError::Spawn(format!("{error}: {said}"))
            }
        })?;
        *lock(&self.inner.capabilities) = capabilities;
        Ok(())
    }

    pub fn id(&self) -> &str {
        &self.inner.id
    }

    /// Whether two handles are the same session.
    pub fn same(&self, other: &Session) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    pub fn adapter(&self) -> &str {
        &self.inner.adapter
    }

    pub fn pid(&self) -> Option<u32> {
        lock(&self.inner.child).as_ref().map(Child::id)
    }

    pub fn capabilities(&self) -> Json {
        lock(&self.inner.capabilities).clone()
    }

    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    pub fn uptime(&self) -> Duration {
        self.inner.started.elapsed()
    }

    fn supports(&self, capability: &str) -> bool {
        lock(&self.inner.capabilities).bool_at(capability) == Some(true)
    }

    fn write(&self, message: Json) -> Result<(), DapError> {
        let body = message.to_compact();
        let mut writer = lock(&self.inner.writer);
        transport::write_message(&mut **writer, &body).map_err(|error| {
            self.inner.alive.store(false, Ordering::SeqCst);
            DapError::Exited(format!("{}: {error}", self.inner.adapter))
        })
    }

    /// Sends a request; the answer arrives on the returned channel.
    fn send(&self, command: &str, arguments: Json) -> Result<mpsc::Receiver<Result<Json, DapError>>, DapError> {
        if !self.is_alive() {
            return Err(DapError::Exited(format!("{} is not running", self.inner.adapter)));
        }
        let seq = self.inner.seq.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        lock(&self.inner.pending).insert(seq, sender);
        let message = object([("seq", int(seq)), ("type", string("request")), ("command", string(command)), ("arguments", arguments)]);
        if let Err(error) = self.write(message) {
            lock(&self.inner.pending).remove(&seq);
            return Err(error);
        }
        Ok(receiver)
    }

    pub fn request(&self, command: &str, arguments: Json, timeout: Duration) -> Result<Json, DapError> {
        let receiver = self.send(command, arguments)?;
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(DapError::Timeout(format!("{command} after {:.0}s", timeout.as_secs_f64()))),
            Err(RecvTimeoutError::Disconnected) => Err(DapError::Exited(format!("{} closed", self.inner.adapter))),
        }
    }

    /// The session to talk to: the newest live child when the adapter
    /// started one (the program runs there), otherwise this one.
    pub fn target(&self) -> Session {
        let children = lock(&self.inner.children).clone();
        children.iter().rev().find(|child| child.is_alive()).map(Session::target).unwrap_or_else(|| self.clone())
    }

    /// Runs the launch sequence: `launch` (or `attach`), breakpoints and
    /// `configurationDone` once the adapter is ready, then the answer.
    pub fn launch(
        &self,
        request: &str,
        configuration: Json,
        breakpoints: &[(PathBuf, Vec<BreakpointSpec>)],
        functions: &[String],
        exceptions: Option<&[String]>,
        timeout: Duration,
    ) -> Result<Json, DapError> {
        let answer = self.send(request, configuration)?;
        let deadline = Instant::now() + timeout;

        {
            let mut state = lock(&self.inner.state);
            while !state.initialized && self.is_alive() && Instant::now() < deadline {
                state = self.inner.changed.wait_timeout(state, Duration::from_millis(100)).map(|(g, _)| g).unwrap_or_else(|p| p.into_inner().0);
            }
            if !state.initialized {
                drop(state);
                // The launch itself may already have failed; its reason beats
                // "no initialized event".
                if let Ok(Err(error)) = answer.try_recv() {
                    return Err(error);
                }
                return Err(DapError::Timeout(format!("{} never reported it was ready ({})", self.inner.adapter, self.inner.stderr.last(3).join(" | "))));
            }
        }

        let mut verified = Vec::new();
        for (path, specs) in breakpoints {
            verified.push(object([("path", string(path.to_string_lossy())), ("breakpoints", self.set_breakpoints(path, specs)?)]));
        }
        if !functions.is_empty() && self.supports("supportsFunctionBreakpoints") {
            self.set_function_breakpoints(functions)?;
        }
        self.set_exception_breakpoints(exceptions)?;
        if self.supports("supportsConfigurationDoneRequest") {
            self.request("configurationDone", json::empty(), DEFAULT_TIMEOUT)?;
        }
        lock(&self.inner.state).status = Some(Status::Running);
        self.inner.changed.notify_all();

        let remaining = deadline.saturating_duration_since(Instant::now()).max(Duration::from_secs(1));
        match answer.recv_timeout(remaining) {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(DapError::Timeout(format!("{request} was not answered"))),
        }
        Ok(array(verified))
    }

    /// Replaces the breakpoints in one file — DAP sets them per file, as a set.
    pub fn set_breakpoints(&self, path: &Path, specs: &[BreakpointSpec]) -> Result<Json, DapError> {
        {
            let mut recorded = lock(&self.inner.breakpoints);
            recorded.source.retain(|(known, _)| known != path);
            if !specs.is_empty() {
                recorded.source.push((path.to_path_buf(), specs.to_vec()));
            }
        }
        let arguments = object([
            ("source", object([("path", string(path.to_string_lossy())), ("name", string(path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()))])),
            ("breakpoints", array(specs.iter().map(BreakpointSpec::to_json))),
            ("lines", array(specs.iter().map(|s| int(s.line.into())))),
            ("sourceModified", Json::Bool(false)),
        ]);
        let result = self.request("setBreakpoints", arguments, DEFAULT_TIMEOUT)?;
        Ok(array(result.at("breakpoints").map(|b| b.items().to_vec()).unwrap_or_default().into_iter().map(|bp| {
            object([
                ("verified", Json::Bool(bp.bool_at("verified").unwrap_or(false))),
                ("line", bp.at("line").cloned().unwrap_or(Json::Null)),
                ("message", bp.at("message").cloned().unwrap_or(Json::Null)),
                ("id", bp.at("id").cloned().unwrap_or(Json::Null)),
            ])
        })))
    }

    /// The breakpoints this session holds for one file — what
    /// [`Session::set_breakpoints`] last sent for it.
    pub fn breakpoints_in(&self, path: &Path) -> Vec<BreakpointSpec> {
        lock(&self.inner.breakpoints).source.iter().find(|(known, _)| known == path).map(|(_, specs)| specs.clone()).unwrap_or_default()
    }

    pub fn set_function_breakpoints(&self, names: &[String]) -> Result<Json, DapError> {
        lock(&self.inner.breakpoints).functions = names.to_vec();
        let breakpoints = array(names.iter().map(|name| object([("name", string(name))])));
        self.request("setFunctionBreakpoints", object([("breakpoints", breakpoints)]), DEFAULT_TIMEOUT)
    }

    /// Exception breakpoints: the given filters, or — with `None` — the ones
    /// the adapter marks as its defaults.
    pub fn set_exception_breakpoints(&self, filters: Option<&[String]>) -> Result<(), DapError> {
        lock(&self.inner.breakpoints).exceptions = filters.map(<[String]>::to_vec);
        let available = lock(&self.inner.capabilities).at("exceptionBreakpointFilters").map(|f| f.items().to_vec()).unwrap_or_default();
        let chosen: Vec<String> = match filters {
            Some(filters) => filters.to_vec(),
            None => available.iter().filter(|f| f.bool_at("default") == Some(true)).filter_map(|f| f.str_at("filter").map(String::from)).collect(),
        };
        if available.is_empty() && chosen.is_empty() {
            return Ok(());
        }
        self.request("setExceptionBreakpoints", object([("filters", json::strings(&chosen))]), DEFAULT_TIMEOUT).map(|_| ())
    }

    pub fn threads(&self) -> Result<Vec<(i64, String)>, DapError> {
        let result = self.request("threads", Json::Null, DEFAULT_TIMEOUT)?;
        let threads: Vec<(i64, String)> = result
            .at("threads")
            .map(|t| t.items().to_vec())
            .unwrap_or_default()
            .iter()
            .filter_map(|t| Some((t.i64_at("id")?, t.str_at("name").unwrap_or("thread").to_string())))
            .collect();
        lock(&self.inner.state).threads = threads.clone();
        Ok(threads)
    }

    /// The thread a stop concerns: the stopped event's, or the first.
    pub fn stopped_thread(&self) -> Option<i64> {
        let stop = lock(&self.inner.state).stop.clone();
        stop.and_then(|s| s.i64_at("threadId")).or_else(|| self.threads().ok().and_then(|t| t.first().map(|(id, _)| *id)))
    }

    pub fn stack(&self, thread: i64, levels: u32) -> Result<Vec<Json>, DapError> {
        let result = self.request("stackTrace", object([("threadId", int(thread)), ("startFrame", int(0)), ("levels", int(levels.into()))]), DEFAULT_TIMEOUT)?;
        let mut sources: HashMap<String, Option<Vec<String>>> = HashMap::new();
        Ok(result
            .at("stackFrames")
            .map(|f| f.items().to_vec())
            .unwrap_or_default()
            .iter()
            .map(|frame| {
                let path = frame.str_at("source.path").map(String::from);
                let line = frame.i64_at("line").unwrap_or(0);
                let text = path.as_ref().and_then(|path| {
                    let lines = sources
                        .entry(path.clone())
                        .or_insert_with(|| std::fs::read_to_string(path).ok().map(|t| t.lines().map(String::from).collect()));
                    lines.as_ref().and_then(|lines| lines.get((line - 1).max(0) as usize).map(|l| l.trim().to_string()))
                });
                object([
                    ("id", frame.at("id").cloned().unwrap_or(Json::Null)),
                    ("name", string(frame.str_at("name").unwrap_or("?"))),
                    ("path", path.map_or(Json::Null, string)),
                    ("line", int(line)),
                    ("column", int(frame.i64_at("column").unwrap_or(0))),
                    ("text", text.map_or(Json::Null, string)),
                ])
            })
            .collect())
    }

    pub fn scopes(&self, frame: i64) -> Result<Vec<Json>, DapError> {
        let result = self.request("scopes", object([("frameId", int(frame))]), DEFAULT_TIMEOUT)?;
        Ok(result.at("scopes").map(|s| s.items().to_vec()).unwrap_or_default())
    }

    /// Variables under a reference, expanded `depth` levels, each level
    /// capped at `limit` entries — a large array must not flood the context.
    pub fn variables(&self, reference: i64, depth: u32, limit: usize) -> Result<Json, DapError> {
        let result = self.request("variables", object([("variablesReference", int(reference)), ("start", int(0)), ("count", int(limit as i64))]), DEFAULT_TIMEOUT)?;
        let items = result.at("variables").map(|v| v.items().to_vec()).unwrap_or_default();
        let mut out = Vec::new();
        for variable in items.iter().take(limit) {
            let child = variable.i64_at("variablesReference").unwrap_or(0);
            let value: String = variable.str_at("value").unwrap_or_default().chars().take(500).collect();
            let mut entry = object([
                ("name", string(variable.str_at("name").unwrap_or("?"))),
                ("value", string(value)),
                ("type", variable.at("type").cloned().unwrap_or(Json::Null)),
                ("reference", int(child)),
            ]);
            if depth > 0 && child > 0 {
                if let Ok(children) = self.variables(child, depth - 1, limit) {
                    entry.set("children", children);
                }
            }
            out.push(entry);
        }
        if items.len() > limit {
            out.push(object([("name", string("…")), ("value", string(format!("{} more", items.len() - limit)))]));
        }
        Ok(array(out))
    }

    pub fn evaluate(&self, expression: &str, frame: Option<i64>, context: &str, depth: u32) -> Result<Json, DapError> {
        let mut arguments = object([("expression", string(expression)), ("context", string(context))]);
        if let Some(frame) = frame {
            arguments.set("frameId", int(frame));
        }
        let result = self.request("evaluate", arguments, DEFAULT_TIMEOUT)?;
        let reference = result.i64_at("variablesReference").unwrap_or(0);
        let mut value = object([
            ("result", string(result.str_at("result").unwrap_or_default())),
            ("type", result.at("type").cloned().unwrap_or(Json::Null)),
            ("reference", int(reference)),
        ]);
        if depth > 0 && reference > 0 {
            value.set("children", self.variables(reference, depth - 1, 50)?);
        }
        Ok(value)
    }

    pub fn set_variable(&self, reference: i64, name: &str, value: &str) -> Result<Json, DapError> {
        self.request("setVariable", object([("variablesReference", int(reference)), ("name", string(name)), ("value", string(value))]), DEFAULT_TIMEOUT)
    }

    /// Resumes, steps, or pauses.
    pub fn control(&self, action: &str, thread: Option<i64>) -> Result<(), DapError> {
        let command = match action {
            "continue" => "continue",
            "next" | "over" | "step" => "next",
            "stepIn" | "in" => "stepIn",
            "stepOut" | "out" => "stepOut",
            "pause" => "pause",
            "stepBack" | "back" => "stepBack",
            "reverseContinue" => "reverseContinue",
            other => return Err(DapError::Adapter(format!("unknown action `{other}`: use continue, next, stepIn, stepOut, or pause"))),
        };
        if matches!(command, "stepBack" | "reverseContinue") && !self.supports("supportsStepBack") {
            return Err(DapError::Adapter(format!("{} cannot step backwards", self.inner.adapter)));
        }
        let thread = match thread {
            Some(thread) => thread,
            None => self.stopped_thread().ok_or_else(|| DapError::Adapter("no thread to act on".into()))?,
        };
        let mut arguments = object([("threadId", int(thread))]);
        if command != "pause" && command != "continue" {
            arguments.set("granularity", string("line"));
        }
        if command != "pause" {
            // Cleared before the request, so a stop that arrives while it is
            // in flight is not mistaken for the old one.
            let mut state = lock(&self.inner.state);
            state.status = Some(Status::Running);
            state.stop = None;
        }
        self.request(command, arguments, DEFAULT_TIMEOUT)?;
        Ok(())
    }

    pub fn status(&self) -> Status {
        lock(&self.inner.state).status.unwrap_or(Status::Starting)
    }

    /// Waits until the program stops, exits, or `timeout` passes; returns the
    /// status it ended in.
    pub fn wait(&self, timeout: Duration) -> Status {
        let deadline = Instant::now() + timeout;
        loop {
            let target = self.target();
            let status = target.status();
            if status.settled() {
                return status;
            }
            let now = Instant::now();
            if now >= deadline {
                return status;
            }
            let state = lock(&target.inner.state);
            let _ = target.inner.changed.wait_timeout(state, deadline.saturating_duration_since(now).min(Duration::from_millis(100)));
        }
    }

    pub fn stop_info(&self) -> Option<Json> {
        lock(&self.inner.state).stop.clone()
    }

    pub fn exit_code(&self) -> Option<i64> {
        lock(&self.inner.state).exit_code
    }

    /// Output lines after `cursor`, and the cursor to pass next time.
    pub fn output_since(&self, cursor: u64) -> (Vec<(String, String)>, u64) {
        let output = lock(&self.inner.output);
        let lines = output.lines.iter().filter(|(index, _, _)| *index >= cursor).map(|(_, category, text)| (category.clone(), text.clone())).collect();
        (lines, output.next)
    }

    /// Where the program is and what it holds: the stop reason, the stack,
    /// and the top frame's variables. What an agent needs to answer "why is
    /// this wrong" in one call.
    pub fn snapshot(&self, frame_index: usize, depth: u32, levels: u32) -> Json {
        let target = self.target();
        let status = target.status();
        let mut value = object([("session", string(&self.inner.id)), ("status", string(status.label()))]);
        if let Some(code) = target.exit_code().or_else(|| self.exit_code()) {
            value.set("exitCode", int(code));
        }
        if status != Status::Stopped {
            return value;
        }
        if let Some(stop) = target.stop_info() {
            value.set("reason", stop.at("reason").cloned().unwrap_or(Json::Null));
            value.set("description", stop.at("description").cloned().unwrap_or(Json::Null));
            value.set("text", stop.at("text").cloned().unwrap_or(Json::Null));
        }
        let Some(thread) = target.stopped_thread() else { return value };
        value.set("thread", int(thread));
        let frames = target.stack(thread, levels.max(1)).unwrap_or_default();
        if let Some(frame) = frames.get(frame_index).or_else(|| frames.first()) {
            if let Some(frame_id) = frame.i64_at("id") {
                let mut scopes = Vec::new();
                for scope in target.scopes(frame_id).unwrap_or_default() {
                    let expensive = scope.bool_at("expensive").unwrap_or(false);
                    let reference = scope.i64_at("variablesReference").unwrap_or(0);
                    let variables = if expensive || reference == 0 { Json::Null } else { target.variables(reference, depth, 40).unwrap_or(Json::Null) };
                    scopes.push(object([
                        ("name", string(scope.str_at("name").unwrap_or("scope"))),
                        ("reference", int(reference)),
                        ("expensive", Json::Bool(expensive)),
                        ("variables", variables),
                    ]));
                }
                value.set("scopes", array(scopes));
            }
        }
        value.set("frames", array(frames));
        value
    }

    /// Ends the session: `terminate` or `disconnect`, then the adapter's
    /// whole process tree — the debuggee included — so nothing is left
    /// running whatever the adapter did.
    pub fn terminate(&self) {
        for child in lock(&self.inner.children).drain(..) {
            child.terminate();
        }
        if self.is_alive() {
            if self.supports("supportsTerminateRequest") {
                let _ = self.request("terminate", object([("restart", Json::Bool(false))]), Duration::from_secs(3));
            }
            let _ = self.request("disconnect", object([("terminateDebuggee", Json::Bool(true)), ("restart", Json::Bool(false))]), Duration::from_secs(3));
        }
        self.inner.alive.store(false, Ordering::SeqCst);
        for mut spawned in lock(&self.inner.state).spawned.drain(..) {
            let _ = pi_sys::kill_tree(spawned.id(), true);
            let _ = spawned.kill();
            let _ = spawned.wait();
        }
        if let Some(child) = lock(&self.inner.child).as_mut() {
            let _ = pi_sys::kill_tree(child.id(), true);
            let _ = child.kill();
            let _ = child.wait();
        }
        let mut state = lock(&self.inner.state);
        if !matches!(state.status, Some(Status::Exited)) {
            state.status = Some(Status::Terminated);
        }
        drop(state);
        self.inner.changed.notify_all();
    }

    pub fn recent_events(&self) -> Vec<String> {
        lock(&self.inner.state).events.iter().cloned().collect()
    }

    pub fn stderr_tail(&self) -> Vec<String> {
        self.inner.stderr.last(10)
    }
}

fn read_loop(inner: Arc<Inner>, mut reader: Box<dyn BufRead + Send>) {
    loop {
        match transport::read_message(&mut reader) {
            Ok(Some(body)) => {
                if let Ok(message) = json::parse(&String::from_utf8_lossy(&body)) {
                    handle(&inner, message);
                }
            }
            Ok(None) | Err(_) => break,
        }
    }
    inner.alive.store(false, Ordering::SeqCst);
    let pending: Vec<_> = lock(&inner.pending).drain().map(|(_, sender)| sender).collect();
    for sender in pending {
        let _ = sender.send(Err(DapError::Exited(format!("{} closed its connection", inner.adapter))));
    }
    let mut state = lock(&inner.state);
    if !matches!(state.status, Some(Status::Exited)) {
        state.status = Some(Status::Terminated);
    }
    drop(state);
    inner.changed.notify_all();
}

fn respond(inner: &Inner, request: &Json, body: Result<Json, String>) {
    let seq = inner.seq.fetch_add(1, Ordering::SeqCst);
    let mut message = object([
        ("seq", int(seq)),
        ("type", string("response")),
        ("request_seq", request.at("seq").cloned().unwrap_or(Json::Null)),
        ("command", request.at("command").cloned().unwrap_or(Json::Null)),
    ]);
    match body {
        Ok(body) => {
            message.set("success", Json::Bool(true));
            message.set("body", body);
        }
        Err(reason) => {
            message.set("success", Json::Bool(false));
            message.set("message", string(reason));
        }
    }
    let _ = transport::write_message(&mut **lock(&inner.writer), &message.to_compact());
}

fn handle(inner: &Arc<Inner>, message: Json) {
    match message.str_at("type") {
        Some("response") => {
            let Some(seq) = message.i64_at("request_seq") else { return };
            let Some(sender) = lock(&inner.pending).remove(&seq) else { return };
            let reply = if message.bool_at("success") == Some(true) {
                Ok(message.at("body").cloned().unwrap_or(Json::Null))
            } else {
                // The formatted error, when the adapter gives one, says more
                // than the bare `message` field.
                let detail = message.str_at("body.error.format").or_else(|| message.str_at("message")).unwrap_or("the request failed");
                Err(DapError::Adapter(detail.to_string()))
            };
            let _ = sender.send(reply);
        }
        Some("event") => event(inner, &message),
        Some("request") => reverse_request(inner, &message),
        _ => {}
    }
}

fn event(inner: &Arc<Inner>, message: &Json) {
    let name = message.str_at("event").unwrap_or_default().to_string();
    let body = message.at("body").cloned().unwrap_or(Json::Null);
    if name == "output" {
        let category = body.str_at("category").unwrap_or("console");
        if category != "telemetry" {
            lock(&inner.output).push(category, body.str_at("output").unwrap_or_default());
        }
        inner.changed.notify_all();
        return;
    }

    let mut state = lock(&inner.state);
    if state.events.len() >= 50 {
        state.events.pop_front();
    }
    state.events.push_back(name.clone());
    match name.as_str() {
        "initialized" => state.initialized = true,
        "stopped" => {
            state.status = Some(Status::Stopped);
            state.stop = Some(body);
        }
        "continued" => {
            state.status = Some(Status::Running);
            state.stop = None;
        }
        "exited" => {
            state.exit_code = body.i64_at("exitCode");
            state.status = Some(Status::Exited);
        }
        "terminated" => {
            if !matches!(state.status, Some(Status::Exited)) {
                state.status = Some(Status::Terminated);
            }
        }
        "thread" => {
            if let Some(id) = body.i64_at("threadId") {
                if body.str_at("reason") == Some("exited") {
                    state.threads.retain(|(thread, _)| *thread != id);
                }
            }
        }
        "breakpoint" => state.breakpoint_events.push(body),
        _ => {}
    }
    drop(state);
    inner.changed.notify_all();
}

fn drain_into(stream: impl Read + Send + 'static, output: Arc<Mutex<Output>>, category: &'static str) {
    thread::spawn(move || {
        for line in BufReader::new(stream).split(b'\n').map_while(Result::ok) {
            lock(&output).push(category, &format!("{}\n", String::from_utf8_lossy(&line).trim_end_matches('\r')));
        }
    });
}

fn reverse_request(inner: &Arc<Inner>, request: &Json) {
    let arguments = request.at("arguments").cloned().unwrap_or(Json::Null);
    match request.str_at("command") {
        Some("runInTerminal") => {
            // There is no terminal: the program runs here, and its output is
            // captured like any other.
            let args: Vec<String> = arguments.at("args").map(|a| a.items().iter().filter_map(Json::as_str).map(String::from).collect()).unwrap_or_default();
            let Some((program, rest)) = args.split_first() else {
                respond(inner, request, Err("runInTerminal without a command".into()));
                return;
            };
            let mut command = Command::new(program);
            command.args(rest).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
            command.current_dir(arguments.str_at("cwd").map(PathBuf::from).unwrap_or_else(|| inner.cwd.clone()));
            if let Some(Json::Object(env)) = arguments.at("env") {
                for (key, value) in env {
                    match value {
                        Json::Null => {
                            command.env_remove(key);
                        }
                        other => {
                            command.env(key, other.as_str().unwrap_or_default());
                        }
                    }
                }
            }
            match command.spawn() {
                Ok(mut child) => {
                    if let Some(stdout) = child.stdout.take() {
                        drain_into(stdout, Arc::clone(&inner.output), "stdout");
                    }
                    if let Some(stderr) = child.stderr.take() {
                        drain_into(stderr, Arc::clone(&inner.output), "stderr");
                    }
                    let pid = child.id();
                    lock(&inner.state).spawned.push(child);
                    respond(inner, request, Ok(object([("processId", int(pid.into()))])));
                }
                Err(error) => respond(inner, request, Err(format!("{program}: {error}"))),
            }
        }
        Some("startDebugging") => {
            let Some(port) = inner.port else {
                respond(inner, request, Err("child sessions need a TCP adapter".into()));
                return;
            };
            respond(inner, request, Ok(Json::Null));
            let parent = Arc::clone(inner);
            let kind = arguments.str_at("request").unwrap_or("launch").to_string();
            let configuration = arguments.at("configuration").cloned().unwrap_or(Json::Null);
            thread::spawn(move || {
                let id = format!("{}.{}", parent.id, lock(&parent.children).len() + 1);
                let Ok(wire) = Wire::connect(&format!("127.0.0.1:{port}"), Duration::from_secs(10)) else { return };
                let child = Session::from_wire(wire, &parent.adapter, &id, Some(port), &parent.cwd, Arc::clone(&parent.output));
                if child.initialize(&parent.adapter).is_err() {
                    return;
                }
                lock(&parent.children).push(child.clone());
                parent.changed.notify_all();
                let breakpoints = lock(&parent.breakpoints).clone();
                let _ = child.launch(
                    &kind,
                    configuration,
                    &breakpoints.source,
                    &breakpoints.functions,
                    breakpoints.exceptions.as_deref(),
                    Duration::from_secs(60),
                );
                parent.changed.notify_all();
            });
        }
        Some(other) => respond(inner, request, Err(format!("{other} is not supported"))),
        None => {}
    }
}
