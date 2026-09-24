//! Applying a `WorkspaceEdit` to the files on disk.
//!
//! A rename, a code action, or a file move comes back from the server as a
//! workspace edit: text edits across many files, sometimes file creations,
//! renames, and deletions too. Applying half of one leaves a project that
//! compiles under neither name, so the whole edit is computed first, against
//! an overlay of the files it touches, and written only if every part of it
//! applies.

use crate::json::{Json, JsonExt};
use crate::protocol::Range;
use crate::text::{apply_edits, TextEdit};
use crate::uri;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Modified,
    Created,
    Renamed { from: PathBuf },
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChange {
    pub path: PathBuf,
    pub kind: ChangeKind,
    /// Text edits applied to this file.
    pub edits: usize,
    /// A unified diff of the file, for a preview.
    pub diff: String,
}

impl FileChange {
    pub fn to_json(&self) -> Json {
        use crate::json::{int, object, string};
        let (kind, from) = match &self.kind {
            ChangeKind::Modified => ("modified", None),
            ChangeKind::Created => ("created", None),
            ChangeKind::Renamed { from } => ("renamed", Some(from)),
            ChangeKind::Deleted => ("deleted", None),
        };
        object([
            ("path", string(self.path.to_string_lossy())),
            ("kind", string(kind)),
            ("from", from.map_or(Json::Null, |from| string(from.to_string_lossy()))),
            ("edits", int(self.edits as i64)),
            ("diff", string(&self.diff)),
        ])
    }
}

/// The files an edit touches, as they would be after it: `Some(text)` for a
/// file that exists, `None` for one deleted.
struct Overlay {
    files: HashMap<PathBuf, Option<String>>,
    /// Paths in first-touched order, so results read in the edit's order.
    order: Vec<PathBuf>,
    original: HashMap<PathBuf, Option<String>>,
    edits: HashMap<PathBuf, usize>,
    renamed: HashMap<PathBuf, PathBuf>,
    directory_moves: Vec<(PathBuf, PathBuf)>,
}

impl Overlay {
    fn new() -> Self {
        Overlay {
            files: HashMap::new(),
            order: Vec::new(),
            original: HashMap::new(),
            edits: HashMap::new(),
            renamed: HashMap::new(),
            directory_moves: Vec::new(),
        }
    }

    fn touch(&mut self, path: &Path) {
        if !self.files.contains_key(path) {
            let content = fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).to_string());
            self.original.insert(path.to_path_buf(), content.clone());
            self.files.insert(path.to_path_buf(), content);
            self.order.push(path.to_path_buf());
        }
    }

    fn get(&mut self, path: &Path) -> Option<String> {
        self.touch(path);
        self.files.get(path).cloned().flatten()
    }

    fn set(&mut self, path: &Path, content: Option<String>) {
        self.touch(path);
        self.files.insert(path.to_path_buf(), content);
    }
}

fn text_edits(value: &Json) -> Vec<TextEdit> {
    value.items().iter().filter_map(TextEdit::parse).collect()
}

fn apply_to(overlay: &mut Overlay, path: &Path, edits: &[TextEdit]) -> Result<(), String> {
    let Some(current) = overlay.get(path) else {
        return Err(format!("{} does not exist", path.display()));
    };
    let next = apply_edits(&current, edits).map_err(|error| format!("{}: {error}", path.display()))?;
    overlay.set(path, Some(next));
    *overlay.edits.entry(path.to_path_buf()).or_default() += edits.len();
    Ok(())
}

fn flag(value: &Json, key: &str) -> bool {
    value.bool_at(&format!("options.{key}")).unwrap_or(false)
}

