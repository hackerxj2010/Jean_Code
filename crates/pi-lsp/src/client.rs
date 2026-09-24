//! One running language server.
//!
//! A reader thread owns the server's output: it pairs responses with the
//! requests waiting on them, stores what the server publishes (diagnostics,
//! progress, log messages), and answers the requests a server makes of its
//! client — its configuration, dynamic capability registrations, and edits it
//! wants applied. Every public method is callable from any thread; the bridge
//! runs language-server calls concurrently so one slow `references` does not
//! hold up a `hover` somewhere else.
//!
//! Documents are synchronised from disk before every request. The agent edits
//! files with its own tools, not through this client, so the file on disk is
//! the truth and the server is told about it — opened, changed, saved — just
//! before it is asked anything about it.

use crate::json::{self, array, empty, int, object, string, Json, JsonExt};
use crate::languages;
use crate::protocol::Diagnostic;
use crate::transport::{self, StderrTail, Wire};
use crate::uri;
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub enum LspError {
    /// The server could not be started.
    Spawn(String),
    /// The server is gone.
    Exited(String),
    /// No answer in time; the request was cancelled.
    Timeout(String),
    /// The server answered with an error.
    Server { code: i64, message: String },
    /// Reading a file, or writing to the server, failed.
    Io(String),
}

