//! Positions in text, and applying edits to it.
//!
//! LSP positions count UTF-16 code units — a legacy of the editor it came
//! from — while Rust strings are UTF-8. A file with one `é` or one emoji
//! before an edit site is exactly where an off-by-one lands an edit in the
//! middle of the wrong token, so every conversion goes through here.

use crate::protocol::{Position, Range};

/// A text indexed by line, for position arithmetic.
///
/// Lines end at `\n`, `\r\n`, or a lone `\r`, as the specification says; the
/// terminator belongs to no line's content.
pub struct Lines<'a> {
    text: &'a str,
    /// Byte offset where each line starts.
    starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    pub fn new(text: &'a str) -> Self {
        let bytes = text.as_bytes();
        let mut starts = vec![0];
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\n' => starts.push(index + 1),
                b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                    starts.push(index + 2);
                    index += 1;
                }
                b'\r' => starts.push(index + 1),
                _ => {}
            }
            index += 1;
        }
        Lines { text, starts }
    }

    pub fn count(&self) -> usize {
        self.starts.len()
    }

    /// A line's content, without its terminator. Past the end: empty.
    pub fn line(&self, line: usize) -> &'a str {
        let Some(&start) = self.starts.get(line) else { return "" };
        let end = self.starts.get(line + 1).copied().unwrap_or(self.text.len());
        self.text[start..end].trim_end_matches(['\n', '\r'])
    }

    /// The byte offset of a position, clamped: past the end of a line is its
    /// end, past the last line is the end of the text. Servers do send both.
    pub fn offset(&self, position: Position) -> usize {
        let line = position.line as usize;
        if line >= self.starts.len() {
            return self.text.len();
        }
        let start = self.starts[line];
        start + utf16_to_byte(self.line(line), position.character)
    }

    /// The position of a byte offset.
    pub fn position(&self, offset: usize) -> Position {
        let offset = offset.min(self.text.len());
        let line = match self.starts.binary_search(&offset) {
            Ok(line) => line,
            Err(next) => next - 1,
        };
        let content = self.line(line);
        let within = (offset - self.starts[line]).min(content.len());
        Position::new(line as u32, byte_to_utf16(content, within))
    }
}

/// The byte index of a UTF-16 column within one line, clamped to its end.
pub fn utf16_to_byte(line: &str, column: u32) -> usize {
    let mut units = 0u32;
    for (index, character) in line.char_indices() {
        if units >= column {
            return index;
        }
        units += character.len_utf16() as u32;
    }
    line.len()
}

/// The UTF-16 column of a byte index within one line.
pub fn byte_to_utf16(line: &str, byte: usize) -> u32 {
    let mut end = byte.min(line.len());
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line[..end].encode_utf16().count() as u32
}

/// Where `symbol` sits on `line`, as a position *inside* it.
///
/// The middle of the token rather than its first character: servers resolve a
/// position inside an identifier reliably, while the first character can land
/// on the preceding punctuation. A whole-word occurrence is preferred over a
/// substring match, so `id` finds `id` and not the `id` inside `width`.
/// `occurrence` picks the nth match (zero-based) when a line has several.
pub fn symbol_position(text: &str, line: u32, symbol: &str, occurrence: usize) -> Option<Position> {
    if symbol.is_empty() {
        return None;
    }
    let lines = Lines::new(text);
    if line as usize >= lines.count() {
        return None;
    }
    let content = lines.line(line as usize);
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$';

    let all: Vec<usize> = content.match_indices(symbol).map(|(index, _)| index).collect();
    let whole: Vec<usize> = all
        .iter()
        .copied()
        .filter(|&index| {
            let before = content[..index].chars().next_back();
            let after = content[index + symbol.len()..].chars().next();
            !before.is_some_and(is_word) && !after.is_some_and(is_word)
        })
        .collect();
    let chosen = if whole.is_empty() { &all } else { &whole };
    let start = *chosen.get(occurrence).or_else(|| chosen.first())?;

    let middle = symbol.char_indices().nth(symbol.chars().count() / 2).map_or(0, |(index, _)| index);
    Some(Position::new(line, byte_to_utf16(content, start + middle)))
}

/// The first line containing `symbol` as a whole word, for callers that know a
/// name but not where it is.
pub fn find_symbol_line(text: &str, symbol: &str) -> Option<u32> {
    if symbol.is_empty() {
        return None;
    }
    let lines = Lines::new(text);
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    let whole_word = |content: &str| {
        content.match_indices(symbol).any(|(index, _)| {
            !content[..index].chars().next_back().is_some_and(is_word)
                && !content[index + symbol.len()..].chars().next().is_some_and(is_word)
        })
    };
    let count = lines.count() as u32;
    (0..count)
        .find(|&line| whole_word(lines.line(line as usize)))
        .or_else(|| (0..count).find(|&line| lines.line(line as usize).contains(symbol)))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
    pub range: Range,
    pub new_text: String,
}

impl TextEdit {
    pub fn parse(value: &crate::json::Json) -> Option<TextEdit> {
        use crate::json::JsonExt;
        // `AnnotatedTextEdit` and `SnippetTextEdit` carry the same two fields;
        // a snippet's placeholders are left literal, since no user is there to
        // tab through them.
        let new_text = value
            .str_at("newText")
            .map(String::from)
            .or_else(|| value.str_at("snippet.value").map(strip_snippet))?;
        Some(TextEdit { range: Range::parse(value.at("range")?)?, new_text })
    }
}

