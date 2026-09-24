//! A minimal JSON codec for the bridge.
//!
//! `pi-builtins` already has a complete JSON parser and writer, so this reuses
//! it rather than adding a dependency or writing a second one. What lives here
//! is only the request/response shape and the helpers for pulling typed fields
//! out of a request without a `match` at every call site.

use pi_builtins::json::{self, Json};
use std::collections::BTreeMap;

/// One call from TypeScript.
#[derive(Debug, Clone)]
pub struct Request {
    /// Echoed back so the caller can pair a response with its request. The
    /// bridge answers in order, but the caller should not have to rely on that.
    pub id: String,
    /// `namespace.operation`, e.g. `ast.search_tree`.
    pub method: String,
    pub params: BTreeMap<String, Json>,
}

impl Request {
    pub fn parse(line: &str) -> Result<Self, String> {
        let value = json::parse(line)?;
        let Json::Object(map) = value else {
            return Err("a request must be a JSON object".to_string());
        };

        let id = match map.get("id") {
            Some(Json::String(id)) => id.clone(),
            Some(Json::Number(n)) => json::format_number(*n),
            // An id-less request is answerable, it just cannot be paired.
            _ => String::new(),
        };

        let method = match map.get("method") {
            Some(Json::String(method)) => method.clone(),
            _ => return Err("a request needs a `method` string".to_string()),
        };

        let params = match map.get("params") {
            Some(Json::Object(params)) => params.clone(),
            None | Some(Json::Null) => BTreeMap::new(),
            _ => return Err("`params` must be an object".to_string()),
        };

        Ok(Request { id, method, params })
    }

    pub fn string(&self, key: &str) -> Result<&str, String> {
        match self.params.get(key) {
            Some(Json::String(value)) => Ok(value),
            Some(other) => Err(format!("`{key}` must be a string, got a {}", other.type_name())),
            None => Err(format!("`{key}` is required")),
        }
    }

    pub fn optional_string(&self, key: &str) -> Option<&str> {
        match self.params.get(key) {
            Some(Json::String(value)) => Some(value),
            _ => None,
        }
    }

    pub fn usize(&self, key: &str, default: usize) -> usize {
        match self.params.get(key) {
            // Guarded rather than cast blindly: a negative or fractional count
            // becomes a very large `usize` and turns a limit into no limit.
            Some(Json::Number(value)) if *value >= 0.0 && value.is_finite() => *value as usize,
            _ => default,
        }
    }

    pub fn bool(&self, key: &str, default: bool) -> bool {
        match self.params.get(key) {
            Some(Json::Bool(value)) => *value,
            _ => default,
        }
    }

    pub fn string_list(&self, key: &str) -> Vec<String> {
        match self.params.get(key) {
            Some(Json::Array(items)) => items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
            _ => Vec::new(),
        }
    }
}

/// Builds `{"id":…,"ok":true,"result":…}` as one line.
pub fn success(id: &str, result: Json) -> String {
    let mut map = BTreeMap::new();
    map.insert("id".to_string(), Json::String(id.to_string()));
    map.insert("ok".to_string(), Json::Bool(true));
    map.insert("result".to_string(), result);
    Json::Object(map).to_compact()
}

/// Builds `{"id":…,"ok":false,"error":…}` as one line.
///
/// A failed operation is still a *successful* exchange: the bridge answers and
/// stays up. Exiting on a bad request would take down every other pending call
/// with it.
pub fn failure(id: &str, message: impl Into<String>) -> String {
    let mut map = BTreeMap::new();
    map.insert("id".to_string(), Json::String(id.to_string()));
    map.insert("ok".to_string(), Json::Bool(false));
    map.insert("error".to_string(), Json::String(message.into()));
    Json::Object(map).to_compact()
}

/// A JSON object from key/value pairs, which is most of what the handlers do.
pub fn object(pairs: Vec<(&str, Json)>) -> Json {
    Json::Object(
        pairs
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

pub fn strings(values: impl IntoIterator<Item = String>) -> Json {
    Json::Array(values.into_iter().map(Json::String).collect())
}

pub fn number(value: usize) -> Json {
    Json::Number(value as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_request() {
        let request =
            Request::parse(r#"{"id":"1","method":"ast.search","params":{"pattern":"f($A)"}}"#)
                .unwrap();
        assert_eq!(request.id, "1");
        assert_eq!(request.method, "ast.search");
        assert_eq!(request.string("pattern").unwrap(), "f($A)");
    }

    #[test]
    fn a_numeric_id_still_pairs() {
        let request = Request::parse(r#"{"id":7,"method":"x"}"#).unwrap();
        assert_eq!(request.id, "7");
    }

    #[test]
    fn missing_params_is_not_an_error() {
        let request = Request::parse(r#"{"id":"1","method":"walk.list"}"#).unwrap();
        assert!(request.params.is_empty());
    }

    #[test]
    fn a_required_field_reports_which_one() {
        let request = Request::parse(r#"{"id":"1","method":"x"}"#).unwrap();
        let error = request.string("pattern").unwrap_err();
        assert!(error.contains("pattern"), "{error}");
    }

    #[test]
    fn a_negative_count_falls_back_rather_than_wrapping() {
        // `-1 as usize` is 18446744073709551615, which would turn a limit into
        // no limit and walk an entire filesystem.
        let request = Request::parse(r#"{"id":"1","method":"x","params":{"limit":-1}}"#).unwrap();
        assert_eq!(request.usize("limit", 50), 50);
    }

    #[test]
    fn a_request_without_a_method_is_rejected() {
        assert!(Request::parse(r#"{"id":"1"}"#).is_err());
        assert!(Request::parse("not json").is_err());
        assert!(Request::parse("[]").is_err());
    }

    #[test]
    fn responses_are_one_line() {
        let ok = success("1", Json::String("done".into()));
        assert!(!ok.contains('\n'));
        assert!(ok.contains("\"ok\":true"));

        let bad = failure("1", "no such method");
        assert!(!bad.contains('\n'));
        assert!(bad.contains("\"ok\":false"));
    }
}
