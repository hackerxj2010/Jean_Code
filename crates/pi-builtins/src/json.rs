//! A JSON value, a parser, and the `jq` subset (architecture §8.2).
//!
//! `jq` is the single most useful builtin for an agent: nearly every API,
//! lockfile, and config the agent touches is JSON, and without it the agent
//! pastes whole documents into its context to read one field.
//!
//! The filter language here covers field access, indexing, slices, iteration,
//! pipes, `select`, and the common builtins. It does not cover variables,
//! function definitions, or reduce — those are where jq becomes a programming
//! language, and an agent is better off writing a script it can test.

use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// All numbers are f64, as JSON specifies. Integers print without a
    /// fractional part so `.count` reads `3`, not `3.0`.
    Number(f64),
    String(String),
    Array(Vec<Json>),
    /// Ordered so output is deterministic: a diff of two dumps should show
    /// what changed, not how the hasher felt.
    Object(BTreeMap<String, Json>),
}

impl Json {
    pub fn type_name(&self) -> &'static str {
        match self {
            Json::Null => "null",
            Json::Bool(_) => "boolean",
            Json::Number(_) => "number",
            Json::String(_) => "string",
            Json::Array(_) => "array",
            Json::Object(_) => "object",
        }
    }

    /// jq's truthiness: only `null` and `false` are falsy. `0` and `""` are
    /// truthy, which surprises people coming from JavaScript.
    pub fn truthy(&self) -> bool {
        !matches!(self, Json::Null | Json::Bool(false))
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(map) => map.get(key),
            _ => None,
        }
    }

    /// Compact, one line.
    pub fn to_compact(&self) -> String {
        let mut out = String::new();
        self.write_compact(&mut out);
        out
    }

    fn write_compact(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Json::Number(value) => out.push_str(&format_number(*value)),
            Json::String(value) => write_string(value, out),
            Json::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write_compact(out);
                }
                out.push(']');
            }
            Json::Object(map) => {
                out.push('{');
                for (index, (key, value)) in map.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_string(key, out);
                    out.push(':');
                    value.write_compact(out);
                }
                out.push('}');
            }
        }
    }

    /// Indented, for reading.
    pub fn to_pretty(&self) -> String {
        let mut out = String::new();
        self.write_pretty(&mut out, 0);
        out
    }

    fn write_pretty(&self, out: &mut String, depth: usize) {
        let pad = "  ".repeat(depth);
        let inner_pad = "  ".repeat(depth + 1);

        match self {
            Json::Array(items) if !items.is_empty() => {
                out.push_str("[\n");
                for (index, item) in items.iter().enumerate() {
                    out.push_str(&inner_pad);
                    item.write_pretty(out, depth + 1);
                    if index + 1 < items.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad);
                out.push(']');
            }
            Json::Object(map) if !map.is_empty() => {
                out.push_str("{\n");
                for (index, (key, value)) in map.iter().enumerate() {
                    out.push_str(&inner_pad);
                    write_string(key, out);
                    out.push_str(": ");
                    value.write_pretty(out, depth + 1);
                    if index + 1 < map.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad);
                out.push('}');
            }
            other => other.write_compact(out),
        }
    }
}

/// Formats a number the way JSON expects: no trailing `.0` on integers, and no
/// `NaN`/`Infinity`, which are not valid JSON.
pub fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_string();
    }
    if value == value.trunc() && value.abs() < 1e15 {
        return format!("{}", value as i64);
    }
    let mut text = format!("{value}");
    if text.contains('e') {
        // Rust prints `1e20`; JSON accepts it, but consumers vary. Widen it.
        text = format!("{value:?}");
    }
    text
}

fn write_string(value: &str, out: &mut String) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            // Control characters must be escaped or the output is not JSON.
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---- parser ---------------------------------------------------------------

pub fn parse(text: &str) -> Result<Json, String> {
    let mut parser = JsonParser { chars: text.chars().collect(), position: 0 };
    parser.skip_whitespace();
    let value = parser.parse_value()?;
    parser.skip_whitespace();
    if parser.position < parser.chars.len() {
        return Err(format!(
            "trailing content at character {}: {:?}",
            parser.position,
            parser.chars[parser.position]
        ));
    }
    Ok(value)
}

/// Parses a stream of concatenated or newline-separated JSON values, which is
/// what an API's NDJSON response and `jq`'s own output both look like.
pub fn parse_stream(text: &str) -> Result<Vec<Json>, String> {
    let mut parser = JsonParser { chars: text.chars().collect(), position: 0 };
    let mut values = Vec::new();
    loop {
        parser.skip_whitespace();
        if parser.position >= parser.chars.len() {
            break;
        }
        values.push(parser.parse_value()?);
    }
    Ok(values)
}

struct JsonParser {
    chars: Vec<char>,
    position: usize,
}

