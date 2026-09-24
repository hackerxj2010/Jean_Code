//! Every language server a session uses, and the operations the agent asks
//! of them.
//!
//! The hub decides which server answers for a file — the primary one for the
//! language, and any linters that also apply — starts it on first use, finds
//! or installs its binary, restarts it if it crashes, and speaks for all of
//! them through one JSON interface, which is what the bridge exposes as
//! `lsp.*`.
//!
//! Positions in and out are zero-based lines and UTF-16 columns — the units
//! a JavaScript string indexes in, so the TypeScript side can compute them —
//! and a caller may give a symbol instead of a column: "`foo` on line 42" is
//! how an agent reliably names a position, where a column number is a guess.

use crate::client::{Client, LaunchSpec, LspError};
use crate::detect;
use crate::edit::{self, FileChange};
use crate::install::Toolbox;
use crate::json::{array, int, object, string, Json, JsonExt};
use crate::protocol::{self, Diagnostic, HierarchyItem, Location, Position, Range, Severity};
use crate::servers::{builtin_servers, Role, ServerSpec};
use crate::text::{self, Lines};
use crate::uri;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Debug)]
struct Config {
    project_root: PathBuf,
    user_servers: Json,
    auto_install: bool,
    toolbox: Toolbox,
    request_timeout: Duration,
    start_timeout: Duration,
    diagnostics_wait: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            project_root: std::env::current_dir().unwrap_or_default(),
            user_servers: Json::Null,
            auto_install: !crate::install::downloads_disabled(),
            toolbox: Toolbox::new(Toolbox::default_dir()),
            request_timeout: Duration::from_secs(30),
            start_timeout: Duration::from_secs(60),
            diagnostics_wait: Duration::from_secs(8),
        }
    }
}

/// A running server, or the attempt to start one.
#[derive(Default)]
struct Slot {
    client: Option<Client>,
    /// When starting last failed, and why — so a broken server is not
    /// retried on every file for the rest of the session.
    failed: Option<(Instant, String)>,
    restarts: u32,
}

const RETRY_AFTER: Duration = Duration::from_secs(60);

pub struct Hub {
    config: Mutex<Config>,
    slots: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
    /// Why a server could not be used for a spec id, kept for status.
    notes: Mutex<BTreeMap<String, String>>,
    installs: Mutex<Vec<String>>,
}

static HUB: OnceLock<Hub> = OnceLock::new();

/// The process-wide hub.
pub fn hub() -> &'static Hub {
    HUB.get_or_init(Hub::new)
}

fn millis(params: &Json, key: &str) -> Option<Duration> {
    params.f64_at(key).filter(|value| *value >= 0.0).map(|value| Duration::from_millis(value as u64))
}

fn required_path(params: &Json, key: &str) -> Result<PathBuf, String> {
    params.str_at(key).map(PathBuf::from).ok_or_else(|| format!("`{key}` is required"))
}

/// A location with the line of source it points at, which is what makes a
/// list of locations readable without opening each file.
fn location_json(location: &Location, cache: &mut HashMap<PathBuf, Option<String>>) -> Json {
    let text = cache.entry(location.path.clone()).or_insert_with(|| std::fs::read_to_string(&location.path).ok());
    let preview = text.as_deref().map(|text| Lines::new(text).line(location.range.start.line as usize).trim().to_string()).unwrap_or_default();
    object([
        ("path", string(location.path.to_string_lossy())),
        ("line", int(location.range.start.line.into())),
        ("character", int(location.range.start.character.into())),
        ("endLine", int(location.range.end.line.into())),
        ("endCharacter", int(location.range.end.character.into())),
        ("text", string(preview.chars().take(240).collect::<String>())),
    ])
}

fn locations_json(locations: &[Location]) -> Json {
    let mut cache = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    array(locations.iter().filter(|l| seen.insert((l.path.clone(), l.range.start))).map(|location| location_json(location, &mut cache)))
}

fn document(path: &Path) -> Json {
    object([("uri", string(uri::path_to_uri(path)))])
}

fn position_params(path: &Path, position: Position) -> Json {
    object([("textDocument", document(path)), ("position", position.to_json())])
}

/// Indentation of a file: tabs, or the most common step of leading spaces.
fn indentation(text: &str) -> (u32, bool) {
    let mut tabs = 0;
    let mut steps: HashMap<usize, usize> = HashMap::new();
    let mut previous = 0usize;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if line.starts_with('\t') {
            tabs += 1;
            continue;
        }
        let spaces = line.len() - line.trim_start_matches(' ').len();
        if spaces > previous {
            *steps.entry(spaces - previous).or_default() += 1;
        }
        previous = spaces;
    }
    let step = steps.into_iter().filter(|(step, _)| *step == 2 || *step == 4 || *step == 8).max_by_key(|(_, count)| *count).map_or(4, |(step, _)| step);
    if tabs > 5 {
        (4, false)
    } else {
        (step as u32, true)
    }
}

impl Hub {
    pub fn new() -> Hub {
        Hub {
            config: Mutex::new(Config::default()),
            slots: Mutex::new(HashMap::new()),
            notes: Mutex::new(BTreeMap::new()),
            installs: Mutex::new(Vec::new()),
        }
    }

    fn config(&self) -> Config {
        lock(&self.config).clone()
    }

    /// Every server spec, built-in and user, with user config layered on.
    fn specs(&self) -> Vec<ServerSpec> {
        let config = self.config();
        let mut specs: Vec<ServerSpec> = builtin_servers()
            .into_iter()
            .map(|spec| match config.user_servers.at(&spec.id) {
                Some(overrides) => spec.with_config(overrides),
                None => spec,
            })
            .collect();
        if let Json::Object(user) = &config.user_servers {
            for (id, entry) in user {
                if !specs.iter().any(|spec| spec.id == *id) {
                    if let Some(spec) = ServerSpec::from_config(id, entry) {
                        specs.push(spec);
                    }
                }
            }
        }
        specs
    }

    /// Candidates for a file: primaries by priority, then linters.
    fn candidates(&self, path: &Path) -> Vec<ServerSpec> {
        let mut specs: Vec<ServerSpec> = self.specs().into_iter().filter(|spec| !spec.disabled && spec.handles(path)).collect();
        specs.sort_by_key(|spec| (spec.role == Role::Linter, -spec.priority));
        specs
    }

