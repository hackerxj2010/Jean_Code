//! A small backtracking regex engine.
//!
//! `pi-builtins` has no dependencies, so `grep`, `sed`, and `awk` need an engine
//! of their own. This one covers what shell pipelines actually use: character
//! classes, the three quantifiers plus `{m,n}`, alternation, groups, anchors,
//! and backreferences in a `sed` replacement.
//!
//! It backtracks, so a pathological pattern (`(a+)+b` against a long run of
//! `a`) can blow up. Rather than pretend otherwise, the matcher counts steps and
//! gives up with an error once it passes a budget: a pipeline that stops and
//! says "this pattern is too expensive" is recoverable, one that hangs is not.

/// How many matcher steps a single `is_match` may take before giving up.
///
/// Generous enough that no realistic pattern hits it, small enough that a
/// catastrophic one fails in milliseconds instead of wedging the shell.
const STEP_BUDGET: u32 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    /// One literal character.
    Char(char),
    /// `.` — any character except a newline.
    Any,
    /// A character class: `[a-z]`, `\d`, `\w`, `\s`, and their negations.
    Class { ranges: Vec<(char, char)>, negated: bool },
    /// `^`
    Start,
    /// `$`
    End,
    /// `\b` and `\B`
    WordBoundary { negated: bool },
    /// A group. `index` is `Some` when it captures.
    Group { alternatives: Vec<Vec<Node>>, index: Option<usize> },
    /// A quantified node. `greedy` is false for the `?`-suffixed forms.
    Repeat { node: Box<Node>, min: u32, max: u32, greedy: bool },
}

/// A compiled pattern.
#[derive(Debug, Clone)]
pub struct Regex {
    alternatives: Vec<Vec<Node>>,
    group_count: usize,
    ignore_case: bool,
    source: String,
}

/// Where a group matched, as byte offsets into the subject.
type Captures = Vec<Option<(usize, usize)>>;

struct Matcher {
    /// The subject as chars, with byte offsets, so a match can be sliced back
    /// out without re-walking the string.
    chars: Vec<(usize, char)>,
    /// Byte length of the subject, for the end-of-input offset.
    len: usize,
    ignore_case: bool,
    steps: u32,
}

