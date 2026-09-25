//! Shell arithmetic: `$(( ))`, `let`, and `(( ))`.
//!
//! Integers only, with C's operators and precedence, as bash has them. A
//! bare name is a variable — `$((count + 1))` is how every loop counter is
//! written — and an unset or non-numeric one is 0. Assignments (`i += 2`,
//! `i++`) need somewhere to write, so they work in `let` and `(( ))` and are
//! refused inside `$(( ))`, which only reads.

/// Where names are read from and assignments go.
pub trait Scope {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&mut self, name: &str, value: i64) -> Result<(), String>;
}

/// A scope that reads a variable map and refuses assignments.
pub struct ReadOnly<'a>(pub &'a std::collections::HashMap<String, String>);

impl Scope for ReadOnly<'_> {
    fn get(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
    fn set(&mut self, name: &str, _value: i64) -> Result<(), String> {
        Err(format!("cannot assign `{name}` inside $(( )); use `let` or (( ))"))
    }
}

/// Evaluates `expression`; several comma-separated expressions yield the last.
pub fn evaluate(expression: &str, scope: &mut dyn Scope) -> Result<i64, String> {
    let tokens = lex(expression)?;
    if tokens.is_empty() {
        return Ok(0);
    }
    let mut parser = Parser { tokens, position: 0, scope, depth: 0 };
    let mut value = parser.assignment()?;
    while parser.eat(",") {
        value = parser.assignment()?;
    }
    if parser.position < parser.tokens.len() {
        return Err(format!("unexpected `{}` in arithmetic", parser.tokens[parser.position].text()));
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(i64),
    Name(String),
    Op(&'static str),
}

impl Token {
    fn text(&self) -> String {
        match self {
            Token::Number(n) => n.to_string(),
            Token::Name(name) => name.clone(),
            Token::Op(op) => (*op).to_string(),
        }
    }
}

/// Longest operators first, so `**=` is not read as `*` then `*=`.
const OPERATORS: &[&str] = &[
    "**=", "<<=", ">>=", "**", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=",
    "&=", "|=", "^=", "+", "-", "*", "/", "%", "<", ">", "=", "!", "~", "&", "|", "^", "?", ":", "(", ")", ",",
];

fn lex(text: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '#') {
                i += 1;
            }
            tokens.push(Token::Number(number(&chars[start..i].iter().collect::<String>())?));
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            tokens.push(Token::Name(chars[start..i].iter().collect()));
            continue;
        }
        let rest: String = chars[i..chars.len().min(i + 3)].iter().collect();
        match OPERATORS.iter().find(|op| rest.starts_with(**op)) {
            Some(op) => {
                tokens.push(Token::Op(op));
                i += op.len();
            }
            None => return Err(format!("`{c}` is not an arithmetic operator")),
        }
    }
    Ok(tokens)
}

/// `42`, `0x2a`, `052` (octal, as in C), and `16#2a`.
fn number(text: &str) -> Result<i64, String> {
    let bad = || format!("`{text}` is not a number");
    if let Some((base, digits)) = text.split_once('#') {
        let base: u32 = base.parse().map_err(|_| bad())?;
        if !(2..=36).contains(&base) {
            return Err(bad());
        }
        return i64::from_str_radix(digits, base).map_err(|_| bad());
    }
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).map_err(|_| bad());
    }
    if text.len() > 1 && text.starts_with('0') {
        return i64::from_str_radix(&text[1..], 8).map_err(|_| bad());
    }
    text.parse().map_err(|_| bad())
}

