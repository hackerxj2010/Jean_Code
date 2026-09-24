//! Text-processing builtins (architecture §8.2).
//!
//! Every utility is a pure function over `&str`. Running them in-process
//! removes a fork and an exec per pipeline stage, and — more usefully — makes
//! them behave identically on Windows, where `sed`, `awk`, and `tr` are either
//! absent or subtly different from the GNU versions everyone writes for.

use std::collections::HashMap;

/// What a builtin produces.
///
/// Exit code included because pipelines branch on it, and a builtin that only
/// returned text could not express "no lines matched".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

impl Output {
    pub fn ok(stdout: impl Into<String>) -> Self {
        Self { stdout: stdout.into(), stderr: String::new(), code: 0 }
    }

    pub fn fail(stderr: impl Into<String>, code: i32) -> Self {
        Self { stdout: String::new(), stderr: stderr.into(), code }
    }

    pub fn is_ok(&self) -> bool {
        self.code == 0
    }
}

/// Splits into lines, dropping the empty produced by a trailing newline.
pub fn to_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// Joins lines with a trailing newline, as every text utility emits.
pub fn from_lines<S: AsRef<str>>(lines: &[S]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for line in lines {
        out.push_str(line.as_ref());
        out.push('\n');
    }
    out
}

// ---- head / tail ----------------------------------------------------------

pub fn head(text: &str, count: usize, by_bytes: bool) -> Output {
    if by_bytes {
        // Truncated on a character boundary: slicing a UTF-8 string mid-sequence
        // panics, and a byte count is only ever an approximation anyway.
        let end = text.char_indices().map(|(i, _)| i).take_while(|i| *i < count).last().unwrap_or(0);
        return Output::ok(&text[..end.min(text.len())]);
    }
    Output::ok(from_lines(&to_lines(text).into_iter().take(count).collect::<Vec<_>>()))
}

pub fn tail(text: &str, count: usize, by_bytes: bool) -> Output {
    if by_bytes {
        let start = text.len().saturating_sub(count);
        let boundary = text
            .char_indices()
            .map(|(i, _)| i)
            .find(|i| *i >= start)
            .unwrap_or(text.len());
        return Output::ok(&text[boundary..]);
    }
    let lines = to_lines(text);
    let start = lines.len().saturating_sub(count);
    Output::ok(from_lines(&lines[start..]))
}

// ---- wc -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub lines: usize,
    pub words: usize,
    pub bytes: usize,
    pub chars: usize,
}

pub fn wc(text: &str) -> Counts {
    Counts {
        lines: to_lines(text).len(),
        words: text.split_whitespace().count(),
        // Bytes and chars differ for anything non-ASCII, and `wc -c` means bytes.
        bytes: text.len(),
        chars: text.chars().count(),
    }
}

// ---- sort / uniq ----------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct SortOptions {
    pub numeric: bool,
    pub reverse: bool,
    pub unique: bool,
    pub ignore_case: bool,
    /// 1-based field to sort on, as `sort -k` counts.
    pub key: Option<usize>,
    pub separator: Option<char>,
}

pub fn sort(text: &str, options: &SortOptions) -> Output {
    let mut lines: Vec<String> = to_lines(text).into_iter().map(String::from).collect();

    let key_of = |line: &str| -> String {
        match options.key {
            None => line.to_string(),
            Some(index) => {
                let fields: Vec<&str> = match options.separator {
                    Some(sep) => line.split(sep).collect(),
                    None => line.split_whitespace().collect(),
                };
                fields.get(index.saturating_sub(1)).map(|s| s.to_string()).unwrap_or_default()
            }
        }
    };

    lines.sort_by(|a, b| {
        let (mut left, mut right) = (key_of(a), key_of(b));
        if options.ignore_case {
            left = left.to_lowercase();
            right = right.to_lowercase();
        }

        if options.numeric {
            // A non-numeric line sorts as zero, which is what GNU sort does.
            let na: f64 = left.trim().parse().unwrap_or(0.0);
            let nb: f64 = right.trim().parse().unwrap_or(0.0);
            return na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal);
        }
        // Byte comparison, not locale collation: a pipeline's output must not
        // depend on the machine's locale.
        left.cmp(&right)
    });

    if options.reverse {
        lines.reverse();
    }
    if options.unique {
        lines.dedup();
    }

    Output::ok(from_lines(&lines))
}

