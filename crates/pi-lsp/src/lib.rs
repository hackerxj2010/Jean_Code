//! # pi-lsp
//!
//! A Language Server Protocol client for an agent: any language, the server
//! found or installed on demand, and every request that helps an agent reason
//! about code rather than text.
//!
//! What it does that a text search cannot:
//!
//! * **Diagnostics after every edit** — the type checker's and the linters'
//!   together, waited for until the server has finished reporting, pulled
//!   where the server supports it.
//! * **Navigation that follows the language** — definition, type definition,
//!   implementation, declaration, references, call and type hierarchies,
//!   through imports, re-exports, and generics.
//! * **Changes the language server makes correctly** — renames across the
//!   project, quick fixes and refactors from code actions, formatting, and
//!   moving a file with every import of it updated — applied to disk all or
//!   nothing.
//!
//! The registry ([`servers`]) covers seventy-odd servers across every major
//! ecosystem, each with a recipe to install it into `~/.jean/tools` when it is
//! missing ([`install`]), and user config can add any other. The [`hub`] is
//! the entry point: `hub().call("diagnostics", &params)`.
//!
//! No dependencies beyond the workspace's own JSON: framing, URIs, UTF-16
//! positions, and edit application are all here, and all tested.

pub mod client;
pub mod detect;
pub mod edit;
pub mod hub;
pub mod install;
pub mod json;
pub mod languages;
pub mod protocol;
pub mod servers;
pub mod text;
pub mod transport;
pub mod uri;

pub use client::{Client, LaunchSpec, LspError};
pub use hub::{hub, Hub, METHODS};
