/**
 * `@jean/projects` — project knowledge base and retrieval (architecture §6.24).
 *
 * Indexes a codebase and its documentation so an agent can answer questions
 * about a repository far larger than its context window.
 *
 * The design constraint that shapes everything here: **no embedding model.**
 * An embedding index means a network call per chunk on every reindex, an API
 * key for a second provider, and a vector store to maintain. For a codebase —
 * as opposed to a corpus of prose — lexical retrieval is also *better* at the
 * queries that matter, because the query is usually a symbol name, an error
 * string, or a file path, and those are exact matches that embeddings blur.
 *
 * So retrieval is BM25 over an inverted index, with three things layered on
 * that close most of the gap:
 *
 * - **Identifier splitting**, so `runAgentLoop` is findable as "agent loop".
 * - **Structural chunking**, so a retrieved chunk is a whole declaration.
 * - **Path and recency boosts**, because a match in `src/` beats one in a
 *   fixture, and a file edited this week beats one untouched for two years.
 *
 * `@jean/memory` covers cross-session recall of facts; this is the
 * larger-corpus case of "what does this repository contain".
 */

export {
  chunkFile,
  chunkId,
  declarationName,
  kindFor,
  renderChunk,
  type Chunk,
  type ChunkKind,
  type ChunkOptions,
} from './chunk.ts'

export {
  Index,
  splitIdentifier,
  stem,
  tokenize,
  type IndexedChunk,
  type ScoredChunk,
} from './retrieve.ts'

export {
  KnowledgeBase,
  type BuildProgress,
  type BuildResult,
  type KnowledgeBaseOptions,
  type Query,
  type QueryResult,
} from './base.ts'
