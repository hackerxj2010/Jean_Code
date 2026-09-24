//! # brush-core
//!
//! **Superseded.** This crate was reserved to vendor the `brush` shell as the
//! parser and executor behind [`pi_shell`]. That vendoring never happened, and
//! it should not: `pi-shell` now implements its own tokenizer, parser,
//! expansion, and executor directly, in about the same amount of code a fork
//! would have needed patches for.
//!
//! Three reasons the fork was the wrong plan:
//!
//! - **Dependency weight.** Vendoring a full bash implementation brings its
//!   dependency tree with it. The rest of this workspace takes none, and one
//!   crate reintroducing a dozen would have decided the question for all of it.
//! - **The interesting behaviour is ours.** Permission gating on a parsed
//!   command tree, sessions that survive across tool calls, and dispatching to
//!   in-process builtins are not features of a shell — they are the reason to
//!   have written one. Every one of them would have been a patch carried
//!   against upstream forever.
//! - **Scope.** Jean Code does not need bash. It needs the subset an agent
//!   writes: pipelines, redirection, `&&`, substitution, globs, and quoting.
//!   `pi-shell` covers that and reports clearly what it does not, which is more
//!   useful than a fork that half-supports the rest.
//!
//! The crate remains in the workspace as a pointer, so anyone looking for the
//! shell implementation finds their way to it rather than concluding it is
//! missing. It has no functionality of its own and nothing depends on it.
//!
//! [`pi_shell`]: https://docs.rs/pi-shell

/// Where the shell actually lives.
pub const IMPLEMENTATION: &str = "pi-shell";

/// What `pi-shell` implements, for a caller checking before it reaches for a
/// system shell.
pub const SUPPORTED: &[&str] = &[
    "pipelines",
    "&& and ||",
    "sequences and subshells",
    "redirection (< > >> 2> 2>&1)",
    "heredocs",
    "command substitution",
    "arithmetic expansion",
    "parameter expansion with defaults",
    "brace expansion",
    "globbing",
    "quoting and escaping",
    "variable and directory persistence across calls",
    "aliases",
];

/// What it deliberately does not implement.
///
/// Listed rather than silently missing: a caller that needs one of these should
/// find out here and spawn a system shell, not discover it from a script that
/// half-ran.
pub const UNSUPPORTED: &[&str] = &[
    "functions",
    "for/while/case/if constructs",
    "arrays and associative arrays",
    "process substitution",
    "job control (fg, bg, jobs)",
    "traps and signal handling",
    "sourcing scripts",
];

/// Whether a script uses anything `pi-shell` will not run.
///
/// A cheap keyword scan, deliberately erring toward reporting a construct that
/// is not really there: a false warning costs a spawned subprocess, and a
/// missed one costs a script that runs halfway and stops.
pub fn needs_system_shell(script: &str) -> Option<&'static str> {
    const MARKERS: &[(&str, &str)] = &[
        ("function ", "functions"),
        ("for ", "for loops"),
        ("while ", "while loops"),
        ("until ", "until loops"),
        ("case ", "case statements"),
        ("if ", "if statements"),
        ("trap ", "traps"),
        ("source ", "sourcing"),
        ("declare ", "declare"),
        ("local ", "local"),
    ];

    /// Markers that mean what they say anywhere in a line, because no ordinary
    /// word contains them.
    const ANYWHERE: &[(&str, &str)] =
        &[("<(", "process substitution"), (">(", "process substitution")];

    for line in script.lines() {
        let trimmed = line.trim();
        // A comment mentioning `if` is not an if statement.
        if trimmed.starts_with('#') {
            continue;
        }

        for (marker, name) in ANYWHERE {
            if trimmed.contains(marker) {
                return Some(name);
            }
        }

        for (marker, name) in MARKERS {
            // Anchored to the start of a command, so `notify_if_failed` and a
            // path containing `for` do not trip it.
            if trimmed.starts_with(marker) || trimmed.contains(&format!("; {marker}")) {
                return Some(name);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pointer_names_the_real_implementation() {
        assert_eq!(IMPLEMENTATION, "pi-shell");
        assert!(!SUPPORTED.is_empty());
        assert!(!UNSUPPORTED.is_empty());
    }

    #[test]
    fn detects_constructs_that_need_a_real_shell() {
        assert_eq!(needs_system_shell("for f in *.txt; do echo $f; done"), Some("for loops"));
        assert_eq!(needs_system_shell("function greet() { echo hi; }"), Some("functions"));
        assert_eq!(needs_system_shell("if [ -f x ]; then echo yes; fi"), Some("if statements"));
        assert_eq!(needs_system_shell("diff <(sort a) <(sort b)"), Some("process substitution"));
    }

    #[test]
    fn an_ordinary_pipeline_needs_nothing_special() {
        assert_eq!(needs_system_shell("cat file.txt | grep needle | wc -l"), None);
        assert_eq!(needs_system_shell("export X=1 && echo $X"), None);
    }

    #[test]
    fn an_identifier_containing_a_keyword_is_not_a_construct() {
        // `format_if_needed` starts with neither `if ` nor `for `.
        assert_eq!(needs_system_shell("format_if_needed --check"), None);
        assert_eq!(needs_system_shell("echo performance"), None);
    }

    #[test]
    fn a_comment_mentioning_a_keyword_is_not_a_construct() {
        assert_eq!(needs_system_shell("# if this fails, retry\necho ok"), None);
    }
}