/// Applies a `WorkspaceEdit` — to disk when `write`, or only as a preview.
///
/// Returns what changed (or would change), each file with a diff.
pub fn apply_workspace_edit(edit: &Json, write: bool) -> Result<Vec<FileChange>, String> {
    let mut overlay = Overlay::new();

    if let Some(Json::Array(operations)) = edit.at("documentChanges") {
        for operation in operations {
            match operation.str_at("kind") {
                Some("create") => {
                    let path = uri::uri_to_path(operation.str_at("uri").ok_or("create without a uri")?);
                    let exists = overlay.get(&path).is_some();
                    if exists && !flag(operation, "overwrite") {
                        if flag(operation, "ignoreIfExists") {
                            continue;
                        }
                        return Err(format!("{} already exists", path.display()));
                    }
                    overlay.set(&path, Some(String::new()));
                }
                Some("rename") => {
                    let from = uri::uri_to_path(operation.str_at("oldUri").ok_or("rename without oldUri")?);
                    let to = uri::uri_to_path(operation.str_at("newUri").ok_or("rename without newUri")?);
                    if from.is_dir() {
                        overlay.directory_moves.push((from, to));
                        continue;
                    }
                    let Some(content) = overlay.get(&from) else {
                        return Err(format!("{} does not exist", from.display()));
                    };
                    if overlay.get(&to).is_some() && !flag(operation, "overwrite") {
                        if flag(operation, "ignoreIfExists") {
                            continue;
                        }
                        return Err(format!("{} already exists", to.display()));
                    }
                    overlay.set(&from, None);
                    overlay.set(&to, Some(content));
                    overlay.renamed.insert(to, from);
                }
                Some("delete") => {
                    let path = uri::uri_to_path(operation.str_at("uri").ok_or("delete without a uri")?);
                    if overlay.get(&path).is_none() && !path.is_dir() && !flag(operation, "ignoreIfNotExists") {
                        return Err(format!("{} does not exist", path.display()));
                    }
                    overlay.set(&path, None);
                }
                _ => {
                    let path = uri::uri_to_path(operation.str_at("textDocument.uri").ok_or("text edit without a document")?);
                    apply_to(&mut overlay, &path, &text_edits(operation.at("edits").unwrap_or(&Json::Null)))?;
                }
            }
        }
    } else if let Some(Json::Object(changes)) = edit.at("changes") {
        for (raw_uri, edits) in changes {
            apply_to(&mut overlay, &uri::uri_to_path(raw_uri), &text_edits(edits))?;
        }
    }

    // Everything applied in memory; now describe it, and write it if asked.
    let mut changes = Vec::new();
    for path in overlay.order.clone() {
        let before = overlay.original.get(&path).cloned().flatten();
        let after = overlay.files.get(&path).cloned().flatten();
        let kind = match (&before, &after, overlay.renamed.get(&path)) {
            (_, Some(_), Some(from)) => ChangeKind::Renamed { from: from.clone() },
            (None, Some(_), None) => ChangeKind::Created,
            (Some(_), None, _) => {
                // The source of a rename is reported by its destination.
                if overlay.renamed.values().any(|from| *from == path) {
                    continue;
                }
                ChangeKind::Deleted
            }
            (Some(old), Some(new), None) if old == new => continue,
            (Some(_), Some(_), None) => ChangeKind::Modified,
            (None, None, _) => continue,
        };
        let shown = path.to_string_lossy().to_string();
        let diff = pi_builtins::data::unified_diff(before.as_deref().unwrap_or(""), after.as_deref().unwrap_or(""), &shown, &shown, 2);
        changes.push(FileChange { edits: overlay.edits.get(&path).copied().unwrap_or(0), path, kind, diff });
    }
    for (from, to) in &overlay.directory_moves {
        changes.push(FileChange { path: to.clone(), kind: ChangeKind::Renamed { from: from.clone() }, edits: 0, diff: String::new() });
    }

    if write {
        for (from, to) in &overlay.directory_moves {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
            }
            fs::rename(from, to).map_err(|error| format!("{} -> {}: {error}", from.display(), to.display()))?;
        }
        for path in &overlay.order {
            let before = overlay.original.get(path).cloned().flatten();
            match overlay.files.get(path).cloned().flatten() {
                Some(after) if before.as_deref() != Some(after.as_str()) => {
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
                    }
                    fs::write(path, after).map_err(|error| format!("{}: {error}", path.display()))?;
                }
                None if before.is_some() => {
                    fs::remove_file(path).map_err(|error| format!("{}: {error}", path.display()))?;
                }
                None if path.is_dir() => {
                    fs::remove_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))?;
                }
                _ => {}
            }
        }
    }

    Ok(changes)
}

/// Applies plain text edits to one file — what formatting returns.
pub fn apply_text_edits(path: &Path, edits: &[Json], write: bool) -> Result<Option<FileChange>, String> {
    let before = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let parsed = text_edits(&Json::Array(edits.to_vec()));
    let after = apply_edits(&before, &parsed).map_err(|error| format!("{}: {error}", path.display()))?;
    if after == before {
        return Ok(None);
    }
    if write {
        fs::write(path, &after).map_err(|error| format!("{}: {error}", path.display()))?;
    }
    let shown = path.to_string_lossy().to_string();
    Ok(Some(FileChange {
        path: path.to_path_buf(),
        kind: ChangeKind::Modified,
        edits: parsed.len(),
        diff: pi_builtins::data::unified_diff(&before, &after, &shown, &shown, 2),
    }))
}