/// `${1:name}` → `name`, `$0` → nothing: a snippet as plain text.
fn strip_snippet(snippet: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = snippet.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '\\' if index + 1 < chars.len() => {
                out.push(chars[index + 1]);
                index += 2;
            }
            '$' if chars.get(index + 1) == Some(&'{') => {
                let mut depth = 1;
                let mut cursor = index + 2;
                let mut body = String::new();
                while cursor < chars.len() && depth > 0 {
                    match chars[cursor] {
                        '{' => depth += 1,
                        '}' => depth -= 1,
                        _ => {}
                    }
                    if depth > 0 {
                        body.push(chars[cursor]);
                    }
                    cursor += 1;
                }
                let placeholder = body.split_once(':').map(|(_, text)| text.to_string()).unwrap_or_default();
                out.push_str(&strip_snippet(&placeholder));
                index = cursor;
            }
            '$' if chars.get(index + 1).is_some_and(char::is_ascii_digit) => {
                index += 1;
                while chars.get(index).is_some_and(char::is_ascii_digit) {
                    index += 1;
                }
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    out
}

/// Applies edits to a text, all or nothing.
///
/// The edits' ranges refer to the text *before* any of them, as the
/// specification requires; applying from the last to the first keeps each
/// range valid. Two edits that overlap cannot both be honoured, and applying
/// one silently would leave the file in a state neither intended — so that is
/// an error, and nothing changes.
pub fn apply_edits(text: &str, edits: &[TextEdit]) -> Result<String, String> {
    let lines = Lines::new(text);
    let mut spans: Vec<(usize, usize, usize)> = edits
        .iter()
        .enumerate()
        .map(|(index, edit)| {
            let start = lines.offset(edit.range.start);
            let end = lines.offset(edit.range.end).max(start);
            (start, end, index)
        })
        .collect();
    // Stable on equal starts, so two inserts at one point keep their order.
    spans.sort_by(|a, b| a.0.cmp(&b.0).then(a.2.cmp(&b.2)));
    for pair in spans.windows(2) {
        if pair[1].0 < pair[0].1 {
            let at = lines.position(pair[1].0);
            return Err(format!("overlapping edits at line {}", at.line + 1));
        }
    }

    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, end, index) in spans {
        out.push_str(&text[cursor..start]);
        out.push_str(&edits[index].new_text);
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_columns_land_on_the_right_bytes() {
        let line = "let é = \"😀\";";
        // `é` is one UTF-16 unit, the emoji two.
        assert_eq!(utf16_to_byte(line, 4), 4);
        assert_eq!(utf16_to_byte(line, 5), 6);
        assert_eq!(byte_to_utf16(line, line.find('😀').unwrap() + 4), 11);
        assert_eq!(utf16_to_byte(line, 999), line.len());
    }

    #[test]
    fn every_line_ending_is_one_break() {
        let lines = Lines::new("a\r\nb\rc\nd");
        assert_eq!(lines.count(), 4);
        assert_eq!(lines.line(1), "b");
        assert_eq!(lines.offset(Position::new(3, 1)), 8);
        assert_eq!(lines.position(7), Position::new(3, 0));
    }

    #[test]
    fn edits_apply_against_the_original_text() {
        let text = "one two three\nfour";
        let edits = vec![
            TextEdit { range: Range::new(Position::new(0, 0), Position::new(0, 3)), new_text: "1".into() },
            TextEdit { range: Range::new(Position::new(0, 8), Position::new(0, 13)), new_text: "3".into() },
            TextEdit { range: Range::new(Position::new(1, 4), Position::new(1, 4)), new_text: "!".into() },
        ];
        assert_eq!(apply_edits(text, &edits).unwrap(), "1 two 3\nfour!");
    }

    #[test]
    fn overlapping_edits_change_nothing() {
        let edits = vec![
            TextEdit { range: Range::new(Position::new(0, 0), Position::new(0, 5)), new_text: "x".into() },
            TextEdit { range: Range::new(Position::new(0, 3), Position::new(0, 7)), new_text: "y".into() },
        ];
        assert!(apply_edits("abcdefgh", &edits).is_err());
    }

    #[test]
    fn a_symbol_is_found_as_a_word_before_a_substring() {
        let text = "const width = id(id)";
        let first = symbol_position(text, 0, "id", 0).unwrap();
        assert_eq!(first.character, 15, "the call, not the `id` inside `width`");
        let second = symbol_position(text, 0, "id", 1).unwrap();
        assert_eq!(second.character, 18);
        assert!(symbol_position(text, 0, "missing", 0).is_none());
        assert_eq!(find_symbol_line("a\nb foo\nfoo", "foo"), Some(1));
    }

    #[test]
    fn snippets_become_plain_text() {
        assert_eq!(strip_snippet("fn ${1:name}(${2:args}) {$0}"), "fn name(args) {}");
        assert_eq!(strip_snippet("cost: \\$5"), "cost: $5");
    }
}
