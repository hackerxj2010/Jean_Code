//! The operations that need state, or that reach the crates added after the
//! first cut of the bridge: shell sessions, isolated views, reversible
//! compaction, system control, token counting, audio, and the memory log.
//!
//! State lives in [`State`], owned by `main` and passed to every call. A shell
//! session, an isolated view, or a power assertion is created by one call and
//! used or released by later ones, so it cannot live in a handler's locals.

use crate::protocol::{number, object, strings, Request};
use pi_builtins::json::Json;
use std::collections::HashMap;
use std::path::Path;

/// Everything the bridge keeps between calls.
#[derive(Default)]
pub struct State {
    next: u64,
    shells: HashMap<String, pi_shell::Session>,
    views: HashMap<String, pi_iso::View>,
    awake: HashMap<String, pi_sys::PowerAssertion>,
    /// A loaded `.tiktoken` vocabulary, by path: loading one parses a hundred
    /// thousand merges, which is worth doing once per process, not per call.
    counter: Option<(String, pi_tokens::Counter)>,
}

impl State {
    fn id(&mut self, prefix: &str) -> String {
        self.next += 1;
        format!("{prefix}-{}", self.next)
    }
}

fn nullable(value: Option<&str>) -> Json {
    value.map_or(Json::Null, |v| Json::String(v.to_string()))
}

fn number_param(request: &Request, key: &str) -> Option<f64> {
    match request.params.get(key) {
        Some(Json::Number(value)) if value.is_finite() => Some(*value),
        _ => None,
    }
}

// ---- pi-shell + brush-core ---------------------------------------------------