    fn note(&self, id: &str, text: String) {
        lock(&self.notes).insert(id.to_string(), text);
    }

    fn root_for(&self, spec: &ServerSpec, path: &Path, config: &Config) -> Option<PathBuf> {
        let start = path.parent().unwrap_or(path);
        let inside = start.starts_with(&config.project_root);
        let ceiling = inside.then_some(config.project_root.as_path());
        match detect::find_root(start, &spec.root_markers, ceiling) {
            Some(root) => Some(root),
            None if spec.root_required => None,
            None if inside => Some(config.project_root.clone()),
            None => Some(start.to_path_buf()),
        }
    }

    /// Where a server's binary is: in the project, on `PATH`, or among the
    /// tools Jean installed.
    fn resolve_binary(&self, spec: &ServerSpec, root: &Path, config: &Config) -> Option<PathBuf> {
        let binary = spec.command.first()?;
        let first = detect::project_bin_dirs(root, &config.project_root);
        if let Some(found) = detect::which(binary, &first, &config.toolbox.bin_dirs()) {
            return Some(found);
        }
        spec.install.as_ref().and_then(|install| config.toolbox.locate(&spec.id, install))
    }

    fn substitute(value: &Json, replacements: &[(&str, String)]) -> Json {
        match value {
            Json::String(text) => {
                let mut out = text.clone();
                for (key, replacement) in replacements {
                    out = out.replace(key, replacement);
                }
                Json::String(out)
            }
            Json::Array(items) => Json::Array(items.iter().map(|item| Hub::substitute(item, replacements)).collect()),
            Json::Object(map) => Json::Object(map.iter().map(|(key, item)| (key.clone(), Hub::substitute(item, replacements))).collect()),
            other => other.clone(),
        }
    }

    /// The TypeScript library a TypeScript, Vue, or Astro server should load:
    /// the project's own first — so it type-checks with the version the
    /// project builds with — then Jean's, then the one installed alongside
    /// the server binary (a global npm install puts both side by side).
    fn typescript_lib(root: &Path, config: &Config, binary: Option<&Path>) -> Option<PathBuf> {
        let mut dirs = vec![root.to_path_buf(), config.project_root.clone(), config.toolbox.dir.join("npm")];
        if let Some(bin_dir) = binary.and_then(Path::parent) {
            // Windows global npm: `<prefix>/x.cmd` beside `<prefix>/node_modules`.
            dirs.push(bin_dir.to_path_buf());
            if let Some(parent) = bin_dir.parent() {
                // `node_modules/.bin/x` beside `node_modules/typescript`.
                dirs.push(parent.parent().map(Path::to_path_buf).unwrap_or_else(|| parent.to_path_buf()));
                // Unix global npm: `<prefix>/bin/x` and `<prefix>/lib/node_modules`.
                dirs.push(parent.join("lib"));
            }
        }
        dirs.into_iter().map(|dir| dir.join("node_modules").join("typescript").join("lib")).find(|lib| lib.join("tsserver.js").is_file())
    }

    /// A running client for `spec` at `root`: the existing one, or a new one
    /// started — installed first if need be and allowed.
    fn client_for(&self, spec: &ServerSpec, root: &Path, config: &Config, may_install: bool) -> Result<Client, String> {
        let key = format!("{}@{}", spec.id, uri::path_key(root));
        let slot = Arc::clone(lock(&self.slots).entry(key).or_default());
        let mut slot = lock(&slot);

        if let Some(client) = &slot.client {
            if client.is_alive() {
                return Ok(client.clone());
            }
            // Crashed. Restart, but not forever.
            slot.restarts += 1;
            slot.client = None;
            if slot.restarts > 3 {
                slot.failed = Some((Instant::now(), format!("{} crashed {} times", spec.id, slot.restarts)));
            }
        }
        if let Some((when, why)) = &slot.failed {
            if when.elapsed() < RETRY_AFTER {
                return Err(why.clone());
            }
        }

        let binary = match self.resolve_binary(spec, root, config) {
            Some(binary) => binary,
            None => {
                let missing = spec.command.first().cloned().unwrap_or_default();
                let Some(install) = spec.install.as_ref() else {
                    return Err(format!("`{missing}` is not installed"));
                };
                if !may_install || !config.auto_install || !install.automatic() {
                    return Err(format!("`{missing}` is not installed ({})", install.describe()));
                }
                if let Some(reason) = config.toolbox.cannot_install(install) {
                    return Err(format!("`{missing}` is not installed and cannot be installed here: {reason}"));
                }
                let mut log = Vec::new();
                let result = config.toolbox.install(&spec.id, install, &mut log);
                let mut installs = lock(&self.installs);
                match result {
                    Ok(binary) => {
                        installs.push(format!("installed {} ({}) at {}", spec.id, install.describe(), binary.display()));
                        binary
                    }
                    Err(error) => {
                        installs.push(format!("could not install {}: {error}", spec.id));
                        slot.failed = Some((Instant::now(), format!("installing {} failed: {error}", spec.id)));
                        return Err(format!("installing {} failed: {error}", spec.id));
                    }
                }
            }
        };

        let mut command = vec![binary.to_string_lossy().to_string()];
        command.extend(spec.command.iter().skip(1).cloned());
        let typescript = Hub::typescript_lib(root, config, Some(&binary));
        let tsdk = typescript.as_ref().map(|lib| lib.to_string_lossy().to_string()).unwrap_or_default();
        let replacements = [("${tsdk}", tsdk), ("${toolsDir}", config.toolbox.dir.to_string_lossy().to_string())];
        let mut env = spec.env.clone();
        if let Some(install) = &spec.install {
            env.extend(config.toolbox.runtime_env(install));
        }
        let mut initialization = Hub::substitute(&spec.initialization, &replacements);
        // The TypeScript server refuses to start without a TypeScript it can
        // find, and it only looks in the workspace; a project with no
        // `node_modules` yet is exactly when the agent needs it most.
        if matches!(spec.id.as_str(), "typescript" | "vtsls") && initialization.at("tsserver.path").is_none() {
            if let Some(lib) = &typescript {
                let mut tsserver = initialization.at("tsserver").cloned().unwrap_or_else(crate::json::empty);
                tsserver.set("path", string(lib.join("tsserver.js").to_string_lossy()));
                if matches!(initialization, Json::Null) {
                    initialization = crate::json::empty();
                }
                initialization.set("tsserver", tsserver);
            }
        }
        let launch = LaunchSpec {
            server: spec.id.clone(),
            command,
            root: root.to_path_buf(),
            env,
            initialization,
            settings: Hub::substitute(&spec.settings, &replacements),
            language_id: spec.language_id.clone(),
        };

        match Client::start(&launch, config.start_timeout) {
            Ok(client) => {
                slot.client = Some(client.clone());
                slot.failed = None;
                Ok(client)
            }
            Err(error) => {
                let message = format!("{} did not start: {error}", spec.id);
                slot.failed = Some((Instant::now(), message.clone()));
                Err(message)
            }
        }
    }