#[derive(Debug, Clone, Default)]
pub struct UniqOptions {
    pub count: bool,
    pub duplicates_only: bool,
    pub unique_only: bool,
    pub ignore_case: bool,
}

/// `uniq` collapses *adjacent* duplicates only, exactly as the real one does.
pub fn uniq(text: &str, options: &UniqOptions) -> Output {
    let mut groups: Vec<(String, usize)> = Vec::new();

    for line in to_lines(text) {
        let same = groups.last().is_some_and(|(previous, _)| {
            if options.ignore_case {
                previous.to_lowercase() == line.to_lowercase()
            } else {
                previous == line
            }
        });

        if same {
            groups.last_mut().unwrap().1 += 1;
        } else {
            groups.push((line.to_string(), 1));
        }
    }

    let selected: Vec<&(String, usize)> = groups
        .iter()
        .filter(|(_, count)| {
            if options.duplicates_only {
                *count > 1
            } else if options.unique_only {
                *count == 1
            } else {
                true
            }
        })
        .collect();

    let rendered: Vec<String> = selected
        .iter()
        .map(|(line, count)| {
            if options.count {
                format!("{count:>7} {line}")
            } else {
                line.clone()
            }
        })
        .collect();

    Output::ok(from_lines(&rendered))
}

// ---- cut / paste / join / comm --------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CutOptions {
    /// 1-based field numbers.
    pub fields: Option<Vec<usize>>,
    /// 1-based character positions.
    pub characters: Option<Vec<usize>>,
    pub delimiter: Option<char>,
    pub output_delimiter: Option<String>,
    /// Drop lines with no delimiter, as `cut -s` does.
    pub only_delimited: bool,
}

pub fn cut(text: &str, options: &CutOptions) -> Output {
    let delimiter = options.delimiter.unwrap_or('\t');
    let output = options.output_delimiter.clone().unwrap_or_else(|| delimiter.to_string());
    let mut out: Vec<String> = Vec::new();

    for line in to_lines(text) {
        if let Some(positions) = &options.characters {
            let chars: Vec<char> = line.chars().collect();
            let picked: String = positions
                .iter()
                .filter_map(|p| chars.get(p.saturating_sub(1)))
                .collect();
            out.push(picked);
            continue;
        }

        let Some(fields) = &options.fields else {
            out.push(line.to_string());
            continue;
        };

        if !line.contains(delimiter) {
            // A line with no delimiter passes through whole unless -s is set.
            if !options.only_delimited {
                out.push(line.to_string());
            }
            continue;
        }

        let parts: Vec<&str> = line.split(delimiter).collect();
        let picked: Vec<&str> = fields
            .iter()
            .map(|f| *parts.get(f.saturating_sub(1)).unwrap_or(&""))
            .collect();
        out.push(picked.join(&output));
    }

    Output::ok(from_lines(&out))
}

/// `paste`: merges corresponding lines of several inputs.
pub fn paste(inputs: &[&str], delimiter: char) -> Output {
    let columns: Vec<Vec<&str>> = inputs.iter().map(|input| to_lines(input)).collect();
    let height = columns.iter().map(|c| c.len()).max().unwrap_or(0);

    let rows: Vec<String> = (0..height)
        .map(|row| {
            columns
                .iter()
                .map(|column| *column.get(row).unwrap_or(&""))
                .collect::<Vec<_>>()
                .join(&delimiter.to_string())
        })
        .collect();

    Output::ok(from_lines(&rows))
}

/// `join`: relational join of two inputs on a shared field.
pub fn join(left: &str, right: &str, field1: usize, field2: usize, separator: char) -> Output {
    let key1 = field1.saturating_sub(1);
    let key2 = field2.saturating_sub(1);

    let mut index: HashMap<String, Vec<Vec<String>>> = HashMap::new();
    for line in to_lines(right) {
        let fields: Vec<String> = line.split(separator).map(String::from).collect();
        let key = fields.get(key2).cloned().unwrap_or_default();
        index.entry(key).or_default().push(fields);
    }

    let mut out: Vec<String> = Vec::new();
    for line in to_lines(left) {
        let fields: Vec<String> = line.split(separator).map(String::from).collect();
        let key = fields.get(key1).cloned().unwrap_or_default();

        for matched in index.get(&key).into_iter().flatten() {
            // The join field first, then the rest of each side — GNU's order.
            let mut row = vec![key.clone()];
            row.extend(fields.iter().enumerate().filter(|(i, _)| *i != key1).map(|(_, f)| f.clone()));
            row.extend(matched.iter().enumerate().filter(|(i, _)| *i != key2).map(|(_, f)| f.clone()));
            out.push(row.join(&separator.to_string()));
        }
    }

    Output::ok(from_lines(&out))
}