struct Parser<'a> {
    tokens: Vec<Token>,
    position: usize,
    scope: &'a mut dyn Scope,
    depth: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn peek_op(&self) -> Option<&'static str> {
        match self.peek() {
            Some(Token::Op(op)) => Some(op),
            _ => None,
        }
    }

    fn eat(&mut self, op: &str) -> bool {
        if self.peek_op() == Some(op) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, op: &str) -> Result<(), String> {
        if self.eat(op) {
            Ok(())
        } else {
            Err(format!("expected `{op}` in arithmetic"))
        }
    }

    /// The value of a variable: an integer, or — as bash does — the value of
    /// the expression it holds, a few levels deep.
    fn variable(&mut self, name: &str) -> Result<i64, String> {
        let Some(text) = self.scope.get(name) else { return Ok(0) };
        let text = text.trim();
        if text.is_empty() {
            return Ok(0);
        }
        if let Ok(value) = number(text) {
            return Ok(value);
        }
        if self.depth > 8 {
            return Err(format!("`{name}` refers to itself"));
        }
        let tokens = lex(text)?;
        let mut inner = Parser { tokens, position: 0, scope: &mut *self.scope, depth: self.depth + 1 };
        inner.ternary()
    }

    fn assignment(&mut self) -> Result<i64, String> {
        if let (Some(Token::Name(name)), Some(Token::Op(op))) = (self.tokens.get(self.position), self.tokens.get(self.position + 1)) {
            let op = *op;
            if matches!(op, "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "**=" | "<<=" | ">>=" | "&=" | "|=" | "^=") {
                let name = name.clone();
                self.position += 2;
                let right = self.assignment()?;
                let value = if op == "=" { right } else { binary(&op[..op.len() - 1], self.variable(&name)?, right)? };
                self.scope.set(&name, value)?;
                return Ok(value);
            }
        }
        self.ternary()
    }

    fn ternary(&mut self) -> Result<i64, String> {
        let condition = self.binary(0)?;
        if !self.eat("?") {
            return Ok(condition);
        }
        let yes = self.assignment()?;
        self.expect(":")?;
        let no = self.assignment()?;
        Ok(if condition != 0 { yes } else { no })
    }

    /// Precedence climbing over the binary operators, loosest first.
    fn binary(&mut self, level: usize) -> Result<i64, String> {
        const LEVELS: &[&[&str]] = &[
            &["||"],
            &["&&"],
            &["|"],
            &["^"],
            &["&"],
            &["==", "!="],
            &["<", "<=", ">", ">="],
            &["<<", ">>"],
            &["+", "-"],
            &["*", "/", "%"],
        ];
        if level == LEVELS.len() {
            return self.power();
        }
        let mut left = self.binary(level + 1)?;
        while let Some(op) = self.peek_op().filter(|op| LEVELS[level].contains(op)) {
            self.position += 1;
            let right = self.binary(level + 1)?;
            left = binary(op, left, right)?;
        }
        Ok(left)
    }

    fn power(&mut self) -> Result<i64, String> {
        let base = self.unary()?;
        if self.eat("**") {
            // Right-associative: 2 ** 3 ** 2 is 2 ** 9.
            let exponent = self.power()?;
            return binary("**", base, exponent);
        }
        Ok(base)
    }

    fn unary(&mut self) -> Result<i64, String> {
        match self.peek_op() {
            Some("-") => {
                self.position += 1;
                Ok(self.unary()?.wrapping_neg())
            }
            Some("+") => {
                self.position += 1;
                self.unary()
            }
            Some("!") => {
                self.position += 1;
                Ok(i64::from(self.unary()? == 0))
            }
            Some("~") => {
                self.position += 1;
                Ok(!self.unary()?)
            }
            Some(op @ ("++" | "--")) => {
                self.position += 1;
                let Some(Token::Name(name)) = self.peek().cloned() else { return Err(format!("`{op}` needs a variable")) };
                self.position += 1;
                let value = self.variable(&name)? + if op == "++" { 1 } else { -1 };
                self.scope.set(&name, value)?;
                Ok(value)
            }
            _ => self.postfix(),
        }
    }

    fn postfix(&mut self) -> Result<i64, String> {
        match self.peek().cloned() {
            Some(Token::Number(value)) => {
                self.position += 1;
                Ok(value)
            }
            Some(Token::Name(name)) => {
                self.position += 1;
                let value = self.variable(&name)?;
                if let Some(op @ ("++" | "--")) = self.peek_op() {
                    self.position += 1;
                    self.scope.set(&name, value + if op == "++" { 1 } else { -1 })?;
                }
                Ok(value)
            }
            Some(Token::Op("(")) => {
                self.position += 1;
                let mut value = self.assignment()?;
                while self.eat(",") {
                    value = self.assignment()?;
                }
                self.expect(")")?;
                Ok(value)
            }
            Some(other) => Err(format!("unexpected `{}` in arithmetic", other.text())),
            None => Err("arithmetic expression ends too early".to_string()),
        }
    }
}