/// The range an edit covers, for callers listing where a rename lands.
pub fn edit_ranges(edit: &Json) -> Vec<(PathBuf, Range, String)> {
    let mut out = Vec::new();
    let mut push = |raw_uri: &str, edits: &Json| {
        for edit in text_edits(edits) {
            out.push((uri::uri_to_path(raw_uri), edit.range, edit.new_text));
        }
    };
    if let Some(Json::Array(operations)) = edit.at("documentChanges") {
        for operation in operations {
            if let (Some(raw_uri), Some(edits)) = (operation.str_at("textDocument.uri"), operation.at("edits")) {
                push(raw_uri, edits);
            }
        }
    } else if let Some(Json::Object(changes)) = edit.at("changes") {
        for (raw_uri, edits) in changes {
            push(raw_uri, edits);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::literal;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pi-lsp-edit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn uri_of(path: &Path) -> String {
        uri::path_to_uri(path)
    }

    #[test]
    fn a_rename_across_files_applies_everywhere() {
        let dir = scratch("rename");
        let a = dir.join("a.ts");
        let b = dir.join("b.ts");
        fs::write(&a, "export const oldName = 1\n").unwrap();
        fs::write(&b, "import { oldName } from './a'\nconsole.log(oldName)\n").unwrap();
        let edit = literal(&format!(
            r#"{{"changes":{{"{}":[{{"range":{{"start":{{"line":0,"character":13}},"end":{{"line":0,"character":20}}}},"newText":"newName"}}],"{}":[{{"range":{{"start":{{"line":0,"character":9}},"end":{{"line":0,"character":16}}}},"newText":"newName"}},{{"range":{{"start":{{"line":1,"character":12}},"end":{{"line":1,"character":19}}}},"newText":"newName"}}]}}}}"#,
            uri_of(&a),
            uri_of(&b)
        ));

        let preview = apply_workspace_edit(&edit, false).unwrap();
        assert_eq!(preview.len(), 2);
        assert!(fs::read_to_string(&a).unwrap().contains("oldName"), "a preview writes nothing");

        let applied = apply_workspace_edit(&edit, true).unwrap();
        assert_eq!(applied.iter().map(|c| c.edits).sum::<usize>(), 3);
        assert_eq!(fs::read_to_string(&b).unwrap(), "import { newName } from './a'\nconsole.log(newName)\n");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn document_changes_create_rename_and_edit_in_order() {
        let dir = scratch("ops");
        let old = dir.join("old.ts");
        let new = dir.join("sub/new.ts");
        let created = dir.join("created.ts");
        fs::write(&old, "let x = 1\n").unwrap();
        let edit = literal(&format!(
            r#"{{"documentChanges":[
                {{"kind":"rename","oldUri":"{}","newUri":"{}"}},
                {{"textDocument":{{"uri":"{}","version":null}},"edits":[{{"range":{{"start":{{"line":0,"character":4}},"end":{{"line":0,"character":5}}}},"newText":"y"}}]}},
                {{"kind":"create","uri":"{}"}},
                {{"textDocument":{{"uri":"{}","version":null}},"edits":[{{"range":{{"start":{{"line":0,"character":0}},"end":{{"line":0,"character":0}}}},"newText":"export {{}}\n"}}]}}
            ]}}"#,
            uri_of(&old),
            uri_of(&new),
            uri_of(&new),
            uri_of(&created),
            uri_of(&created)
        ));
        let changes = apply_workspace_edit(&edit, true).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(&new).unwrap(), "let y = 1\n");
        assert_eq!(fs::read_to_string(&created).unwrap(), "export {}\n");
        assert!(changes.iter().any(|c| matches!(&c.kind, ChangeKind::Renamed { from } if *from == old)));
        assert!(changes.iter().any(|c| c.kind == ChangeKind::Created));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failing_part_writes_nothing() {
        let dir = scratch("atomic");
        let a = dir.join("a.ts");
        fs::write(&a, "abcdef\n").unwrap();
        let missing = dir.join("missing.ts");
        let edit = literal(&format!(
            r#"{{"documentChanges":[
                {{"textDocument":{{"uri":"{}"}},"edits":[{{"range":{{"start":{{"line":0,"character":0}},"end":{{"line":0,"character":1}}}},"newText":"X"}}]}},
                {{"textDocument":{{"uri":"{}"}},"edits":[{{"range":{{"start":{{"line":0,"character":0}},"end":{{"line":0,"character":1}}}},"newText":"Y"}}]}}
            ]}}"#,
            uri_of(&a),
            uri_of(&missing)
        ));
        assert!(apply_workspace_edit(&edit, true).is_err());
        assert_eq!(fs::read_to_string(&a).unwrap(), "abcdef\n");
        fs::remove_dir_all(&dir).ok();
    }
}
