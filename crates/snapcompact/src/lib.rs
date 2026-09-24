//! # snapcompact
//!
//! Context compaction: older turns collapse into frames that keep their
//! referenced entities addressable without keeping their full text.
//!
//! The problem is that a long session runs out of context window, and the naive
//! fix — summarize everything older than N turns into a paragraph — throws away
//! exactly what the agent needs later. It forgets which file it edited, what
//! the error message said, which command it already tried. Then it tries the
//! failing command again.
//!
//! So a frame keeps three things:
//!
//! 1. A **summary** of what happened, for the model to read.
//! 2. The **entities** referenced — files, symbols, commands, errors — kept in
//!    full, because they are short and they are what gets looked up.
//! 3. A **content hash** of the original text, so the full turn can be fetched
//!    back if the agent needs it.
//!
//! The third point is what makes this different from summarizing: compaction is
//! lossless at the storage layer and lossy only in what is *presented*. Nothing
//! is destroyed, so a wrong compaction decision is recoverable.

pub mod entities;
pub mod store;

pub use entities::{extract, Entity, EntityKind};
pub use store::Store;

/// One turn in a conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub index: usize,
    pub role: Role,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    /// Tool output, which is where most of the bulk lives.
    Tool,
    System,
}

impl Role {
    pub fn label(&self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
            Role::System => "system",
        }
    }
}

/// A compacted frame covering a contiguous range of turns.
#[derive(Debug, Clone)]
pub struct Frame {
    pub first_turn: usize,
    pub last_turn: usize,
    pub summary: String,
    /// Everything the frame referenced, kept in full.
    pub entities: Vec<Entity>,
    /// Content hash of the original text, for retrieval.
    pub hash: String,
    /// Estimated tokens before and after, so the saving is visible.
    pub tokens_before: usize,
    pub tokens_after: usize,
}

impl Frame {
    /// The frame as the model sees it.
    pub fn render(&self) -> String {
        let span = if self.first_turn == self.last_turn {
            format!("turn {}", self.first_turn)
        } else {
            format!("turns {}–{}", self.first_turn, self.last_turn)
        };

        let mut out = format!("[compacted {span}]\n{}\n", self.summary.trim());

        if !self.entities.is_empty() {
            out.push_str("\nreferenced:\n");
            for entity in &self.entities {
                out.push_str(&format!("  {} {}\n", entity.kind.label(), entity.text));
            }
        }

        // The hash is included so the model can ask for the full text by name
        // rather than guessing that it is gone.
        out.push_str(&format!("\n[full text available as {}]\n", &self.hash[..12.min(self.hash.len())]));
        out
    }
}

/// How compaction decides what to collapse.
#[derive(Debug, Clone)]
pub struct Policy {
    /// Turns at the end that are never compacted.
    ///
    /// The recent turns are what the agent is actually working from; compacting
    /// them is how an agent loses the thread mid-task.
    pub keep_recent: usize,
    /// Turns at the start that are never compacted — the original request.
    pub keep_first: usize,
    /// Compaction starts once the estimate passes this.
    pub trigger_tokens: usize,
    /// Compaction stops once the estimate drops below this.
    pub target_tokens: usize,
    /// Turns shorter than this are left alone: compacting them saves nothing
    /// and costs the reader a frame header.
    pub min_turn_tokens: usize,
    /// How many turns one frame may span.
    pub max_frame_turns: usize,
}

impl Default for Policy {
    fn default() -> Self {
        Policy {
            keep_recent: 8,
            keep_first: 2,
            trigger_tokens: 120_000,
            // Well below the trigger: compacting down to just under it means
            // compacting again on the very next turn.
            target_tokens: 60_000,
            min_turn_tokens: 200,
            max_frame_turns: 12,
        }
    }
}

/// The result of a compaction pass.
#[derive(Debug, Clone, Default)]
pub struct Compaction {
    pub frames: Vec<Frame>,
    /// Turns kept whole, by index.
    pub kept: Vec<usize>,
    pub tokens_before: usize,
    pub tokens_after: usize,
}

impl Compaction {
    pub fn saved(&self) -> usize {
        self.tokens_before.saturating_sub(self.tokens_after)
    }

    /// A one-line report, for the transcript.
    pub fn report(&self) -> String {
        if self.frames.is_empty() {
            return "nothing to compact".to_string();
        }
        let percent = if self.tokens_before == 0 {
            0
        } else {
            self.saved() * 100 / self.tokens_before
        };
        format!(
            "compacted {} turns into {} frames: {} → {} tokens ({percent}% smaller)",
            self.frames.iter().map(|f| f.last_turn - f.first_turn + 1).sum::<usize>(),
            self.frames.len(),
            self.tokens_before,
            self.tokens_after
        )
    }
}

