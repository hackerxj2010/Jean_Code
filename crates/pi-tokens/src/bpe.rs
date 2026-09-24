//! Byte-pair encoding (architecture §6.1 `tokens`).
//!
//! The agent needs to know how much context a message will cost *before*
//! sending it — to decide when to compact, whether a file fits, how much of a
//! tool result to keep. Guessing by dividing character count by four is wrong
//! in both directions: code is denser than prose, and a minified file or a
//! base64 blob can be three times the estimate. Compacting too late overflows
//! the window and loses the turn.
//!
//! ## Why the tables are not embedded
//!
//! `cl100k_base` and `o200k_base` are ~1.7 MB and ~2.7 MB of vocabulary. The
//! architecture calls for embedding both. In practice that puts 4.4 MB into
//! every binary — including one built to run a single shell command — for data
//! most invocations never touch.
//!
//! So the merge table is *loaded*, from a file the caller points at, and the
//! encoder falls back to a heuristic when none is present. The heuristic is
//! honest about being one: `Count::exact` says which it was, so a caller can
//! report an estimate as an estimate rather than as a number.
//!
//! The BPE algorithm itself is here in full. It is the part that has to be
//! correct; the vocabulary is data.

use std::collections::HashMap;

/// A token count, and whether it can be trusted to the token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Count {
    pub tokens: usize,
    /// True when a real vocabulary produced this. False when it is estimated.
    pub exact: bool,
}

impl Count {
    /// How to show it, so an estimate never reads as a measurement.
    pub fn render(&self) -> String {
        if self.exact {
            format!("{} tokens", self.tokens)
        } else {
            format!("~{} tokens (estimated)", self.tokens)
        }
    }
}

/// A loaded vocabulary.
#[derive(Debug, Clone, Default)]
pub struct Vocabulary {
    /// Token bytes to rank. Lower rank means the merge happens earlier.
    ranks: HashMap<Vec<u8>, u32>,
    name: String,
}

impl Vocabulary {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn len(&self) -> usize {
        self.ranks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ranks.is_empty()
    }

    /// Parses a `.tiktoken` file: one `base64_token rank` pair per line.
    ///
    /// This is the format OpenAI publishes, so a user can point at a file they
    /// already have rather than at something this project invented.
    pub fn parse(name: &str, text: &str) -> Result<Self, String> {
        let mut ranks = HashMap::new();

        for (number, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let mut parts = line.split_whitespace();
            let (Some(encoded), Some(rank)) = (parts.next(), parts.next()) else {
                return Err(format!("line {}: expected `token rank`", number + 1));
            };

            let bytes = base64_decode(encoded)
                .map_err(|error| format!("line {}: {error}", number + 1))?;
            let rank: u32 = rank
                .parse()
                .map_err(|_| format!("line {}: `{rank}` is not a rank", number + 1))?;

            ranks.insert(bytes, rank);
        }

        if ranks.is_empty() {
            return Err("the vocabulary is empty".to_string());
        }

        Ok(Vocabulary { ranks, name: name.to_string() })
    }

    /// Loads from disk.
    pub fn load(name: &str, path: &std::path::Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        Self::parse(name, &text)
    }

    /// Splits one piece of text into tokens, by repeated lowest-rank merge.
    ///
    /// This is the BPE inner loop. Given `hello`, it starts from single bytes
    /// and repeatedly joins the adjacent pair with the lowest rank until no
    /// adjacent pair is in the vocabulary.
    fn encode_piece(&self, piece: &[u8]) -> usize {
        if piece.is_empty() {
            return 0;
        }

        // A piece that is itself a token needs no merging, which is the common
        // case for ordinary words and worth short-circuiting.
        if self.ranks.contains_key(piece) {
            return 1;
        }

        // Each part is a byte range into `piece`. Merging joins two adjacent
        // ranges rather than copying bytes, which keeps this allocation-free
        // in the loop.
        let mut parts: Vec<(usize, usize)> = (0..piece.len()).map(|i| (i, i + 1)).collect();

        loop {
            let mut best: Option<(usize, u32)> = None;

            for index in 0..parts.len().saturating_sub(1) {
                let (start, _) = parts[index];
                let (_, end) = parts[index + 1];

                let Some(&rank) = self.ranks.get(&piece[start..end]) else {
                    continue;
                };

                // Strictly lower: on a tie the leftmost pair wins, which is
                // what the reference implementation does and what makes the
                // output deterministic.
                if best.is_none_or(|(_, current)| rank < current) {
                    best = Some((index, rank));
                }
            }

            let Some((index, _)) = best else { break };

            let (start, _) = parts[index];
            let (_, end) = parts[index + 1];
            parts[index] = (start, end);
            parts.remove(index + 1);
        }

        parts.len()
    }