fn binary(op: &str, left: i64, right: i64) -> Result<i64, String> {
    Ok(match op {
        "+" => left.wrapping_add(right),
        "-" => left.wrapping_sub(right),
        "*" => left.wrapping_mul(right),
        "/" | "%" if right == 0 => return Err("division by zero".to_string()),
        "/" => left.wrapping_div(right),
        "%" => left.wrapping_rem(right),
        "**" => {
            if right < 0 {
                return Err("negative exponent".to_string());
            }
            left.wrapping_pow(u32::try_from(right).unwrap_or(u32::MAX))
        }
        "<<" => left.wrapping_shl(right as u32),
        ">>" => left.wrapping_shr(right as u32),
        "<" => i64::from(left < right),
        "<=" => i64::from(left <= right),
        ">" => i64::from(left > right),
        ">=" => i64::from(left >= right),
        "==" => i64::from(left == right),
        "!=" => i64::from(left != right),
        "&" => left & right,
        "|" => left | right,
        "^" => left ^ right,
        "&&" => i64::from(left != 0 && right != 0),
        "||" => i64::from(left != 0 || right != 0),
        other => return Err(format!("unknown operator `{other}`")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Map(HashMap<String, String>);
    impl Scope for Map {
        fn get(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }
        fn set(&mut self, name: &str, value: i64) -> Result<(), String> {
            self.0.insert(name.to_string(), value.to_string());
            Ok(())
        }
    }

    fn eval(expression: &str) -> i64 {
        let mut scope = Map(HashMap::from([
            ("count".to_string(), "4".to_string()),
            ("expr".to_string(), "count * 2".to_string()),
        ]));
        evaluate(expression, &mut scope).unwrap()
    }

    #[test]
    fn integers_with_c_precedence() {
        assert_eq!(eval("1 + 2 * 3"), 7);
        assert_eq!(eval("(1 + 2) * 3"), 9);
        assert_eq!(eval("7 / 2"), 3);
        assert_eq!(eval("7 % 3"), 1);
        assert_eq!(eval("2 ** 3 ** 2"), 512);
        assert_eq!(eval("-3 + 1"), -2);
        assert_eq!(eval("0x10 + 010 + 2#11"), 16 + 8 + 3);
    }

    #[test]
    fn bare_names_are_variables() {
        assert_eq!(eval("count + 1"), 5);
        assert_eq!(eval("unset_name + 1"), 1);
        // A variable holding an expression is evaluated, as bash does.
        assert_eq!(eval("expr + 1"), 9);
    }

    #[test]
    fn comparisons_logic_and_the_ternary() {
        assert_eq!(eval("count > 3 && count < 10"), 1);
        assert_eq!(eval("!(count == 4)"), 0);
        assert_eq!(eval("count > 3 ? 100 : 200"), 100);
    }

    #[test]
    fn assignments_write_through_the_scope() {
        let mut scope = Map(HashMap::from([("i".to_string(), "1".to_string())]));
        assert_eq!(evaluate("i += 2", &mut scope).unwrap(), 3);
        assert_eq!(evaluate("i++", &mut scope).unwrap(), 3);
        assert_eq!(scope.0["i"], "4");
        assert_eq!(evaluate("++i, i * 10", &mut scope).unwrap(), 50);
    }

    #[test]
    fn read_only_scopes_refuse_assignment_and_errors_are_reported() {
        let map = HashMap::new();
        assert!(evaluate("x = 1", &mut ReadOnly(&map)).is_err());
        assert!(evaluate("1 / 0", &mut ReadOnly(&map)).is_err());
        assert!(evaluate("1 +", &mut ReadOnly(&map)).is_err());
    }
}
