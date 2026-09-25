//! Builtins that belong to the shell language rather than to coreutils:
//! `test` / `[` / `[[`, `printf`, and the field splitting `read` does.
//!
//! `pi-builtins` has a `test`, but a small one — no `!`, no `-a`/`-o`, no
//! `-x`. Scripts lean on these in every `if`, so the shell has its own, with
//! paths resolved against the session's directory rather than the process's.

use pi_builtins::data::glob_match;
use std::path::{Path, PathBuf};

// ---- test ------------------------------------------------------------------

/// Evaluates a `test` expression. `double` is `[[ ]]`: `==` matches a glob
/// pattern, `=~` a regular expression, and `&&` / `||` join terms.
/// An `Err` is a malformed expression — exit status 2, as in bash.
pub fn test(arguments: &[String], cwd: &Path, double: bool) -> Result<bool, String> {
    if arguments.is_empty() {
        return Ok(false);
    }
    let mut parser = Test { args: arguments, position: 0, cwd, double };
    let value = parser.or()?;
    if parser.position < arguments.len() {
        return Err(format!("unexpected `{}`", arguments[parser.position]));
    }
    Ok(value)
}

struct Test<'a> {
    args: &'a [String],
    position: usize,
    cwd: &'a Path,
    double: bool,
}

const UNARY: &[&str] = &[
    "-e", "-f", "-d", "-s", "-r", "-w", "-x", "-L", "-h", "-z", "-n", "-b", "-c", "-p", "-S", "-t", "-O", "-G", "-a",
];
const BINARY: &[&str] = &["=", "==", "!=", "<", ">", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot", "-ef", "=~"];

impl Test<'_> {
    fn peek(&self) -> Option<&str> {
        self.args.get(self.position).map(String::as_str)
    }

    fn next(&mut self) -> Option<&str> {
        let value = self.args.get(self.position).map(String::as_str);
        self.position += 1;
        value
    }

    fn or(&mut self) -> Result<bool, String> {
        let mut value = self.and()?;
        while self.peek() == Some("-o") || (self.double && self.peek() == Some("||")) {
            self.position += 1;
            let right = self.and()?;
            value = value || right;
        }
        Ok(value)
    }

    fn and(&mut self) -> Result<bool, String> {
        let mut value = self.not()?;
        while (self.peek() == Some("-a") && self.position + 1 < self.args.len()) || (self.double && self.peek() == Some("&&")) {
            self.position += 1;
            let right = self.not()?;
            value = value && right;
        }
        Ok(value)
    }

    fn not(&mut self) -> Result<bool, String> {
        // `[ ! ]` is a test of the string "!", which is non-empty.
        if self.peek() == Some("!") && self.position + 1 < self.args.len() {
            self.position += 1;
            return Ok(!self.not()?);
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<bool, String> {
        let Some(first) = self.next().map(String::from) else { return Err("argument expected".to_string()) };
        if first == "(" && self.position < self.args.len() {
            let value = self.or()?;
            if self.next() != Some(")") {
                return Err("expected `)`".to_string());
            }
            return Ok(value);
        }
        // A binary operator after the first operand wins over reading the
        // operand as a unary operator: `[ -n = -n ]` compares two strings.
        let binary = self.peek().filter(|op| BINARY.contains(op) && (self.double || *op != "=~")).map(String::from);
        if let Some(op) = binary {
            if self.position + 1 < self.args.len() {
                self.position += 1;
                let right = self.next().unwrap_or_default().to_string();
                return self.binary(&first, &op, &right);
            }
        }
        if UNARY.contains(&first.as_str()) && self.position < self.args.len() {
            let operand = self.next().unwrap_or_default().to_string();
            return Ok(self.unary(&first, &operand));
        }
        Ok(!first.is_empty())
    }

    fn path(&self, operand: &str) -> PathBuf {
        let path = PathBuf::from(operand);
        if path.is_absolute() {
            path
        } else {
            self.cwd.join(path)
        }
    }

    fn unary(&self, op: &str, operand: &str) -> bool {
        let path = self.path(operand);
        match op {
            "-z" => operand.is_empty(),
            "-n" => !operand.is_empty(),
            "-e" | "-a" => path.exists(),
            "-f" => path.is_file(),
            "-d" => path.is_dir(),
            "-s" => std::fs::metadata(&path).is_ok_and(|m| m.len() > 0),
            "-r" => std::fs::File::open(&path).is_ok(),
            "-w" => std::fs::metadata(&path).is_ok_and(|m| !m.permissions().readonly()),
            "-x" => executable(&path),
            "-L" | "-h" => std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()),
            "-O" | "-G" => path.exists(),
            // Devices, pipes, sockets, terminals: none in an agent's shell.
            _ => false,
        }
    }

    fn binary(&self, left: &str, op: &str, right: &str) -> Result<bool, String> {
        let integers = || -> Result<(i64, i64), String> {
            let parse = |text: &str| text.trim().parse::<i64>().map_err(|_| format!("`{text}`: integer expression expected"));
            Ok((parse(left)?, parse(right)?))
        };
        let modified = |text: &str| std::fs::metadata(self.path(text)).and_then(|m| m.modified()).ok();
        Ok(match op {
            "=" | "==" if self.double => glob_match(right, left),
            "!=" if self.double => !glob_match(right, left),
            "=" | "==" => left == right,
            "!=" => left != right,
            "<" => left < right,
            ">" => left > right,
            "-eq" => integers().map(|(a, b)| a == b)?,
            "-ne" => integers().map(|(a, b)| a != b)?,
            "-lt" => integers().map(|(a, b)| a < b)?,
            "-le" => integers().map(|(a, b)| a <= b)?,
            "-gt" => integers().map(|(a, b)| a > b)?,
            "-ge" => integers().map(|(a, b)| a >= b)?,
            "-nt" => matches!((modified(left), modified(right)), (Some(a), Some(b)) if a > b),
            "-ot" => matches!((modified(left), modified(right)), (Some(a), Some(b)) if a < b),
            "-ef" => match (std::fs::canonicalize(self.path(left)), std::fs::canonicalize(self.path(right))) {
                (Ok(a), Ok(b)) => a == b,
                _ => false,
            },
            "=~" => pi_builtins::regex::Regex::new(right, false)?.is_match(left),
            other => return Err(format!("unknown operator `{other}`")),
        })
    }
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else { return false };
    if metadata.is_dir() {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
        matches!(extension.as_str(), "exe" | "bat" | "cmd" | "com" | "ps1" | "sh")
    }
}

// ---- printf ----------------------------------------------------------------

/// `printf FORMAT [ARGS...]`, reusing the format while arguments remain.
pub fn printf(arguments: &[String]) -> Result<String, String> {
    let Some((format, mut rest)) = arguments.split_first() else {
        return Err("usage: printf format [arguments]".to_string());
    };
    let mut out = String::new();
    loop {
        let used = format_once(format, &mut rest, &mut out)?;
        if rest.is_empty() || used == 0 {
            break;
        }
    }
    Ok(out)
}

/// Takes the next argument, or an empty one when they have run out.
fn take(rest: &mut &[String], used: &mut usize) -> String {
    match rest.split_first() {
        Some((first, tail)) => {
            *rest = tail;
            *used += 1;
            first.clone()
        }
        None => String::new(),
    }
}

/// One pass over the format. Returns how many arguments it consumed.
fn format_once(format: &str, rest: &mut &[String], out: &mut String) -> Result<usize, String> {
    let chars: Vec<char> = format.chars().collect();
    let mut used = 0;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            i = escape(&chars, i, out);
            continue;
        }
        if c != '%' {
            out.push(c);
            i += 1;
            continue;
        }
        i += 1;
        if chars.get(i) == Some(&'%') {
            out.push('%');
            i += 1;
            continue;
        }
        let mut flags = String::new();
        while let Some(&f) = chars.get(i).filter(|f| "-+ 0#".contains(**f)) {
            flags.push(f);
            i += 1;
        }
        let mut width = String::new();
        if chars.get(i) == Some(&'*') {
            width = take(rest, &mut used);
            i += 1;
        } else {
            while let Some(&d) = chars.get(i).filter(|d| d.is_ascii_digit()) {
                width.push(d);
                i += 1;
            }
        }
        let mut precision: Option<usize> = None;
        if chars.get(i) == Some(&'.') {
            i += 1;
            let mut digits = String::new();
            if chars.get(i) == Some(&'*') {
                digits = take(rest, &mut used);
                i += 1;
            } else {
                while let Some(&d) = chars.get(i).filter(|d| d.is_ascii_digit()) {
                    digits.push(d);
                    i += 1;
                }
            }
            precision = Some(digits.parse().unwrap_or(0));
        }
        let Some(&kind) = chars.get(i) else { return Err("`%` at the end of the format".to_string()) };
        i += 1;
        let argument = take(rest, &mut used);
        let body = match kind {
            's' => match precision {
                Some(p) => argument.chars().take(p).collect(),
                None => argument,
            },
            'b' => {
                let argument_chars: Vec<char> = argument.chars().collect();
                let mut expanded = String::new();
                let mut j = 0;
                while j < argument_chars.len() {
                    if argument_chars[j] == '\\' {
                        j = escape(&argument_chars, j, &mut expanded);
                    } else {
                        expanded.push(argument_chars[j]);
                        j += 1;
                    }
                }
                expanded
            }
            'c' => argument.chars().next().map(String::from).unwrap_or_default(),
            'd' | 'i' | 'u' => {
                let value = integer(&argument)?;
                let sign = if value >= 0 && flags.contains('+') {
                    "+"
                } else if value >= 0 && flags.contains(' ') {
                    " "
                } else {
                    ""
                };
                format!("{sign}{value}")
            }
            'x' => format!("{:x}", integer(&argument)?),
            'X' => format!("{:X}", integer(&argument)?),
            'o' => format!("{:o}", integer(&argument)?),
            'f' | 'F' => format!("{:.*}", precision.unwrap_or(6), float(&argument)?),
            'e' | 'E' => {
                let text = format!("{:.*e}", precision.unwrap_or(6), float(&argument)?);
                if kind == 'E' {
                    text.to_uppercase()
                } else {
                    text
                }
            }
            'g' | 'G' => {
                let text = format!("{}", float(&argument)?);
                if kind == 'G' {
                    text.to_uppercase()
                } else {
                    text
                }
            }
            other => return Err(format!("`%{other}` is not a printf conversion")),
        };
        pad(out, &body, &flags, width.trim_start_matches('-').parse().unwrap_or(0), kind);
    }
    Ok(used)
}

