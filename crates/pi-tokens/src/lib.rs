//! # pi-tokens
//!
//! Token counting (architecture §6.1 `tokens`).
//!
//! The agent decides when to compact, whether a file fits, and how much of a
//! tool result to keep — all from a token count. Getting it wrong in the low
//! direction overflows the context window and loses the turn.
//!
//! Two paths: a real BPE encoder when a vocabulary is available, and a
//! calibrated estimate when it is not. `Count::exact` reports which, so an
//! estimate is never shown as a measurement.

pub mod bpe;

pub use bpe::{estimate, Count, Counter, Vocabulary};
