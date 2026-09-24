//! An inverted index with BM25 ranking.
//!
//! Recall has to be better than substring search or the agent gets the wrong
//! memory, and worse than a vector database is fine — an embedding model would
//! mean a network call on every recall and a dependency this crate will not
//! take. BM25 over an inverted index is the well-understood middle: it ranks by
//! how distinctive a term is, so "the" contributes nothing and "hashline"
//! contributes a lot.

use std::collections::HashMap;

/// BM25's term-frequency saturation. Above this, repeating a word stops helping
/// — which is what stops a document that says "cache" forty times from beating
/// one that answers the question.
const K1: f64 = 1.2;

/// How much document length is normalised away. 0.75 is the standard value: a
/// long document is penalised, but not so much that a thorough note loses to a
/// one-line one that happens to be short.
const B: f64 = 0.75;

#[derive(Debug, Default, Clone)]
pub struct Index {
    /// term -> (document id -> count in that document)
    postings: HashMap<String, HashMap<u64, u32>>,
    /// document id -> term count
    lengths: HashMap<u64, usize>,
    total_length: usize,
}

impl Index {
    pub fn new() -> Self {
        Index::default()
    }

    pub fn len(&self) -> usize {
        self.lengths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lengths.is_empty()
    }

    /// Adds or replaces a document.
    pub fn insert(&mut self, id: u64, text: &str) {
        // Replacing means removing first, or the old terms keep matching a
        // document whose text no longer contains them.
        self.remove(id);

        let terms = tokenize(text);
        for term in &terms {
            *self.postings.entry(term.clone()).or_default().entry(id).or_insert(0) += 1;
        }

        self.lengths.insert(id, terms.len());
        self.total_length += terms.len();
    }

    pub fn remove(&mut self, id: u64) {
        let Some(length) = self.lengths.remove(&id) else { return };
        self.total_length = self.total_length.saturating_sub(length);

        // Empty postings are pruned, or the index grows forever across edits.
        self.postings.retain(|_, documents| {
            documents.remove(&id);
            !documents.is_empty()
        });
    }

    /// Ranks documents against a query, best first.
    pub fn search(&self, query: &str, limit: usize) -> Vec<(u64, f64)> {
        if self.lengths.is_empty() {
            return Vec::new();
        }

        let average_length = self.total_length as f64 / self.lengths.len() as f64;
        let count = self.lengths.len() as f64;
        let mut scores: HashMap<u64, f64> = HashMap::new();

        for term in tokenize(query) {
            let Some(documents) = self.postings.get(&term) else { continue };

            // Inverse document frequency: a term in every document tells the
            // ranking nothing, and this drives its contribution to zero.
            let appearances = documents.len() as f64;
            let idf = ((count - appearances + 0.5) / (appearances + 0.5) + 1.0).ln();

            for (id, frequency) in documents {
                let length = *self.lengths.get(id).unwrap_or(&0) as f64;
                let tf = *frequency as f64;
                let normalised = tf * (K1 + 1.0)
                    / (tf + K1 * (1.0 - B + B * length / average_length.max(1.0)));
                *scores.entry(*id).or_insert(0.0) += idf * normalised;
            }
        }

        let mut ranked: Vec<(u64, f64)> = scores.into_iter().collect();
        // Ties break by id so results are deterministic: an agent comparing two
        // runs should not see them differ over an ordering coin flip.
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
        ranked.truncate(limit);
        ranked
    }

    /// Documents containing every term in the query, unranked.
    ///
    /// For the case where recall must be exact — "which memories mention this
    /// exact file" — and a ranked list would bury the answer.
    pub fn search_all_terms(&self, query: &str) -> Vec<u64> {
        let terms = tokenize(query);
        if terms.is_empty() {
            return Vec::new();
        }

        let mut candidates: Option<Vec<u64>> = None;
        for term in &terms {
            let Some(documents) = self.postings.get(term) else { return Vec::new() };
            let ids: Vec<u64> = documents.keys().copied().collect();

            candidates = Some(match candidates {
                None => ids,
                Some(previous) => previous.into_iter().filter(|id| ids.contains(id)).collect(),
            });
        }

        let mut found = candidates.unwrap_or_default();
        found.sort_unstable();
        found
    }
}

/// Words that carry no signal and would otherwise dominate a short query.
const STOP_WORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "if", "then", "of", "to", "in", "on", "at", "by", "for",
    "with", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these",
    "those", "as", "from", "not", "no", "do", "does", "did", "so", "we", "i", "you",
];

/// Splits text into indexable terms.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut terms = Vec::new();

    for raw in text.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-') {
        if raw.is_empty() {
            continue;
        }
        let lower = raw.to_lowercase();

        if STOP_WORDS.contains(&lower.as_str()) {
            continue;
        }
        // A single character is never distinctive enough to rank on.
        if lower.chars().count() < 2 {
            continue;
        }

        terms.push(stem(&lower));

        // Identifiers are also indexed by their parts, so a search for "loop"
        // finds `runAgentLoop` and a search for the whole name still works.
        for part in split_identifier(&lower) {
            if part.chars().count() >= 3 && part != lower {
                terms.push(stem(&part));
            }
        }
    }

    terms
}

