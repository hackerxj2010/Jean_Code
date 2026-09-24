//! The LSP data types an agent reads, and how to read each one from what
//! servers actually send.
//!
//! The specification allows several shapes for most results — a definition
//! is a `Location`, a `Location[]`, or a `LocationLink[]`; hover contents are
//! a string, a `MarkedString`, an array of either, or `MarkupContent` — and
//! real servers use all of them. Each `parse` here accepts every legal shape,
//! because the alternative is an answer that silently comes back empty for
//! one language and not another.

use crate::json::{array, int, object, optional, string, Json, JsonExt};
use crate::uri;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Position {
    /// Zero-based.
    pub line: u32,
    /// Zero-based, in UTF-16 code units — the encoding this client negotiates.
    pub character: u32,
}

impl Position {
    pub fn new(line: u32, character: u32) -> Self {
        Position { line, character }
    }

    pub fn parse(value: &Json) -> Option<Position> {
        Some(Position { line: value.u32_at("line")?, character: value.u32_at("character")? })
    }

    pub fn to_json(self) -> Json {
        object([("line", int(self.line.into())), ("character", int(self.character.into()))])
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

impl Range {
    pub fn new(start: Position, end: Position) -> Self {
        Range { start, end }
    }

    /// The whole of line `line`, as far as any server cares.
    pub fn line(line: u32) -> Self {
        Range { start: Position::new(line, 0), end: Position::new(line, u32::MAX / 2) }
    }

    pub fn parse(value: &Json) -> Option<Range> {
        Some(Range { start: Position::parse(value.at("start")?)?, end: Position::parse(value.at("end")?)? })
    }

    pub fn to_json(self) -> Json {
        object([("start", self.start.to_json()), ("end", self.end.to_json())])
    }

    pub fn contains(&self, position: Position) -> bool {
        self.start <= position && position <= self.end
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Location {
    pub path: PathBuf,
    pub range: Range,
}

impl Location {
    /// A `Location` or a `LocationLink`. For a link, the selection range —
    /// the name itself — rather than the whole declaration.
    pub fn parse(value: &Json) -> Option<Location> {
        if let Some(target) = value.str_at("targetUri") {
            let range = value.at("targetSelectionRange").or_else(|| value.at("targetRange")).and_then(Range::parse)?;
            return Some(Location { path: uri::uri_to_path(target), range });
        }
        let path = uri::uri_to_path(value.str_at("uri")?);
        // A `WorkspaceSymbol` may carry a location with no range at all.
        let range = value.at("range").and_then(Range::parse).unwrap_or_default();
        Some(Location { path, range })
    }

    /// `null`, one location, or an array of locations or links.
    pub fn parse_many(value: &Json) -> Vec<Location> {
        match value {
            Json::Array(items) => items.iter().filter_map(Location::parse).collect(),
            Json::Null => Vec::new(),
            single => Location::parse(single).into_iter().collect(),
        }
    }

    pub fn to_json(&self) -> Json {
        object([
            ("path", string(self.path.to_string_lossy())),
            ("range", self.range.to_json()),
        ])
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    Error,
    Warning,
    Information,
    Hint,
}

impl Severity {
    pub fn from_number(value: Option<u32>) -> Severity {
        match value {
            Some(2) => Severity::Warning,
            Some(3) => Severity::Information,
            Some(4) => Severity::Hint,
            // Absent means the client decides; an unlabeled problem is treated
            // as the one worth fixing.
            _ => Severity::Error,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Information => "information",
            Severity::Hint => "hint",
        }
    }

    pub fn parse_label(text: &str) -> Option<Severity> {
        match text {
            "error" => Some(Severity::Error),
            "warning" => Some(Severity::Warning),
            "information" | "info" => Some(Severity::Information),
            "hint" => Some(Severity::Hint),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    pub path: PathBuf,
    pub range: Range,
    pub severity: Severity,
    pub message: String,
    pub source: Option<String>,
    pub code: Option<String>,
    /// Which server reported it — two servers on one file is normal
    /// (a type checker and a linter), and the agent should know which spoke.
    pub server: String,
    pub tags: Vec<&'static str>,
    pub related: Vec<(Location, String)>,
    /// The raw diagnostic, returned in a code action request so the server can
    /// match the fix to the problem.
    pub raw: Json,
}

impl Diagnostic {
    pub fn parse(value: &Json, path: PathBuf, server: &str) -> Option<Diagnostic> {
        let code = match value.at("code") {
            Some(Json::String(text)) => Some(text.clone()),
            Some(Json::Number(number)) => Some(crate::json::Json::Number(*number).to_compact()),
            _ => None,
        };
        let tags = value
            .at("tags")
            .map(|tags| {
                tags.items()
                    .iter()
                    .filter_map(|tag| match tag.as_f64() {
                        Some(1.0) => Some("unnecessary"),
                        Some(2.0) => Some("deprecated"),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let related = value
            .at("relatedInformation")
            .map(|items| {
                items
                    .items()
                    .iter()
                    .filter_map(|item| Some((Location::parse(item.at("location")?)?, item.str_at("message")?.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        Some(Diagnostic {
            path,
            range: Range::parse(value.at("range")?)?,
            severity: Severity::from_number(value.u32_at("severity")),
            message: value.str_at("message")?.to_string(),
            source: value.str_at("source").map(String::from),
            code,
            server: server.to_string(),
            tags,
            related,
            raw: value.clone(),
        })
    }

    pub fn to_json(&self) -> Json {
        object([
            ("path", string(self.path.to_string_lossy())),
            ("range", self.range.to_json()),
            ("severity", string(self.severity.label())),
            ("message", string(&self.message)),
            ("source", optional(self.source.clone().map(string))),
            ("code", optional(self.code.clone().map(string))),
            ("server", string(&self.server)),
            ("tags", array(self.tags.iter().map(|tag| string(*tag)))),
            (
                "related",
                array(self.related.iter().map(|(location, message)| {
                    object([("location", location.to_json()), ("message", string(message))])
                })),
            ),
        ])
    }
}

const SYMBOL_KINDS: [&str; 26] = [
    "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum",
    "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key",
    "null", "enum member", "struct", "event", "operator", "type parameter",
];

pub fn symbol_kind(number: Option<u32>) -> &'static str {
    number.and_then(|n| SYMBOL_KINDS.get((n as usize).wrapping_sub(1)).copied()).unwrap_or("symbol")
}

const COMPLETION_KINDS: [&str; 25] = [
    "text", "method", "function", "constructor", "field", "variable", "class", "interface", "module", "property",
    "unit", "value", "enum", "keyword", "snippet", "color", "file", "reference", "folder", "enum member",
    "constant", "struct", "event", "operator", "type parameter",
];

pub fn completion_kind(number: Option<u32>) -> &'static str {
    number.and_then(|n| COMPLETION_KINDS.get((n as usize).wrapping_sub(1)).copied()).unwrap_or("text")
}

#[derive(Clone, Debug, PartialEq)]
pub struct Symbol {
    pub name: String,
    pub kind: &'static str,
    pub detail: Option<String>,
    pub container: Option<String>,
    pub path: PathBuf,
    /// The whole declaration.
    pub range: Range,
    /// The name within it.
    pub selection: Range,
    /// Nesting depth in a hierarchical outline: members sit under their type.
    pub depth: u32,
}

impl Symbol {
    pub fn to_json(&self) -> Json {
        object([
            ("name", string(&self.name)),
            ("kind", string(self.kind)),
            ("detail", optional(self.detail.clone().map(string))),
            ("container", optional(self.container.clone().map(string))),
            ("path", string(self.path.to_string_lossy())),
            ("range", self.range.to_json()),
            ("selection", self.selection.to_json()),
            ("depth", int(self.depth.into())),
        ])
    }
}

fn flatten_document_symbol(value: &Json, path: &PathBuf, container: Option<&str>, depth: u32, out: &mut Vec<Symbol>) {
    let Some(name) = value.str_at("name") else { return };
    let Some(range) = value.at("range").and_then(Range::parse) else { return };
    let selection = value.at("selectionRange").and_then(Range::parse).unwrap_or(range);
    out.push(Symbol {
        name: name.to_string(),
        kind: symbol_kind(value.u32_at("kind")),
        detail: value.str_at("detail").filter(|d| !d.is_empty()).map(String::from),
        container: container.map(String::from),
        path: path.clone(),
        range,
        selection,
        depth,
    });
    for child in value.at("children").map(JsonExt::items).unwrap_or(&[]) {
        flatten_document_symbol(child, path, Some(name), depth + 1, out);
    }
}

/// `textDocument/documentSymbol`: hierarchical `DocumentSymbol[]` flattened in
/// source order with depths, or the flat `SymbolInformation[]` older servers
/// send.
pub fn parse_document_symbols(value: &Json, path: &PathBuf) -> Vec<Symbol> {
    let mut out = Vec::new();
    for item in value.items() {
        if item.at("location").is_some() {
            if let Some(symbol) = parse_symbol_information(item) {
                out.push(symbol);
            }
        } else {
            flatten_document_symbol(item, path, None, 0, &mut out);
        }
    }
    out
}

fn parse_symbol_information(value: &Json) -> Option<Symbol> {
    let location = Location::parse(value.at("location")?)?;
    Some(Symbol {
        name: value.str_at("name")?.to_string(),
        kind: symbol_kind(value.u32_at("kind")),
        detail: None,
        container: value.str_at("containerName").filter(|c| !c.is_empty()).map(String::from),
        path: location.path,
        range: location.range,
        selection: location.range,
        depth: 0,
    })
}

/// `workspace/symbol`: `SymbolInformation[]` or `WorkspaceSymbol[]`.
pub fn parse_workspace_symbols(value: &Json) -> Vec<Symbol> {
    value.items().iter().filter_map(parse_symbol_information).collect()
}

/// Plain text from `string | MarkupContent`.
pub fn documentation_text(value: Option<&Json>) -> Option<String> {
    match value? {
        Json::String(text) => Some(text.clone()),
        Json::Object(_) => value?.str_at("value").map(String::from),
        _ => None,
    }
    .filter(|text| !text.trim().is_empty())
}

fn marked(value: &Json) -> Option<String> {
    match value {
        Json::String(text) => Some(text.clone()),
        Json::Object(_) => {
            let text = value.str_at("value")?;
            match value.str_at("language") {
                Some(language) => Some(format!("```{language}\n{text}\n```")),
                // MarkupContent: `{ kind, value }`.
                None => Some(text.to_string()),
            }
        }
        _ => None,
    }
}

/// The text of a hover: every shape the specification allows, joined.
pub fn hover_text(value: &Json) -> Option<String> {
    let contents = value.at("contents")?;
    let text = match contents {
        Json::Array(items) => items.iter().filter_map(marked).collect::<Vec<_>>().join("\n\n"),
        other => marked(other)?,
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompletionItem {
    pub label: String,
    pub kind: &'static str,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub deprecated: bool,
}

impl CompletionItem {
    pub fn to_json(&self) -> Json {
        object([
            ("label", string(&self.label)),
            ("kind", string(self.kind)),
            ("detail", optional(self.detail.clone().map(string))),
            ("documentation", optional(self.documentation.clone().map(string))),
            ("deprecated", Json::Bool(self.deprecated)),
        ])
    }
}

/// `CompletionItem[]` or `CompletionList`, in the server's order — which is
/// its ranking — unless it supplies `sortText`, which then decides.
pub fn parse_completions(value: &Json) -> Vec<CompletionItem> {
    let items = match value {
        Json::Array(items) => items.as_slice(),
        other => other.at("items").map(JsonExt::items).unwrap_or(&[]),
    };
    let mut ranked: Vec<(String, CompletionItem)> = items
        .iter()
        .filter_map(|item| {
            let label = item.str_at("label")?.to_string();
            let sort = item.str_at("sortText").unwrap_or(&label).to_string();
            let detail = item
                .str_at("detail")
                .map(String::from)
                .or_else(|| item.str_at("labelDetails.description").map(String::from));
            Some((
                sort,
                CompletionItem {
                    label,
                    kind: completion_kind(item.u32_at("kind")),
                    detail,
                    documentation: documentation_text(item.at("documentation")),
                    deprecated: item.bool_at("deprecated").unwrap_or(false)
                        || item.at("tags").is_some_and(|tags| tags.items().iter().any(|t| t.as_f64() == Some(1.0))),
                },
            ))
        })
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0));
    ranked.into_iter().map(|(_, item)| item).collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Signature {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<String>,
    pub active: bool,
    pub active_parameter: Option<u32>,
}

/// `SignatureHelp`, with parameter labels resolved from their offsets.
pub fn parse_signatures(value: &Json) -> Vec<Signature> {
    let active_signature = value.u32_at("activeSignature").unwrap_or(0);
    let shared_parameter = value.u32_at("activeParameter");
    value
        .at("signatures")
        .map(JsonExt::items)
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .filter_map(|(index, signature)| {
            let label = signature.str_at("label")?.to_string();
            let parameters = signature
                .at("parameters")
                .map(JsonExt::items)
                .unwrap_or(&[])
                .iter()
                .filter_map(|parameter| match parameter.at("label")? {
                    Json::String(text) => Some(text.clone()),
                    // `[start, end]` in UTF-16 units into the signature label.
                    Json::Array(bounds) => {
                        let start = bounds.first()?.as_f64()? as usize;
                        let end = bounds.get(1)?.as_f64()? as usize;
                        let units: Vec<u16> = label.encode_utf16().collect();
                        Some(String::from_utf16_lossy(units.get(start..end.min(units.len()))?))
                    }
                    _ => None,
                })
                .collect();
            Some(Signature {
                label,
                documentation: documentation_text(signature.at("documentation")),
                parameters,
                active: index as u32 == active_signature,
                active_parameter: signature.u32_at("activeParameter").or(shared_parameter),
            })
        })
        .collect()
}

impl Signature {
    pub fn to_json(&self) -> Json {
        object([
            ("label", string(&self.label)),
            ("documentation", optional(self.documentation.clone().map(string))),
            ("parameters", array(self.parameters.iter().map(string))),
            ("active", Json::Bool(self.active)),
            ("activeParameter", optional(self.active_parameter.map(|n| int(n.into())))),
        ])
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub preferred: bool,
    /// Why the server offers but will not apply it, when it says.
    pub disabled: Option<String>,
    pub has_edit: bool,
    pub has_command: bool,
    /// The action as sent, needed to resolve and apply it later.
    pub raw: Json,
}

/// `(Command | CodeAction)[]`.
pub fn parse_code_actions(value: &Json) -> Vec<CodeAction> {
    value
        .items()
        .iter()
        .filter_map(|item| {
            let title = item.str_at("title")?.to_string();
            // A bare `Command` has a string `command`; a `CodeAction` has an
            // object there, or none.
            let bare_command = matches!(item.at("command"), Some(Json::String(_)));
            Some(CodeAction {
                title,
                kind: item.str_at("kind").map(String::from),
                preferred: item.bool_at("isPreferred").unwrap_or(false),
                disabled: item.str_at("disabled.reason").map(String::from),
                has_edit: item.at("edit").is_some(),
                has_command: bare_command || item.at("command").is_some(),
                raw: item.clone(),
            })
        })
        .collect()
}

impl CodeAction {
    pub fn to_json(&self) -> Json {
        object([
            ("title", string(&self.title)),
            ("kind", optional(self.kind.clone().map(string))),
            ("preferred", Json::Bool(self.preferred)),
            ("disabled", optional(self.disabled.clone().map(string))),
        ])
    }
}

/// A call or type hierarchy item.
#[derive(Clone, Debug, PartialEq)]
pub struct HierarchyItem {
    pub name: String,
    pub kind: &'static str,
    pub detail: Option<String>,
    pub path: PathBuf,
    pub range: Range,
    pub selection: Range,
    /// Sent back verbatim for the follow-up request.
    pub raw: Json,
}

impl HierarchyItem {
    pub fn parse(value: &Json) -> Option<HierarchyItem> {
        Some(HierarchyItem {
            name: value.str_at("name")?.to_string(),
            kind: symbol_kind(value.u32_at("kind")),
            detail: value.str_at("detail").map(String::from),
            path: uri::uri_to_path(value.str_at("uri")?),
            range: Range::parse(value.at("range")?)?,
            selection: value.at("selectionRange").and_then(Range::parse).unwrap_or_default(),
            raw: value.clone(),
        })
    }

    pub fn to_json(&self) -> Json {
        object([
            ("name", string(&self.name)),
            ("kind", string(self.kind)),
            ("detail", optional(self.detail.clone().map(string))),
            ("path", string(self.path.to_string_lossy())),
            ("range", self.range.to_json()),
            ("selection", self.selection.to_json()),
        ])
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct InlayHint {
    pub position: Position,
    pub label: String,
    pub kind: Option<&'static str>,
}

pub fn parse_inlay_hints(value: &Json) -> Vec<InlayHint> {
    value
        .items()
        .iter()
        .filter_map(|hint| {
            let label = match hint.at("label")? {
                Json::String(text) => text.clone(),
                Json::Array(parts) => parts.iter().filter_map(|part| part.str_at("value")).collect::<String>(),
                _ => return None,
            };
            Some(InlayHint {
                position: Position::parse(hint.at("position")?)?,
                label,
                kind: match hint.u32_at("kind") {
                    Some(1) => Some("type"),
                    Some(2) => Some("parameter"),
                    _ => None,
                },
            })
        })
        .collect()
}

impl InlayHint {
    pub fn to_json(&self) -> Json {
        object([
            ("position", self.position.to_json()),
            ("label", string(&self.label)),
            ("kind", optional(self.kind.map(string))),
        ])
    }
}

/// `textDocument/documentHighlight`: where a symbol is read and written in
/// one file.
pub fn parse_highlights(value: &Json) -> Vec<(Range, &'static str)> {
    value
        .items()
        .iter()
        .filter_map(|item| {
            let kind = match item.u32_at("kind") {
                Some(2) => "read",
                Some(3) => "write",
                _ => "text",
            };
            Some((Range::parse(item.at("range")?)?, kind))
        })
        .collect()
}

/// `textDocument/codeLens`: the annotations an editor draws above lines —
/// "12 references", "Run test".
pub fn parse_code_lenses(value: &Json) -> Vec<(Range, Option<String>)> {
    value
        .items()
        .iter()
        .filter_map(|item| Some((Range::parse(item.at("range")?)?, item.str_at("command.title").map(String::from))))
        .collect()
}

/// `textDocument/foldingRange` as `(start line, end line, kind)`.
pub fn parse_folding_ranges(value: &Json) -> Vec<(u32, u32, Option<String>)> {
    value
        .items()
        .iter()
        .filter_map(|item| Some((item.u32_at("startLine")?, item.u32_at("endLine")?, item.str_at("kind").map(String::from))))
        .collect()
}

/// Semantic tokens decoded against the server's legend, as
/// `(line, character, length, type, modifiers)`.
pub fn decode_semantic_tokens(value: &Json, legend: &Json) -> Vec<(u32, u32, u32, String, Vec<String>)> {
    let types: Vec<&str> = legend.at("tokenTypes").map(JsonExt::items).unwrap_or(&[]).iter().filter_map(Json::as_str).collect();
    let modifiers: Vec<&str> =
        legend.at("tokenModifiers").map(JsonExt::items).unwrap_or(&[]).iter().filter_map(Json::as_str).collect();
    let data: Vec<u32> = value.at("data").map(JsonExt::items).unwrap_or(&[]).iter().filter_map(|n| n.as_f64().map(|v| v as u32)).collect();

    let mut out = Vec::with_capacity(data.len() / 5);
    let (mut line, mut character) = (0u32, 0u32);
    for chunk in data.chunks_exact(5) {
        let (delta_line, delta_start, length, kind, bits) = (chunk[0], chunk[1], chunk[2], chunk[3], chunk[4]);
        if delta_line > 0 {
            line += delta_line;
            character = delta_start;
        } else {
            character += delta_start;
        }
        let names = (0..32)
            .filter(|bit| bits & (1 << bit) != 0)
            .filter_map(|bit| modifiers.get(bit as usize).map(|m| m.to_string()))
            .collect();
        out.push((line, character, length, types.get(kind as usize).unwrap_or(&"unknown").to_string(), names));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::literal;

    #[test]
    fn definitions_come_in_three_shapes() {
        let single = literal(r#"{"uri":"file:///a.ts","range":{"start":{"line":1,"character":2},"end":{"line":1,"character":5}}}"#);
        assert_eq!(Location::parse_many(&single).len(), 1);
        let links = literal(
            r#"[{"targetUri":"file:///b.ts","targetRange":{"start":{"line":0,"character":0},"end":{"line":9,"character":1}},"targetSelectionRange":{"start":{"line":3,"character":4},"end":{"line":3,"character":8}}}]"#,
        );
        let parsed = Location::parse_many(&links);
        assert_eq!(parsed[0].range.start, Position::new(3, 4), "the name, not the whole declaration");
        assert!(Location::parse_many(&Json::Null).is_empty());
    }

    #[test]
    fn hover_reads_every_legal_shape() {
        assert_eq!(hover_text(&literal(r#"{"contents":{"kind":"markdown","value":"**x**"}}"#)).unwrap(), "**x**");
        assert_eq!(
            hover_text(&literal(r#"{"contents":[{"language":"ts","value":"let x: number"},"doc"]}"#)).unwrap(),
            "```ts\nlet x: number\n```\n\ndoc"
        );
        assert!(hover_text(&literal(r#"{"contents":""}"#)).is_none());
    }

    #[test]
    fn document_symbols_flatten_with_depth_and_container() {
        let value = literal(
            r#"[{"name":"Store","kind":5,"range":{"start":{"line":0,"character":0},"end":{"line":9,"character":1}},"selectionRange":{"start":{"line":0,"character":6},"end":{"line":0,"character":11}},"children":[{"name":"get","kind":6,"range":{"start":{"line":1,"character":2},"end":{"line":1,"character":10}},"selectionRange":{"start":{"line":1,"character":2},"end":{"line":1,"character":5}}}]}]"#,
        );
        let symbols = parse_document_symbols(&value, &PathBuf::from("/a.ts"));
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[1].container.as_deref(), Some("Store"));
        assert_eq!(symbols[1].depth, 1);
        assert_eq!(symbols[1].kind, "method");
    }

    #[test]
    fn signature_parameter_offsets_count_utf16() {
        let value = literal(r#"{"signatures":[{"label":"f(é: number, b)","parameters":[{"label":[2,11]},{"label":"b"}]}],"activeParameter":1}"#);
        let signatures = parse_signatures(&value);
        assert_eq!(signatures[0].parameters, vec!["é: number".to_string(), "b".to_string()]);
        assert_eq!(signatures[0].active_parameter, Some(1));
    }

    #[test]
    fn semantic_tokens_decode_relative_positions() {
        let legend = literal(r#"{"tokenTypes":["variable","function"],"tokenModifiers":["declaration","readonly"]}"#);
        let tokens = decode_semantic_tokens(&literal(r#"{"data":[0,4,3,0,1, 0,6,2,1,0, 2,1,4,0,3]}"#), &legend);
        assert_eq!(tokens[0], (0, 4, 3, "variable".into(), vec!["declaration".into()]));
        assert_eq!(tokens[1].1, 10);
        assert_eq!(tokens[2], (2, 1, 4, "variable".into(), vec!["declaration".into(), "readonly".into()]));
    }
}
