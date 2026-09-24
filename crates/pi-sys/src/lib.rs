//! # pi-sys
//!
//! The operating-system surface the agent needs (architecture §6.1):
//! process trees, the clipboard, and power assertions.
//!
//! Grouped into one crate because they share a shape rather than a subject:
//! each is a thin, std-only wrapper over a platform tool, each has a different
//! answer on every OS, and each degrades to an honest "unavailable" rather than
//! to a lie. Splitting them into three crates would triple the manifest count
//! for about nine hundred lines.
//!
//! No `arboard`, no `sysinfo`, no `nix`. Every operation here is spawning a
//! process and reading its output, which is what those crates do underneath —
//! and this workspace's premise is not carrying a dependency tree.

pub mod clipboard;
pub mod power;
pub mod process;

pub use clipboard::{copy, paste, Backend};
pub use power::{prevent_sleep, Assertion, PowerAssertion};
pub use process::{descendants, kill_tree, snapshot, KillReport, Process};