/// Splits `camelCase`, `snake_case`, and `kebab-case` into parts.
fn split_identifier(word: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    for chunk in word.split(['_', '-']) {
        if chunk.is_empty() {
            continue;
        }
        // The input is already lowercased, so camel-case boundaries are gone;
        // splitting on digits is what remains and it catches `sha256sum`.
        let mut current = String::new();
        let mut previous_digit = false;
        for c in chunk.chars() {
            let digit = c.is_ascii_digit();
            if digit != previous_digit && !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            current.push(c);
            previous_digit = digit;
        }
        if !current.is_empty() {
            parts.push(current);
        }
    }
    parts
}

/// A conservative suffix stemmer.
///
/// Full Porter stemming turns "operating" into "oper", which makes recall worse
/// as often as better. This only collapses the endings that reliably mean the
/// same word: plurals and the common verb forms.
pub fn stem(word: &str) -> String {
    // Short words are left alone: stripping "s" from "gas" gives "ga".
    if word.chars().count() <= 3 {
        return word.to_string();
    }

    for suffix in ["ies", "ied"] {
        if let Some(root) = word.strip_suffix(suffix) {
            if root.chars().count() >= 2 {
                return format!("{root}y");
            }
        }
    }

    for suffix in ["sses", "shes", "ches", "xes", "zes"] {
        if let Some(root) = word.strip_suffix("es") {
            if word.ends_with(suffix) {
                return root.to_string();
            }
        }
    }

    for suffix in ["ing", "ed"] {
        if let Some(root) = word.strip_suffix(suffix) {
            if root.chars().count() >= 4 {
                // `running` -> `run`, not `runn`.
                let chars: Vec<char> = root.chars().collect();
                if chars.len() >= 2 && chars[chars.len() - 1] == chars[chars.len() - 2] {
                    return chars[..chars.len() - 1].iter().collect();
                }
                return root.to_string();
            }
        }
    }

    // `s` last, and not after another `s` — `class` must not become `clas`.
    if let Some(root) = word.strip_suffix('s') {
        if root.chars().count() >= 3 && !root.ends_with('s') && !root.ends_with('u') {
            return root.to_string();
        }
    }

    word.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_a_relevant_document_first() {
        let mut index = Index::new();
        index.insert(1, "the hashline format anchors patches by content hash");
        index.insert(2, "a shopping list with milk and bread");
        index.insert(3, "content addressed storage for checkpoints");

        let results = index.search("hashline patches", 5);
        assert_eq!(results[0].0, 1);
    }

    #[test]
    fn a_common_term_does_not_dominate() {
        let mut index = Index::new();
        for id in 1..=20 {
            index.insert(id, "the system uses a cache for the results");
        }
        index.insert(99, "the system uses a cache and the hashline anchors it");

        // Only document 99 has "hashline"; that must outweigh twenty documents
        // sharing every other word.
        let results = index.search("cache hashline", 5);
        assert_eq!(results[0].0, 99);
    }

    #[test]
    fn stop_words_are_ignored() {
        assert!(tokenize("the and of").is_empty());
        // A query of nothing but stop words matches nothing rather than
        // everything.
        let mut index = Index::new();
        index.insert(1, "some real content here");
        assert!(index.search("the and of", 5).is_empty());
    }

    #[test]
    fn identifiers_are_indexed_by_their_parts() {
        let mut index = Index::new();
        index.insert(1, "the run_agent_loop function drives everything");

        // Both the whole name and a part of it must find it.
        assert!(!index.search("run_agent_loop", 5).is_empty());
        assert!(!index.search("agent", 5).is_empty());
    }

    #[test]
    fn plurals_match_singulars() {
        let mut index = Index::new();
        index.insert(1, "the checkpoint stores files");
        assert!(!index.search("checkpoints", 5).is_empty());
        assert!(!index.search("file", 5).is_empty());
    }

    #[test]
    fn stemming_does_not_mangle_short_or_double_s_words() {
        // The failures a naive stemmer produces.
        assert_eq!(stem("gas"), "gas");
        assert_eq!(stem("class"), "class");
        assert_eq!(stem("status"), "status");
        assert_eq!(stem("running"), "run");
        assert_eq!(stem("stored"), "stor");
        assert_eq!(stem("queries"), "query");
    }

    #[test]
    fn replacing_a_document_removes_its_old_terms() {
        let mut index = Index::new();
        index.insert(1, "original content about hashline");
        index.insert(1, "replacement content about something else");

        assert!(index.search("hashline", 5).is_empty());
        assert!(!index.search("replacement", 5).is_empty());
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn removing_a_document_prunes_its_postings() {
        let mut index = Index::new();
        index.insert(1, "unique term zebra");
        index.remove(1);
        assert!(index.search("zebra", 5).is_empty());
        assert!(index.is_empty());
    }

    #[test]
    fn all_terms_search_requires_every_term() {
        let mut index = Index::new();
        index.insert(1, "alpha beta gamma");
        index.insert(2, "alpha delta");

        assert_eq!(index.search_all_terms("alpha beta"), vec![1]);
        assert_eq!(index.search_all_terms("alpha"), vec![1, 2]);
        assert!(index.search_all_terms("alpha epsilon").is_empty());
    }

    #[test]
    fn results_are_deterministic_across_runs() {
        let build = || {
            let mut index = Index::new();
            for id in 1..=10 {
                index.insert(id, "identical text in every document");
            }
            index.search("identical text", 10)
        };
        assert_eq!(build(), build());
    }

    #[test]
    fn searching_an_empty_index_is_safe() {
        assert!(Index::new().search("anything", 5).is_empty());
    }
}
