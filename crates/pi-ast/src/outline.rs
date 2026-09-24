//! A file outline: the declarations in a file, without reading all of it.
//!
//! This is what lets an agent answer "what is in this file" for a 4,000-line
//! module without spending 40,000 tokens on it. The outline is derived from the
//! token stream, so it works on a file that does not compile and needs no
//! language server running.

use crate::tokens::{significant, syntax_for, tokenize, Kind, Syntax, Token};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Function,
    Method,
    Class,
    Struct,
    Enum,
    Interface,
    Trait,
    Type,
    Constant,
    Import,
    Test,
}

impl ItemKind {
    pub fn label(&self) -> &'static str {
        match self {
            ItemKind::Function => "fn",
            ItemKind::Method => "method",
            ItemKind::Class => "class",
            ItemKind::Struct => "struct",
            ItemKind::Enum => "enum",
            ItemKind::Interface => "interface",
            ItemKind::Trait => "trait",
            ItemKind::Type => "type",
            ItemKind::Constant => "const",
            ItemKind::Import => "import",
            ItemKind::Test => "test",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Item {
    pub kind: ItemKind,
    pub name: String,
    pub line: usize,
    /// Nesting depth in brackets, so members read as members.
    pub depth: usize,
    /// Whether the declaration is exported or public.
    pub exported: bool,
}

/// Extracts the outline of a source file.
pub fn outline(source: &str, syntax: &Syntax) -> Vec<Item> {
    let tokens = significant(&tokenize(source, syntax));
    let mut items = Vec::new();
    let mut depth = 0usize;

    for (index, token) in tokens.iter().enumerate() {
        match token.kind {
            Kind::Open if token.text == "{" => {
                depth += 1;
                continue;
            }
            Kind::Close if token.text == "}" => {
                depth = depth.saturating_sub(1);
                continue;
            }
            _ => {}
        }

        if token.kind != Kind::Identifier {
            continue;
        }

        let Some(kind) = keyword_kind(&token.text, syntax) else { continue };

        // The name is the next identifier, skipping the modifiers that can sit
        // between the keyword and the name (`async`, `mut`, generics).
        let Some(name) = next_name(&tokens, index + 1) else { continue };

        let exported = index > 0
            && matches!(
                tokens[index.saturating_sub(1)].text.as_str(),
                "export" | "pub" | "public" | "default"
            );

        // A function inside a class or impl block is a method, which is worth
        // distinguishing: a reader scanning the outline wants the shape.
        let kind = if kind == ItemKind::Function && depth > 0 { ItemKind::Method } else { kind };

        items.push(Item { kind, name, line: token.line, depth, exported });
    }

    // Test functions are marked so a reader can skip them, or find only them.
    for item in &mut items {
        if item.name.starts_with("test_")
            || item.name.starts_with("Test")
            || item.name.ends_with("_test")
        {
            item.kind = ItemKind::Test;
        }
    }

    items
}

fn keyword_kind(word: &str, syntax: &Syntax) -> Option<ItemKind> {
    // `def` is Python's function keyword and nothing in C-family languages;
    // `func` is Go's. Checking the syntax avoids a `func` variable in
    // TypeScript being read as a declaration.
    match (syntax.name, word) {
        ("python", "def") => Some(ItemKind::Function),
        ("python", "class") => Some(ItemKind::Class),
        ("python", "import") | ("python", "from") => Some(ItemKind::Import),

        ("go", "func") => Some(ItemKind::Function),
        ("go", "type") => Some(ItemKind::Type),
        ("go", "import") => Some(ItemKind::Import),
        ("go", "const") => Some(ItemKind::Constant),

        ("rust", "fn") => Some(ItemKind::Function),
        ("rust", "struct") => Some(ItemKind::Struct),
        ("rust", "enum") => Some(ItemKind::Enum),
        ("rust", "trait") => Some(ItemKind::Trait),
        ("rust", "type") => Some(ItemKind::Type),
        ("rust", "const") | ("rust", "static") => Some(ItemKind::Constant),
        ("rust", "use") | ("rust", "mod") => Some(ItemKind::Import),

        (_, "function") => Some(ItemKind::Function),
        (_, "class") => Some(ItemKind::Class),
        (_, "interface") => Some(ItemKind::Interface),
        (_, "enum") => Some(ItemKind::Enum),
        (_, "type") => Some(ItemKind::Type),
        (_, "import") => Some(ItemKind::Import),
        _ => None,
    }
}

/// The declared name after a keyword.
fn next_name(tokens: &[Token], from: usize) -> Option<String> {
    const MODIFIERS: &[&str] =
        &["async", "mut", "unsafe", "extern", "const", "static", "abstract", "final", "*"];

    let mut index = from;
    while index < tokens.len() {
        let token = &tokens[index];

        // A brace or semicolon before any name means there was no declaration:
        // `type { ... }` in an import, or a bare `const` in a for-loop head.
        if token.text == "{" || token.text == ";" || token.text == "=" {
            return None;
        }

        if token.kind == Kind::Identifier && !MODIFIERS.contains(&token.text.as_str()) {
            return Some(token.text.clone());
        }

        // Skip a generic parameter list, or Go's receiver `(r *T)`.
        if token.kind == Kind::Open || token.text == "<" {
            let mut depth = 0;
            while index < tokens.len() {
                match tokens[index].kind {
                    Kind::Open => depth += 1,
                    Kind::Close => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                index += 1;
            }
        }

        index += 1;
    }
    None
}

/// Renders an outline as indented text.
pub fn render(items: &[Item]) -> String {
    let mut out = String::new();
    for item in items {
        let indent = "  ".repeat(item.depth.min(6));
        let visibility = if item.exported { "" } else { "· " };
        out.push_str(&format!(
            "{:>5}  {indent}{visibility}{} {}\n",
            item.line,
            item.kind.label(),
            item.name
        ));
    }
    out
}

/// The outline of a file on disk.
pub fn outline_file(path: &str) -> Result<Vec<Item>, String> {
    let source = std::fs::read_to_string(path).map_err(|error| format!("{path}: {error}"))?;
    Ok(outline(&source, &syntax_for(path)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::{PYTHON, RUST, TYPESCRIPT};

    fn names(source: &str, syntax: &Syntax) -> Vec<String> {
        outline(source, syntax).into_iter().map(|item| item.name).collect()
    }

    #[test]
    fn typescript_declarations() {
        let source = r#"
import { a } from "./a";

export function first(): void {}

class Widget {
  render() {}
}

export interface Shape { size: number }
type Alias = string;
"#;
        let found = names(source, &TYPESCRIPT);
        assert!(found.contains(&"first".to_string()));
        assert!(found.contains(&"Widget".to_string()));
        assert!(found.contains(&"Shape".to_string()));
        assert!(found.contains(&"Alias".to_string()));
    }

    #[test]
    fn exported_declarations_are_marked() {
        let items = outline("export function shown() {}\nfunction hidden() {}", &TYPESCRIPT);
        let shown = items.iter().find(|item| item.name == "shown").unwrap();
        let hidden = items.iter().find(|item| item.name == "hidden").unwrap();
        assert!(shown.exported);
        assert!(!hidden.exported);
    }

    #[test]
    fn a_function_inside_a_class_is_a_method() {
        let items = outline("class A {\n  function go() {}\n}", &TYPESCRIPT);
        let go = items.iter().find(|item| item.name == "go").unwrap();
        assert_eq!(go.kind, ItemKind::Method);
        assert!(go.depth > 0);
    }

    #[test]
    fn rust_declarations() {
        let source = "pub struct Config { size: usize }\n\nimpl Config {\n    pub fn new() -> Self { Self { size: 0 } }\n}\n\npub enum Mode { On, Off }\n";
        let found = names(source, &RUST);
        assert!(found.contains(&"Config".to_string()));
        assert!(found.contains(&"new".to_string()));
        assert!(found.contains(&"Mode".to_string()));
    }

    #[test]
    fn python_declarations() {
        let source = "import os\n\nclass Thing:\n    def method(self):\n        pass\n\ndef top_level():\n    pass\n";
        let found = names(source, &PYTHON);
        assert!(found.contains(&"Thing".to_string()));
        assert!(found.contains(&"method".to_string()));
        assert!(found.contains(&"top_level".to_string()));
    }

    #[test]
    fn a_keyword_from_another_language_is_not_a_declaration() {
        // `def` is an ordinary identifier in TypeScript.
        let items = outline("const def = 1; def(x);", &TYPESCRIPT);
        assert!(items.iter().all(|item| item.name != "x"));
    }

    #[test]
    fn a_declaration_in_a_comment_is_not_found() {
        let items = outline("// export function ghost() {}\nexport function real() {}", &TYPESCRIPT);
        assert_eq!(items.iter().filter(|item| item.kind == ItemKind::Function).count(), 1);
        assert_eq!(items[0].name, "real");
    }

    #[test]
    fn tests_are_labelled() {
        let items = outline("function test_adds() {}", &TYPESCRIPT);
        assert_eq!(items[0].kind, ItemKind::Test);
    }

    #[test]
    fn generics_are_skipped_when_finding_the_name() {
        let items = outline("export function map<T, U>(items: T[]): U[] {}", &TYPESCRIPT);
        assert_eq!(items[0].name, "map");
    }

    #[test]
    fn an_import_with_braces_does_not_invent_a_name() {
        // `import { a, b } from "x"` has no declared name to report.
        let items = outline(r#"import { a, b } from "x";"#, &TYPESCRIPT);
        assert!(items.iter().all(|item| item.name != "{"));
    }

    #[test]
    fn rendering_indents_by_depth() {
        let items = outline("class A {\n  function go() {}\n}", &TYPESCRIPT);
        let rendered = render(&items);
        assert!(rendered.contains("class A"));
        assert!(rendered.contains("  "));
    }

    #[test]
    fn an_empty_file_produces_an_empty_outline() {
        assert!(outline("", &TYPESCRIPT).is_empty());
        assert!(outline("\n\n// only a comment\n", &TYPESCRIPT).is_empty());
    }
}
