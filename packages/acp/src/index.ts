/**
 * `@jean/acp` — Agent Client Protocol over stdio (architecture §6.22).
 *
 * The framing layer is implemented and tested here: newline-delimited JSON-RPC,
 * request/response correlation, notification dispatch, and error mapping. That
 * is the part that has to be exactly right, because an editor on the other end
 * will hang rather than complain.
 *
 * Binding those messages to an orchestrator session is not implemented.
 */

export {
  Connection,
  ErrorCode,
  type Handler,
  type Request,
  type Response,
} from './connection.ts'

export {
  serve,
  type AgentSession,
  type ServeOptions,
} from './session.ts'