impl Regex {
    pub fn new(pattern: &str, ignore_case: bool) -> Result<Self, String> {
        let mut parser = Parser {
            chars: pattern.chars().collect(),
            position: 0,
            group_count: 0,
        };
        let alternatives = parser.parse_alternatives()?;
        if parser.position < parser.chars.len() {
            return Err(format!(
                "unexpected `{}` at position {} in /{pattern}/",
                parser.chars[parser.position], parser.position
            ));
        }
        Ok(Regex {
            alternatives,
            group_count: parser.group_count,
            ignore_case,
            source: pattern.to_string(),
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    /// Whether the pattern matches anywhere in `text`.
    pub fn is_match(&self, text: &str) -> bool {
        self.find(text).is_some()
    }

    /// Whether the pattern matches the entire line, as `grep -x` requires.
    pub fn matches_whole(&self, text: &str) -> bool {
        match self.find(text) {
            Some(found) => found.start == 0 && found.end == text.len(),
            None => false,
        }
    }

    /// The leftmost match.
    pub fn find(&self, text: &str) -> Option<Match> {
        self.find_from(text, 0)
    }

    /// The leftmost match at or after `from` (a byte offset).
    pub fn find_from(&self, text: &str, from: usize) -> Option<Match> {
        let mut matcher = Matcher {
            chars: text.char_indices().collect(),
            len: text.len(),
            ignore_case: self.ignore_case,
            steps: 0,
        };

        let start_index = matcher
            .chars
            .iter()
            .position(|(offset, _)| *offset >= from)
            .unwrap_or(matcher.chars.len());

        for index in start_index..=matcher.chars.len() {
            let mut captures: Captures = vec![None; self.group_count + 1];
            for alternative in &self.alternatives {
                if let Some(end) = matcher.match_sequence(alternative, index, &mut captures) {
                    let start_offset = matcher.offset(index);
                    let end_offset = matcher.offset(end);
                    captures[0] = Some((start_offset, end_offset));
                    return Some(Match {
                        start: start_offset,
                        end: end_offset,
                        text: text[start_offset..end_offset].to_string(),
                        groups: captures
                            .iter()
                            .map(|span| span.map(|(s, e)| text[s..e].to_string()))
                            .collect(),
                    });
                }
                // Reset between alternatives: a partial match must not leave
                // captures behind for the next one to read.
                captures.iter_mut().for_each(|slot| *slot = None);
            }
            if matcher.steps > STEP_BUDGET {
                return None;
            }
        }
        None
    }

    /// Every non-overlapping match, left to right.
    pub fn find_all(&self, text: &str) -> Vec<Match> {
        let mut found = Vec::new();
        let mut position = 0;

        while position <= text.len() {
            let Some(hit) = self.find_from(text, position) else { break };
            // An empty match would loop forever without this: advance one
            // character past it and keep going.
            position = if hit.end > hit.start {
                hit.end
            } else {
                next_char_boundary(text, hit.end)
            };
            found.push(hit);
        }
        found
    }

    /// Replaces the first match, or every match when `global`.
    ///
    /// `$1`/`\1` in the replacement expand to captured groups, and `&` to the
    /// whole match — the `sed` conventions, since that is the caller.
    pub fn replace(&self, text: &str, replacement: &str, global: bool) -> String {
        let matches = if global {
            self.find_all(text)
        } else {
            self.find(text).into_iter().collect()
        };

        if matches.is_empty() {
            return text.to_string();
        }

        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for hit in &matches {
            out.push_str(&text[last..hit.start]);
            out.push_str(&expand(replacement, hit));
            last = hit.end;
        }
        out.push_str(&text[last..]);
        out
    }
}

/// One match, with its captures.
#[derive(Debug, Clone)]
pub struct Match {
    pub start: usize,
    pub end: usize,
    pub text: String,
    /// Index 0 is the whole match; the rest are groups in open-paren order.
    pub groups: Vec<Option<String>>,
}

impl Match {
    pub fn group(&self, index: usize) -> Option<&str> {
        self.groups.get(index).and_then(|g| g.as_deref())
    }
}

/// Expands `$1`, `\1`, and `&` in a replacement.
fn expand(replacement: &str, hit: &Match) -> String {
    let chars: Vec<char> = replacement.chars().collect();
    let mut out = String::new();
    let mut index = 0;

    while index < chars.len() {
        let c = chars[index];

        if (c == '$' || c == '\\') && index + 1 < chars.len() {
            let next = chars[index + 1];

            if let Some(digit) = next.to_digit(10) {
                let group = if c == '$' { hit.group(digit as usize) } else { hit.group(digit as usize) };
                out.push_str(group.unwrap_or(""));
                index += 2;
                continue;
            }

            if c == '\\' {
                // `\n` and `\t` are the escapes sed scripts actually carry.
                out.push(match next {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    other => other,
                });
                index += 2;
                continue;
            }
        }

        if c == '&' {
            out.push_str(&hit.text);
            index += 1;
            continue;
        }

        out.push(c);
        index += 1;
    }
    out
}

fn next_char_boundary(text: &str, from: usize) -> usize {
    let mut index = from + 1;
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

// ---- parser ---------------------------------------------------------------

struct Parser {
    chars: Vec<char>,
    position: usize,
    group_count: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.position).copied()
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.position += 1;
        }
        c
    }

    fn parse_alternatives(&mut self) -> Result<Vec<Vec<Node>>, String> {
        let mut alternatives = vec![self.parse_sequence()?];
        while self.peek() == Some('|') {
            self.position += 1;
            alternatives.push(self.parse_sequence()?);
        }
        Ok(alternatives)
    }

    fn parse_sequence(&mut self) -> Result<Vec<Node>, String> {
        let mut nodes = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let node = self.parse_atom()?;
            nodes.push(self.parse_quantifier(node)?);
        }
        Ok(nodes)
    }