impl fmt::Display for LspError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LspError::Spawn(message) => write!(f, "could not start the server: {message}"),
            LspError::Exited(message) => write!(f, "the server exited: {message}"),
            LspError::Timeout(message) => write!(f, "timed out: {message}"),
            LspError::Server { code, message } => write!(f, "server error {code}: {message}"),
            LspError::Io(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for LspError {}

/// How to start a server.
#[derive(Clone, Debug)]
pub struct LaunchSpec {
    pub server: String,
    /// The resolved program, then its arguments.
    pub command: Vec<String>,
    pub root: PathBuf,
    pub env: Vec<(String, String)>,
    pub initialization: Json,
    pub settings: Json,
    pub language_id: Option<String>,
}

type Reply = Result<Json, LspError>;

struct Document {
    version: i64,
    text: String,
    /// The publish count when the server was last told of new text: only a
    /// publish after it describes this text.
    changed_at: u64,
}

struct Published {
    items: Vec<Json>,
    /// Which publish this was, counting every publish from this server.
    sequence: u64,
}

#[derive(Clone, Debug)]
pub struct Progress {
    pub title: String,
    pub message: Option<String>,
    pub percentage: Option<u32>,
    pub done: bool,
}

#[derive(Default)]
struct State {
    documents: HashMap<String, Document>,
    diagnostics: HashMap<String, Published>,
    pulled: HashMap<String, (Option<String>, Vec<Json>)>,
    publishes: u64,
    progress: HashMap<String, Progress>,
    registrations: HashMap<String, (String, Json)>,
    messages: VecDeque<(String, String)>,
    applied: Vec<Vec<PathBuf>>,
}

struct Inner {
    server: String,
    root: PathBuf,
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<i64, Sender<Reply>>>,
    next_id: AtomicI64,
    state: Mutex<State>,
    changed: Condvar,
    alive: AtomicBool,
    child: Mutex<Option<Child>>,
    stderr: StderrTail,
    settings: Json,
    capabilities: Mutex<Json>,
    server_info: Mutex<Json>,
    language_id: Option<String>,
    started: Instant,
    /// Held for the whole of a sync, so two threads syncing one file cannot
    /// send their `didChange` versions out of order.
    sync_lock: Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panicked holder leaves the data as it was; carrying on beats wedging
    // every later call on a poisoned lock.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The capabilities this client declares. Everything it can make use of, so
/// servers turn on everything they have.
fn client_capabilities() -> Json {
    json::literal(
        r#"{
  "general": {"positionEncodings": ["utf-16"], "markdown": {"parser": "marked"}, "staleRequestSupport": {"cancel": true, "retryOnContentModified": []}},
  "window": {"workDoneProgress": true, "showMessage": {}, "showDocument": {"support": false}},
  "workspace": {
    "applyEdit": true,
    "workspaceEdit": {"documentChanges": true, "resourceOperations": ["create", "rename", "delete"], "failureHandling": "abort", "normalizesLineEndings": true, "changeAnnotationSupport": {"groupsOnLabel": true}},
    "didChangeConfiguration": {"dynamicRegistration": true},
    "didChangeWatchedFiles": {"dynamicRegistration": true, "relativePatternSupport": true},
    "symbol": {"dynamicRegistration": false, "symbolKind": {"valueSet": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26]}},
    "executeCommand": {"dynamicRegistration": false},
    "workspaceFolders": true,
    "configuration": true,
    "semanticTokens": {"refreshSupport": false},
    "codeLens": {"refreshSupport": false},
    "inlayHint": {"refreshSupport": false},
    "diagnostics": {"refreshSupport": true},
    "fileOperations": {"dynamicRegistration": false, "willRename": true, "didRename": true, "didCreate": true, "didDelete": true}
  },
  "textDocument": {
    "synchronization": {"dynamicRegistration": false, "willSave": false, "willSaveWaitUntil": false, "didSave": true},
    "publishDiagnostics": {"relatedInformation": true, "versionSupport": true, "tagSupport": {"valueSet": [1, 2]}, "codeDescriptionSupport": true, "dataSupport": true},
    "diagnostic": {"dynamicRegistration": true, "relatedDocumentSupport": true},
    "hover": {"contentFormat": ["markdown", "plaintext"]},
    "completion": {"contextSupport": true, "completionItem": {"snippetSupport": false, "documentationFormat": ["markdown", "plaintext"], "deprecatedSupport": true, "tagSupport": {"valueSet": [1]}, "labelDetailsSupport": true, "resolveSupport": {"properties": ["documentation", "detail"]}}, "completionItemKind": {"valueSet": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25]}},
    "signatureHelp": {"contextSupport": true, "signatureInformation": {"documentationFormat": ["markdown", "plaintext"], "parameterInformation": {"labelOffsetSupport": true}, "activeParameterSupport": true}},
    "definition": {"linkSupport": true},
    "typeDefinition": {"linkSupport": true},
    "implementation": {"linkSupport": true},
    "declaration": {"linkSupport": true},
    "references": {},
    "documentHighlight": {},
    "documentSymbol": {"hierarchicalDocumentSymbolSupport": true, "symbolKind": {"valueSet": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26]}},
    "codeAction": {"isPreferredSupport": true, "disabledSupport": true, "dataSupport": true, "resolveSupport": {"properties": ["edit"]}, "codeActionLiteralSupport": {"codeActionKind": {"valueSet": ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"]}}},
    "codeLens": {},
    "formatting": {},
    "rangeFormatting": {},
    "rename": {"prepareSupport": true},
    "foldingRange": {"lineFoldingOnly": true},
    "selectionRange": {},
    "callHierarchy": {},
    "typeHierarchy": {},
    "inlayHint": {},
    "semanticTokens": {"requests": {"full": true, "range": false}, "formats": ["relative"], "tokenTypes": ["namespace","type","class","enum","interface","struct","typeParameter","parameter","variable","property","enumMember","event","function","method","macro","keyword","modifier","comment","string","number","regexp","operator","decorator"], "tokenModifiers": ["declaration","definition","readonly","static","deprecated","abstract","async","modification","documentation","defaultLibrary"]}
  }
}"#,
    )
}

/// Replaces `${root}` in string values of settings a server was configured
/// with — `rootPath`-relative settings are common.
fn expand(value: &Json, root: &Path) -> Json {
    match value {
        Json::String(text) => Json::String(text.replace("${root}", &root.to_string_lossy())),
        Json::Array(items) => Json::Array(items.iter().map(|item| expand(item, root)).collect()),
        Json::Object(map) => Json::Object(map.iter().map(|(key, item)| (key.clone(), expand(item, root))).collect()),
        other => other.clone(),
    }
}

/// How a diagnostics call ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Freshness {
    /// Reported for the file as it is on disk now.
    Current,
    /// The server had not reported on the latest content by the deadline;
    /// these are the last it did report.
    Stale,
    /// The server has said nothing about this file.
    Unknown,
}

