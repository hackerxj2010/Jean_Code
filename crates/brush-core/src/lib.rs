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
//!   writes: pipelines, redirection, `&&`, substitution, globs, quoting,
//!   conditions, loops, `case`, and functions.
//!   `pi-shell` covers that and reports clearly what it does not, which is more
//!   useful than a fork that half-supports the rest.
//!
//! The crate remains in the workspace as a pointer, so anyone looking for the
//! shell implementation finds their way to it rather than concluding it is
//! missing — and for one decision `pi-natives` makes before running a script:
//! [`needs_system_shell`], whether it uses one of the few constructs
//! `pi-shell` leaves to a real shell.
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
    "redirection (< > >> 2> 2>&1 <<<), on compound commands too",
    "heredocs, quoted (literal) or not, and <<-",
    "command substitution",
    "arithmetic expansion, let",
    "parameter expansion with defaults",
    "brace expansion",
    "globbing",
    "quoting and escaping",
    "variable and directory persistence across calls",
    "aliases",
    "if/elif/else, for, while, until, case",
    "functions, local, return, break/continue N",
    "test, [ and [[ (patterns, =~)",
    "read, printf, set -e / -o pipefail, shift, eval, source, declare",
];

/// What it deliberately does not implement.
///
/// Listed rather than silently missing: a caller that needs one of these should
/// find out here and spawn a system shell, not discover it from a script that
/// half-ran.
pub const UNSUPPORTED: &[&str] = &[
    "arrays and associative arrays",
    "process substitution",
    "(( )) arithmetic commands and C-style for loops",
    "select and coproc",
    "job control (fg, bg, jobs)",
    "traps and signal handling",
];

/// Whether a script uses anything `pi-shell` will not run.
///
/// A cheap keyword scan, deliberately erring toward reporting a construct that
/// is not really there: a false warning costs a spawned subprocess, and a
/// missed one costs a script that runs halfway and stops.
pub fn needs_system_shell(script: &str) -> Option<&'static str> {
    const MARKERS: &[(&str, &str)] = &[
        ("trap ", "traps"),
        ("select ", "select"),
        ("coproc ", "coproc"),
        ("declare -a", "arrays"),
        ("declare -A", "arrays"),
        ("local -a", "arrays"),
        ("((", "arithmetic commands"),
        ("for ((", "C-style for loops"),
    ];

    /// Markers that mean what they say anywhere in a line, because no ordinary
    /// word contains them.
    const ANYWHERE: &[(&str, &str)] = &[
        ("<(", "process substitution"),
        (">(", "process substitution"),
        ("=(", "arrays"),
        ("[@]", "arrays"),
        ("[*]}", "arrays"),
    ];

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
        assert_eq!(needs_system_shell("diff <(sort a) <(sort b)"), Some("process substitution"));
        assert_eq!(needs_system_shell("files=(a b c)"), Some("arrays"));
        assert_eq!(needs_system_shell("echo \"${files[@]}\""), Some("arrays"));
        assert_eq!(needs_system_shell("trap cleanup EXIT"), Some("traps"));
        assert_eq!(needs_system_shell("for ((i=0; i<3; i++)); do echo $i; done"), Some("C-style for loops"));
        assert_eq!(needs_system_shell("(( count++ ))"), Some("arithmetic commands"));
    }

    #[test]
    fn control_flow_runs_in_the_embedded_shell() {
        assert_eq!(needs_system_shell("for f in *.txt; do echo $f; done"), None);
        assert_eq!(needs_system_shell("function greet() { echo hi; }"), None);
        assert_eq!(needs_system_shell("if [ -f x ]; then echo yes; fi"), None);
        assert_eq!(needs_system_shell("while read l; do echo $l; done < f"), None);
        assert_eq!(needs_system_shell("case $1 in a) echo a ;; esac"), None);
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