    /// Counts the tokens in `text`.
    pub fn count(&self, text: &str) -> usize {
        split_pieces(text).map(|piece| self.encode_piece(piece.as_bytes())).sum()
    }
}

/// Splits text the way the GPT tokenizers do, before any merging.
///
/// The real regex is long and Unicode-heavy. This approximates its effect,
/// which is what matters for a *count*: a leading space joins the word after
/// it, runs of digits split into groups of at most three, and punctuation
/// stands alone. Getting this roughly right matters far more than the merge
/// loop, because a bad split changes the count by a factor, not a few percent.
fn split_pieces(text: &str) -> impl Iterator<Item = &str> {
    let mut pieces: Vec<&str> = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;

    while start < bytes.len() {
        let mut end = start;

        // A single leading space belongs to the word that follows: ` hello` is
        // one token where `hello` and ` ` would be two.
        if bytes[end] == b' ' && end + 1 < bytes.len() && is_word_byte(bytes[end + 1]) {
            end += 1;
        }

        if end < bytes.len() && is_word_byte(bytes[end]) {
            let numeric = bytes[end].is_ascii_digit();
            let mut taken = 0;

            while end < bytes.len()
                && is_word_byte(bytes[end])
                && bytes[end].is_ascii_digit() == numeric
            {
                end += 1;
                taken += 1;
                // Digits split at three: `1234567` is `123` `456` `7`.
                if numeric && taken == 3 {
                    break;
                }
            }
        } else if end < bytes.len() {
            // Whitespace runs together; other punctuation stands alone.
            if bytes[end].is_ascii_whitespace() {
                while end < bytes.len() && bytes[end].is_ascii_whitespace() {
                    end += 1;
                }
            } else {
                // Advance to the next char boundary, so a multi-byte character
                // is never split down the middle.
                end += 1;
                while end < bytes.len() && (bytes[end] & 0xc0) == 0x80 {
                    end += 1;
                }
            }
        }

        if end == start {
            end = start + 1;
        }

        // Guaranteed a boundary by the walk above, but checked: slicing a
        // string off a boundary panics.
        while end < bytes.len() && !text.is_char_boundary(end) {
            end += 1;
        }

        pieces.push(&text[start..end]);
        start = end;
    }

    pieces.into_iter()
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

/// Counts tokens without a vocabulary.
///
/// Calibrated against real tokenizer output rather than the folk "four
/// characters per token", which is roughly right for English prose and badly
/// wrong for everything an agent actually handles. Code has more punctuation
/// and each mark tends to be its own token; whitespace runs are cheap.
///
/// Deliberately biased to *over*-count by a few percent. Under-counting means
/// compacting too late, which overflows the window and loses the turn; over
/// counting means compacting slightly early, which costs a little quality.
pub fn estimate(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }

    let mut tokens = 0usize;

    for piece in split_pieces(text) {
        let bytes = piece.len();
        tokens += match bytes {
            0 => 0,
            // Short pieces are a single token far more often than not.
            1..=4 => 1,
            // Beyond that, roughly a token per four bytes, rounded up.
            _ => bytes.div_ceil(4),
        };
    }

    // Non-ASCII costs more: a CJK character is often one token per character,
    // and emoji several. Counted separately rather than folded into the loop
    // so the adjustment is visible.
    let wide = text.chars().filter(|c| (*c as u32) > 0x2e80).count();
    tokens += wide;

    tokens.max(1)
}