/// Estimates the tokens in a string.
///
/// Four characters per token is the usual rule for English prose. Code runs
/// denser — more punctuation, fewer whole words — so this weights by how much
/// of the text is non-alphabetic. Being roughly right everywhere beats being
/// exactly right on prose and 40% low on a stack trace.
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let characters = text.chars().count();
    let symbols = text.chars().filter(|c| !c.is_alphanumeric() && !c.is_whitespace()).count();
    let density = symbols as f64 / characters as f64;
    // 4.0 chars/token for prose down to 2.8 for symbol-heavy text.
    let per_token = 4.0 - density * 1.2;
    (characters as f64 / per_token.max(2.0)).ceil() as usize
}

/// Compacts a conversation according to a policy.
pub fn compact(turns: &[Turn], policy: &Policy, store: &mut Store) -> Compaction {
    let total: usize = turns.iter().map(|turn| estimate_tokens(&turn.text)).sum();

    let mut result = Compaction { tokens_before: total, tokens_after: total, ..Default::default() };

    if total <= policy.trigger_tokens {
        result.kept = turns.iter().map(|turn| turn.index).collect();
        return result;
    }

    // The window that may be compacted: everything but the head and the tail.
    let start = policy.keep_first.min(turns.len());
    let end = turns.len().saturating_sub(policy.keep_recent).max(start);

    let mut running = total;
    let mut index = start;
    let mut compacted: Vec<usize> = Vec::new();

    while index < end && running > policy.target_tokens {
        // A frame runs until it hits the turn cap or the target is reached.
        let frame_start = index;
        let mut frame_end = index;
        let mut frame_tokens = 0usize;

        while frame_end < end
            && frame_end - frame_start < policy.max_frame_turns
            && running - frame_tokens > policy.target_tokens
        {
            frame_tokens += estimate_tokens(&turns[frame_end].text);
            frame_end += 1;
        }

        if frame_end == frame_start {
            break;
        }

        let slice = &turns[frame_start..frame_end];

        // A run of small turns is not worth a frame: the header costs more than
        // the text saves.
        if frame_tokens < policy.min_turn_tokens {
            index = frame_end;
            continue;
        }

        let frame = build_frame(slice, store);
        running = running - frame.tokens_before + frame.tokens_after;
        compacted.extend(slice.iter().map(|turn| turn.index));
        result.frames.push(frame);
        index = frame_end;
    }

    result.kept = turns
        .iter()
        .map(|turn| turn.index)
        .filter(|index| !compacted.contains(index))
        .collect();
    result.tokens_after = running;
    result
}

/// Builds one frame from a run of turns.
pub fn build_frame(turns: &[Turn], store: &mut Store) -> Frame {
    let combined: String = turns
        .iter()
        .map(|turn| format!("{}: {}", turn.role.label(), turn.text))
        .collect::<Vec<_>>()
        .join("\n\n");

    let tokens_before = estimate_tokens(&combined);
    let hash = store.put(&combined);

    let mut entities = extract(&combined);
    // Bounded: a frame listing 400 files is no more useful than one listing 30,
    // and it defeats the purpose.
    entities.truncate(30);

    let summary = summarize(turns);
    let rendered_tokens = estimate_tokens(&summary)
        + entities.iter().map(|e| estimate_tokens(&e.text) + 2).sum::<usize>()
        + 20;

    Frame {
        first_turn: turns.first().map(|t| t.index).unwrap_or(0),
        last_turn: turns.last().map(|t| t.index).unwrap_or(0),
        summary,
        entities,
        hash,
        tokens_before,
        tokens_after: rendered_tokens,
    }
}

/// A structural summary of what happened in a run of turns.
///
/// Deliberately not a model call. Compaction runs when the context is already
/// full, which is the worst moment to need another request, and a summary that
/// says which tools ran and what they touched is more reliably useful than a
/// paragraph of prose about it.
fn summarize(turns: &[Turn]) -> String {
    let mut lines: Vec<String> = Vec::new();

    for turn in turns {
        let first_line = turn
            .text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("");

        let condensed = if first_line.chars().count() > 120 {
            let head: String = first_line.chars().take(117).collect();
            format!("{head}...")
        } else {
            first_line.to_string()
        };

        if condensed.is_empty() {
            continue;
        }

        let size = estimate_tokens(&turn.text);
        // The size is kept because "the tool returned 8,000 tokens" is itself
        // information — it tells the agent not to re-run it blindly.
        lines.push(if size > 500 {
            format!("{}: {condensed} [{size} tokens]", turn.role.label())
        } else {
            format!("{}: {condensed}", turn.role.label())
        });
    }

    lines.join("\n")
}