    /// The servers for a file: the first primary that runs, plus — with
    /// `linters` — every linter that applies and is installed.
    fn clients_for(&self, path: &Path, linters: bool) -> Result<Vec<Client>, String> {
        let config = self.config();
        let candidates = self.candidates(path);
        if candidates.is_empty() {
            return Err(format!("no language server is registered for {}", path.display()));
        }

        let mut clients = Vec::new();
        let mut reasons = Vec::new();
        let mut have_primary = false;
        for spec in &candidates {
            if spec.role == Role::Primary && have_primary {
                continue;
            }
            if spec.role == Role::Linter && !linters {
                continue;
            }
            let Some(root) = self.root_for(spec, path, &config) else {
                continue;
            };
            // Primaries may be installed on demand; a linter only runs when
            // the project already has it, since it only means something with
            // the project's own configuration.
            match self.client_for(spec, &root, &config, spec.role == Role::Primary) {
                Ok(client) => {
                    have_primary |= spec.role == Role::Primary;
                    clients.push(client);
                }
                Err(reason) => {
                    self.note(&spec.id, reason.clone());
                    if spec.role == Role::Primary {
                        reasons.push(reason);
                    }
                }
            }
        }

        if clients.is_empty() {
            return Err(if reasons.is_empty() {
                format!("no language server applies to {}", path.display())
            } else {
                reasons.join("; ")
            });
        }
        Ok(clients)
    }

    fn primary(&self, path: &Path) -> Result<Vec<Client>, String> {
        self.clients_for(path, false)
    }

    fn running(&self) -> Vec<Client> {
        let slots: Vec<Arc<Mutex<Slot>>> = lock(&self.slots).values().cloned().collect();
        slots.iter().filter_map(|slot| lock(slot).client.clone()).filter(Client::is_alive).collect()
    }

    /// Resolves the position a caller means: a symbol on a line (preferred),
    /// a symbol anywhere, or a line and column.
    fn position(&self, params: &Json) -> Result<(PathBuf, Position), String> {
        let path = required_path(params, "path")?;
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let occurrence = params.u32_at("occurrence").unwrap_or(0) as usize;
        let line = params.u32_at("line");

        if let Some(symbol) = params.str_at("symbol").filter(|s| !s.is_empty()) {
            let line = match line {
                Some(line) => line,
                None => text::find_symbol_line(&text, symbol).ok_or_else(|| format!("`{symbol}` does not appear in {}", path.display()))?,
            };
            let lines = Lines::new(&text);
            if line as usize >= lines.count() {
                return Err(format!("{} has {} lines, so line {} does not exist", path.display(), lines.count(), line + 1));
            }
            return text::symbol_position(&text, line, symbol, occurrence).map(|position| (path.clone(), position)).ok_or_else(|| {
                format!("`{symbol}` is not on line {} of {}; that line reads: {}", line + 1, path.display(), lines.line(line as usize).trim())
            });
        }

        let line = line.ok_or("`line` or `symbol` is required")?;
        Ok((path, Position::new(line, params.u32_at("character").unwrap_or(0))))
    }

    fn timeout(&self, params: &Json) -> Duration {
        millis(params, "timeoutMs").unwrap_or_else(|| self.config().request_timeout)
    }

    /// Asks each server that supports `method`, in order, until one answers
    /// with something.
    fn first_answer(&self, clients: &[Client], path: &Path, method: &str, params: &Json, timeout: Duration) -> Result<(Json, String), String> {
        let mut last_error = None;
        let mut asked = false;
        for client in clients.iter().filter(|client| client.supports(method)) {
            asked = true;
            if let Err(error) = client.sync(path) {
                last_error = Some(error.to_string());
                continue;
            }
            match client.request(method, params.clone(), timeout) {
                Ok(Json::Null) => {}
                Ok(Json::Array(items)) if items.is_empty() => {}
                Ok(result) => return Ok((result, client.server().to_string())),
                Err(error) => last_error = Some(error.to_string()),
            }
        }
        if !asked {
            let names: Vec<&str> = clients.iter().map(Client::server).collect();
            return Err(format!("{} does not support {method}", names.join(", ")));
        }
        match last_error {
            Some(error) => Err(error),
            None => Ok((Json::Null, String::new())),
        }
    }

    /// Syncs changed files with every running server, after an edit.
    fn resync(&self, changes: &[FileChange]) {
        for client in self.running() {
            for change in changes {
                let _ = client.sync(&change.path);
                if let edit::ChangeKind::Renamed { from } = &change.kind {
                    let _ = client.sync(from);
                }
            }
        }
    }

    // ---- the operations ----------------------------------------------------

    fn configure(&self, params: &Json) -> Result<Json, String> {
        let mut config = lock(&self.config);
        if let Some(root) = params.str_at("projectRoot") {
            config.project_root = PathBuf::from(root);
        }
        if let Some(servers) = params.at("servers") {
            config.user_servers = servers.clone();
        }
        if let Some(auto) = params.bool_at("autoInstall") {
            config.auto_install = auto && !crate::install::downloads_disabled();
        }
        if let Some(dir) = params.str_at("toolsDir") {
            config.toolbox = Toolbox::new(dir);
        }
        if let Some(timeout) = millis(params, "requestTimeoutMs") {
            config.request_timeout = timeout;
        }
        if let Some(timeout) = millis(params, "startTimeoutMs") {
            config.start_timeout = timeout;
        }
        if let Some(wait) = millis(params, "diagnosticsWaitMs") {
            config.diagnostics_wait = wait;
        }
        let summary = object([
            ("projectRoot", string(config.project_root.to_string_lossy())),
            ("autoInstall", Json::Bool(config.auto_install)),
            ("toolsDir", string(config.toolbox.dir.to_string_lossy())),
        ]);
        drop(config);
        // New settings mean a failed server deserves another try.
        lock(&self.notes).clear();
        for slot in lock(&self.slots).values() {
            lock(slot).failed = None;
        }
        Ok(summary)
    }