impl Freshness {
    pub fn label(&self) -> &'static str {
        match self {
            Freshness::Current => "current",
            Freshness::Stale => "stale",
            Freshness::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Synced {
    Opened,
    Changed,
    Unchanged,
    Missing,
}

#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl Client {
    /// Starts a server and completes the `initialize` handshake.
    pub fn start(spec: &LaunchSpec, timeout: Duration) -> Result<Client, LspError> {
        let wire = Wire::spawn(&spec.command, &spec.root, &spec.env)
            .map_err(|error| LspError::Spawn(format!("{}: {error}", spec.command.join(" "))))?;
        Client::connect(spec, wire, timeout)
    }

    /// Completes the handshake over an existing connection — how tests and a
    /// server reached over TCP get a client.
    pub fn connect(spec: &LaunchSpec, wire: Wire, timeout: Duration) -> Result<Client, LspError> {
        let Wire { reader, writer, child, stderr } = wire;
        let inner = Arc::new(Inner {
            server: spec.server.clone(),
            root: spec.root.clone(),
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            alive: AtomicBool::new(true),
            child: Mutex::new(child),
            stderr,
            settings: expand(&spec.settings, &spec.root),
            capabilities: Mutex::new(Json::Null),
            server_info: Mutex::new(Json::Null),
            language_id: spec.language_id.clone(),
            started: Instant::now(),
            sync_lock: Mutex::new(()),
        });

        let reader_inner = Arc::clone(&inner);
        thread::Builder::new()
            .name(format!("lsp-{}", spec.server))
            .spawn(move || read_loop(reader_inner, reader))
            .map_err(|error| LspError::Spawn(error.to_string()))?;

        let client = Client { inner };
        let root_uri = uri::path_to_uri(&spec.root);
        let name = spec.root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "root".into());
        let params = object([
            ("processId", int(std::process::id().into())),
            ("clientInfo", object([("name", string("Jean Code")), ("version", string(env!("CARGO_PKG_VERSION")))])),
            ("locale", string("en")),
            ("rootPath", string(spec.root.to_string_lossy())),
            ("rootUri", string(&root_uri)),
            ("workspaceFolders", array([object([("uri", string(&root_uri)), ("name", string(name))])])),
            ("initializationOptions", expand(&spec.initialization, &spec.root)),
            ("capabilities", client_capabilities()),
            ("trace", string("off")),
        ]);

        let result = match client.request("initialize", params, timeout) {
            Ok(result) => result,
            Err(error) => {
                let said = client.inner.stderr.last(6).join("\n");
                client.kill();
                return Err(match error {
                    LspError::Exited(_) | LspError::Timeout(_) if !said.is_empty() => LspError::Spawn(format!("{error}\n{said}")),
                    other => other,
                });
            }
        };
        *lock(&client.inner.capabilities) = result.at("capabilities").cloned().unwrap_or_else(empty);
        *lock(&client.inner.server_info) = result.at("serverInfo").cloned().unwrap_or(Json::Null);

        client.notify("initialized", empty())?;
        if !matches!(client.inner.settings, Json::Null) {
            client.notify("workspace/didChangeConfiguration", object([("settings", client.inner.settings.clone())]))?;
        }
        Ok(client)
    }