/// `comm`: what is unique to each input, and what is shared.
pub fn comm(left: &str, right: &str, suppress: (bool, bool, bool)) -> Output {
    let a = to_lines(left);
    let b = to_lines(right);
    let in_b: std::collections::HashSet<&str> = b.iter().copied().collect();
    let in_a: std::collections::HashSet<&str> = a.iter().copied().collect();

    let mut out: Vec<String> = Vec::new();
    if !suppress.0 {
        out.extend(a.iter().filter(|l| !in_b.contains(*l)).map(|l| l.to_string()));
    }
    if !suppress.1 {
        out.extend(b.iter().filter(|l| !in_a.contains(*l)).map(|l| format!("\t{l}")));
    }
    if !suppress.2 {
        out.extend(a.iter().filter(|l| in_b.contains(*l)).map(|l| format!("\t\t{l}")));
    }

    Output::ok(from_lines(&out))
}

// ---- tr -------------------------------------------------------------------

/// Expands `a-z` ranges in a `tr` set.
fn expand_set(set: &str) -> Vec<char> {
    let chars: Vec<char> = set.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        if i + 2 < chars.len() && chars[i + 1] == '-' {
            let (start, end) = (chars[i] as u32, chars[i + 2] as u32);
            for code in start..=end {
                if let Some(c) = char::from_u32(code) {
                    out.push(c);
                }
            }
            i += 3;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TrOptions {
    pub delete: bool,
    pub squeeze: bool,
    pub complement: bool,
}

pub fn tr(text: &str, from: &str, to: &str, options: &TrOptions) -> Output {
    let source = expand_set(from);
    let target = expand_set(to);

    let mut out = String::new();
    let mut previous: Option<char> = None;

    for c in text.chars() {
        let position = source.iter().position(|s| *s == c);
        let matched = if options.complement { position.is_none() } else { position.is_some() };

        let replacement = if !matched {
            Some(c)
        } else if options.delete {
            None
        } else if target.is_empty() {
            Some(c)
        } else {
            // A short target set repeats its last character, as `tr` does.
            let index = position.unwrap_or(0).min(target.len() - 1);
            Some(target[index])
        };

        let Some(emitted) = replacement else { continue };

        if options.squeeze && previous == Some(emitted) && matched {
            continue;
        }
        out.push(emitted);
        previous = Some(emitted);
    }

    Output::ok(out)
}

// ---- formatting -----------------------------------------------------------

/// `fold`: hard-wraps at a width.
pub fn fold(text: &str, width: usize, break_at_spaces: bool) -> Output {
    let mut out: Vec<String> = Vec::new();

    for line in to_lines(text) {
        if line.chars().count() <= width {
            out.push(line.to_string());
            continue;
        }

        let mut rest: Vec<char> = line.chars().collect();
        while rest.len() > width {
            let mut cut = width;
            if break_at_spaces {
                if let Some(space) = rest[..width].iter().rposition(|c| *c == ' ') {
                    if space > 0 {
                        cut = space;
                    }
                }
            }
            out.push(rest[..cut].iter().collect());
            let skip = if break_at_spaces && rest.get(cut) == Some(&' ') { cut + 1 } else { cut };
            rest = rest[skip..].to_vec();
        }
        if !rest.is_empty() {
            out.push(rest.iter().collect());
        }
    }

    Output::ok(from_lines(&out))
}

/// `fmt`: reflows paragraphs, preserving blank-line separation.
pub fn fmt(text: &str, width: usize) -> Output {
    let mut out: Vec<String> = Vec::new();

    for paragraph in text.split("\n\n") {
        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if words.is_empty() {
            continue;
        }

        let mut line = String::new();
        for word in words {
            let candidate =
                if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            if candidate.chars().count() > width && !line.is_empty() {
                out.push(line);
                line = word.to_string();
            } else {
                line = candidate;
            }
        }
        if !line.is_empty() {
            out.push(line);
        }
        out.push(String::new());
    }

    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    Output::ok(from_lines(&out))
}

/// `expand`: tabs to spaces, respecting tab stops.
pub fn expand(text: &str, tab_size: usize) -> Output {
    let lines: Vec<String> = to_lines(text)
        .into_iter()
        .map(|line| {
            let mut out = String::new();
            for c in line.chars() {
                if c == '\t' {
                    let width = out.chars().count();
                    let pad = tab_size - (width % tab_size);
                    out.push_str(&" ".repeat(pad));
                } else {
                    out.push(c);
                }
            }
            out
        })
        .collect();

    Output::ok(from_lines(&lines))
}

/// `unexpand`: leading spaces back to tabs.
pub fn unexpand(text: &str, tab_size: usize) -> Output {
    let lines: Vec<String> = to_lines(text)
        .into_iter()
        .map(|line| {
            let indent = line.chars().take_while(|c| *c == ' ').count();
            let tabs = indent / tab_size;
            if tabs > 0 {
                format!("{}{}", "\t".repeat(tabs), &line[tabs * tab_size..])
            } else {
                line.to_string()
            }
        })
        .collect();

    Output::ok(from_lines(&lines))
}

/// `nl`: numbers lines.
pub fn nl(text: &str, start: usize, skip_blank: bool) -> Output {
    let mut counter = start;
    let lines: Vec<String> = to_lines(text)
        .into_iter()
        .map(|line| {
            if skip_blank && line.trim().is_empty() {
                "      \t".to_string()
            } else {
                let numbered = format!("{counter:>6}\t{line}");
                counter += 1;
                numbered
            }
        })
        .collect();

    Output::ok(from_lines(&lines))
}

/// `column -t`: aligns whitespace-separated fields.
pub fn column(text: &str) -> Output {
    let rows: Vec<Vec<&str>> =
        to_lines(text).into_iter().map(|line| line.split_whitespace().collect()).collect();

    let mut widths: Vec<usize> = Vec::new();
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            let width = cell.chars().count();
            if widths.len() <= index {
                widths.push(width);
            } else if widths[index] < width {
                widths[index] = width;
            }
        }
    }

    let lines: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .enumerate()
                .map(|(index, cell)| {
                    if index == row.len() - 1 {
                        cell.to_string()
                    } else {
                        format!("{cell:<width$}", width = widths[index])
                    }
                })
                .collect::<Vec<_>>()
                .join("  ")
        })
        .collect();

    Output::ok(from_lines(&lines))
}