fn pad(out: &mut String, body: &str, flags: &str, width: usize, kind: char) {
    let length = body.chars().count();
    if length >= width {
        out.push_str(body);
    } else if flags.contains('-') {
        out.push_str(body);
        out.push_str(&" ".repeat(width - length));
    } else if flags.contains('0') && matches!(kind, 'd' | 'i' | 'u' | 'f' | 'F' | 'x' | 'X' | 'o') {
        let (sign, digits) = body.strip_prefix('-').map_or(("", body), |d| ("-", d));
        out.push_str(sign);
        out.push_str(&"0".repeat(width - length));
        out.push_str(digits);
    } else {
        out.push_str(&" ".repeat(width - length));
        out.push_str(body);
    }
}

/// Writes the escape at `chars[i]` (a backslash) and returns where it ended.
fn escape(chars: &[char], i: usize, out: &mut String) -> usize {
    let Some(&next) = chars.get(i + 1) else {
        out.push('\\');
        return i + 1;
    };
    let simple = match next {
        'n' => Some('\n'),
        't' => Some('\t'),
        'r' => Some('\r'),
        'a' => Some('\x07'),
        'b' => Some('\x08'),
        'f' => Some('\x0c'),
        'v' => Some('\x0b'),
        'e' | 'E' => Some('\x1b'),
        '\\' => Some('\\'),
        '"' => Some('"'),
        '\'' => Some('\''),
        _ => None,
    };
    if let Some(c) = simple {
        out.push(c);
        return i + 2;
    }
    if next == 'x' {
        let digits: String = chars[i + 2..].iter().take(2).take_while(|c| c.is_ascii_hexdigit()).collect();
        if let Some(c) = u32::from_str_radix(&digits, 16).ok().and_then(char::from_u32) {
            out.push(c);
            return i + 2 + digits.len();
        }
    }
    if next.is_digit(8) {
        let digits: String = chars[i + 1..].iter().take(4).take_while(|c| c.is_digit(8)).collect();
        if let Some(c) = u32::from_str_radix(&digits, 8).ok().and_then(char::from_u32) {
            out.push(c);
            return i + 1 + digits.len();
        }
    }
    out.push('\\');
    out.push(next);
    i + 2
}

