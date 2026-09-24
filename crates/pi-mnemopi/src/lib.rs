//! # pi-mnemopi
//!
//! The native memory backend: an append-only log on disk with ranked recall.
//!
//! Two design choices worth stating, because both are unusual:
//!
//! **Append-only.** A memory is never edited in place; an update writes a new
//! record superseding the old one. Memory is a record of what was believed
//! *when*, and an agent that silently rewrites its own history cannot be
//! debugged — you cannot tell whether it never knew something or knew it and
//! forgot. Compaction rewrites the log only when asked.
//!
//! **No SQLite.** The whole crate takes no dependencies, so recall is BM25 over
//! an inverted index built at load. For the scale memory actually reaches —
//! thousands of short records, not millions — the index builds in milliseconds
//! and the format stays a text file a person can read and a `git diff` can
//! show.

pub mod index;

pub use index::Index;

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// What a memory is for, which decides how it is recalled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Who the user is: role, preferences, expertise.
    User,
    /// Guidance on how to work, including the reasoning behind it.
    Feedback,
    /// Ongoing work, goals, constraints not derivable from the code.
    Project,
    /// A pointer to something external: a URL, a dashboard, a ticket.
    Reference,
    /// A technique learned from solving something hard.
    Pattern,
}

impl Kind {
    pub fn label(&self) -> &'static str {
        match self {
            Kind::User => "user",
            Kind::Feedback => "feedback",
            Kind::Project => "project",
            Kind::Reference => "reference",
            Kind::Pattern => "pattern",
        }
    }

    pub fn parse(text: &str) -> Option<Kind> {
        match text.trim().to_lowercase().as_str() {
            "user" => Some(Kind::User),
            "feedback" => Some(Kind::Feedback),
            "project" => Some(Kind::Project),
            "reference" => Some(Kind::Reference),
            "pattern" => Some(Kind::Pattern),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Memory {
    pub id: u64,
    pub kind: Kind,
    /// A short slug, unique among live memories.
    pub name: String,
    /// One line, used to decide relevance during recall.
    pub description: String,
    pub text: String,
    /// Seconds since the epoch.
    pub created: u64,
    /// The id this record replaces, if any.
    pub supersedes: Option<u64>,
    /// Names of related memories, from `[[link]]` syntax in the text.
    pub links: Vec<String>,
    /// The project root this belongs to; `None` means it applies everywhere.
    pub project: Option<String>,
    /// Where it came from: a session id, a file, or the user directly.
    pub source: Option<String>,
}

impl Memory {
    /// A memory's full searchable text: the name and description carry as much
    /// signal as the body and are what a recall query usually matches.
    fn indexable(&self) -> String {
        format!("{} {} {}", self.name, self.description, self.text)
    }
}

/// A recalled memory with its score.
#[derive(Debug, Clone)]
pub struct Recalled {
    pub memory: Memory,
    pub score: f64,
}

pub struct Storage {
    path: PathBuf,
    /// Live records by id, newest state only.
    memories: HashMap<u64, Memory>,
    /// Ids that a later record superseded or deleted.
    dead: Vec<u64>,
    index: Index,
    next_id: u64,
}

impl Storage {
    /// Opens a store, creating it if needed.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, String> {
        let path = path.into();

        let mut storage = Storage {
            path,
            memories: HashMap::new(),
            dead: Vec::new(),
            index: Index::new(),
            next_id: 1,
        };

        if storage.path.exists() {
            storage.load()?;
        } else if let Some(parent) = storage.path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
        }

        Ok(storage)
    }

    /// An in-memory store, for tests.
    pub fn ephemeral() -> Self {
        Storage {
            path: PathBuf::new(),
            memories: HashMap::new(),
            dead: Vec::new(),
            index: Index::new(),
            next_id: 1,
        }
    }

    pub fn len(&self) -> usize {
        self.memories.len()
    }

    pub fn is_empty(&self) -> bool {
        self.memories.is_empty()
    }

    /// Stores a memory, returning its id.
    ///
    /// A name that already exists supersedes the previous record rather than
    /// creating a duplicate — the common case is the agent learning a fuller
    /// version of something it already knew.
    pub fn remember(
        &mut self,
        kind: Kind,
        name: &str,
        description: &str,
        text: &str,
    ) -> Result<u64, String> {
        self.remember_scoped(kind, name, description, text, None, None)
    }

    /// Stores a memory scoped to a project and attributed to a source.
    pub fn remember_scoped(
        &mut self,
        kind: Kind,
        name: &str,
        description: &str,
        text: &str,
        project: Option<&str>,
        source: Option<&str>,
    ) -> Result<u64, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a memory needs a name".to_string());
        }
        if text.trim().is_empty() {
            return Err("a memory needs a body".to_string());
        }

        let supersedes = self
            .memories
            .values()
            .find(|memory| memory.name == name)
            .map(|memory| memory.id);

        let memory = Memory {
            id: self.next_id,
            kind,
            name: name.to_string(),
            description: description.trim().to_string(),
            text: text.trim().to_string(),
            created: now(),
            supersedes,
            links: extract_links(text),
            project: project.map(one_line).filter(|p| !p.trim().is_empty()),
            source: source.map(one_line).filter(|s| !s.trim().is_empty()),
        };

        self.next_id += 1;
        let id = memory.id;

        self.append(&memory)?;

        if let Some(old) = supersedes {
            self.memories.remove(&old);
            self.index.remove(old);
            self.dead.push(old);
        }

        self.index.insert(id, &memory.indexable());
        self.memories.insert(id, memory);

        Ok(id)
    }

    /// Marks a memory dead. The record stays in the log.
    pub fn forget(&mut self, name: &str) -> Result<bool, String> {
        let Some(id) = self.memories.values().find(|m| m.name == name).map(|m| m.id) else {
            return Ok(false);
        };

        self.append_line(&format!("---\nforget: {id}\n"))?;
        self.memories.remove(&id);
        self.index.remove(id);
        self.dead.push(id);
        Ok(true)
    }

    pub fn get(&self, name: &str) -> Option<&Memory> {
        self.memories.values().find(|memory| memory.name == name)
    }

    /// A live memory by id.
    pub fn get_id(&self, id: u64) -> Option<&Memory> {
        self.memories.get(&id)
    }

    /// Marks a memory dead by id. The record stays in the log.
    pub fn forget_id(&mut self, id: u64) -> Result<bool, String> {
        let Some(name) = self.memories.get(&id).map(|m| m.name.clone()) else {
            return Ok(false);
        };
        self.forget(&name)
    }

    /// Every live memory, newest first.
    pub fn all(&self) -> Vec<&Memory> {
        let mut memories: Vec<&Memory> = self.memories.values().collect();
        memories.sort_by(|a, b| b.created.cmp(&a.created).then(b.id.cmp(&a.id)));
        memories
    }

    pub fn of_kind(&self, kind: Kind) -> Vec<&Memory> {
        self.all().into_iter().filter(|memory| memory.kind == kind).collect()
    }

    /// Recalls memories matching a query, best first.
    pub fn recall(&self, query: &str, limit: usize) -> Vec<Recalled> {
        self.index
            .search(query, limit)
            .into_iter()
            .filter_map(|(id, score)| {
                self.memories.get(&id).map(|memory| Recalled { memory: memory.clone(), score })
            })
            .collect()
    }

    /// Memories linked from one, following `[[name]]` references.
    ///
    /// A link to a name that does not exist yet is not an error: it marks
    /// something worth writing later.
    pub fn linked(&self, name: &str) -> Vec<&Memory> {
        let Some(memory) = self.get(name) else { return Vec::new() };
        memory.links.iter().filter_map(|link| self.get(link)).collect()
    }

    /// Names referenced by some memory but not yet written.
    pub fn dangling_links(&self) -> Vec<String> {
        let mut missing: Vec<String> = self
            .memories
            .values()
            .flat_map(|memory| memory.links.iter())
            .filter(|link| self.get(link).is_none())
            .cloned()
            .collect();
        missing.sort();
        missing.dedup();
        missing
    }

    /// Rewrites the log with only live records.
    ///
    /// Only on request: the superseded history is the audit trail, and dropping
    /// it on a timer would make a wrong memory untraceable.
    pub fn compact(&mut self) -> Result<usize, String> {
        if self.path.as_os_str().is_empty() {
            let removed = self.dead.len();
            self.dead.clear();
            return Ok(removed);
        }

        let removed = self.dead.len();
        let mut out = String::new();
        for memory in self.all() {
            out.push_str(&serialize(memory));
        }

        // Written to a temporary file and renamed: a crash mid-write would
        // otherwise leave a truncated log, which is every memory lost.
        let temporary = self.path.with_extension("tmp");
        fs::write(&temporary, &out).map_err(|error| format!("{}: {error}", temporary.display()))?;
        fs::rename(&temporary, &self.path)
            .map_err(|error| format!("{}: {error}", self.path.display()))?;

        self.dead.clear();
        Ok(removed)
    }

    fn append(&self, memory: &Memory) -> Result<(), String> {
        self.append_line(&serialize(memory))
    }

    fn append_line(&self, text: &str) -> Result<(), String> {
        if self.path.as_os_str().is_empty() {
            return Ok(());
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| format!("{}: {error}", self.path.display()))?;
        file.write_all(text.as_bytes())
            .map_err(|error| format!("{}: {error}", self.path.display()))
    }

    fn load(&mut self) -> Result<(), String> {
        let content = fs::read_to_string(&self.path)
            .map_err(|error| format!("{}: {error}", self.path.display()))?;

        for record in content.split("\n---\n") {
            let record = record.trim_start_matches("---\n").trim();
            if record.is_empty() {
                continue;
            }

            if let Some(id) = record.strip_prefix("forget: ") {
                if let Ok(id) = id.trim().parse::<u64>() {
                    self.memories.remove(&id);
                    self.index.remove(id);
                    self.dead.push(id);
                }
                continue;
            }

            // A malformed record is skipped rather than failing the load: one
            // bad line must not cost the user every memory they have.
            let Some(memory) = deserialize(record) else { continue };

            self.next_id = self.next_id.max(memory.id + 1);

            if let Some(old) = memory.supersedes {
                self.memories.remove(&old);
                self.index.remove(old);
                self.dead.push(old);
            }

            self.index.insert(memory.id, &memory.indexable());
            self.memories.insert(memory.id, memory);
        }

        Ok(())
    }
}