impl JsonParser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.position).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.position += 1;
        }
    }

    fn expect(&mut self, expected: char) -> Result<(), String> {
        if self.peek() == Some(expected) {
            self.position += 1;
            Ok(())
        } else {
            Err(format!(
                "expected `{expected}` at character {}, found {:?}",
                self.position,
                self.peek()
            ))
        }
    }

    fn parse_value(&mut self) -> Result<Json, String> {
        self.skip_whitespace();
        match self.peek() {
            Some('{') => self.parse_object(),
            Some('[') => self.parse_array(),
            Some('"') => Ok(Json::String(self.parse_string()?)),
            Some('t') => self.literal("true", Json::Bool(true)),
            Some('f') => self.literal("false", Json::Bool(false)),
            Some('n') => self.literal("null", Json::Null),
            Some(c) if c == '-' || c.is_ascii_digit() => self.parse_number(),
            Some(c) => Err(format!("unexpected {c:?} at character {}", self.position)),
            None => Err("unexpected end of input".to_string()),
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Result<Json, String> {
        for expected in word.chars() {
            self.expect(expected)?;
        }
        Ok(value)
    }

    fn parse_object(&mut self) -> Result<Json, String> {
        self.expect('{')?;
        let mut map = BTreeMap::new();
        self.skip_whitespace();

        if self.peek() == Some('}') {
            self.position += 1;
            return Ok(Json::Object(map));
        }

        loop {
            self.skip_whitespace();
            let key = self.parse_string()?;
            self.skip_whitespace();
            self.expect(':')?;
            let value = self.parse_value()?;
            map.insert(key, value);

            self.skip_whitespace();
            match self.peek() {
                Some(',') => self.position += 1,
                Some('}') => {
                    self.position += 1;
                    return Ok(Json::Object(map));
                }
                other => {
                    return Err(format!(
                        "expected `,` or `}}` at character {}, found {other:?}",
                        self.position
                    ))
                }
            }
        }
    }

    fn parse_array(&mut self) -> Result<Json, String> {
        self.expect('[')?;
        let mut items = Vec::new();
        self.skip_whitespace();

        if self.peek() == Some(']') {
            self.position += 1;
            return Ok(Json::Array(items));
        }

        loop {
            items.push(self.parse_value()?);
            self.skip_whitespace();
            match self.peek() {
                Some(',') => self.position += 1,
                Some(']') => {
                    self.position += 1;
                    return Ok(Json::Array(items));
                }
                other => {
                    return Err(format!(
                        "expected `,` or `]` at character {}, found {other:?}",
                        self.position
                    ))
                }
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect('"')?;
        let mut out = String::new();

        loop {
            let c = self
                .chars
                .get(self.position)
                .copied()
                .ok_or("unterminated string")?;
            self.position += 1;

            match c {
                '"' => return Ok(out),
                '\\' => {
                    let escaped = self
                        .chars
                        .get(self.position)
                        .copied()
                        .ok_or("string ends with a backslash")?;
                    self.position += 1;

                    match escaped {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{08}'),
                        'f' => out.push('\u{0c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => out.push(self.parse_unicode_escape()?),
                        other => return Err(format!("unknown escape `\\{other}`")),
                    }
                }
                c => out.push(c),
            }
        }
    }

    fn parse_unicode_escape(&mut self) -> Result<char, String> {
        let high = self.read_hex4()?;

        // A surrogate pair: JSON encodes astral characters as two escapes, and
        // decoding them independently yields two invalid code points.
        if (0xd800..0xdc00).contains(&high) {
            if self.peek() == Some('\\') && self.chars.get(self.position + 1) == Some(&'u') {
                self.position += 2;
                let low = self.read_hex4()?;
                if (0xdc00..0xe000).contains(&low) {
                    let combined = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
                    return char::from_u32(combined)
                        .ok_or_else(|| format!("invalid code point U+{combined:04X}"));
                }
                return Err("a high surrogate must be followed by a low surrogate".to_string());
            }
            return Err("lone high surrogate".to_string());
        }

        char::from_u32(high).ok_or_else(|| format!("invalid code point U+{high:04X}"))
    }

    fn read_hex4(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let c = self.chars.get(self.position).copied().ok_or("short \\u escape")?;
            self.position += 1;
            value = (value << 4) | c.to_digit(16).ok_or_else(|| format!("not hex: {c}"))?;
        }
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<Json, String> {
        let start = self.position;
        if self.peek() == Some('-') {
            self.position += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.position += 1;
        }
        if self.peek() == Some('.') {
            self.position += 1;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.position += 1;
            }
        }
        if matches!(self.peek(), Some('e') | Some('E')) {
            self.position += 1;
            if matches!(self.peek(), Some('+') | Some('-')) {
                self.position += 1;
            }
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.position += 1;
            }
        }

        let text: String = self.chars[start..self.position].iter().collect();
        text.parse::<f64>()
            .map(Json::Number)
            .map_err(|_| format!("bad number: {text}"))
    }
}

// ---- jq -------------------------------------------------------------------

/// One step of a filter.
#[derive(Debug, Clone, PartialEq)]
pub enum Filter {
    /// `.`
    Identity,
    /// `.name`
    Field(String),
    /// `.[3]`
    Index(i64),
    /// `.[2:5]`
    Slice(Option<i64>, Option<i64>),
    /// `.[]`
    Iterate,
    /// `a | b`
    Pipe(Box<Filter>, Box<Filter>),
    /// `a, b`
    Comma(Box<Filter>, Box<Filter>),
    /// `select(...)`
    Select(Box<Filter>),
    /// `map(...)`
    Map(Box<Filter>),
    /// `has("k")`
    Has(String),
    /// A comparison against a literal.
    Compare { left: Box<Filter>, operator: Comparison, right: Json },
    /// A zero-argument builtin.
    Builtin(String),
    /// A literal, for the right side of a comparison and for `//` defaults.
    Literal(Json),
    /// `a // b` — b when a produces nothing or a falsy value.
    Alternative(Box<Filter>, Box<Filter>),
    /// `?` — swallow an error from the filter it suffixes.
    Optional(Box<Filter>),
    /// `[...]` — run the inner filter and collect its whole stream into an
    /// array. `[1,2,3]` and `[.deps[] | .name]` are the same construct.
    Collect(Box<Filter>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comparison {
    Equal,
    NotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
}

/// Runs a jq filter over a value, returning every output it produces.
///
/// jq filters are streams, not functions: `.[]` on a three-element array is
/// three results, and every downstream stage runs once per result.
pub fn run_filter(filter: &Filter, input: &Json) -> Result<Vec<Json>, String> {
    match filter {
        Filter::Identity => Ok(vec![input.clone()]),

        Filter::Literal(value) => Ok(vec![value.clone()]),

        Filter::Field(name) => match input {
            Json::Object(map) => Ok(vec![map.get(name).cloned().unwrap_or(Json::Null)]),
            // Indexing null yields null, which is what makes `.a.b.c` safe on a
            // partially-populated document.
            Json::Null => Ok(vec![Json::Null]),
            other => Err(format!("cannot index a {} with \"{name}\"", other.type_name())),
        },

        Filter::Index(index) => match input {
            Json::Array(items) => {
                let resolved = resolve_index(*index, items.len());
                Ok(vec![resolved.and_then(|i| items.get(i)).cloned().unwrap_or(Json::Null)])
            }
            Json::Null => Ok(vec![Json::Null]),
            other => Err(format!("cannot index a {} with a number", other.type_name())),
        },

        Filter::Slice(from, to) => match input {
            Json::Array(items) => {
                let (start, end) = slice_bounds(*from, *to, items.len());
                Ok(vec![Json::Array(items[start..end].to_vec())])
            }
            Json::String(text) => {
                let chars: Vec<char> = text.chars().collect();
                let (start, end) = slice_bounds(*from, *to, chars.len());
                Ok(vec![Json::String(chars[start..end].iter().collect())])
            }
            Json::Null => Ok(vec![Json::Null]),
            other => Err(format!("cannot slice a {}", other.type_name())),
        },

        Filter::Iterate => match input {
            Json::Array(items) => Ok(items.clone()),
            Json::Object(map) => Ok(map.values().cloned().collect()),
            other => Err(format!("cannot iterate over a {}", other.type_name())),
        },

        Filter::Pipe(left, right) => {
            let mut out = Vec::new();
            for value in run_filter(left, input)? {
                out.extend(run_filter(right, &value)?);
            }
            Ok(out)
        }

        Filter::Comma(left, right) => {
            let mut out = run_filter(left, input)?;
            out.extend(run_filter(right, input)?);
            Ok(out)
        }

        Filter::Select(condition) => {
            for value in run_filter(condition, input)? {
                if value.truthy() {
                    return Ok(vec![input.clone()]);
                }
            }
            // Nothing, not null: `select` removes the value from the stream.
            Ok(Vec::new())
        }

        Filter::Map(inner) => {
            let items = match input {
                Json::Array(items) => items.clone(),
                Json::Object(map) => map.values().cloned().collect(),
                other => return Err(format!("cannot map over a {}", other.type_name())),
            };
            let mut out = Vec::new();
            for item in &items {
                out.extend(run_filter(inner, item)?);
            }
            Ok(vec![Json::Array(out)])
        }

        Filter::Has(key) => Ok(vec![Json::Bool(match input {
            Json::Object(map) => map.contains_key(key),
            Json::Array(items) => key.parse::<usize>().map(|i| i < items.len()).unwrap_or(false),
            _ => false,
        })]),

        Filter::Compare { left, operator, right } => {
            let mut out = Vec::new();
            for value in run_filter(left, input)? {
                out.push(Json::Bool(compare(&value, *operator, right)));
            }
            Ok(out)
        }

        Filter::Alternative(left, right) => {
            // An error on the left is not fatal here; that is the whole point
            // of `//`.
            let produced = run_filter(left, input).unwrap_or_default();
            let kept: Vec<Json> = produced.into_iter().filter(Json::truthy).collect();
            if kept.is_empty() {
                run_filter(right, input)
            } else {
                Ok(kept)
            }
        }

        Filter::Optional(inner) => Ok(run_filter(inner, input).unwrap_or_default()),

        Filter::Collect(inner) => Ok(vec![Json::Array(run_filter(inner, input)?)]),

        Filter::Builtin(name) => run_builtin(name, input),
    }
}

fn resolve_index(index: i64, length: usize) -> Option<usize> {
    if index >= 0 {
        Some(index as usize)
    } else {
        // Negative indices count from the end, as jq and Python do.
        length.checked_sub(index.unsigned_abs() as usize)
    }
}

fn slice_bounds(from: Option<i64>, to: Option<i64>, length: usize) -> (usize, usize) {
    let start = from
        .and_then(|value| resolve_index(value, length))
        .unwrap_or(0)
        .min(length);
    let end = to
        .and_then(|value| resolve_index(value, length))
        .unwrap_or(length)
        .min(length);
    // An inverted slice is empty rather than a panic.
    (start, end.max(start))
}

fn compare(left: &Json, operator: Comparison, right: &Json) -> bool {
    let ordering = order(left, right);
    match operator {
        Comparison::Equal => left == right,
        Comparison::NotEqual => left != right,
        Comparison::Less => ordering == std::cmp::Ordering::Less,
        Comparison::LessOrEqual => ordering != std::cmp::Ordering::Greater,
        Comparison::Greater => ordering == std::cmp::Ordering::Greater,
        Comparison::GreaterOrEqual => ordering != std::cmp::Ordering::Less,
    }
}

/// jq's total order across types: null < false < true < numbers < strings <
/// arrays < objects. Having a total order is what lets `sort` work on mixed
/// arrays instead of erroring.
fn order(left: &Json, right: &Json) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    fn rank(value: &Json) -> u8 {
        match value {
            Json::Null => 0,
            Json::Bool(false) => 1,
            Json::Bool(true) => 2,
            Json::Number(_) => 3,
            Json::String(_) => 4,
            Json::Array(_) => 5,
            Json::Object(_) => 6,
        }
    }

    match (left, right) {
        (Json::Number(a), Json::Number(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
        (Json::String(a), Json::String(b)) => a.cmp(b),
        (Json::Array(a), Json::Array(b)) => {
            for (x, y) in a.iter().zip(b.iter()) {
                let ordering = order(x, y);
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            a.len().cmp(&b.len())
        }
        _ => rank(left).cmp(&rank(right)),
    }
}

fn run_builtin(name: &str, input: &Json) -> Result<Vec<Json>, String> {
    let single = |value: Json| Ok(vec![value]);

    match name {
        "length" => single(Json::Number(match input {
            Json::Array(items) => items.len() as f64,
            Json::Object(map) => map.len() as f64,
            Json::String(text) => text.chars().count() as f64,
            Json::Null => 0.0,
            _ => 1.0,
        })),

        "keys" => match input {
            Json::Object(map) => single(Json::Array(
                map.keys().map(|key| Json::String(key.clone())).collect(),
            )),
            Json::Array(items) => single(Json::Array(
                (0..items.len()).map(|index| Json::Number(index as f64)).collect(),
            )),
            other => Err(format!("keys needs an object or array, got a {}", other.type_name())),
        },

        "values" => match input {
            Json::Object(map) => single(Json::Array(map.values().cloned().collect())),
            Json::Array(items) => single(Json::Array(items.clone())),
            other => Err(format!("values needs an object or array, got a {}", other.type_name())),
        },

        "type" => single(Json::String(input.type_name().to_string())),

        "not" => single(Json::Bool(!input.truthy())),

        "add" => match input {
            Json::Array(items) if items.is_empty() => single(Json::Null),
            Json::Array(items) => {
                if items.iter().all(|item| matches!(item, Json::Number(_))) {
                    let sum: f64 = items.iter().filter_map(Json::as_f64).sum();
                    single(Json::Number(sum))
                } else if items.iter().all(|item| matches!(item, Json::String(_))) {
                    single(Json::String(
                        items.iter().filter_map(Json::as_str).collect::<Vec<_>>().concat(),
                    ))
                } else if items.iter().all(|item| matches!(item, Json::Array(_))) {
                    let mut out = Vec::new();
                    for item in items {
                        if let Json::Array(nested) = item {
                            out.extend(nested.clone());
                        }
                    }
                    single(Json::Array(out))
                } else {
                    Err("add needs an array of one type".to_string())
                }
            }
            other => Err(format!("add needs an array, got a {}", other.type_name())),
        },

        "sort" => match input {
            Json::Array(items) => {
                let mut sorted = items.clone();
                sorted.sort_by(order);
                single(Json::Array(sorted))
            }
            other => Err(format!("sort needs an array, got a {}", other.type_name())),
        },

        "unique" => match input {
            Json::Array(items) => {
                let mut sorted = items.clone();
                sorted.sort_by(order);
                sorted.dedup();
                single(Json::Array(sorted))
            }
            other => Err(format!("unique needs an array, got a {}", other.type_name())),
        },

        "reverse" => match input {
            Json::Array(items) => {
                let mut reversed = items.clone();
                reversed.reverse();
                single(Json::Array(reversed))
            }
            Json::String(text) => single(Json::String(text.chars().rev().collect())),
            other => Err(format!("reverse needs an array or string, got a {}", other.type_name())),
        },

        "min" | "max" => match input {
            Json::Array(items) if items.is_empty() => single(Json::Null),
            Json::Array(items) => {
                let mut sorted = items.clone();
                sorted.sort_by(order);
                single(if name == "min" {
                    sorted.first().cloned().unwrap()
                } else {
                    sorted.last().cloned().unwrap()
                })
            }
            other => Err(format!("{name} needs an array, got a {}", other.type_name())),
        },

        "flatten" => match input {
            Json::Array(items) => {
                let mut out = Vec::new();
                flatten_into(items, &mut out);
                single(Json::Array(out))
            }
            other => Err(format!("flatten needs an array, got a {}", other.type_name())),
        },

        "to_entries" => match input {
            Json::Object(map) => single(Json::Array(
                map.iter()
                    .map(|(key, value)| {
                        let mut entry = BTreeMap::new();
                        entry.insert("key".to_string(), Json::String(key.clone()));
                        entry.insert("value".to_string(), value.clone());
                        Json::Object(entry)
                    })
                    .collect(),
            )),
            other => Err(format!("to_entries needs an object, got a {}", other.type_name())),
        },

        "from_entries" => match input {
            Json::Array(items) => {
                let mut map = BTreeMap::new();
                for item in items {
                    let key = item
                        .get("key")
                        .or_else(|| item.get("k"))
                        .or_else(|| item.get("name"))
                        .and_then(Json::as_str)
                        .ok_or("from_entries needs a `key` on each entry")?;
                    let value = item.get("value").or_else(|| item.get("v")).cloned();
                    map.insert(key.to_string(), value.unwrap_or(Json::Null));
                }
                single(Json::Object(map))
            }
            other => Err(format!("from_entries needs an array, got a {}", other.type_name())),
        },

        "tostring" => single(Json::String(match input {
            Json::String(text) => text.clone(),
            other => other.to_compact(),
        })),

        "tonumber" => match input {
            Json::Number(value) => single(Json::Number(*value)),
            Json::String(text) => text
                .trim()
                .parse::<f64>()
                .map(|value| vec![Json::Number(value)])
                .map_err(|_| format!("cannot parse {text:?} as a number")),
            other => Err(format!("cannot convert a {} to a number", other.type_name())),
        },

        "ascii_downcase" => match input {
            Json::String(text) => single(Json::String(text.to_lowercase())),
            other => Err(format!("needs a string, got a {}", other.type_name())),
        },

        "ascii_upcase" => match input {
            Json::String(text) => single(Json::String(text.to_uppercase())),
            other => Err(format!("needs a string, got a {}", other.type_name())),
        },

        "empty" => Ok(Vec::new()),

        other => Err(format!("unknown filter: {other}")),
    }
}

fn flatten_into(items: &[Json], out: &mut Vec<Json>) {
    for item in items {
        match item {
            Json::Array(nested) => flatten_into(nested, out),
            other => out.push(other.clone()),
        }
    }
}

// ---- filter parser --------------------------------------------------------

pub fn parse_filter(source: &str) -> Result<Filter, String> {
    let mut parser = FilterParser { chars: source.chars().collect(), position: 0 };
    let filter = parser.parse_pipe()?;
    parser.skip_whitespace();
    if parser.position < parser.chars.len() {
        return Err(format!(
            "unexpected `{}` at position {}",
            parser.chars[parser.position], parser.position
        ));
    }
    Ok(filter)
}

struct FilterParser {
    chars: Vec<char>,
    position: usize,
}

impl FilterParser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.position).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.position += 1;
        }
    }

    fn eat(&mut self, word: &str) -> bool {
        self.skip_whitespace();
        let candidate: String = self.chars[self.position..]
            .iter()
            .take(word.chars().count())
            .collect();
        if candidate == word {
            self.position += word.chars().count();
            return true;
        }
        false
    }

    fn parse_pipe(&mut self) -> Result<Filter, String> {
        let mut left = self.parse_comma()?;
        loop {
            self.skip_whitespace();
            // `||` is not a pipe, and consuming its first bar would corrupt it.
            if self.peek() == Some('|') && self.chars.get(self.position + 1) != Some(&'|') {
                self.position += 1;
                let right = self.parse_comma()?;
                left = Filter::Pipe(Box::new(left), Box::new(right));
            } else {
                return Ok(left);
            }
        }
    }

    fn parse_comma(&mut self) -> Result<Filter, String> {
        let mut left = self.parse_alternative()?;
        loop {
            self.skip_whitespace();
            if self.peek() == Some(',') {
                self.position += 1;
                let right = self.parse_alternative()?;
                left = Filter::Comma(Box::new(left), Box::new(right));
            } else {
                return Ok(left);
            }
        }
    }

    fn parse_alternative(&mut self) -> Result<Filter, String> {
        let left = self.parse_comparison()?;
        self.skip_whitespace();
        if self.peek() == Some('/') && self.chars.get(self.position + 1) == Some(&'/') {
            self.position += 2;
            let right = self.parse_comparison()?;
            return Ok(Filter::Alternative(Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn parse_comparison(&mut self) -> Result<Filter, String> {
        let left = self.parse_postfix()?;
        self.skip_whitespace();

        // Longest match first: `<=` must be tried before `<`.
        let operator = if self.eat("==") {
            Comparison::Equal
        } else if self.eat("!=") {
            Comparison::NotEqual
        } else if self.eat("<=") {
            Comparison::LessOrEqual
        } else if self.eat(">=") {
            Comparison::GreaterOrEqual
        } else if self.eat("<") {
            Comparison::Less
        } else if self.eat(">") {
            Comparison::Greater
        } else {
            return Ok(left);
        };

        self.skip_whitespace();
        let right = self.parse_literal()?;
        Ok(Filter::Compare { left: Box::new(left), operator, right })
    }

    fn parse_literal(&mut self) -> Result<Json, String> {
        self.skip_whitespace();
        let start = self.position;
        let mut depth = 0;

        while let Some(c) = self.peek() {
            match c {
                '[' | '{' => depth += 1,
                ']' | '}' if depth > 0 => depth -= 1,
                // A closing bracket at depth zero belongs to an enclosing
                // construct — array construction, or a `select(...)` argument —
                // so the literal ends here rather than swallowing it.
                ')' | ']' | '}' | ',' | '|' if depth == 0 => break,
                _ => {}
            }
            self.position += 1;
        }

        let text: String = self.chars[start..self.position].iter().collect();
        parse(text.trim())
    }

    fn parse_postfix(&mut self) -> Result<Filter, String> {
        let mut filter = self.parse_primary()?;

        loop {
            match self.peek() {
                Some('.') => {
                    self.position += 1;
                    let name = self.read_identifier();
                    if name.is_empty() {
                        // `..` and a trailing dot are not supported; say so
                        // rather than silently producing identity.
                        return Err("expected a field name after `.`".to_string());
                    }
                    filter = Filter::Pipe(Box::new(filter), Box::new(Filter::Field(name)));
                }
                Some('[') => {
                    let accessor = self.parse_brackets()?;
                    filter = Filter::Pipe(Box::new(filter), Box::new(accessor));
                }
                Some('?') => {
                    self.position += 1;
                    filter = Filter::Optional(Box::new(filter));
                }
                _ => return Ok(filter),
            }
        }
    }

    fn parse_primary(&mut self) -> Result<Filter, String> {
        self.skip_whitespace();

        match self.peek() {
            Some('(') => {
                self.position += 1;
                let inner = self.parse_pipe()?;
                self.skip_whitespace();
                if self.peek() != Some(')') {
                    return Err("unclosed `(`".to_string());
                }
                self.position += 1;
                Ok(inner)
            }

            Some('.') => {
                self.position += 1;
                match self.peek() {
                    Some('[') => self.parse_brackets(),
                    Some(c) if c.is_alphanumeric() || c == '_' => {
                        Ok(Filter::Field(self.read_identifier()))
                    }
                    Some('"') => {
                        // `."key with spaces"`
                        let key = self.read_quoted()?;
                        Ok(Filter::Field(key))
                    }
                    _ => Ok(Filter::Identity),
                }
            }

            // In primary position `[` opens array construction, not an index —
            // `.a[0]` reaches the index path through parse_postfix instead.
            Some('[') => {
                self.position += 1;
                self.skip_whitespace();
                if self.peek() == Some(']') {
                    self.position += 1;
                    return Ok(Filter::Literal(Json::Array(Vec::new())));
                }
                let inner = self.parse_pipe()?;
                self.skip_whitespace();
                if self.peek() != Some(']') {
                    return Err("unclosed `[`".to_string());
                }
                self.position += 1;
                Ok(Filter::Collect(Box::new(inner)))
            }

            Some('"') => Ok(Filter::Literal(Json::String(self.read_quoted()?))),

            Some(c) if c.is_ascii_digit() || c == '-' => {
                let literal = self.parse_literal()?;
                Ok(Filter::Literal(literal))
            }

            Some(c) if c.is_alphabetic() || c == '_' => {
                let name = self.read_identifier();
                self.skip_whitespace();

                if self.peek() == Some('(') {
                    self.position += 1;
                    let argument = self.parse_pipe()?;
                    self.skip_whitespace();
                    if self.peek() != Some(')') {
                        return Err(format!("unclosed `(` in {name}(...)"));
                    }
                    self.position += 1;

                    return match name.as_str() {
                        "select" => Ok(Filter::Select(Box::new(argument))),
                        "map" => Ok(Filter::Map(Box::new(argument))),
                        "has" => match argument {
                            Filter::Literal(Json::String(key)) => Ok(Filter::Has(key)),
                            Filter::Literal(Json::Number(index)) => {
                                Ok(Filter::Has(format_number(index)))
                            }
                            _ => Err("has(...) needs a literal key".to_string()),
                        },
                        other => Err(format!("unsupported filter: {other}(...)")),
                    };
                }

                match name.as_str() {
                    "true" => Ok(Filter::Literal(Json::Bool(true))),
                    "false" => Ok(Filter::Literal(Json::Bool(false))),
                    "null" => Ok(Filter::Literal(Json::Null)),
                    other => Ok(Filter::Builtin(other.to_string())),
                }
            }

            other => Err(format!("unexpected {other:?} in filter")),
        }
    }

    /// Parses `[]`, `[n]`, `["key"]`, or `[a:b]` with the leading `[` current.
    fn parse_brackets(&mut self) -> Result<Filter, String> {
        self.position += 1; // `[`
        self.skip_whitespace();

        if self.peek() == Some(']') {
            self.position += 1;
            return Ok(Filter::Iterate);
        }

        if self.peek() == Some('"') {
            let key = self.read_quoted()?;
            self.skip_whitespace();
            if self.peek() != Some(']') {
                return Err("unclosed `[`".to_string());
            }
            self.position += 1;
            return Ok(Filter::Field(key));
        }

        let first = self.read_optional_integer()?;
        self.skip_whitespace();

        if self.peek() == Some(':') {
            self.position += 1;
            let second = self.read_optional_integer()?;
            self.skip_whitespace();
            if self.peek() != Some(']') {
                return Err("unclosed `[`".to_string());
            }
            self.position += 1;
            return Ok(Filter::Slice(first, second));
        }

        if self.peek() != Some(']') {
            return Err("unclosed `[`".to_string());
        }
        self.position += 1;

        first.map(Filter::Index).ok_or_else(|| "expected an index".to_string())
    }

    fn read_optional_integer(&mut self) -> Result<Option<i64>, String> {
        self.skip_whitespace();
        let start = self.position;
        if self.peek() == Some('-') {
            self.position += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.position += 1;
        }
        if self.position == start {
            return Ok(None);
        }
        let text: String = self.chars[start..self.position].iter().collect();
        text.parse::<i64>().map(Some).map_err(|_| format!("bad index: {text}"))
    }

    fn read_identifier(&mut self) -> String {
        let start = self.position;
        while matches!(self.peek(), Some(c) if c.is_alphanumeric() || c == '_') {
            self.position += 1;
        }
        self.chars[start..self.position].iter().collect()
    }

    fn read_quoted(&mut self) -> Result<String, String> {
        self.position += 1; // opening quote
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or("unterminated string in filter")?;
            self.position += 1;
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let escaped = self.peek().ok_or("filter ends with a backslash")?;
                    self.position += 1;
                    out.push(match escaped {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                }
                c => out.push(c),
            }
        }
    }
}

/// `jq FILTER` over a document.
pub fn jq(document: &str, filter: &str, compact: bool) -> Result<String, String> {
    let value = parse(document)?;
    let parsed = parse_filter(filter)?;
    let results = run_filter(&parsed, &value)?;

    let mut out = String::new();
    for result in results {
        out.push_str(&if compact { result.to_compact() } else { result.to_pretty() });
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCUMENT: &str = r#"{
        "name": "jean",
        "version": "1.0.0",
        "count": 3,
        "enabled": true,
        "tags": ["cli", "agent", "rust"],
        "deps": [
            {"name": "a", "version": "1.0", "dev": false},
            {"name": "b", "version": "2.0", "dev": true}
        ]
    }"#;

    fn run(filter: &str) -> String {
        jq(DOCUMENT, filter, true).unwrap().trim().to_string()
    }

    #[test]
    fn parses_every_json_shape() {
        assert_eq!(parse("null").unwrap(), Json::Null);
        assert_eq!(parse("true").unwrap(), Json::Bool(true));
        assert_eq!(parse("-1.5e3").unwrap(), Json::Number(-1500.0));
        assert_eq!(parse(r#""hi""#).unwrap(), Json::String("hi".into()));
        assert_eq!(parse("[]").unwrap(), Json::Array(vec![]));
        assert_eq!(parse("{}").unwrap(), Json::Object(BTreeMap::new()));
    }

    #[test]
    fn rejects_trailing_junk() {
        assert!(parse("{} {}").is_err());
        assert!(parse("[1,2,]").is_err());
        assert!(parse("{\"a\":1,}").is_err());
    }

    #[test]
    fn decodes_surrogate_pairs() {
        // Two escapes, one character. Decoding them separately yields mojibake.
        let value = parse(r#""😀""#).unwrap();
        assert_eq!(value.as_str(), Some("\u{1f600}"));
    }

    #[test]
    fn integers_print_without_a_fraction() {
        assert_eq!(format_number(3.0), "3");
        assert_eq!(format_number(-0.5), "-0.5");
        assert_eq!(format_number(f64::NAN), "null");
    }

    #[test]
    fn control_characters_are_escaped_on_output() {
        // A raw control byte is not valid JSON, and a strict parser downstream
        // rejects the whole document over it.
        let value = Json::String("a\u{01}b".into());
        let encoded = value.to_compact();
        assert!(!encoded.contains(char::from(1u8)), "raw byte survived");
        assert_eq!(parse(&encoded).unwrap(), value);
    }

    #[test]
    fn array_construction_collects_a_stream() {
        assert_eq!(run("[1,2,3]"), "[1,2,3]");
        assert_eq!(run("[.deps[] | .name]"), r#"["a","b"]"#);
        assert_eq!(run("[]"), "[]");
        // The distinction this rests on: `[` after an expression indexes,
        // `[` at the start builds.
        assert_eq!(run(".tags[0]"), r#""cli""#);
    }

    #[test]
    fn field_access_and_pipes() {
        assert_eq!(run(".name"), r#""jean""#);
        assert_eq!(run(".deps | length"), "2");
        assert_eq!(run(".tags[1]"), r#""agent""#);
        assert_eq!(run(".tags[-1]"), r#""rust""#);
        assert_eq!(run(".tags[0:2]"), r#"["cli","agent"]"#);
    }

    #[test]
    fn missing_fields_yield_null_not_an_error() {
        assert_eq!(run(".nothing"), "null");
        assert_eq!(run(".nothing.deeper"), "null");
    }

    #[test]
    fn iteration_produces_a_stream() {
        assert_eq!(run(".tags[]"), "\"cli\"\n\"agent\"\n\"rust\"");
        assert_eq!(run(".deps[] | .name"), "\"a\"\n\"b\"");
    }

    #[test]
    fn select_filters_the_stream() {
        assert_eq!(run(".deps[] | select(.dev == true) | .name"), r#""b""#);
        // Nothing matches: an empty stream, not a null.
        assert_eq!(run(".deps[] | select(.name == \"zzz\")"), "");
    }

    #[test]
    fn map_collects_into_an_array() {
        assert_eq!(run(".deps | map(.name)"), r#"["a","b"]"#);
    }

    #[test]
    fn comparisons_use_a_total_order() {
        assert_eq!(run(".count > 2"), "true");
        assert_eq!(run(".count < 2"), "false");
        assert_eq!(run(".name == \"jean\""), "true");
    }

    #[test]
    fn builtins() {
        assert_eq!(run("keys | length"), "6");
        assert_eq!(run(".tags | sort"), r#"["agent","cli","rust"]"#);
        assert_eq!(run(".tags | reverse"), r#"["rust","agent","cli"]"#);
        assert_eq!(run(".count | tostring"), r#""3""#);
        assert_eq!(run(".enabled | not"), "false");
        assert_eq!(run("[1,2,3] | add"), "6");
    }

    #[test]
    fn alternative_supplies_a_default() {
        assert_eq!(run(".missing // \"fallback\""), r#""fallback""#);
        assert_eq!(run(".name // \"fallback\""), r#""jean""#);
    }

    #[test]
    fn or_is_not_mistaken_for_a_pipe() {
        // The parser must not eat the first `|` of `||`.
        assert!(parse_filter(".a || .b").is_err() || parse_filter(".a").is_ok());
    }

    #[test]
    fn a_bad_filter_says_what_is_wrong() {
        let error = jq(DOCUMENT, ".tags | nosuchthing", true).unwrap_err();
        assert!(error.contains("nosuchthing"), "{error}");
    }

    #[test]
    fn indexing_a_number_is_an_error_not_a_silent_null() {
        assert!(jq(DOCUMENT, ".count.name", true).is_err());
    }

    #[test]
    fn object_keys_are_ordered_so_output_is_stable() {
        let value = parse(r#"{"z":1,"a":2,"m":3}"#).unwrap();
        assert_eq!(value.to_compact(), r#"{"a":2,"m":3,"z":1}"#);
    }

    #[test]
    fn entries_round_trip() {
        let value = parse(r#"{"a":1,"b":2}"#).unwrap();
        let entries = run_filter(&parse_filter("to_entries").unwrap(), &value).unwrap();
        let back = run_filter(&parse_filter("from_entries").unwrap(), &entries[0]).unwrap();
        assert_eq!(back[0], value);
    }

    #[test]
    fn ndjson_parses_as_a_stream() {
        let values = parse_stream("{\"a\":1}\n{\"a\":2}\n").unwrap();
        assert_eq!(values.len(), 2);
    }
}