/// Renders a compaction as the message list the model receives.
pub fn render(turns: &[Turn], compaction: &Compaction) -> String {
    let mut pieces: Vec<(usize, String)> = Vec::new();

    for frame in &compaction.frames {
        pieces.push((frame.first_turn, frame.render()));
    }

    for turn in turns {
        if compaction.kept.contains(&turn.index) {
            pieces.push((turn.index, format!("{}: {}", turn.role.label(), turn.text)));
        }
    }

    // Ordering by original turn index keeps the conversation in sequence; a
    // frame appearing after the turns it summarizes would read as new activity.
    pieces.sort_by_key(|(index, _)| *index);
    pieces.into_iter().map(|(_, text)| text).collect::<Vec<_>>().join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turns(count: usize, size: usize) -> Vec<Turn> {
        (0..count)
            .map(|index| Turn {
                index,
                role: if index % 2 == 0 { Role::User } else { Role::Assistant },
                text: format!("Turn {index}. ") + &"word ".repeat(size),
            })
            .collect()
    }

    #[test]
    fn token_estimates_are_in_the_right_range() {
        // Prose: roughly four characters per token.
        let prose = "The quick brown fox jumps over the lazy dog.";
        let estimate = estimate_tokens(prose);
        assert!((8..=16).contains(&estimate), "{estimate}");

        // Code is denser and must estimate higher per character.
        let code = "const x=[1,2,3].map((n)=>n*2);";
        assert!(estimate_tokens(code) > code.len() / 5);

        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn nothing_is_compacted_below_the_trigger() {
        let mut store = Store::in_memory();
        let conversation = turns(10, 5);
        let result = compact(&conversation, &Policy::default(), &mut store);
        assert!(result.frames.is_empty());
        assert_eq!(result.kept.len(), 10);
    }

    #[test]
    fn compaction_shrinks_a_long_conversation() {
        let mut store = Store::in_memory();
        let conversation = turns(60, 400);
        let policy = Policy { trigger_tokens: 5_000, target_tokens: 2_000, ..Default::default() };

        let result = compact(&conversation, &policy, &mut store);
        assert!(!result.frames.is_empty());
        assert!(result.tokens_after < result.tokens_before);
        assert!(result.saved() > 0);
    }

    #[test]
    fn recent_turns_are_never_compacted() {
        // The agent works from these; compacting them loses the thread.
        let mut store = Store::in_memory();
        let conversation = turns(60, 400);
        let policy = Policy {
            trigger_tokens: 1_000,
            target_tokens: 100,
            keep_recent: 5,
            ..Default::default()
        };

        let result = compact(&conversation, &policy, &mut store);
        for index in 55..60 {
            assert!(result.kept.contains(&index), "turn {index} was compacted");
        }
    }

    #[test]
    fn the_opening_turns_are_never_compacted() {
        let mut store = Store::in_memory();
        let conversation = turns(60, 400);
        let policy = Policy {
            trigger_tokens: 1_000,
            target_tokens: 100,
            keep_first: 2,
            ..Default::default()
        };

        let result = compact(&conversation, &policy, &mut store);
        assert!(result.kept.contains(&0));
        assert!(result.kept.contains(&1));
    }

    #[test]
    fn a_frame_keeps_the_files_it_referenced() {
        let mut store = Store::in_memory();
        let conversation = vec![Turn {
            index: 0,
            role: Role::Tool,
            text: "Edited src/main.rs and packages/core/src/loop.ts. Ran `cargo test`. Error: E0308 mismatched types.".to_string(),
        }];

        let frame = build_frame(&conversation, &mut store);
        let texts: Vec<&str> = frame.entities.iter().map(|e| e.text.as_str()).collect();
        assert!(texts.contains(&"src/main.rs"), "{texts:?}");
        assert!(texts.contains(&"packages/core/src/loop.ts"), "{texts:?}");
    }

    #[test]
    fn the_original_text_is_retrievable_by_hash() {
        // Compaction is lossy in what it shows, not in what it stores.
        let mut store = Store::in_memory();
        let conversation = turns(3, 100);
        let frame = build_frame(&conversation, &mut store);

        let recovered = store.get(&frame.hash).unwrap();
        assert!(recovered.contains("Turn 0"));
        assert!(recovered.contains("Turn 2"));
    }

    #[test]
    fn a_frame_renders_with_its_hash() {
        let mut store = Store::in_memory();
        let frame = build_frame(&turns(3, 100), &mut store);
        let rendered = frame.render();
        assert!(rendered.contains("compacted turns 0–2"));
        assert!(rendered.contains("full text available"));
    }

    #[test]
    fn rendering_keeps_the_conversation_in_order() {
        let mut store = Store::in_memory();
        let conversation = turns(40, 300);
        let policy = Policy {
            trigger_tokens: 1_000,
            target_tokens: 300,
            keep_recent: 3,
            keep_first: 1,
            ..Default::default()
        };

        let result = compact(&conversation, &policy, &mut store);
        let rendered = render(&conversation, &result);

        // The first turn precedes the last one in the output.
        let first = rendered.find("Turn 0").unwrap();
        let last = rendered.find("Turn 39").unwrap();
        assert!(first < last);
    }

    #[test]
    fn the_report_states_what_happened() {
        let mut store = Store::in_memory();
        let policy = Policy { trigger_tokens: 1_000, target_tokens: 400, ..Default::default() };
        let result = compact(&turns(40, 300), &policy, &mut store);
        let report = result.report();
        assert!(report.contains("frames"), "{report}");
        assert!(report.contains("smaller"), "{report}");
    }

    #[test]
    fn compacting_an_empty_conversation_is_safe() {
        let mut store = Store::in_memory();
        let result = compact(&[], &Policy::default(), &mut store);
        assert!(result.frames.is_empty());
        assert_eq!(result.tokens_before, 0);
    }
}