    fn diagnostics(&self, params: &Json) -> Result<Json, String> {
        let config = self.config();
        let wait = millis(params, "waitMs").unwrap_or(config.diagnostics_wait);
        let settle = millis(params, "settleMs").unwrap_or(Duration::from_millis(400));
        let minimum = params.str_at("severity").and_then(Severity::parse_label).unwrap_or(Severity::Hint);

        let mut paths: Vec<PathBuf> = params.at("paths").map(|p| p.items().iter().filter_map(Json::as_str).map(PathBuf::from).collect()).unwrap_or_default();
        if let Some(path) = params.str_at("path") {
            paths.push(PathBuf::from(path));
        }

        let mut diagnostics: Vec<Diagnostic> = Vec::new();
        let mut files = Vec::new();
        if paths.is_empty() {
            for client in self.running() {
                diagnostics.extend(client.all_diagnostics());
            }
        } else {
            for path in &paths {
                match self.clients_for(path, true) {
                    Ok(clients) => {
                        let mut servers = Vec::new();
                        for client in clients {
                            match client.diagnostics(path, wait, settle) {
                                Ok((items, freshness)) => {
                                    servers.push(object([("server", string(client.server())), ("freshness", string(freshness.label()))]));
                                    diagnostics.extend(items);
                                }
                                Err(error) => servers.push(object([("server", string(client.server())), ("error", string(error.to_string()))])),
                            }
                        }
                        files.push(object([("path", string(path.to_string_lossy())), ("servers", array(servers))]));
                    }
                    Err(reason) => files.push(object([("path", string(path.to_string_lossy())), ("error", string(reason))])),
                }
            }
        }

        diagnostics.retain(|d| d.severity <= minimum);
        diagnostics.sort_by(|a, b| a.severity.cmp(&b.severity).then_with(|| a.path.cmp(&b.path)).then(a.range.start.cmp(&b.range.start)));
        diagnostics.dedup_by(|a, b| a.path == b.path && a.range == b.range && a.message == b.message);
        let pending: Vec<Json> = self.running().iter().flat_map(|client| client.active_progress()).map(|p| string(p.title)).collect();
        Ok(object([
            ("diagnostics", array(diagnostics.iter().map(Diagnostic::to_json))),
            ("files", array(files)),
            ("pending", array(pending)),
        ]))
    }

    fn touch(&self, params: &Json) -> Result<Json, String> {
        let path = required_path(params, "path")?;
        let kind = match params.str_at("kind") {
            Some("created") => 1,
            Some("deleted") => 3,
            _ => 2,
        };
        let mut synced = Vec::new();
        for client in self.running() {
            let _ = client.files_changed(&[(path.clone(), kind)]);
            if client.sync(&path).is_ok() {
                synced.push(string(client.server()));
            }
        }
        // Opening the file's own server now means diagnostics are ready by
        // the time anyone asks.
        if params.bool_at("open") == Some(true) && kind != 3 {
            if let Ok(clients) = self.clients_for(&path, true) {
                for client in clients {
                    let _ = client.sync(&path);
                }
            }
        }
        Ok(object([("servers", array(synced))]))
    }

    fn locations(&self, params: &Json, method: &str, extra: Option<(&str, Json)>) -> Result<Json, String> {
        let (path, position) = self.position(params)?;
        let clients = self.primary(&path)?;
        let mut request = position_params(&path, position);
        if let Some((key, value)) = extra {
            request.set(key, value);
        }
        let (result, server) = self.first_answer(&clients, &path, method, &request, self.timeout(params))?;
        let locations = Location::parse_many(&result);
        Ok(object([("locations", locations_json(&locations)), ("server", string(server)), ("position", position.to_json())]))
    }

    fn definition(&self, params: &Json) -> Result<Json, String> {
        let method = match params.str_at("kind").unwrap_or("definition") {
            "type" | "typeDefinition" => "textDocument/typeDefinition",
            "implementation" => "textDocument/implementation",
            "declaration" => "textDocument/declaration",
            _ => "textDocument/definition",
        };
        self.locations(params, method, None)
    }

    fn references(&self, params: &Json) -> Result<Json, String> {
        let include = params.bool_at("includeDeclaration").unwrap_or(false);
        self.locations(params, "textDocument/references", Some(("context", object([("includeDeclaration", Json::Bool(include))]))))
    }

    fn hover(&self, params: &Json) -> Result<Json, String> {
        let (path, position) = self.position(params)?;
        let clients = self.primary(&path)?;
        let (result, server) = self.first_answer(&clients, &path, "textDocument/hover", &position_params(&path, position), self.timeout(params))?;
        Ok(object([("text", protocol::hover_text(&result).map_or(Json::Null, string)), ("server", string(server))]))
    }

    fn highlights(&self, params: &Json) -> Result<Json, String> {
        let (path, position) = self.position(params)?;
        let clients = self.primary(&path)?;
        let (result, _) = self.first_answer(&clients, &path, "textDocument/documentHighlight", &position_params(&path, position), self.timeout(params))?;
        Ok(array(protocol::parse_highlights(&result).into_iter().map(|(range, kind)| object([("range", range.to_json()), ("kind", string(kind))]))))
    }

    fn symbols(&self, params: &Json) -> Result<Json, String> {
        let path = required_path(params, "path")?;
        let clients = self.primary(&path)?;
        let request = object([("textDocument", document(&path))]);
        let (result, server) = self.first_answer(&clients, &path, "textDocument/documentSymbol", &request, self.timeout(params))?;
        let symbols = protocol::parse_document_symbols(&result, &path);
        Ok(object([("symbols", array(symbols.iter().map(protocol::Symbol::to_json))), ("server", string(server))]))
    }