/// One record in the log.
///
/// The format is a readable header plus the body: a person can open the file
/// and understand it, and a `git diff` of it shows what changed.
fn serialize(memory: &Memory) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("id: {}\n", memory.id));
    out.push_str(&format!("kind: {}\n", memory.kind.label()));
    out.push_str(&format!("name: {}\n", memory.name));
    out.push_str(&format!("description: {}\n", one_line(&memory.description)));
    out.push_str(&format!("created: {}\n", memory.created));
    if let Some(supersedes) = memory.supersedes {
        out.push_str(&format!("supersedes: {supersedes}\n"));
    }
    if let Some(project) = &memory.project {
        out.push_str(&format!("project: {}\n", one_line(project)));
    }
    if let Some(source) = &memory.source {
        out.push_str(&format!("source: {}\n", one_line(source)));
    }
    out.push('\n');
    out.push_str(memory.text.trim());
    out.push('\n');
    out
}

fn deserialize(record: &str) -> Option<Memory> {
    let (header, body) = record.split_once("\n\n")?;

    let mut fields: HashMap<&str, &str> = HashMap::new();
    for line in header.lines() {
        if let Some((key, value)) = line.split_once(": ") {
            fields.insert(key.trim(), value.trim());
        }
    }

    let text = body.trim().to_string();
    Some(Memory {
        id: fields.get("id")?.parse().ok()?,
        kind: Kind::parse(fields.get("kind")?)?,
        name: fields.get("name")?.to_string(),
        description: fields.get("description").unwrap_or(&"").to_string(),
        links: extract_links(&text),
        text,
        created: fields.get("created").and_then(|v| v.parse().ok()).unwrap_or(0),
        supersedes: fields.get("supersedes").and_then(|v| v.parse().ok()),
        project: fields.get("project").map(|v| v.to_string()),
        source: fields.get("source").map(|v| v.to_string()),
    })
}