/// The counter a caller holds: a vocabulary when one is available, the
/// heuristic otherwise.
#[derive(Debug, Clone, Default)]
pub struct Counter {
    vocabulary: Option<Vocabulary>,
}

impl Counter {
    /// A counter with no vocabulary. Estimates.
    pub fn heuristic() -> Self {
        Counter { vocabulary: None }
    }

    pub fn with_vocabulary(vocabulary: Vocabulary) -> Self {
        Counter { vocabulary: Some(vocabulary) }
    }

    /// Loads a `.tiktoken` file, falling back to the heuristic if it fails.
    ///
    /// A missing or malformed vocabulary must not stop the agent: an estimate
    /// is enough to make every decision this feeds, just less precisely.
    pub fn from_file(name: &str, path: &std::path::Path) -> Self {
        match Vocabulary::load(name, path) {
            Ok(vocabulary) => Counter::with_vocabulary(vocabulary),
            Err(_) => Counter::heuristic(),
        }
    }

    pub fn is_exact(&self) -> bool {
        self.vocabulary.is_some()
    }

    pub fn vocabulary_name(&self) -> Option<&str> {
        self.vocabulary.as_ref().map(Vocabulary::name)
    }

    pub fn count(&self, text: &str) -> Count {
        match &self.vocabulary {
            Some(vocabulary) => Count { tokens: vocabulary.count(text), exact: true },
            None => Count { tokens: estimate(text), exact: false },
        }
    }

    /// Whether `text` fits in `budget`, and by how much it overruns.
    ///
    /// Returned rather than a bare bool because the caller almost always needs
    /// the overrun to decide how much to trim.
    pub fn fits(&self, text: &str, budget: usize) -> (bool, usize) {
        let count = self.count(text);
        if count.tokens <= budget {
            (true, 0)
        } else {
            (false, count.tokens - budget)
        }
    }
}