    fn workspace_symbols(&self, params: &Json) -> Result<Json, String> {
        let query = params.str_at("query").unwrap_or_default().to_string();
        let limit = params.u32_at("limit").unwrap_or(100) as usize;
        if let Some(path) = params.str_at("path") {
            let _ = self.clients_for(Path::new(path), false);
        }
        let clients = self.running();
        if clients.is_empty() {
            return Err("no language server is running yet; give `path` to start the one for a file".into());
        }
        let mut symbols = Vec::new();
        for client in clients.iter().filter(|client| client.supports("workspace/symbol")) {
            if let Ok(result) = client.request("workspace/symbol", object([("query", string(&query))]), self.timeout(params)) {
                symbols.extend(protocol::parse_workspace_symbols(&result));
            }
        }
        // Exact names first, then prefixes, then everything else.
        let lower = query.to_lowercase();
        symbols.sort_by_key(|symbol| {
            let name = symbol.name.to_lowercase();
            (name != lower, !name.starts_with(&lower), symbol.name.len())
        });
        symbols.truncate(limit);
        Ok(object([("symbols", array(symbols.iter().map(protocol::Symbol::to_json)))]))
    }

    fn completion(&self, params: &Json) -> Result<Json, String> {
        let (path, mut position) = self.position(params)?;
        // A symbol names the token *before* which to complete: after `user.`
        // the position is just past the dot.
        if let (Some(symbol), Ok(text)) = (params.str_at("after"), std::fs::read_to_string(&path)) {
            let lines = Lines::new(&text);
            let line = lines.line(position.line as usize);
            if let Some(index) = line.find(symbol) {
                position.character = text::byte_to_utf16(line, index + symbol.len());
            }
        }
        let clients = self.primary(&path)?;
        let mut request = position_params(&path, position);
        request.set("context", object([("triggerKind", int(1))]));
        let (result, server) = self.first_answer(&clients, &path, "textDocument/completion", &request, self.timeout(params))?;
        let limit = params.u32_at("limit").unwrap_or(50) as usize;
        let prefix = params.str_at("prefix").map(str::to_lowercase);
        let items: Vec<Json> = protocol::parse_completions(&result)
            .into_iter()
            .filter(|item| prefix.as_ref().is_none_or(|prefix| item.label.to_lowercase().starts_with(prefix)))
            .take(limit)
            .map(|item| item.to_json())
            .collect();
        Ok(object([("items", array(items)), ("server", string(server))]))
    }

    fn signature(&self, params: &Json) -> Result<Json, String> {
        let (path, position) = self.position(params)?;
        let clients = self.primary(&path)?;
        let mut request = position_params(&path, position);
        request.set("context", object([("triggerKind", int(1)), ("isRetrigger", Json::Bool(false))]));
        let (result, _) = self.first_answer(&clients, &path, "textDocument/signatureHelp", &request, self.timeout(params))?;
        Ok(array(protocol::parse_signatures(&result).iter().map(protocol::Signature::to_json)))
    }

    fn rename(&self, params: &Json) -> Result<Json, String> {
        let (path, position) = self.position(params)?;
        let new_name = params.str_at("newName").ok_or("`newName` is required")?;
        let apply = params.bool_at("apply").unwrap_or(true);
        let clients = self.primary(&path)?;
        let timeout = self.timeout(params).max(Duration::from_secs(60));

        for client in clients.iter().filter(|client| client.supports("textDocument/rename")) {
            client.sync(&path).map_err(|e| e.to_string())?;
            if client.supports("textDocument/prepareRename") {
                match client.request("textDocument/prepareRename", position_params(&path, position), timeout) {
                    Ok(Json::Null) => return Err("the language server says the symbol at that position cannot be renamed".into()),
                    Err(LspError::Server { message, .. }) => return Err(format!("cannot rename here: {message}")),
                    _ => {}
                }
            }
            let mut request = position_params(&path, position);
            request.set("newName", string(new_name));
            let edit = client.request("textDocument/rename", request, timeout).map_err(|e| e.to_string())?;
            if edit.is_null() {
                continue;
            }
            let changes = edit::apply_workspace_edit(&edit, apply)?;
            if apply {
                self.resync(&changes);
            }
            let edits: Vec<Json> = edit::edit_ranges(&edit)
                .into_iter()
                .map(|(path, range, text)| object([("path", string(path.to_string_lossy())), ("range", range.to_json()), ("newText", string(text))]))
                .collect();
            return Ok(object([
                ("applied", Json::Bool(apply)),
                ("changes", array(changes.iter().map(FileChange::to_json))),
                ("edits", array(edits)),
                ("server", string(client.server())),
            ]));
        }
        Err("no language server for this file supports rename".into())
    }