fn integer(text: &str) -> Result<i64, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(0);
    }
    // `'a` is the character's code, as in C's printf.
    if let Some(c) = text.strip_prefix('\'').or_else(|| text.strip_prefix('"')).and_then(|t| t.chars().next()) {
        return Ok(i64::from(u32::from(c)));
    }
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).map_err(|_| format!("`{text}`: invalid number"));
    }
    text.parse().map_err(|_| format!("`{text}`: invalid number"))
}

fn float(text: &str) -> Result<f64, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(0.0);
    }
    text.parse().map_err(|_| format!("`{text}`: invalid number"))
}

// ---- read ------------------------------------------------------------------

/// What `read NAME...` assigns from `line`: one field per name split on
/// whitespace, the last name taking the rest of the line. Without `-r`, a
/// backslash escapes the next character.
pub fn read_fields(line: &str, names: &[String], raw: bool) -> Vec<(String, String)> {
    let line = if raw { line.to_string() } else { unescape(line) };
    if names.is_empty() {
        return vec![("REPLY".to_string(), line)];
    }
    let mut rest = line.trim_start_matches([' ', '\t']);
    let mut assigned = Vec::new();
    for (index, name) in names.iter().enumerate() {
        if index + 1 == names.len() {
            assigned.push((name.clone(), rest.trim_end_matches([' ', '\t']).to_string()));
            break;
        }
        let end = rest.find([' ', '\t']).unwrap_or(rest.len());
        assigned.push((name.clone(), rest[..end].to_string()));
        rest = rest[end..].trim_start_matches([' ', '\t']);
    }
    assigned
}