    fn parse_quantifier(&mut self, node: Node) -> Result<Node, String> {
        let (min, max) = match self.peek() {
            Some('*') => {
                self.position += 1;
                (0, u32::MAX)
            }
            Some('+') => {
                self.position += 1;
                (1, u32::MAX)
            }
            Some('?') => {
                self.position += 1;
                (0, 1)
            }
            Some('{') => match self.parse_bounds()? {
                Some(bounds) => bounds,
                // `{` that is not a valid bound is a literal brace, which is
                // what every shell regex user expects from `a{b`.
                None => return Ok(node),
            },
            _ => return Ok(node),
        };

        // A trailing `?` makes the quantifier lazy.
        let greedy = if self.peek() == Some('?') {
            self.position += 1;
            false
        } else {
            true
        };

        Ok(Node::Repeat { node: Box::new(node), min, max, greedy })
    }

    /// Parses `{m}`, `{m,}`, or `{m,n}`. Returns `None` — without consuming —
    /// when the braces do not form a bound.
    fn parse_bounds(&mut self) -> Result<Option<(u32, u32)>, String> {
        let start = self.position;
        self.position += 1; // `{`

        let mut minimum = String::new();
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            minimum.push(self.next().unwrap());
        }

        if minimum.is_empty() {
            self.position = start;
            return Ok(None);
        }

        let min: u32 = minimum.parse().map_err(|_| format!("bound too large: {minimum}"))?;

        match self.peek() {
            Some('}') => {
                self.position += 1;
                Ok(Some((min, min)))
            }
            Some(',') => {
                self.position += 1;
                let mut maximum = String::new();
                while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                    maximum.push(self.next().unwrap());
                }
                if self.peek() != Some('}') {
                    self.position = start;
                    return Ok(None);
                }
                self.position += 1;
                let max = if maximum.is_empty() {
                    u32::MAX
                } else {
                    maximum.parse().map_err(|_| format!("bound too large: {maximum}"))?
                };
                if max < min {
                    return Err(format!("bound {{{min},{max}}} counts backwards"));
                }
                Ok(Some((min, max)))
            }
            _ => {
                self.position = start;
                Ok(None)
            }
        }
    }

    fn parse_atom(&mut self) -> Result<Node, String> {
        let c = self.next().ok_or("unexpected end of pattern")?;

        match c {
            '.' => Ok(Node::Any),
            '^' => Ok(Node::Start),
            '$' => Ok(Node::End),

            '(' => {
                // `(?:` opens a non-capturing group.
                let capturing = if self.peek() == Some('?') {
                    if self.chars.get(self.position + 1) == Some(&':') {
                        self.position += 2;
                        false
                    } else {
                        return Err("only `(?:` is supported for group flags".to_string());
                    }
                } else {
                    true
                };

                // The index is assigned before parsing the body so nested
                // groups number in open-paren order, as every regex flavour does.
                let index = if capturing {
                    self.group_count += 1;
                    Some(self.group_count)
                } else {
                    None
                };

                let alternatives = self.parse_alternatives()?;
                if self.next() != Some(')') {
                    return Err("unclosed `(`".to_string());
                }
                Ok(Node::Group { alternatives, index })
            }

            '[' => self.parse_class(),

            '\\' => {
                let escaped = self.next().ok_or("pattern ends with a backslash")?;
                Ok(escape_node(escaped))
            }

            ')' => Err("unmatched `)`".to_string()),

            literal => Ok(Node::Char(literal)),
        }
    }

    fn parse_class(&mut self) -> Result<Node, String> {
        let negated = if self.peek() == Some('^') {
            self.position += 1;
            true
        } else {
            false
        };

        let mut ranges: Vec<(char, char)> = Vec::new();
        let mut first = true;

        loop {
            let c = self.next().ok_or("unclosed `[`")?;

            // `]` as the first member is a literal `]`, per POSIX.
            if c == ']' && !first {
                break;
            }
            first = false;

            let low = if c == '\\' {
                let escaped = self.next().ok_or("class ends with a backslash")?;
                match escape_node(escaped) {
                    Node::Char(literal) => literal,
                    Node::Class { ranges: mut nested, negated: false } => {
                        ranges.append(&mut nested);
                        continue;
                    }
                    // A negated shorthand inside a class (`[\D]`) would need set
                    // subtraction to be correct; refusing beats getting it wrong.
                    _ => return Err(format!("`\\{escaped}` is not supported inside `[...]`")),
                }
            } else {
                c
            };

            // A `-` at either end of the class is a literal hyphen.
            if self.peek() == Some('-') && self.chars.get(self.position + 1) != Some(&']') {
                self.position += 1;
                let high_raw = self.next().ok_or("unclosed range")?;
                let high = if high_raw == '\\' {
                    match escape_node(self.next().ok_or("range ends with a backslash")?) {
                        Node::Char(literal) => literal,
                        _ => return Err("a range endpoint must be a single character".to_string()),
                    }
                } else {
                    high_raw
                };
                if high < low {
                    return Err(format!("range [{low}-{high}] counts backwards"));
                }
                ranges.push((low, high));
            } else {
                ranges.push((low, low));
            }
        }

        if ranges.is_empty() {
            return Err("empty character class".to_string());
        }
        Ok(Node::Class { ranges, negated })
    }
}