    fn code_actions(&self, params: &Json) -> Result<Json, String> {
        let path = required_path(params, "path")?;
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let lines = Lines::new(&text);
        let start_line = params.u32_at("line").unwrap_or(0);
        let end_line = params.u32_at("endLine").unwrap_or(start_line);
        let range = Range::new(
            Position::new(start_line, params.u32_at("character").unwrap_or(0)),
            Position::new(end_line, text::byte_to_utf16(lines.line(end_line as usize), usize::MAX)),
        );
        let clients = self.clients_for(&path, true)?;
        let timeout = self.timeout(params);

        let mut offered: Vec<(Client, protocol::CodeAction)> = Vec::new();
        for client in clients.iter().filter(|client| client.supports("textDocument/codeAction")) {
            let diagnostics = client.diagnostics(&path, Duration::from_millis(1500), Duration::from_millis(200)).map(|(items, _)| items).unwrap_or_default();
            let relevant: Vec<Json> = diagnostics
                .iter()
                .filter(|d| d.range.start.line <= range.end.line && d.range.end.line >= range.start.line)
                .map(|d| d.raw.clone())
                .collect();
            let mut context = object([("diagnostics", array(relevant)), ("triggerKind", int(1))]);
            if let Some(only) = params.at("only") {
                context.set("only", only.clone());
            }
            let request = object([("textDocument", document(&path)), ("range", range.to_json()), ("context", context)]);
            if let Ok(result) = client.request("textDocument/codeAction", request, timeout) {
                offered.extend(protocol::parse_code_actions(&result).into_iter().map(|action| (client.clone(), action)));
            }
        }

        let listed = array(offered.iter().enumerate().map(|(index, (client, action))| {
            let mut value = action.to_json();
            value.set("index", int(index as i64));
            value.set("server", string(client.server()));
            value
        }));

        // `apply`: a title (exact, then substring) or an index.
        let chosen = match params.at("apply") {
            Some(Json::Number(index)) => offered.get(*index as usize),
            Some(Json::String(title)) => {
                let lower = title.to_lowercase();
                offered
                    .iter()
                    .find(|(_, action)| action.title.to_lowercase() == lower)
                    .or_else(|| offered.iter().find(|(_, action)| action.title.to_lowercase().contains(&lower)))
            }
            _ => None,
        };
        let Some((client, action)) = chosen else {
            if params.at("apply").is_some() {
                return Err(format!("no code action matches {}", params.at("apply").map(Json::to_compact).unwrap_or_default()));
            }
            return Ok(object([("actions", listed)]));
        };
        if let Some(reason) = &action.disabled {
            return Err(format!("`{}` is offered but disabled: {reason}", action.title));
        }

        // Resolve an action that came without its edit — which a server marks
        // by giving it `data` to resolve from. One that already carries a
        // command is complete as it is.
        let mut resolved = action.raw.clone();
        let incomplete = !action.has_edit && (resolved.at("data").is_some() || resolved.at("command").is_none());
        if incomplete && client.supports("codeAction/resolve") {
            if let Ok(full) = client.request("codeAction/resolve", resolved.clone(), timeout) {
                resolved = full;
            }
        }

        let mut changes = Vec::new();
        if let Some(edit) = resolved.at("edit") {
            changes = edit::apply_workspace_edit(edit, true)?;
        }
        // A command may edit through `workspace/applyEdit`, which the client
        // records; a bare `Command` has the command at the top level.
        let command = match resolved.at("command") {
            Some(Json::String(name)) => Some((name.clone(), resolved.at("arguments").cloned())),
            Some(object_command) => object_command.str_at("command").map(|name| (name.to_string(), object_command.at("arguments").cloned())),
            None => None,
        };
        if let Some((name, arguments)) = command {
            client.take_applied();
            let mut request = object([("command", string(name))]);
            if let Some(arguments) = arguments {
                request.set("arguments", arguments);
            }
            client.request("workspace/executeCommand", request, timeout).map_err(|e| e.to_string())?;
            for path in client.take_applied() {
                changes.push(FileChange { path, kind: edit::ChangeKind::Modified, edits: 0, diff: String::new() });
            }
        }
        self.resync(&changes);
        Ok(object([
            ("actions", listed),
            ("applied", string(&action.title)),
            ("changes", array(changes.iter().map(FileChange::to_json))),
        ]))
    }

    fn format(&self, params: &Json) -> Result<Json, String> {
        let path = required_path(params, "path")?;
        let apply = params.bool_at("apply").unwrap_or(true);
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let (tab_size, spaces) = indentation(&text);
        let options = object([
            ("tabSize", int(tab_size.into())),
            ("insertSpaces", Json::Bool(spaces)),
            ("trimTrailingWhitespace", Json::Bool(true)),
            ("insertFinalNewline", Json::Bool(true)),
            ("trimFinalNewlines", Json::Bool(true)),
        ]);
        // Linters that format (Biome, Ruff) are asked too: the project's
        // formatter of record is often the linter, not the language server.
        let clients = self.clients_for(&path, true)?;
        let mut ordered: Vec<&Client> = clients.iter().filter(|client| client.supports("textDocument/formatting")).collect();
        ordered.sort_by_key(|client| !matches!(client.server(), "biome" | "ruff"));
        for client in ordered {
            client.sync(&path).map_err(|e| e.to_string())?;
            let request = object([("textDocument", document(&path)), ("options", options.clone())]);
            let edits = client.request("textDocument/formatting", request, self.timeout(params)).map_err(|e| e.to_string())?;
            let change = edit::apply_text_edits(&path, edits.items(), apply)?;
            if let (Some(change), true) = (&change, apply) {
                self.resync(std::slice::from_ref(change));
            }
            return Ok(object([
                ("change", change.map_or(Json::Null, |c| c.to_json())),
                ("applied", Json::Bool(apply)),
                ("server", string(client.server())),
            ]));
        }
        Err("no language server for this file formats documents".into())
    }

    fn hierarchy(&self, params: &Json, prepare: &str, follow: &str, key: &str) -> Result<Json, String> {
        let (path, position) = self.position(params)?;
        let clients = self.primary(&path)?;
        let timeout = self.timeout(params);
        let (prepared, server) = self.first_answer(&clients, &path, prepare, &position_params(&path, position), timeout)?;
        let Some(item) = prepared.items().first().and_then(HierarchyItem::parse) else {
            return Ok(object([("item", Json::Null), ("results", array([]))]));
        };
        let client = clients.iter().find(|client| client.server() == server).ok_or("the answering server went away")?;
        let result = client.request(follow, object([("item", item.raw.clone())]), timeout).map_err(|e| e.to_string())?;
        let results: Vec<Json> = result
            .items()
            .iter()
            .filter_map(|entry| {
                // Calls wrap the item with the ranges where the call happens;
                // type hierarchies return items directly.
                let (target, ranges) = match entry.at(key) {
                    Some(inner) => (HierarchyItem::parse(inner)?, entry.at("fromRanges").map(|r| r.items().to_vec()).unwrap_or_default()),
                    None => (HierarchyItem::parse(entry)?, Vec::new()),
                };
                let mut value = target.to_json();
                value.set("ranges", array(ranges.iter().filter_map(Range::parse).map(Range::to_json)));
                Some(value)
            })
            .collect();
        Ok(object([("item", item.to_json()), ("results", array(results)), ("server", string(server))]))
    }

    fn calls(&self, params: &Json) -> Result<Json, String> {
        match params.str_at("direction").unwrap_or("incoming") {
            "outgoing" => self.hierarchy(params, "textDocument/prepareCallHierarchy", "callHierarchy/outgoingCalls", "to"),
            _ => self.hierarchy(params, "textDocument/prepareCallHierarchy", "callHierarchy/incomingCalls", "from"),
        }
    }

    fn types(&self, params: &Json) -> Result<Json, String> {
        match params.str_at("direction").unwrap_or("supertypes") {
            "subtypes" => self.hierarchy(params, "textDocument/prepareTypeHierarchy", "typeHierarchy/subtypes", "_"),
            _ => self.hierarchy(params, "textDocument/prepareTypeHierarchy", "typeHierarchy/supertypes", "_"),
        }
    }