/// `rev`: reverses each line's characters.
pub fn rev(text: &str) -> Output {
    let lines: Vec<String> =
        to_lines(text).into_iter().map(|line| line.chars().rev().collect()).collect();
    Output::ok(from_lines(&lines))
}

/// `seq`: a numeric sequence.
pub fn seq(start: f64, end: f64, step: f64) -> Output {
    if step == 0.0 {
        return Output::fail("seq: step cannot be zero", 1);
    }
    if (step > 0.0 && start > end) || (step < 0.0 && start < end) {
        return Output::ok("");
    }

    // Each value is derived from the index rather than accumulated: a float
    // step accumulates error, and `seq 0 0.1 1` should end at 1.0 exactly.
    let count = ((end - start) / step).abs().floor() as usize + 1;
    let values: Vec<String> = (0..count)
        .map(|i| {
            let value = start + (i as f64) * step;
            if value.fract() == 0.0 {
                format!("{}", value as i64)
            } else {
                format!("{value}")
            }
        })
        .collect();

    Output::ok(from_lines(&values))
}

/// `yes`: repeats a string. Capped, since the real one never terminates.
pub fn yes(text: &str, count: usize) -> Output {
    let capped = count.min(100_000);
    Output::ok(from_lines(&vec![text; capped]))
}

/// `shuf`: a seeded permutation, so a run is reproducible.
pub fn shuf(text: &str, count: Option<usize>, seed: u64) -> Output {
    let mut lines: Vec<String> = to_lines(text).into_iter().map(String::from).collect();

    // A small deterministic PRNG: an agent that shuffles should be able to
    // reproduce the run it is reporting on.
    let mut state = seed;
    let mut next = || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (state >> 33) as usize
    };

    for i in (1..lines.len()).rev() {
        let j = next() % (i + 1);
        lines.swap(i, j);
    }

    if let Some(limit) = count {
        lines.truncate(limit);
    }
    Output::ok(from_lines(&lines))
}
