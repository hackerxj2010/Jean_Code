//! # pi-natives
//!
//! N-API bindings that expose the Rust core to TypeScript. Every function here
//! has a pure-TypeScript fallback in `packages/tools`, so the CLI runs with or
//! without a compiled native module; the native path is the fast path.
//!
//! Building this crate as a real addon requires the `napi` toolchain
//! (`bun run build:native`). Until then these are plain Rust entry points that
//! the fallback layer mirrors exactly, and the same tests cover both.

pub mod handlers;
pub mod ops;
pub mod protocol;

pub use brush_core;
pub use hashline;
pub use pi_ast;
pub use pi_builtins;
pub use pi_iso;
pub use pi_mnemopi;
pub use pi_shell;
pub use pi_sys;
pub use pi_tokens;
pub use pi_voice;
pub use pi_lsp;
pub use pi_dap;
pub use pi_walker;
pub use snapcompact;

/// Applies a hashline patch. Mirrors `applyHashlinePatch` in
/// `packages/tools/src/edit.ts`.
pub fn apply_hashline(content: &str, patch: &str) -> Result<String, String> {
    hashline::patch(content, patch)
        .map(|a| a.content)
        .map_err(|e| e.to_string())
}

/// Renders a file with its anchor gutter, which is what `read` returns to the
/// agent so it can cite anchors in a subsequent edit.
pub fn annotate(content: &str) -> String {
    hashline::Index::new(content).annotate()
}

#[cfg(test)]
mod tests {
    #[test]
    fn applies_a_patch_through_the_binding() {
        let src = "fn main() {\n    println!(\"hi\");\n}\n";
        let anchor = hashline::anchor_of("    println!(\"hi\");");
        let patch = format!(
            "anchor: h:{anchor}\npatch: |-|\n- println!(\"hi\");\n+ println!(\"hello\");\n"
        );
        let out = super::apply_hashline(src, &patch).expect("applies");
        assert!(out.contains("hello"));
    }
}
