//! Small conveniences over [`pi_builtins::json::Json`].
//!
//! LSP and DAP are JSON all the way down, and reading a field three objects
//! deep with bare `match` statements buries every request under plumbing.
//! These helpers keep the protocol code about the protocol.

pub use pi_builtins::json::{parse, Json};
use std::collections::BTreeMap;

/// An object from `(key, value)` pairs. Keys are copied.
pub fn object<'a>(fields: impl IntoIterator<Item = (&'a str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

/// An empty object.
pub fn empty() -> Json {
    Json::Object(BTreeMap::new())
}

pub fn string(value: impl Into<String>) -> Json {
    Json::String(value.into())
}

pub fn int(value: i64) -> Json {
    Json::Number(value as f64)
}

pub fn uint(value: u64) -> Json {
    Json::Number(value as f64)
}

pub fn boolean(value: bool) -> Json {
    Json::Bool(value)
}

pub fn array(values: impl IntoIterator<Item = Json>) -> Json {
    Json::Array(values.into_iter().collect())
}

pub fn strings<S: AsRef<str>>(values: impl IntoIterator<Item = S>) -> Json {
    Json::Array(values.into_iter().map(|value| Json::String(value.as_ref().to_string())).collect())
}

/// `Some(value)` as the value, `None` as `null`.
pub fn optional(value: Option<Json>) -> Json {
    value.unwrap_or(Json::Null)
}

/// Parses a literal known to be valid, for capability and settings tables.
///
/// # Panics
///
/// On invalid JSON — which can only be a typo in this crate's own source, and
/// is caught by the first test that touches it.
pub fn literal(text: &str) -> Json {
    match parse(text) {
        Ok(value) => value,
        Err(error) => panic!("invalid JSON literal in pi-lsp: {error}\n{text}"),
    }
}

/// Reading fields without a `match` per level.
pub trait JsonExt {
    /// A value by dotted path: `capabilities.textDocumentSync.save`. A numeric
    /// segment indexes an array.
    fn at(&self, path: &str) -> Option<&Json>;
    fn str_at(&self, path: &str) -> Option<&str>;
    fn f64_at(&self, path: &str) -> Option<f64>;
    fn u32_at(&self, path: &str) -> Option<u32>;
    fn i64_at(&self, path: &str) -> Option<i64>;
    fn bool_at(&self, path: &str) -> Option<bool>;
    /// The elements when this is an array, an empty slice otherwise.
    fn items(&self) -> &[Json];
    fn is_null(&self) -> bool;
    /// Whether a capability is present and not `false` — LSP advertises most
    /// of them as `true` or as an options object.
    fn enabled(&self, path: &str) -> bool;
    /// Sets a key on an object; does nothing on anything else.
    fn set(&mut self, key: &str, value: Json);
}

impl JsonExt for Json {
    fn at(&self, path: &str) -> Option<&Json> {
        let mut current = self;
        for segment in path.split('.').filter(|segment| !segment.is_empty()) {
            current = match current {
                Json::Object(map) => map.get(segment)?,
                Json::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
                _ => return None,
            };
        }
        Some(current)
    }

    fn str_at(&self, path: &str) -> Option<&str> {
        self.at(path).and_then(Json::as_str)
    }

    fn f64_at(&self, path: &str) -> Option<f64> {
        self.at(path).and_then(Json::as_f64)
    }

    fn u32_at(&self, path: &str) -> Option<u32> {
        self.f64_at(path).filter(|value| *value >= 0.0).map(|value| value as u32)
    }

    fn i64_at(&self, path: &str) -> Option<i64> {
        self.f64_at(path).map(|value| value as i64)
    }

    fn bool_at(&self, path: &str) -> Option<bool> {
        match self.at(path) {
            Some(Json::Bool(value)) => Some(*value),
            _ => None,
        }
    }

    fn items(&self) -> &[Json] {
        match self {
            Json::Array(items) => items,
            _ => &[],
        }
    }

    fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    fn enabled(&self, path: &str) -> bool {
        !matches!(self.at(path), None | Some(Json::Null) | Some(Json::Bool(false)))
    }

    fn set(&mut self, key: &str, value: Json) {
        if let Json::Object(map) = self {
            map.insert(key.to_string(), value);
        }
    }
}

/// Deep-merges `overlay` onto `base`: objects merge key by key, anything else
/// replaces. How a user's settings for a server layer over the built-in ones.
pub fn merge(base: &Json, overlay: &Json) -> Json {
    match (base, overlay) {
        (Json::Object(left), Json::Object(right)) => {
            let mut merged = left.clone();
            for (key, value) in right {
                let combined = match merged.get(key) {
                    Some(existing) => merge(existing, value),
                    None => value.clone(),
                };
                merged.insert(key.clone(), combined);
            }
            Json::Object(merged)
        }
        (_, Json::Null) => base.clone(),
        _ => overlay.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_reach_through_objects_and_arrays() {
        let value = literal(r#"{"a":{"b":[{"c":"deep"}]},"n":3,"t":true}"#);
        assert_eq!(value.str_at("a.b.0.c"), Some("deep"));
        assert_eq!(value.u32_at("n"), Some(3));
        assert_eq!(value.bool_at("t"), Some(true));
        assert!(value.at("a.missing").is_none());
        assert!(value.enabled("t"));
        assert!(!value.enabled("nope"));
    }

    #[test]
    fn merge_layers_objects_and_replaces_the_rest() {
        let base = literal(r#"{"a":{"x":1,"y":2},"b":[1]}"#);
        let overlay = literal(r#"{"a":{"y":3},"b":[2]}"#);
        let merged = merge(&base, &overlay);
        assert_eq!(merged.u32_at("a.x"), Some(1));
        assert_eq!(merged.u32_at("a.y"), Some(3));
        assert_eq!(merged.u32_at("b.0"), Some(2));
    }
}