fn unescape(line: &str) -> String {
    let mut out = String::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn check(list: &[&str]) -> bool {
        test(&args(list), Path::new("."), false).unwrap()
    }

    #[test]
    fn test_handles_negation_and_connectives() {
        assert!(check(&["-n", "x"]));
        assert!(check(&["!", "-z", "x"]));
        assert!(check(&["a", "=", "a", "-a", "1", "-lt", "2"]));
        assert!(check(&["a", "=", "b", "-o", "(", "3", "-ge", "3", ")"]));
        assert!(!check(&[""]));
        assert!(check(&["-n", "=", "-n"]));
        assert!(test(&args(&["x", "-eq", "1"]), Path::new("."), false).is_err());
    }

    #[test]
    fn double_brackets_match_patterns_and_regexes() {
        let double = |list: &[&str]| test(&args(list), Path::new("."), true).unwrap();
        assert!(double(&["main.rs", "==", "*.rs"]));
        assert!(!double(&["main.rs", "==", "*.ts"]));
        assert!(double(&["v1.2.3", "=~", "^v[0-9]+\\.[0-9]+"]));
        assert!(double(&["a", "==", "b", "||", "c", "!=", "d"]));
    }

    #[test]
    fn files_resolve_against_the_given_directory() {
        let dir = std::env::temp_dir().join(format!("pi-shell-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("present.txt"), "x").unwrap();
        assert!(test(&args(&["-f", "present.txt"]), &dir, false).unwrap());
        assert!(test(&args(&["-s", "present.txt"]), &dir, false).unwrap());
        assert!(!test(&args(&["-d", "present.txt"]), &dir, false).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn printf_formats_and_repeats() {
        assert_eq!(printf(&args(&["%s=%d\\n", "a", "1", "b", "2"])).unwrap(), "a=1\nb=2\n");
        assert_eq!(printf(&args(&["%5s|%-5s|%05d", "ab", "cd", "42"])).unwrap(), "   ab|cd   |00042");
        assert_eq!(printf(&args(&["%.2f %x %o %c", "3.14159", "255", "8", "hello"])).unwrap(), "3.14 ff 10 h");
        assert_eq!(printf(&args(&["%b", "tab\\there"])).unwrap(), "tab\there");
        assert_eq!(printf(&args(&["100%%"])).unwrap(), "100%");
    }

    #[test]
    fn read_splits_the_line_over_its_names() {
        let fields = |line: &str, names: &[&str], raw: bool| read_fields(line, &args(names), raw);
        assert_eq!(fields("  a  b c d ", &["x", "y"], true), vec![("x".into(), "a".into()), ("y".into(), "b c d".into())]);
        assert_eq!(fields("one", &["x", "y"], true), vec![("x".into(), "one".into()), ("y".into(), String::new())]);
        assert_eq!(fields("a\\ b", &[], false), vec![("REPLY".into(), "a b".into())]);
    }
}