/// Collapses newlines, so a multi-line value cannot break the header format.
fn one_line(text: &str) -> String {
    text.replace(['\n', '\r'], " ")
}

/// Extracts `[[name]]` links.
pub fn extract_links(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut links = Vec::new();
    let mut index = 0;

    while index + 1 < chars.len() {
        if chars[index] != '[' || chars[index + 1] != '[' {
            index += 1;
            continue;
        }

        let mut end = index + 2;
        while end + 1 < chars.len() && !(chars[end] == ']' && chars[end + 1] == ']') {
            end += 1;
        }

        if end + 1 < chars.len() {
            let name: String = chars[index + 2..end].iter().collect();
            let name = name.trim().to_string();
            if !name.is_empty() && !links.contains(&name) {
                links.push(name);
            }
            index = end + 2;
            continue;
        }
        // An unclosed `[[` is not a link.
        break;
    }

    links
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Renders memories as an index, one line each.
pub fn render_index(memories: &[&Memory]) -> String {
    let mut out = String::new();
    for memory in memories {
        out.push_str(&format!(
            "- [{}] {} — {}\n",
            memory.kind.label(),
            memory.name,
            one_line(&memory.description)
        ));
    }
    out
}

/// The default store location.
pub fn default_path(home: &Path) -> PathBuf {
    home.join(".jean").join("memory").join("memories.log")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!(
            "mnemopi-{}.log",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    fn seeded() -> Storage {
        let mut storage = Storage::ephemeral();
        storage
            .remember(
                Kind::Project,
                "hashline-parity",
                "The Rust and TypeScript hashline implementations must agree byte for byte",
                "Both implementations are checked against a shared fixture set. See [[dual-implementation]].",
            )
            .unwrap();
        storage
            .remember(
                Kind::Feedback,
                "no-heredocs-for-regex",
                "Write code containing regex escapes with the editor, never through a shell heredoc",
                "Bash and Python heredocs both eat backslash levels.",
            )
            .unwrap();
        storage
            .remember(Kind::User, "prefers-dotenv", "Credentials belong in .env, not pasted into the terminal", "Stated directly.")
            .unwrap();
        storage
    }

    #[test]
    fn remembers_and_recalls() {
        let storage = seeded();
        let results = storage.recall("hashline", 5);
        assert_eq!(results[0].memory.name, "hashline-parity");
    }

    #[test]
    fn recall_ranks_by_relevance_not_recency() {
        let storage = seeded();
        // The newest memory is `prefers-dotenv`; a query about heredocs must
        // still return the heredoc memory first.
        let results = storage.recall("heredoc backslash", 5);
        assert_eq!(results[0].memory.name, "no-heredocs-for-regex");
    }

    #[test]
    fn a_repeated_name_supersedes_rather_than_duplicating() {
        let mut storage = seeded();
        storage
            .remember(Kind::User, "prefers-dotenv", "Updated description", "New body.")
            .unwrap();

        assert_eq!(storage.all().iter().filter(|m| m.name == "prefers-dotenv").count(), 1);
        assert_eq!(storage.get("prefers-dotenv").unwrap().text, "New body.");
        assert!(storage.get("prefers-dotenv").unwrap().supersedes.is_some());
    }

    #[test]
    fn a_superseded_memory_stops_matching() {
        let mut storage = Storage::ephemeral();
        storage.remember(Kind::Project, "thing", "d", "the original zebra text").unwrap();
        storage.remember(Kind::Project, "thing", "d", "the replacement text").unwrap();
        assert!(storage.recall("zebra", 5).is_empty());
    }

    #[test]
    fn forgetting_removes_it_from_recall() {
        let mut storage = seeded();
        assert!(storage.forget("hashline-parity").unwrap());
        assert!(storage.recall("hashline", 5).is_empty());
        assert!(storage.get("hashline-parity").is_none());
        // Forgetting something that was never there is not an error.
        assert!(!storage.forget("never-existed").unwrap());
    }

    #[test]
    fn a_memory_needs_a_name_and_a_body() {
        let mut storage = Storage::ephemeral();
        assert!(storage.remember(Kind::User, "", "d", "body").is_err());
        assert!(storage.remember(Kind::User, "name", "d", "   ").is_err());
    }

    #[test]
    fn links_are_extracted_and_resolved() {
        let mut storage = seeded();
        assert_eq!(
            storage.get("hashline-parity").unwrap().links,
            vec!["dual-implementation".to_string()]
        );
        // The target does not exist yet, which is fine and worth reporting.
        assert_eq!(storage.dangling_links(), vec!["dual-implementation".to_string()]);
        assert!(storage.linked("hashline-parity").is_empty());

        storage.remember(Kind::Project, "dual-implementation", "d", "Now it exists.").unwrap();
        assert_eq!(storage.linked("hashline-parity").len(), 1);
        assert!(storage.dangling_links().is_empty());
    }

    #[test]
    fn an_unclosed_link_is_not_a_link() {
        assert!(extract_links("see [[unclosed").is_empty());
        assert_eq!(extract_links("see [[a]] and [[b]]"), vec!["a", "b"]);
        // A repeated link is one link.
        assert_eq!(extract_links("[[a]] and [[a]]"), vec!["a"]);
    }

    #[test]
    fn persists_and_reloads() {
        let path = temp();
        {
            let mut storage = Storage::open(&path).unwrap();
            storage.remember(Kind::Project, "persisted", "A description", "The body text.").unwrap();
        }

        let reopened = Storage::open(&path).unwrap();
        assert_eq!(reopened.len(), 1);
        let memory = reopened.get("persisted").unwrap();
        assert_eq!(memory.text, "The body text.");
        assert_eq!(memory.description, "A description");
        assert!(!reopened.recall("body", 5).is_empty());

        fs::remove_file(&path).ok();
    }

    #[test]
    fn a_forget_survives_a_reload() {
        let path = temp();
        {
            let mut storage = Storage::open(&path).unwrap();
            storage.remember(Kind::Project, "temporary", "d", "zebra content").unwrap();
            storage.forget("temporary").unwrap();
        }

        let reopened = Storage::open(&path).unwrap();
        assert!(reopened.is_empty());
        assert!(reopened.recall("zebra", 5).is_empty());

        fs::remove_file(&path).ok();
    }

    #[test]
    fn a_multiline_body_round_trips() {
        let path = temp();
        let body = "First line.\n\nA second paragraph with a blank line above it.\n- a list item";
        {
            let mut storage = Storage::open(&path).unwrap();
            storage.remember(Kind::Project, "multi", "d", body).unwrap();
        }

        let reopened = Storage::open(&path).unwrap();
        assert_eq!(reopened.get("multi").unwrap().text, body);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn a_malformed_record_does_not_lose_the_rest() {
        let path = temp();
        {
            let mut storage = Storage::open(&path).unwrap();
            storage.remember(Kind::Project, "good", "d", "content").unwrap();
        }
        // Append garbage, as a partial write would leave.
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"---\nthis is not a record\n")
            .unwrap();

        let reopened = Storage::open(&path).unwrap();
        assert_eq!(reopened.len(), 1);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn compaction_drops_superseded_records_from_the_file() {
        let path = temp();
        let mut storage = Storage::open(&path).unwrap();
        for round in 0..5 {
            storage.remember(Kind::Project, "churned", "d", &format!("version {round}")).unwrap();
        }

        let before = fs::read_to_string(&path).unwrap().len();
        let removed = storage.compact().unwrap();
        let after = fs::read_to_string(&path).unwrap().len();

        assert_eq!(removed, 4);
        assert!(after < before);
        assert_eq!(Storage::open(&path).unwrap().len(), 1);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn filtering_by_kind() {
        let storage = seeded();
        assert_eq!(storage.of_kind(Kind::User).len(), 1);
        assert_eq!(storage.of_kind(Kind::Feedback).len(), 1);
        assert!(storage.of_kind(Kind::Reference).is_empty());
    }

    #[test]
    fn the_index_renders_one_line_per_memory() {
        let storage = seeded();
        let rendered = render_index(&storage.all());
        assert_eq!(rendered.lines().count(), 3);
        assert!(rendered.contains("[project] hashline-parity"));
    }

    #[test]
    fn a_description_with_a_newline_cannot_break_the_format() {
        let path = temp();
        {
            let mut storage = Storage::open(&path).unwrap();
            storage
                .remember(Kind::Project, "tricky", "line one\nname: injected", "body")
                .unwrap();
        }

        let reopened = Storage::open(&path).unwrap();
        assert_eq!(reopened.get("tricky").unwrap().name, "tricky");

        fs::remove_file(&path).ok();
    }
}

#[cfg(test)]
mod scope_tests {
    use super::*;

    #[test]
    fn project_and_source_survive_a_reload() {
        let path = std::env::temp_dir().join(format!(
            "mnemopi-scope-{}.log",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        {
            let mut storage = Storage::open(&path).unwrap();
            let id = storage
                .remember_scoped(Kind::Pattern, "flaky-fix", "How the flaky test was fixed", "Pin TZ=UTC.", Some("D:/proj"), Some("session-1"))
                .unwrap();
            assert_eq!(storage.get_id(id).unwrap().kind, Kind::Pattern);
        }
        let mut storage = Storage::open(&path).unwrap();
        let memory = storage.get("flaky-fix").unwrap().clone();
        assert_eq!(memory.project.as_deref(), Some("D:/proj"));
        assert_eq!(memory.source.as_deref(), Some("session-1"));
        assert!(storage.forget_id(memory.id).unwrap());
        assert!(storage.get_id(memory.id).is_none());
        fs::remove_file(&path).ok();
    }
}