    fn range_request(&self, params: &Json, method: &str) -> Result<(Json, String), String> {
        let path = required_path(params, "path")?;
        let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let lines = Lines::new(&text);
        let start = params.u32_at("line").unwrap_or(0);
        let end = params.u32_at("endLine").unwrap_or(lines.count().saturating_sub(1) as u32);
        let range = Range::new(Position::new(start, 0), Position::new(end, text::byte_to_utf16(lines.line(end as usize), usize::MAX)));
        let clients = self.primary(&path)?;
        let request = object([("textDocument", document(&path)), ("range", range.to_json())]);
        self.first_answer(&clients, &path, method, &request, self.timeout(params))
    }

    fn inlay_hints(&self, params: &Json) -> Result<Json, String> {
        let (result, _) = self.range_request(params, "textDocument/inlayHint")?;
        Ok(array(protocol::parse_inlay_hints(&result).iter().map(protocol::InlayHint::to_json)))
    }

    fn document_request(&self, params: &Json, method: &str) -> Result<(Json, PathBuf), String> {
        let path = required_path(params, "path")?;
        let clients = self.primary(&path)?;
        let (result, _) = self.first_answer(&clients, &path, method, &object([("textDocument", document(&path))]), self.timeout(params))?;
        Ok((result, path))
    }

    fn code_lens(&self, params: &Json) -> Result<Json, String> {
        let (result, _) = self.document_request(params, "textDocument/codeLens")?;
        Ok(array(protocol::parse_code_lenses(&result).into_iter().map(|(range, title)| {
            object([("range", range.to_json()), ("title", title.map_or(Json::Null, string))])
        })))
    }

    fn folding(&self, params: &Json) -> Result<Json, String> {
        let (result, _) = self.document_request(params, "textDocument/foldingRange")?;
        Ok(array(protocol::parse_folding_ranges(&result).into_iter().map(|(start, end, kind)| {
            object([("startLine", int(start.into())), ("endLine", int(end.into())), ("kind", kind.map_or(Json::Null, string))])
        })))
    }

    fn semantic_tokens(&self, params: &Json) -> Result<Json, String> {
        let path = required_path(params, "path")?;
        let clients = self.primary(&path)?;
        let (result, server) = self.first_answer(&clients, &path, "textDocument/semanticTokens/full", &object([("textDocument", document(&path))]), self.timeout(params))?;
        let legend = clients
            .iter()
            .find(|client| client.server() == server)
            .map(|client| client.capabilities().at("semanticTokensProvider.legend").cloned().unwrap_or(Json::Null))
            .unwrap_or(Json::Null);
        let only_line = params.u32_at("line");
        let tokens = protocol::decode_semantic_tokens(&result, &legend);
        Ok(array(tokens.into_iter().filter(|token| only_line.is_none_or(|line| token.0 == line)).take(2000).map(|(line, character, length, kind, modifiers)| {
            object([
                ("line", int(line.into())),
                ("character", int(character.into())),
                ("length", int(length.into())),
                ("type", string(kind)),
                ("modifiers", array(modifiers.into_iter().map(string))),
            ])
        })))
    }

