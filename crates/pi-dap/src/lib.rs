//! # pi-dap
//!
//! A Debug Adapter Protocol client for an agent.
//!
//! A debugger answers "why is this wrong" in one step where reading code and
//! adding prints takes many: stop where it goes wrong, and the stack and the
//! live values are the explanation. This crate drives every mainstream
//! debugger the same way — debugpy, js-debug, Delve, CodeLLDB, lldb-dap, GDB,
//! netcoredbg, ElixirLS, and any adapter user config adds — over stdio or
//! TCP, including js-debug's child sessions, and installs the adapter into
//! `~/.jean/tools` when it is missing.
//!
//! The [`hub`] is the entry point: `hub().call("start", &params)` launches a
//! program to its first breakpoint and answers with where it stopped and what
//! it holds. When a session ends, the adapter's whole process tree is killed
//! through `pi-sys`, so no debuggee outlives it.

pub mod adapters;
pub mod build;
pub mod hub;
pub mod session;

pub use hub::{hub, Hub, METHODS};
pub use session::{BreakpointSpec, DapError, Session, Status};