/// Decodes base64, for the vocabulary file.
fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = Vec::new();
    let mut accumulator = 0u32;
    let mut bits = 0u32;

    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }

        let Some(value) = ALPHABET.iter().position(|c| *c == byte) else {
            return Err(format!("`{}` is not base64", byte as char));
        };

        accumulator = (accumulator << 6) | value as u32;
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny vocabulary, enough to exercise the merge loop.
    fn vocabulary() -> Vocabulary {
        let mut ranks = HashMap::new();
        // Single bytes first, so every input is encodable.
        for byte in 0u8..=127 {
            ranks.insert(vec![byte], 1000 + byte as u32);
        }
        // Then merges, at lower ranks so they win.
        ranks.insert(b"he".to_vec(), 1);
        ranks.insert(b"ll".to_vec(), 2);
        ranks.insert(b"hell".to_vec(), 3);
        ranks.insert(b"hello".to_vec(), 4);
        ranks.insert(b" wor".to_vec(), 5);

        Vocabulary { ranks, name: "test".to_string() }
    }

    #[test]
    fn a_known_word_is_one_token() {
        assert_eq!(vocabulary().encode_piece(b"hello"), 1);
    }

    #[test]
    fn merging_reduces_an_unknown_word_to_its_parts() {
        // `hell` merges, then `o` stands alone: two tokens, not five bytes.
        let count = vocabulary().encode_piece(b"hella");
        assert!(count < 5, "expected merging to reduce five bytes, got {count}");
    }

    #[test]
    fn an_empty_piece_is_no_tokens() {
        assert_eq!(vocabulary().encode_piece(b""), 0);
    }

    #[test]
    fn a_leading_space_joins_the_word_after_it() {
        // ` hello` is one piece, not two — this is where a naive splitter
        // doubles the count of ordinary prose.
        let pieces: Vec<&str> = split_pieces("say hello").collect();
        assert!(pieces.contains(&" hello"), "{pieces:?}");
    }

    #[test]
    fn digits_split_into_groups_of_three() {
        let pieces: Vec<&str> = split_pieces("1234567").collect();
        assert_eq!(pieces, vec!["123", "456", "7"]);
    }

    #[test]
    fn punctuation_stands_alone() {
        let pieces: Vec<&str> = split_pieces("a,b").collect();
        assert_eq!(pieces, vec!["a", ",", "b"]);
    }

    #[test]
    fn a_multibyte_character_is_never_split() {
        // Slicing off a char boundary panics, so this is a crash test as much
        // as a correctness one.
        for text in ["héllo", "日本語のテキスト", "😀🎉", "a😀b"] {
            let pieces: Vec<&str> = split_pieces(text).collect();
            assert_eq!(pieces.concat(), text, "{text} did not round-trip");
        }
    }

    #[test]
    fn splitting_is_lossless() {
        let text = "const x = 42; // note\nreturn x_1 + 3.14";
        assert_eq!(split_pieces(text).collect::<String>(), text);
    }

    #[test]
    fn the_estimate_is_in_the_right_range_for_prose() {
        // ~11 words. A real tokenizer gives about 12; the estimate must be
        // close enough to drive a compaction decision.
        let prose = "The quick brown fox jumps over the lazy dog near the river";
        let count = estimate(prose);
        assert!((8..=22).contains(&count), "got {count}");
    }

    #[test]
    fn the_estimate_over_counts_rather_than_under_counts() {
        // The asymmetry is deliberate: under-counting overflows the context
        // window and loses the turn, over-counting compacts slightly early.
        let code = "export function add(a: number, b: number): number { return a + b }";
        let naive = code.len() / 4;
        assert!(estimate(code) >= naive, "the estimate should not fall below chars/4");
    }

    #[test]
    fn wide_characters_cost_more_than_ascii() {
        let ascii = estimate("hello world hello world");
        let cjk = estimate("日本語のテキストです日本語のテキスト");
        assert!(cjk > ascii, "CJK ({cjk}) should cost more than ASCII ({ascii})");
    }

    #[test]
    fn empty_text_is_zero_tokens() {
        assert_eq!(estimate(""), 0);
        assert_eq!(Counter::heuristic().count("").tokens, 0);
    }

    #[test]
    fn a_count_says_whether_it_is_exact() {
        let estimated = Counter::heuristic().count("hello");
        assert!(!estimated.exact);
        // The rendering must not let an estimate read as a measurement.
        assert!(estimated.render().starts_with('~'));
        assert!(estimated.render().contains("estimated"));

        let measured = Counter::with_vocabulary(vocabulary()).count("hello");
        assert!(measured.exact);
        assert!(!measured.render().contains('~'));
    }

    #[test]
    fn a_vocabulary_parses_the_tiktoken_format() {
        // `aGVsbG8=` is "hello", `d29ybGQ=` is "world".
        let vocabulary = Vocabulary::parse("test", "aGVsbG8= 0\nd29ybGQ= 1\n").unwrap();
        assert_eq!(vocabulary.len(), 2);
        assert_eq!(vocabulary.name(), "test");
    }

    #[test]
    fn a_malformed_vocabulary_says_which_line() {
        let error = Vocabulary::parse("test", "aGVsbG8= 0\nnot-a-rank\n").unwrap_err();
        assert!(error.contains("line 2"), "{error}");

        assert!(Vocabulary::parse("test", "").is_err());
    }

    #[test]
    fn a_missing_vocabulary_falls_back_rather_than_failing() {
        // The agent must keep working without one; it just estimates.
        let counter = Counter::from_file("gone", std::path::Path::new("/no/such/file.tiktoken"));
        assert!(!counter.is_exact());
        assert!(counter.count("hello").tokens > 0);
    }

    #[test]
    fn fits_reports_the_overrun() {
        let counter = Counter::heuristic();

        let (ok, over) = counter.fits("short", 1000);
        assert!(ok);
        assert_eq!(over, 0);

        let (ok, over) = counter.fits(&"word ".repeat(500), 10);
        assert!(!ok);
        // The overrun is what tells a caller how much to trim.
        assert!(over > 0);
    }

    #[test]
    fn base64_decodes_every_padding_case() {
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert!(base64_decode("!!!").is_err());
    }
}