/// The node for a backslash escape.
fn escape_node(escaped: char) -> Node {
    match escaped {
        'd' => Node::Class { ranges: vec![('0', '9')], negated: false },
        'D' => Node::Class { ranges: vec![('0', '9')], negated: true },
        'w' => Node::Class { ranges: word_ranges(), negated: false },
        'W' => Node::Class { ranges: word_ranges(), negated: true },
        's' => Node::Class { ranges: space_ranges(), negated: false },
        'S' => Node::Class { ranges: space_ranges(), negated: true },
        'b' => Node::WordBoundary { negated: false },
        'B' => Node::WordBoundary { negated: true },
        'n' => Node::Char('\n'),
        't' => Node::Char('\t'),
        'r' => Node::Char('\r'),
        '0' => Node::Char('\0'),
        literal => Node::Char(literal),
    }
}

fn word_ranges() -> Vec<(char, char)> {
    vec![('a', 'z'), ('A', 'Z'), ('0', '9'), ('_', '_')]
}

fn space_ranges() -> Vec<(char, char)> {
    vec![(' ', ' '), ('\t', '\t'), ('\n', '\n'), ('\r', '\r'), ('\x0b', '\x0c')]
}

// ---- matcher --------------------------------------------------------------

impl Matcher {
    /// Byte offset of char `index`; the subject's length at the end.
    fn offset(&self, index: usize) -> usize {
        self.chars.get(index).map(|(offset, _)| *offset).unwrap_or(self.len)
    }

    fn char_at(&self, index: usize) -> Option<char> {
        self.chars.get(index).map(|(_, c)| *c)
    }

    fn is_word(&self, index: usize) -> bool {
        match self.char_at(index) {
            Some(c) => c.is_alphanumeric() || c == '_',
            None => false,
        }
    }

    /// Matches `nodes` starting at char `index`, returning the char index just
    /// past the match.
    fn match_sequence(
        &mut self,
        nodes: &[Node],
        index: usize,
        captures: &mut Captures,
    ) -> Option<usize> {
        self.steps += 1;
        if self.steps > STEP_BUDGET {
            return None;
        }

        let Some((first, rest)) = nodes.split_first() else {
            return Some(index);
        };

        match first {
            Node::Repeat { node, min, max, greedy } => {
                self.match_repeat(node, *min, *max, *greedy, rest, index, captures)
            }

            Node::Group { alternatives, index: group } => {
                for alternative in alternatives {
                    // Snapshot: a failed alternative must not leave its captures
                    // visible to the next one.
                    let saved = captures.clone();
                    let mut combined: Vec<Node> = alternative.clone();
                    let inner_end = self.match_sequence(&combined, index, captures);

                    if let Some(end) = inner_end {
                        if let Some(slot) = group {
                            if *slot < captures.len() {
                                captures[*slot] = Some((self.offset(index), self.offset(end)));
                            }
                        }
                        if let Some(final_end) = self.match_sequence(rest, end, captures) {
                            return Some(final_end);
                        }
                    }
                    combined.clear();
                    *captures = saved;
                }
                None
            }

            simple => {
                let end = self.match_one(simple, index)?;
                self.match_sequence(rest, end, captures)
            }
        }
    }