/// The simple commands a line would run, without running them, plus whether
/// it uses a construct only a system shell supports.
pub fn shell_inspect(request: &Request) -> Result<Json, String> {
    let command = request.string("command")?;
    let system = brush_core::needs_system_shell(command);

    Ok(match pi_shell::inspect(command) {
        Ok(found) => object(vec![
            ("parsed", Json::Bool(true)),
            (
                "commands",
                Json::Array(
                    found
                        .iter()
                        .map(|c| {
                            object(vec![
                                ("words", strings(c.words.clone())),
                                ("line", Json::String(c.line())),
                                ("background", Json::Bool(c.background)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("needsSystemShell", nullable(system)),
        ]),
        Err(error) => object(vec![
            ("parsed", Json::Bool(false)),
            ("commands", Json::Array(Vec::new())),
            ("error", Json::String(error)),
            ("needsSystemShell", nullable(system)),
        ]),
    })
}

pub fn shell_open(request: &Request, state: &mut State) -> Result<Json, String> {
    let cwd = request.string("cwd")?;
    if !Path::new(cwd).is_dir() {
        return Err(format!("{cwd} is not a directory"));
    }
    let mut session = pi_shell::Session::new(cwd);
    // The caller has already gated the command; the session only keeps the
    // unrecoverable few refused by name.
    session.policy = if request.bool("confined", false) {
        pi_shell::Policy::confined(cwd)
    } else {
        pi_shell::Policy::default()
    };
    let id = state.id("shell");
    state.shells.insert(id.clone(), session);
    Ok(object(vec![("id", Json::String(id))]))
}

pub fn shell_run(request: &Request, state: &mut State) -> Result<Json, String> {
    let id = request.string("session")?;
    let command = request.string("command")?;
    let stdin = request.optional_string("stdin").unwrap_or("");

    // Refused up front: a script that uses a loop or a function would run
    // halfway in this shell and then stop, which is worse than not running.
    if let Some(construct) = brush_core::needs_system_shell(command) {
        return Err(format!("this command uses {construct}, which needs a system shell"));
    }

    let session = state
        .shells
        .get_mut(id)
        .ok_or_else(|| format!("no shell session {id}"))?;
    let run = pi_shell::run(command, session, stdin);

    Ok(object(vec![
        ("stdout", Json::String(run.stdout)),
        ("stderr", Json::String(run.stderr)),
        ("code", Json::Number(f64::from(run.code))),
        ("cwd", Json::String(session.cwd.to_string_lossy().to_string())),
        ("refused", strings(run.refused)),
        ("jobs", Json::Array(run.jobs.iter().map(|j| Json::Number(f64::from(*j))).collect())),
    ]))
}

pub fn shell_close(request: &Request, state: &mut State) -> Result<Json, String> {
    let id = request.string("session")?;
    Ok(Json::Bool(state.shells.remove(id).is_some()))
}

// ---- pi-iso ----------------------------------------------------------------

pub fn iso_create(request: &Request, state: &mut State) -> Result<Json, String> {
    let source = request.string("source")?;
    let destination = request.string("destination")?;
    let exclude = request.string_list("exclude");

    let view = pi_iso::View::create_excluding(Path::new(source), Path::new(destination), &exclude)?;
    let files = view.base.files.len();
    let backend = view.backend.label().to_string();
    let id = state.id("view");
    state.views.insert(id.clone(), view);

    Ok(object(vec![
        ("id", Json::String(id)),
        ("root", Json::String(destination.to_string())),
        ("backend", Json::String(backend)),
        ("files", number(files)),
    ]))
}

fn change_json(change: &pi_iso::Change) -> Json {
    object(vec![
        ("path", Json::String(change.path().to_string())),
        ("kind", Json::String(change.label().to_string())),
    ])
}

pub fn iso_changes(request: &Request, state: &mut State) -> Result<Json, String> {
    let id = request.string("id")?;
    let view = state.views.get(id).ok_or_else(|| format!("no view {id}"))?;
    Ok(Json::Array(view.changes()?.iter().map(change_json).collect()))
}

/// Plans the merge back and, when nothing conflicts, applies it. A plan with
/// any conflict applies nothing: half of an isolated change is usually worse
/// than none of it.
pub fn iso_merge(request: &Request, state: &mut State) -> Result<Json, String> {
    let id = request.string("id")?;
    let view = state.views.get(id).ok_or_else(|| format!("no view {id}"))?;
    let plan = view.plan()?;

    let conflicts: Vec<Json> = plan
        .conflicts
        .iter()
        .map(|conflict| {
            object(vec![
                ("path", Json::String(conflict.path.clone())),
                ("reason", Json::String(conflict.reason.describe().to_string())),
            ])
        })
        .collect();

    let applied = if plan.is_clean() { view.apply(&plan)? } else { 0 };

    Ok(object(vec![
        ("applied", number(applied)),
        ("changes", Json::Array(plan.apply.iter().map(change_json).collect())),
        ("conflicts", Json::Array(conflicts)),
        ("report", Json::String(plan.report())),
    ]))
}

pub fn iso_discard(request: &Request, state: &mut State) -> Result<Json, String> {
    let id = request.string("id")?;
    match state.views.remove(id) {
        Some(view) => {
            view.discard()?;
            Ok(Json::Bool(true))
        }
        None => Ok(Json::Bool(false)),
    }
}

// ---- snapcompact -----------------------------------------------------------

fn role_of(label: &str) -> snapcompact::Role {
    match label {
        "user" => snapcompact::Role::User,
        "assistant" => snapcompact::Role::Assistant,
        "system" => snapcompact::Role::System,
        _ => snapcompact::Role::Tool,
    }
}

fn entities_json(entities: &[snapcompact::Entity]) -> Json {
    Json::Array(
        entities
            .iter()
            .map(|entity| {
                object(vec![
                    ("kind", Json::String(entity.kind.label().to_string())),
                    ("text", Json::String(entity.text.clone())),
                    ("count", number(entity.count)),
                ])
            })
            .collect(),
    )
}

/// Archives a run of turns in the content-addressed store and returns the
/// frame that stands in for them: summary, extracted entities, and the hash
/// that recovers the full text.
pub fn snap_frame(request: &Request) -> Result<Json, String> {
    let root = request.string("store")?;
    let Some(Json::Array(items)) = request.params.get("turns") else {
        return Err("`turns` must be an array of {role, text}".to_string());
    };

    let turns: Vec<snapcompact::Turn> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let Json::Object(map) = item else { return None };
            let text = map.get("text")?.as_str()?.to_string();
            let role = map.get("role").and_then(Json::as_str).unwrap_or("tool");
            Some(snapcompact::Turn { index, role: role_of(role), text })
        })
        .collect();
    if turns.is_empty() {
        return Err("no turns to archive".to_string());
    }

    let mut store = snapcompact::Store::at(root);
    let frame = snapcompact::build_frame(&turns, &mut store);

    Ok(object(vec![
        ("hash", Json::String(frame.hash.clone())),
        ("summary", Json::String(frame.summary.clone())),
        ("entities", entities_json(&frame.entities)),
        ("tokensBefore", number(frame.tokens_before)),
        ("tokensAfter", number(frame.tokens_after)),
        ("rendered", Json::String(frame.render())),
    ]))
}

pub fn snap_get(request: &Request) -> Result<Json, String> {
    let root = request.string("store")?;
    let hash = request.string("hash")?;
    let store = snapcompact::Store::at(root);
    // A prefix is enough, as `Frame::render` shows only the first 12 characters.
    store
        .get(hash)
        .map(Json::String)
        .ok_or_else(|| format!("nothing archived under {hash}"))
}

pub fn snap_entities(request: &Request) -> Result<Json, String> {
    let text = request.string("text")?;
    Ok(entities_json(&snapcompact::extract(text)))
}

// ---- pi-sys ----------------------------------------------------------------

fn process_json(process: &pi_sys::Process) -> Json {
    object(vec![
        ("pid", Json::Number(f64::from(process.pid))),
        ("parent", Json::Number(f64::from(process.parent))),
        ("name", Json::String(process.name.clone())),
        ("command", nullable(process.command.as_deref())),
    ])
}

pub fn sys_processes(request: &Request) -> Result<Json, String> {
    let list = match number_param(request, "root") {
        Some(root) => pi_sys::descendants(root as u32)?,
        None => pi_sys::snapshot()?,
    };
    Ok(Json::Array(list.iter().map(process_json).collect()))
}

/// Kills a process and everything it started. `child.kill()` on a shell kills
/// the shell and leaves the server it launched running — this does not.
pub fn sys_kill_tree(request: &Request) -> Result<Json, String> {
    let pid = number_param(request, "pid").ok_or("`pid` is required")? as u32;
    let include_root = request.bool("includeRoot", true);
    let report = pi_sys::kill_tree(pid, include_root)?;

    Ok(object(vec![
        ("killed", Json::Array(report.killed.iter().map(|p| Json::Number(f64::from(*p))).collect())),
        (
            "failed",
            Json::Array(
                report
                    .failed
                    .iter()
                    .map(|(pid, why)| {
                        object(vec![
                            ("pid", Json::Number(f64::from(*pid))),
                            ("error", Json::String(why.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "alreadyGone",
            Json::Array(report.already_gone.iter().map(|p| Json::Number(f64::from(*p))).collect()),
        ),
        ("summary", Json::String(report.summary())),
    ]))
}

pub fn sys_copy(request: &Request) -> Result<Json, String> {
    let text = request.string("text")?;
    let backend = pi_sys::copy(text)?;
    Ok(Json::String(backend.label().to_string()))
}

pub fn sys_paste() -> Result<Json, String> {
    pi_sys::paste().map(Json::String)
}

/// Holds the machine awake until released — a long unattended run should not
/// stop because the laptop went to sleep.
pub fn sys_awake(request: &Request, state: &mut State) -> Result<Json, String> {
    let reason = request.optional_string("reason").unwrap_or("Jean Code is working");
    let kind = if request.bool("display", false) {
        pi_sys::Assertion::PreventDisplaySleep
    } else {
        pi_sys::Assertion::PreventIdleSleep
    };
    let assertion = pi_sys::prevent_sleep(kind, reason);
    let active = assertion.is_active();
    let id = state.id("awake");
    state.awake.insert(id.clone(), assertion);
    Ok(object(vec![("id", Json::String(id)), ("active", Json::Bool(active))]))
}

pub fn sys_release(request: &Request, state: &mut State) -> Result<Json, String> {
    let id = request.string("id")?;
    match state.awake.remove(id) {
        Some(mut assertion) => {
            assertion.release();
            Ok(Json::Bool(true))
        }
        None => Ok(Json::Bool(false)),
    }
}

// ---- pi-tokens -------------------------------------------------------------

pub fn tokens_count(request: &Request, state: &mut State) -> Result<Json, String> {
    // Exact with a vocabulary file, the calibrated estimate without one.
    let heuristic = pi_tokens::Counter::heuristic();
    let counter = match request.optional_string("vocabulary") {
        Some(path) if Path::new(path).is_file() => {
            if state.counter.as_ref().is_none_or(|(loaded, _)| loaded != path) {
                let name = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("vocabulary");
                state.counter = Some((path.to_string(), pi_tokens::Counter::from_file(name, Path::new(path))));
            }
            state.counter.as_ref().map_or(&heuristic, |(_, counter)| counter)
        }
        _ => &heuristic,
    };
    if let Some(Json::Array(items)) = request.params.get("texts") {
        let counts: Vec<Json> = items
            .iter()
            .map(|item| number(item.as_str().map_or(0, |text| counter.count(text).tokens)))
            .collect();
        return Ok(Json::Array(counts));
    }
    let text = request.string("text")?;
    let count = counter.count(text);
    Ok(object(vec![("tokens", number(count.tokens)), ("exact", Json::Bool(count.exact))]))
}

// ---- pi-voice --------------------------------------------------------------

/// Describes an audio file: format, length, loudness, and where the speech is.
/// WAV, FLAC, AIFF, and `.au` are decoded here; anything else through ffmpeg.
pub fn voice_probe(request: &Request) -> Result<Json, String> {
    let path = request.string("path")?;
    let decoded = pi_voice::open(Path::new(path))?;
    let frame = decoded.frame;
    let mono = frame.to_mono();

    // Speech segments, from the turn detector over 20 ms windows.
    let window = (mono.sample_rate as usize / 50).max(1);
    let mut detector = pi_voice::TurnDetector::default();
    let mut segments = Vec::new();
    let mut start: Option<u64> = None;
    for (index, chunk) in mono.samples.chunks(window).enumerate() {
        let at = (index * window) as u64 * 1000 / u64::from(mono.sample_rate.max(1));
        let piece = pi_voice::Frame::new(chunk.to_vec(), mono.sample_rate, 1);
        match detector.push(&piece) {
            pi_voice::Turn::Speaking if start.is_none() => start = Some(at),
            pi_voice::Turn::Ended => {
                if let Some(begin) = start.take() {
                    segments.push(object(vec![
                        ("startMs", Json::Number(begin as f64)),
                        ("endMs", Json::Number(at as f64)),
                    ]));
                }
                detector.reset();
            }
            _ => {}
        }
    }
    if let Some(begin) = start {
        segments.push(object(vec![
            ("startMs", Json::Number(begin as f64)),
            ("endMs", Json::Number(mono.duration_ms() as f64)),
        ]));
    }

    Ok(object(vec![
        ("format", Json::String(decoded.format.to_string())),
        ("channels", Json::Number(f64::from(frame.channels))),
        ("sampleRate", Json::Number(f64::from(frame.sample_rate))),
        ("bitsPerSample", Json::Number(f64::from(decoded.bits_per_sample))),
        ("durationMs", Json::Number(frame.duration_ms() as f64)),
        ("rms", Json::Number(f64::from(mono.rms()))),
        ("peak", Json::Number(f64::from(mono.peak()))),
        ("speech", Json::Array(segments)),
    ]))
}

/// Mono, 16 kHz, silence trimmed: the shape speech-to-text services want, and
/// a fraction of the upload.
pub fn voice_prepare(request: &Request) -> Result<Json, String> {
    let path = request.string("path")?;
    let output = request.string("output")?;
    let prepared = pi_voice::open(Path::new(path))?.frame.for_transcription();
    std::fs::write(output, pi_voice::encode(&prepared)).map_err(|error| format!("{output}: {error}"))?;
    Ok(object(vec![
        ("output", Json::String(output.to_string())),
        ("durationMs", Json::Number(prepared.duration_ms() as f64)),
        ("sampleRate", Json::Number(f64::from(prepared.sample_rate))),
    ]))
}

/// Records from the microphone until the speaker finishes (or `maxMs`), and
/// writes it as a 16 kHz mono WAV to `output`.
pub fn voice_record(request: &Request) -> Result<Json, String> {
    let output = request.string("output")?;
    let defaults = pi_voice::external::Capture::default();
    let number = |key: &str, fallback: u32| match request.params.get(key) {
        Some(Json::Number(value)) if *value > 0.0 => *value as u32,
        _ => fallback,
    };
    let options = pi_voice::external::Capture {
        max_ms: number("maxMs", defaults.max_ms),
        wait_ms: number("waitMs", defaults.wait_ms),
        until_silence: request.bool("untilSilence", true),
    };
    let recording = pi_voice::external::record(options)?;
    std::fs::write(output, pi_voice::encode(&recording.frame)).map_err(|error| format!("{output}: {error}"))?;
    Ok(object(vec![
        ("output", Json::String(output.to_string())),
        ("durationMs", Json::Number(recording.frame.duration_ms() as f64)),
        ("recorder", Json::String(recording.recorder)),
        ("heardSpeech", Json::Bool(recording.heard_speech)),
    ]))
}

/// The microphone recorders this machine has, most suitable first.
pub fn voice_recorders() -> Json {
    Json::Array(
        pi_voice::external::recorders()
            .into_iter()
            .map(|recorder| {
                object(vec![
                    ("name", Json::String(recorder.name)),
                    ("program", Json::String(recorder.program.to_string_lossy().to_string())),
                ])
            })
            .collect(),
    )
}

// ---- pi-mnemopi, the full backend ------------------------------------------

fn memory_json(memory: &pi_mnemopi::Memory) -> Json {
    object(vec![
        ("id", Json::Number(memory.id as f64)),
        ("kind", Json::String(memory.kind.label().to_string())),
        ("name", Json::String(memory.name.clone())),
        ("description", Json::String(memory.description.clone())),
        ("text", Json::String(memory.text.clone())),
        ("created", Json::Number(memory.created as f64)),
        ("project", nullable(memory.project.as_deref())),
        ("source", nullable(memory.source.as_deref())),
    ])
}

/// Whether a memory applies to `project`: global memories apply everywhere,
/// unless `strict` asks for that project's own memories only.
fn in_scope(memory: &pi_mnemopi::Memory, project: Option<&str>, strict: bool) -> bool {
    match (project, memory.project.as_deref()) {
        (None, _) => true,
        (Some(_), None) => !strict,
        (Some(wanted), Some(own)) => wanted == own,
    }
}

pub fn memory_remember(request: &Request) -> Result<Json, String> {
    let path = request.string("path")?;
    let name = request.string("name")?;
    let text = request.string("text")?;
    let description = request.optional_string("description").unwrap_or("");
    let kind = request.optional_string("kind").unwrap_or("project");
    let parsed = pi_mnemopi::Kind::parse(kind).ok_or_else(|| format!("unknown memory kind: {kind}"))?;

    let mut storage = pi_mnemopi::Storage::open(path)?;
    let id = storage.remember_scoped(
        parsed,
        name,
        description,
        text,
        request.optional_string("project"),
        request.optional_string("source"),
    )?;
    let memory = storage.get_id(id).ok_or("the memory vanished after writing")?;
    Ok(memory_json(memory))
}

pub fn memory_recall(request: &Request) -> Result<Json, String> {
    let path = request.string("path")?;
    let query = request.string("query")?;
    let limit = request.usize("limit", 5);
    let project = request.optional_string("project");
    let kind = request.optional_string("kind").and_then(pi_mnemopi::Kind::parse);

    let storage = pi_mnemopi::Storage::open(path)?;
    // Over-fetched, since scope and kind filter after ranking.
    let hits = storage.recall(query, limit.saturating_mul(4).max(limit));
    let strict = request.bool("strict", false);

    Ok(Json::Array(
        hits.iter()
            .filter(|hit| in_scope(&hit.memory, project, strict))
            .filter(|hit| kind.is_none_or(|k| hit.memory.kind == k))
            .take(limit)
            .map(|hit| {
                let mut value = memory_json(&hit.memory);
                if let Json::Object(map) = &mut value {
                    map.insert("score".to_string(), Json::Number(hit.score));
                }
                value
            })
            .collect(),
    ))
}

pub fn memory_list(request: &Request) -> Result<Json, String> {
    let path = request.string("path")?;
    let limit = request.usize("limit", 50);
    let project = request.optional_string("project");
    let kind = request.optional_string("kind").and_then(pi_mnemopi::Kind::parse);

    let strict = request.bool("strict", false);

    let storage = pi_mnemopi::Storage::open(path)?;
    Ok(Json::Array(
        storage
            .all()
            .into_iter()
            .filter(|memory| in_scope(memory, project, strict))
            .filter(|memory| kind.is_none_or(|k| memory.kind == k))
            .take(limit)
            .map(memory_json)
            .collect(),
    ))
}

pub fn memory_get(request: &Request) -> Result<Json, String> {
    let path = request.string("path")?;
    let id = number_param(request, "id").ok_or("`id` is required")? as u64;
    let storage = pi_mnemopi::Storage::open(path)?;
    Ok(storage.get_id(id).map_or(Json::Null, memory_json))
}

pub fn memory_forget(request: &Request) -> Result<Json, String> {
    let path = request.string("path")?;
    let id = number_param(request, "id").ok_or("`id` is required")? as u64;
    let mut storage = pi_mnemopi::Storage::open(path)?;
    Ok(Json::Bool(storage.forget_id(id)?))
}

pub fn memory_count(request: &Request) -> Result<Json, String> {
    let path = request.string("path")?;
    Ok(number(pi_mnemopi::Storage::open(path)?.len()))
}

/// Replaces a memory's text. The log is append-only, so this writes a record
/// superseding the old one under the same name: the answer carries a new id.
pub fn memory_update(request: &Request) -> Result<Json, String> {
    let path = request.string("path")?;
    let id = number_param(request, "id").ok_or("`id` is required")? as u64;
    let text = request.string("text")?;

    let mut storage = pi_mnemopi::Storage::open(path)?;
    let Some(old) = storage.get_id(id).cloned() else { return Ok(Json::Null) };
    let description = request.optional_string("description").unwrap_or(&old.description).to_string();
    let written = storage.remember_scoped(
        old.kind,
        &old.name,
        &description,
        text,
        old.project.as_deref(),
        old.source.as_deref(),
    )?;
    let memory = storage.get_id(written).ok_or("the memory vanished after writing")?;
    Ok(memory_json(memory))
}