    /// Moves a file and lets the server update every import of it.
    fn rename_file(&self, params: &Json) -> Result<Json, String> {
        let from = required_path(params, "from")?;
        let to = required_path(params, "to")?;
        let apply = params.bool_at("apply").unwrap_or(true);
        if !from.exists() {
            return Err(format!("{} does not exist", from.display()));
        }
        if to.exists() {
            return Err(format!("{} already exists", to.display()));
        }
        let files = array([object([("oldUri", string(uri::path_to_uri(&from))), ("newUri", string(uri::path_to_uri(&to)))])]);

        let probe = if from.is_dir() { from.join("index.ts") } else { from.clone() };
        let clients = self.primary(&probe).or_else(|_| Ok::<_, String>(self.running()))?;
        let mut changes = Vec::new();
        let mut server = String::new();
        for client in clients.iter().filter(|client| client.supports("workspace/willRenameFiles")) {
            if from.is_file() {
                let _ = client.sync(&from);
            }
            if let Ok(edit) = client.request("workspace/willRenameFiles", object([("files", files.clone())]), self.timeout(params).max(Duration::from_secs(60))) {
                if !edit.is_null() {
                    changes = edit::apply_workspace_edit(&edit, apply)?;
                    server = client.server().to_string();
                    break;
                }
            }
        }

        if apply {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
            }
            std::fs::rename(&from, &to).map_err(|error| format!("{} -> {}: {error}", from.display(), to.display()))?;
            for client in self.running() {
                let _ = client.close(&from);
                let _ = client.notify("workspace/didRenameFiles", object([("files", files.clone())]));
            }
            self.resync(&changes);
        }
        Ok(object([
            ("applied", Json::Bool(apply)),
            ("moved", object([("from", string(from.to_string_lossy())), ("to", string(to.to_string_lossy()))])),
            ("changes", array(changes.iter().map(FileChange::to_json))),
            ("server", if server.is_empty() { Json::Null } else { string(server) }),
        ]))
    }

    fn execute_command(&self, params: &Json) -> Result<Json, String> {
        let path = required_path(params, "path")?;
        let command = params.str_at("command").ok_or("`command` is required")?;
        let clients = self.primary(&path)?;
        let client = clients
            .iter()
            .find(|client| client.capabilities().at("executeCommandProvider.commands").is_some_and(|list| list.items().iter().any(|c| c.as_str() == Some(command))))
            .or_else(|| clients.first())
            .ok_or("no server")?;
        client.take_applied();
        let mut request = object([("command", string(command))]);
        if let Some(arguments) = params.at("arguments") {
            request.set("arguments", arguments.clone());
        }
        let result = client.request("workspace/executeCommand", request, self.timeout(params)).map_err(|e| e.to_string())?;
        let edited: Vec<Json> = client.take_applied().iter().map(|path| string(path.to_string_lossy())).collect();
        Ok(object([("result", result), ("edited", array(edited)), ("server", string(client.server()))]))
    }

    fn servers(&self, params: &Json) -> Result<Json, String> {
        let config = self.config();
        let only = params.str_at("path").map(PathBuf::from);
        let running: HashMap<String, Client> = self.running().into_iter().map(|client| (client.server().to_string(), client)).collect();
        let notes = lock(&self.notes).clone();
        let list = self
            .specs()
            .into_iter()
            .filter(|spec| only.as_ref().is_none_or(|path| spec.handles(path)))
            .map(|spec| {
                let binary = self.resolve_binary(&spec, &config.project_root, &config);
                let status = if spec.disabled {
                    "disabled"
                } else if running.contains_key(&spec.id) {
                    "running"
                } else if binary.is_some() {
                    "installed"
                } else if spec.install.as_ref().is_some_and(|i| i.automatic() && config.toolbox.cannot_install(i).is_none()) && config.auto_install {
                    "installable"
                } else {
                    "missing"
                };
                object([
                    ("id", string(&spec.id)),
                    ("name", string(&spec.name)),
                    ("role", string(spec.role.label())),
                    ("extensions", array(spec.extensions.iter().map(string))),
                    ("status", string(status)),
                    ("binary", binary.map_or(Json::Null, |b| string(b.to_string_lossy()))),
                    ("install", spec.install.as_ref().map_or(Json::Null, |i| string(i.describe()))),
                    ("note", notes.get(&spec.id).map_or(Json::Null, |n| string(n))),
                ])
            })
            .collect::<Vec<_>>();
        Ok(array(list))
    }

    fn status(&self) -> Result<Json, String> {
        let config = self.config();
        let running = self.running().into_iter().map(|client| {
            let info = client.server_info();
            object([
                ("server", string(client.server())),
                ("root", string(client.root().to_string_lossy())),
                ("pid", client.pid().map_or(Json::Null, |pid| int(pid.into()))),
                ("name", info.str_at("name").map_or(Json::Null, string)),
                ("version", info.str_at("version").map_or(Json::Null, string)),
                ("uptimeSeconds", int(client.uptime().as_secs() as i64)),
                ("openDocuments", int(client.open_documents() as i64)),
                ("progress", array(client.active_progress().into_iter().map(|p| string(match p.message { Some(m) => format!("{}: {m}", p.title), None => p.title })))),
                // What the server has been saying: the first place to look
                // when it answers nothing.
                (
                    "log",
                    array(client.messages().into_iter().rev().take(15).rev().map(|(level, text)| string(format!("[{level}] {}", text.chars().take(300).collect::<String>())))),
                ),
                ("stderr", array(client.stderr_tail(10).into_iter().map(string))),
            ])
        });
        Ok(object([
            ("projectRoot", string(config.project_root.to_string_lossy())),
            ("autoInstall", Json::Bool(config.auto_install)),
            ("toolsDir", string(config.toolbox.dir.to_string_lossy())),
            ("running", array(running)),
            ("installs", array(lock(&self.installs).iter().map(string))),
            ("notes", Json::Object(lock(&self.notes).iter().map(|(k, v)| (k.clone(), string(v))).collect())),
        ]))
    }

    fn install(&self, params: &Json) -> Result<Json, String> {
        let id = params.str_at("id").ok_or("`id` is required")?;
        let config = self.config();
        let spec = self.specs().into_iter().find(|spec| spec.id == id).ok_or_else(|| format!("no server called {id}"))?;
        let install = spec.install.as_ref().ok_or_else(|| format!("{id} has no install recipe"))?;
        let mut log = Vec::new();
        let binary = config.toolbox.install(&spec.id, install, &mut log)?;
        lock(&self.installs).push(format!("installed {id} ({}) at {}", install.describe(), binary.display()));
        Ok(object([("id", string(id)), ("binary", string(binary.to_string_lossy())), ("log", array(log.into_iter().map(string)))]))
    }

    /// Shuts every server down.
    pub fn shutdown(&self) -> Json {
        let slots: Vec<Arc<Mutex<Slot>>> = lock(&self.slots).drain().map(|(_, slot)| slot).collect();
        let mut stopped = Vec::new();
        for slot in slots {
            if let Some(client) = lock(&slot).client.take() {
                stopped.push(string(client.server()));
                client.shutdown();
            }
        }
        array(stopped)
    }

    /// The bridge's entry point: `lsp.<method>` with its params.
    pub fn call(&self, method: &str, params: &Json) -> Result<Json, String> {
        match method {
            "configure" => self.configure(params),
            "diagnostics" => self.diagnostics(params),
            "touch" => self.touch(params),
            "definition" => self.definition(params),
            "references" => self.references(params),
            "hover" => self.hover(params),
            "highlights" => self.highlights(params),
            "symbols" => self.symbols(params),
            "workspace_symbols" => self.workspace_symbols(params),
            "completion" => self.completion(params),
            "signature" => self.signature(params),
            "rename" => self.rename(params),
            "code_actions" => self.code_actions(params),
            "format" => self.format(params),
            "calls" => self.calls(params),
            "types" => self.types(params),
            "inlay_hints" => self.inlay_hints(params),
            "code_lens" => self.code_lens(params),
            "folding" => self.folding(params),
            "semantic_tokens" => self.semantic_tokens(params),
            "rename_file" => self.rename_file(params),
            "execute_command" => self.execute_command(params),
            "servers" => self.servers(params),
            "status" => self.status(),
            "install" => self.install(params),
            "stop" => Ok(self.shutdown()),
            other => Err(format!("unknown lsp method: {other}")),
        }
    }
}

impl Default for Hub {
    fn default() -> Self {
        Hub::new()
    }
}

/// Every method `Hub::call` answers, for the bridge's method list.
pub const METHODS: &[&str] = &[
    "configure", "diagnostics", "touch", "definition", "references", "hover", "highlights", "symbols",
    "workspace_symbols", "completion", "signature", "rename", "code_actions", "format", "calls", "types",
    "inlay_hints", "code_lens", "folding", "semantic_tokens", "rename_file", "execute_command", "servers", "status",
    "install", "stop",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indentation_is_read_from_the_file() {
        assert_eq!(indentation("a\n  b\n    c\n  d\n"), (2, true));
        assert_eq!(indentation("a\n\tb\n\tc\n\td\n\te\n\tf\n\tg\n"), (4, false));
        assert_eq!(indentation("x"), (4, true));
    }

    #[test]
    fn a_file_no_server_handles_is_said_plainly() {
        let hub = Hub::new();
        let error = hub.call("hover", &crate::json::literal(r#"{"path":"/tmp/nothing.unknownext","line":0}"#)).unwrap_err();
        assert!(error.contains("nothing.unknownext"), "{error}");
    }

    #[test]
    fn every_listed_method_dispatches() {
        let hub = Hub::new();
        for method in METHODS {
            if let Err(error) = hub.call(method, &Json::Null) {
                assert!(!error.starts_with("unknown lsp method"), "{method}: {error}");
            }
        }
    }
}