    /// Matches a single non-group, non-repeat node.
    fn match_one(&mut self, node: &Node, index: usize) -> Option<usize> {
        self.steps += 1;
        if self.steps > STEP_BUDGET {
            return None;
        }

        match node {
            Node::Start => {
                // Start of subject, or just after a newline: `grep` feeds one
                // line at a time, but `sed` on a buffer benefits from multiline.
                if index == 0 || self.char_at(index - 1) == Some('\n') {
                    Some(index)
                } else {
                    None
                }
            }

            Node::End => {
                if index == self.chars.len() || self.char_at(index) == Some('\n') {
                    Some(index)
                } else {
                    None
                }
            }

            Node::WordBoundary { negated } => {
                let before = index > 0 && self.is_word(index - 1);
                let after = self.is_word(index);
                let boundary = before != after;
                if boundary != *negated {
                    Some(index)
                } else {
                    None
                }
            }

            Node::Any => match self.char_at(index) {
                Some(c) if c != '\n' => Some(index + 1),
                _ => None,
            },

            Node::Char(expected) => {
                let actual = self.char_at(index)?;
                let equal = if self.ignore_case {
                    actual.eq_ignore_ascii_case(expected)
                        || actual.to_lowercase().eq(expected.to_lowercase())
                } else {
                    actual == *expected
                };
                if equal {
                    Some(index + 1)
                } else {
                    None
                }
            }

            Node::Class { ranges, negated } => {
                let actual = self.char_at(index)?;
                let mut inside = in_ranges(actual, ranges);

                if !inside && self.ignore_case {
                    // Try both cases rather than lowering the ranges, which
                    // would break `[A-Z]` under a case-insensitive search.
                    inside = actual
                        .to_lowercase()
                        .chain(actual.to_uppercase())
                        .any(|folded| in_ranges(folded, ranges));
                }

                if inside != *negated {
                    Some(index + 1)
                } else {
                    None
                }
            }

            // Handled by match_sequence; reaching here means a caller bypassed it.
            Node::Group { .. } | Node::Repeat { .. } => None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn match_repeat(
        &mut self,
        node: &Node,
        min: u32,
        max: u32,
        greedy: bool,
        rest: &[Node],
        index: usize,
        captures: &mut Captures,
    ) -> Option<usize> {
        // Collect every reachable end position, consuming as many repetitions
        // as possible. A repetition that consumes nothing would loop forever,
        // so the walk stops when the position stops advancing.
        let mut positions = vec![index];
        let mut current = index;
        let mut count = 0u32;

        while count < max {
            self.steps += 1;
            if self.steps > STEP_BUDGET {
                return None;
            }

            let single = std::slice::from_ref(node);
            let mut attempt = captures.clone();
            let Some(next) = self.match_sequence(single, current, &mut attempt) else { break };
            if next == current {
                break;
            }
            *captures = attempt;
            current = next;
            positions.push(current);
            count += 1;
        }

        if (positions.len() as u32) <= min && count < min {
            return None;
        }

        // Below `min` repetitions the match is invalid regardless of the tail.
        let lowest = min as usize;
        if positions.len() <= lowest && lowest > 0 {
            return None;
        }

        let candidates: Vec<usize> = if greedy {
            positions[lowest..].iter().rev().copied().collect()
        } else {
            positions[lowest..].to_vec()
        };

        for candidate in candidates {
            let saved = captures.clone();
            if let Some(end) = self.match_sequence(rest, candidate, captures) {
                return Some(end);
            }
            *captures = saved;
        }
        None
    }
}

fn in_ranges(c: char, ranges: &[(char, char)]) -> bool {
    ranges.iter().any(|(low, high)| c >= *low && c <= *high)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(pattern: &str, text: &str) -> bool {
        Regex::new(pattern, false).unwrap().is_match(text)
    }

    #[test]
    fn literals_and_dots() {
        assert!(matches("abc", "xxabcxx"));
        assert!(!matches("abc", "abx"));
        assert!(matches("a.c", "abc"));
        assert!(!matches("a.c", "a\nc"));
    }

    #[test]
    fn anchors_bind_to_the_line() {
        assert!(matches("^abc", "abc"));
        assert!(!matches("^abc", "xabc"));
        assert!(matches("abc$", "xxabc"));
        assert!(matches("^b", "a\nb"));
    }

    #[test]
    fn quantifiers() {
        assert!(matches("ab*c", "ac"));
        assert!(matches("ab*c", "abbbc"));
        assert!(!matches("ab+c", "ac"));
        assert!(matches("ab?c", "abc"));
        assert!(matches("a{2,3}b", "aaab"));
        assert!(!matches("a{4,}b", "aaab"));
    }

    #[test]
    fn lazy_quantifiers_stop_early() {
        let regex = Regex::new("<.+?>", false).unwrap();
        assert_eq!(regex.find("<a><b>").unwrap().text, "<a>");
        let greedy = Regex::new("<.+>", false).unwrap();
        assert_eq!(greedy.find("<a><b>").unwrap().text, "<a><b>");
    }

    #[test]
    fn classes_and_shorthands() {
        assert!(matches("[a-z]+", "hello"));
        assert!(!matches("^[a-z]+$", "Hello"));
        assert!(matches(r"\d{3}", "abc123"));
        assert!(matches(r"\w+", "some_name"));
        assert!(matches("[^0-9]", "a"));
        assert!(!matches("^[^0-9]$", "5"));
    }

    #[test]
    fn a_literal_bracket_first_in_a_class() {
        assert!(matches("[]]", "]"));
    }

    #[test]
    fn alternation_and_groups() {
        assert!(matches("cat|dog", "hotdog"));
        assert!(matches("(ab)+c", "ababc"));
        assert!(matches("(?:ab)+c", "ababc"));
    }

    #[test]
    fn word_boundaries() {
        // The bug this guards: `\b` written through a mangling heredoc becomes a
        // literal backspace byte and silently matches nothing.
        assert!(matches(r"\btoken\b", "a token here"));
        assert!(!matches(r"\btoken\b", "sessionToken"));
    }

    #[test]
    fn captures_are_numbered_by_open_paren() {
        let regex = Regex::new(r"(\w+)@(\w+)\.com", false).unwrap();
        let found = regex.find("mail: user@example.com").unwrap();
        assert_eq!(found.group(1), Some("user"));
        assert_eq!(found.group(2), Some("example"));
    }

    #[test]
    fn replacement_expands_groups() {
        let regex = Regex::new(r"(\w+) (\w+)", false).unwrap();
        assert_eq!(regex.replace("john smith", "$2 $1", false), "smith john");
        assert_eq!(regex.replace("john smith", r"\2 \1", false), "smith john");
    }

    #[test]
    fn global_replacement_hits_every_match() {
        let regex = Regex::new("a", false).unwrap();
        assert_eq!(regex.replace("banana", "o", true), "bonono");
        assert_eq!(regex.replace("banana", "o", false), "bonana");
    }

    #[test]
    fn ignore_case_folds_both_ways() {
        assert!(Regex::new("hello", true).unwrap().is_match("HELLO"));
        assert!(Regex::new("[a-z]+", true).unwrap().is_match("ABC"));
    }

    #[test]
    fn find_all_does_not_loop_on_empty_matches() {
        let regex = Regex::new("x*", false).unwrap();
        // Would hang before the boundary advance; the assertion is that it ends.
        assert!(regex.find_all("abc").len() <= 4);
    }

    #[test]
    fn a_catastrophic_pattern_gives_up_instead_of_hanging() {
        let regex = Regex::new("(a+)+b", false).unwrap();
        let subject = "a".repeat(40);
        assert!(!regex.is_match(&subject));
    }

    #[test]
    fn bad_patterns_are_rejected_with_a_reason() {
        assert!(Regex::new("(abc", false).is_err());
        assert!(Regex::new("[a-", false).is_err());
        assert!(Regex::new("[z-a]", false).unwrap_err().contains("backwards"));
        assert!(Regex::new(r"abc\", false).is_err());
    }

    #[test]
    fn a_brace_that_is_not_a_bound_is_a_literal() {
        assert!(matches("a{b", "a{b"));
    }
}