    pub fn server(&self) -> &str {
        &self.inner.server
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    pub fn pid(&self) -> Option<u32> {
        lock(&self.inner.child).as_ref().map(Child::id)
    }

    pub fn uptime(&self) -> Duration {
        self.inner.started.elapsed()
    }

    pub fn capabilities(&self) -> Json {
        lock(&self.inner.capabilities).clone()
    }

    pub fn server_info(&self) -> Json {
        lock(&self.inner.server_info).clone()
    }

    pub fn stderr_tail(&self, lines: usize) -> Vec<String> {
        self.inner.stderr.last(lines)
    }

    /// Log and show-message notifications, newest last.
    pub fn messages(&self) -> Vec<(String, String)> {
        lock(&self.inner.state).messages.iter().cloned().collect()
    }

    /// Work the server has reported as in progress: indexing, a `cargo check`.
    pub fn active_progress(&self) -> Vec<Progress> {
        lock(&self.inner.state).progress.values().filter(|p| !p.done).cloned().collect()
    }

    pub fn open_documents(&self) -> usize {
        lock(&self.inner.state).documents.len()
    }

    /// Files a `workspace/applyEdit` from this server has changed since the
    /// last call — how executing a command that edits reports what it did.
    pub fn take_applied(&self) -> Vec<PathBuf> {
        std::mem::take(&mut lock(&self.inner.state).applied).into_iter().flatten().collect()
    }

    /// Whether the server handles `method`, statically or by a dynamic
    /// registration.
    pub fn supports(&self, method: &str) -> bool {
        let capability = match method {
            "textDocument/hover" => "hoverProvider",
            "textDocument/definition" => "definitionProvider",
            "textDocument/typeDefinition" => "typeDefinitionProvider",
            "textDocument/implementation" => "implementationProvider",
            "textDocument/declaration" => "declarationProvider",
            "textDocument/references" => "referencesProvider",
            "textDocument/documentSymbol" => "documentSymbolProvider",
            "workspace/symbol" => "workspaceSymbolProvider",
            "textDocument/rename" => "renameProvider",
            "textDocument/prepareRename" => "renameProvider.prepareProvider",
            "textDocument/codeAction" => "codeActionProvider",
            "codeAction/resolve" => "codeActionProvider.resolveProvider",
            "textDocument/formatting" => "documentFormattingProvider",
            "textDocument/rangeFormatting" => "documentRangeFormattingProvider",
            "textDocument/completion" => "completionProvider",
            "textDocument/signatureHelp" => "signatureHelpProvider",
            "textDocument/prepareCallHierarchy" => "callHierarchyProvider",
            "textDocument/prepareTypeHierarchy" => "typeHierarchyProvider",
            "textDocument/inlayHint" => "inlayHintProvider",
            "textDocument/documentHighlight" => "documentHighlightProvider",
            "textDocument/codeLens" => "codeLensProvider",
            "textDocument/foldingRange" => "foldingRangeProvider",
            "textDocument/semanticTokens/full" => "semanticTokensProvider",
            "textDocument/diagnostic" => "diagnosticProvider",
            "workspace/willRenameFiles" => "workspace.fileOperations.willRename",
            "workspace/executeCommand" => "executeCommandProvider",
            _ => "",
        };
        if !capability.is_empty() && lock(&self.inner.capabilities).enabled(capability) {
            return true;
        }
        lock(&self.inner.state).registrations.values().any(|(registered, _)| registered == method)
    }

    /// Sends a request and waits for its answer.
    pub fn request(&self, method: &str, params: Json, timeout: Duration) -> Result<Json, LspError> {
        if !self.is_alive() {
            return Err(LspError::Exited(self.exit_reason()));
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        lock(&self.inner.pending).insert(id, sender);

        let message = object([("jsonrpc", string("2.0")), ("id", int(id)), ("method", string(method)), ("params", params)]);
        if let Err(error) = self.write(&message) {
            lock(&self.inner.pending).remove(&id);
            return Err(error);
        }

        match receiver.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.inner.pending).remove(&id);
                // Tell the server to stop working on it: an abandoned
                // `references` on a large project can otherwise hold a core
                // for a minute.
                let _ = self.notify("$/cancelRequest", object([("id", int(id))]));
                Err(LspError::Timeout(format!("{method} after {:.1}s", timeout.as_secs_f64())))
            }
            Err(RecvTimeoutError::Disconnected) => Err(LspError::Exited(self.exit_reason())),
        }
    }

    pub fn notify(&self, method: &str, params: Json) -> Result<(), LspError> {
        self.write(&object([("jsonrpc", string("2.0")), ("method", string(method)), ("params", params)]))
    }

    fn write(&self, message: &Json) -> Result<(), LspError> {
        let body = message.to_compact();
        let mut writer = lock(&self.inner.writer);
        transport::write_message(&mut **writer, &body).map_err(|error| {
            self.inner.alive.store(false, Ordering::SeqCst);
            LspError::Exited(format!("{error}; {}", self.exit_reason()))
        })
    }

    fn exit_reason(&self) -> String {
        let said = self.inner.stderr.last(4).join(" | ");
        let status = lock(&self.inner.child).as_mut().and_then(|child| child.try_wait().ok().flatten());
        match (status, said.is_empty()) {
            (Some(status), false) => format!("{} exited ({status}): {said}", self.inner.server),
            (Some(status), true) => format!("{} exited ({status})", self.inner.server),
            (None, false) => format!("{} stopped answering: {said}", self.inner.server),
            (None, true) => format!("{} stopped answering", self.inner.server),
        }
    }

    fn language_for(&self, path: &Path) -> String {
        self.inner
            .language_id
            .clone()
            .or_else(|| languages::language_of(path).map(String::from))
            .unwrap_or_else(|| "plaintext".to_string())
    }

    /// Brings the server's copy of a file up to date with the disk.
    pub fn sync(&self, path: &Path) -> Result<Synced, LspError> {
        let _serial = lock(&self.inner.sync_lock);
        let uri = uri::path_to_uri(path);
        let text = match std::fs::read(path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            Err(_) => {
                let was_open = lock(&self.inner.state).documents.remove(&uri).is_some();
                if was_open {
                    self.notify("textDocument/didClose", object([("textDocument", object([("uri", string(&uri))]))]))?;
                }
                return Ok(Synced::Missing);
            }
        };

        let (outcome, version) = {
            let mut state = lock(&self.inner.state);
            let publishes = state.publishes;
            match state.documents.get_mut(&uri) {
                None => {
                    state.documents.insert(uri.clone(), Document { version: 1, text: text.clone(), changed_at: publishes });
                    (Synced::Opened, 1)
                }
                Some(document) if document.text != text => {
                    document.version += 1;
                    document.text = text.clone();
                    document.changed_at = publishes;
                    (Synced::Changed, document.version)
                }
                Some(_) => (Synced::Unchanged, 0),
            }
        };

        match outcome {
            Synced::Opened => {
                self.notify(
                    "textDocument/didOpen",
                    object([(
                        "textDocument",
                        object([
                            ("uri", string(&uri)),
                            ("languageId", string(self.language_for(path))),
                            ("version", int(1)),
                            ("text", string(text)),
                        ]),
                    )]),
                )?;
            }
            Synced::Changed => {
                // The whole text rather than a range: always legal, and a
                // diff computed here would only save bytes on a local pipe.
                self.notify(
                    "textDocument/didChange",
                    object([
                        ("textDocument", object([("uri", string(&uri)), ("version", int(version))])),
                        ("contentChanges", array([object([("text", string(text.clone()))])])),
                    ]),
                )?;
                // The agent's edits are writes to disk — saves. Servers that
                // check on save (rust-analyzer's `cargo check`) only re-check
                // when told.
                let capabilities = self.capabilities();
                if capabilities.enabled("textDocumentSync.save") || capabilities.as_f64_or_zero("textDocumentSync") > 0.0 {
                    let mut params = object([("textDocument", object([("uri", string(&uri))]))]);
                    if capabilities.bool_at("textDocumentSync.save.includeText") == Some(true) {
                        params.set("text", string(text));
                    }
                    self.notify("textDocument/didSave", params)?;
                }
            }
            Synced::Unchanged | Synced::Missing => {}
        }
        Ok(outcome)
    }

    /// Stops tracking a file.
    pub fn close(&self, path: &Path) -> Result<(), LspError> {
        let uri = uri::path_to_uri(path);
        if lock(&self.inner.state).documents.remove(&uri).is_some() {
            self.notify("textDocument/didClose", object([("textDocument", object([("uri", string(&uri))]))]))?;
        }
        Ok(())
    }

    /// The server's diagnostics for a file as it is on disk now.
    ///
    /// Pull (`textDocument/diagnostic`) when the server supports it: one
    /// request, an exact answer. Otherwise push: after syncing, wait for the
    /// server to publish for this file, then keep waiting while it goes on
    /// publishing — servers report in bursts, syntax first and types after —
    /// until it has been quiet for `settle`, or `wait` runs out. A server busy
    /// with reported work (indexing, a build) is given the full `wait`.
    pub fn diagnostics(&self, path: &Path, wait: Duration, settle: Duration) -> Result<(Vec<Diagnostic>, Freshness), LspError> {
        let uri = uri::path_to_uri(path);
        let synced = self.sync(path)?;
        if synced == Synced::Missing {
            return Ok((Vec::new(), Freshness::Current));
        }
        // Publishes after this one describe the text the server now has —
        // whether this call sent it or an earlier sync did (an applied edit).
        let before = lock(&self.inner.state).documents.get(&uri).map_or(0, |document| document.changed_at);

        if self.supports("textDocument/diagnostic") {
            match self.pull(path, &uri, wait) {
                Ok(items) => return Ok((items, Freshness::Current)),
                // Declared but unimplemented is common; push is the fallback.
                Err(LspError::Server { .. }) => {}
                Err(other) => return Err(other),
            }
        }

        let deadline = Instant::now() + wait;
        let mut state = lock(&self.inner.state);
        // Nothing new to tell the server, and it has reported on this text.
        if synced == Synced::Unchanged && state.diagnostics.get(&uri).is_some_and(|published| published.sequence > before) {
            let items = state.diagnostics[&uri].items.clone();
            drop(state);
            return Ok((self.parse_items(path, &items), Freshness::Current));
        }

        let mut last_seen: Option<(u64, Instant)> = None;
        loop {
            if let Some(published) = state.diagnostics.get(&uri) {
                if published.sequence > before && last_seen.is_none_or(|(sequence, _)| sequence != published.sequence) {
                    last_seen = Some((published.sequence, Instant::now()));
                }
            }
            let now = Instant::now();
            let busy = state.progress.values().any(|progress| !progress.done);
            if let Some((_, at)) = last_seen {
                if now.duration_since(at) >= settle && !busy {
                    break;
                }
            }
            if now >= deadline || !self.is_alive() {
                break;
            }
            let slice = deadline.saturating_duration_since(now).min(settle.max(Duration::from_millis(50)));
            state = self.inner.changed.wait_timeout(state, slice).map(|(guard, _)| guard).unwrap_or_else(|p| p.into_inner().0);
        }

        let freshness = if last_seen.is_some() {
            Freshness::Current
        } else if state.diagnostics.contains_key(&uri) {
            Freshness::Stale
        } else {
            Freshness::Unknown
        };
        let items = state.diagnostics.get(&uri).map(|p| p.items.clone()).unwrap_or_default();
        drop(state);
        Ok((self.parse_items(path, &items), freshness))
    }

    fn pull(&self, path: &Path, uri: &str, wait: Duration) -> Result<Vec<Diagnostic>, LspError> {
        let previous = lock(&self.inner.state).pulled.get(uri).and_then(|(id, _)| id.clone());
        let mut params = object([("textDocument", object([("uri", string(uri))]))]);
        if let Some(identifier) = self.capabilities().str_at("diagnosticProvider.identifier") {
            params.set("identifier", string(identifier));
        }
        if let Some(previous) = &previous {
            params.set("previousResultId", string(previous));
        }
        let result = self.request("textDocument/diagnostic", params, wait.max(Duration::from_secs(5)))?;
        let mut state = lock(&self.inner.state);
        let items = if result.str_at("kind") == Some("unchanged") {
            state.pulled.get(uri).map(|(_, items)| items.clone()).unwrap_or_default()
        } else {
            result.at("items").map(|items| items.items().to_vec()).unwrap_or_default()
        };
        state.pulled.insert(uri.to_string(), (result.str_at("resultId").map(String::from), items.clone()));
        drop(state);
        Ok(self.parse_items(path, &items))
    }

    fn parse_items(&self, path: &Path, items: &[Json]) -> Vec<Diagnostic> {
        items.iter().filter_map(|item| Diagnostic::parse(item, path.to_path_buf(), &self.inner.server)).collect()
    }

    /// Every diagnostic this server has published, for any file.
    pub fn all_diagnostics(&self) -> Vec<Diagnostic> {
        let state = lock(&self.inner.state);
        let mut out = Vec::new();
        for (uri, published) in &state.diagnostics {
            let path = uri::uri_to_path(uri);
            out.extend(published.items.iter().filter_map(|item| Diagnostic::parse(item, path.clone(), &self.inner.server)));
        }
        for (uri, (_, items)) in &state.pulled {
            let path = uri::uri_to_path(uri);
            out.extend(items.iter().filter_map(|item| Diagnostic::parse(item, path.clone(), &self.inner.server)));
        }
        out
    }

    /// Tells the server files were created, changed, or deleted behind its
    /// back, when it asked to be told (`workspace/didChangeWatchedFiles`).
    pub fn files_changed(&self, changes: &[(PathBuf, u32)]) -> Result<(), LspError> {
        let wants = lock(&self.inner.state).registrations.values().any(|(method, _)| method == "workspace/didChangeWatchedFiles");
        if !wants || changes.is_empty() {
            return Ok(());
        }
        let events = changes.iter().map(|(path, kind)| object([("uri", string(uri::path_to_uri(path))), ("type", int((*kind).into()))]));
        self.notify("workspace/didChangeWatchedFiles", object([("changes", array(events))]))
    }

    /// `shutdown`, `exit`, then a kill if the server is still there.
    pub fn shutdown(&self) {
        if self.is_alive() {
            let _ = self.request("shutdown", Json::Null, Duration::from_secs(3));
            let _ = self.notify("exit", Json::Null);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let exited = lock(&self.inner.child).as_mut().is_none_or(|child| child.try_wait().ok().flatten().is_some());
            if exited || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        self.kill();
    }

    fn kill(&self) {
        self.inner.alive.store(false, Ordering::SeqCst);
        if let Some(child) = lock(&self.inner.child).as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

trait NumberOrZero {
    fn as_f64_or_zero(&self, path: &str) -> f64;
}

impl NumberOrZero for Json {
    /// `textDocumentSync` as a bare kind number (`1` full, `2` incremental)
    /// implies save notifications are welcome.
    fn as_f64_or_zero(&self, path: &str) -> f64 {
        self.f64_at(path).unwrap_or(0.0)
    }
}

fn read_loop(inner: Arc<Inner>, mut reader: Box<dyn BufRead + Send>) {
    loop {
        match transport::read_message(&mut reader) {
            Ok(Some(body)) => {
                let text = String::from_utf8_lossy(&body);
                if let Ok(message) = json::parse(&text) {
                    handle(&inner, message);
                }
            }
            Ok(None) | Err(_) => break,
        }
    }

    inner.alive.store(false, Ordering::SeqCst);
    let pending: Vec<Sender<Reply>> = lock(&inner.pending).drain().map(|(_, sender)| sender).collect();
    for sender in pending {
        let _ = sender.send(Err(LspError::Exited(format!("{} closed its output", inner.server))));
    }
    inner.changed.notify_all();
}

fn respond(inner: &Inner, id: &Json, result: Result<Json, (i64, String)>) {
    let mut message = object([("jsonrpc", string("2.0")), ("id", id.clone())]);
    match result {
        Ok(value) => message.set("result", value),
        Err((code, text)) => message.set("error", object([("code", int(code)), ("message", string(text))])),
    }
    let body = message.to_compact();
    let _ = transport::write_message(&mut **lock(&inner.writer), &body);
}

fn handle(inner: &Arc<Inner>, message: Json) {
    let method = message.str_at("method").map(String::from);
    let id = message.at("id").cloned();

    match (method, id) {
        (None, Some(id)) => {
            let Some(id) = id.as_f64().map(|n| n as i64) else { return };
            let Some(sender) = lock(&inner.pending).remove(&id) else { return };
            let reply = match message.at("error") {
                Some(error) => Err(LspError::Server {
                    code: error.i64_at("code").unwrap_or(0),
                    message: error.str_at("message").unwrap_or("unknown error").to_string(),
                }),
                None => Ok(message.at("result").cloned().unwrap_or(Json::Null)),
            };
            let _ = sender.send(reply);
        }
        (Some(method), Some(id)) => {
            let params = message.at("params").cloned().unwrap_or(Json::Null);
            let result = server_request(inner, &method, &params);
            respond(inner, &id, result);
        }
        (Some(method), None) => {
            let params = message.at("params").cloned().unwrap_or(Json::Null);
            notification(inner, &method, &params);
        }
        (None, None) => {}
    }
}

fn server_request(inner: &Arc<Inner>, method: &str, params: &Json) -> Result<Json, (i64, String)> {
    match method {
        "workspace/configuration" => {
            let items = params.at("items").map(JsonExt::items).unwrap_or(&[]);
            Ok(array(items.iter().map(|item| match item.str_at("section") {
                Some(section) if !section.is_empty() => inner.settings.at(section).cloned().unwrap_or(Json::Null),
                _ => inner.settings.clone(),
            })))
        }
        "client/registerCapability" => {
            let mut state = lock(&inner.state);
            for registration in params.at("registrations").map(JsonExt::items).unwrap_or(&[]) {
                if let (Some(id), Some(method)) = (registration.str_at("id"), registration.str_at("method")) {
                    let options = registration.at("registerOptions").cloned().unwrap_or(Json::Null);
                    state.registrations.insert(id.to_string(), (method.to_string(), options));
                }
            }
            Ok(Json::Null)
        }
        "client/unregisterCapability" => {
            let mut state = lock(&inner.state);
            // The specification misspells this field, and servers follow it.
            let list = params.at("unregisterations").or_else(|| params.at("unregistrations"));
            for item in list.map(JsonExt::items).unwrap_or(&[]) {
                if let Some(id) = item.str_at("id") {
                    state.registrations.remove(id);
                }
            }
            Ok(Json::Null)
        }
        "workspace/applyEdit" => {
            let edit = params.at("edit").cloned().unwrap_or(Json::Null);
            match crate::edit::apply_workspace_edit(&edit, true) {
                Ok(changes) => {
                    lock(&inner.state).applied.push(changes.iter().map(|change| change.path.clone()).collect());
                    Ok(object([("applied", Json::Bool(true))]))
                }
                Err(reason) => Ok(object([("applied", Json::Bool(false)), ("failureReason", string(reason))])),
            }
        }
        "workspace/workspaceFolders" => {
            let root_uri = uri::path_to_uri(&inner.root);
            let name = inner.root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            Ok(array([object([("uri", string(root_uri)), ("name", string(name))])]))
        }
        "window/workDoneProgress/create" => Ok(Json::Null),
        // No user is there to choose; declining is the honest answer.
        "window/showMessageRequest" => Ok(Json::Null),
        "window/showDocument" => Ok(object([("success", Json::Bool(false))])),
        "workspace/diagnostic/refresh" => {
            lock(&inner.state).pulled.clear();
            Ok(Json::Null)
        }
        "workspace/semanticTokens/refresh" | "workspace/inlayHint/refresh" | "workspace/codeLens/refresh" | "workspace/foldingRange/refresh" => {
            Ok(Json::Null)
        }
        other => Err((-32601, format!("{other} is not supported by this client"))),
    }
}

fn notification(inner: &Arc<Inner>, method: &str, params: &Json) {
    match method {
        "textDocument/publishDiagnostics" => {
            let Some(raw_uri) = params.str_at("uri") else { return };
            let uri = uri::normalize(raw_uri);
            let items = params.at("diagnostics").map(|d| d.items().to_vec()).unwrap_or_default();
            let mut state = lock(&inner.state);
            state.publishes += 1;
            let sequence = state.publishes;
            state.diagnostics.insert(uri, Published { items, sequence });
            drop(state);
            inner.changed.notify_all();
        }
        "$/progress" => {
            let token = match params.at("token") {
                Some(Json::String(text)) => text.clone(),
                Some(other) => other.to_compact(),
                None => return,
            };
            let Some(value) = params.at("value") else { return };
            let mut state = lock(&inner.state);
            match value.str_at("kind") {
                Some("begin") => {
                    state.progress.insert(
                        token,
                        Progress {
                            title: value.str_at("title").unwrap_or("working").to_string(),
                            message: value.str_at("message").map(String::from),
                            percentage: value.u32_at("percentage"),
                            done: false,
                        },
                    );
                }
                Some("report") => {
                    if let Some(progress) = state.progress.get_mut(&token) {
                        if let Some(message) = value.str_at("message") {
                            progress.message = Some(message.to_string());
                        }
                        progress.percentage = value.u32_at("percentage").or(progress.percentage);
                    }
                }
                Some("end") => {
                    if let Some(progress) = state.progress.get_mut(&token) {
                        progress.done = true;
                    }
                    // Finished work is only interesting until the next begins.
                    state.progress.retain(|_, progress| !progress.done);
                }
                _ => {}
            }
            drop(state);
            inner.changed.notify_all();
        }
        "window/logMessage" | "window/showMessage" => {
            let level = match params.u32_at("type") {
                Some(1) => "error",
                Some(2) => "warning",
                Some(3) => "info",
                _ => "log",
            };
            let text = params.str_at("message").unwrap_or_default().to_string();
            let mut state = lock(&inner.state);
            if state.messages.len() >= 200 {
                state.messages.pop_front();
            }
            state.messages.push_back((level.to_string(), text));
        }
        _ => {}
    }
}
