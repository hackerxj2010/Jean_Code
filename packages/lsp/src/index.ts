/**
 * `@jean/lsp` — Language Server Protocol integration (architecture §11).
 *
 * Gives the agent the same code intelligence an editor has: real diagnostics,
 * go-to-definition through imports, and references that distinguish a binding
 * from a string that happens to match.
 */

export {
  Connection,
  ErrorCode,
  LspError,
  pathToUri,
  uriToPath,
  type NotificationMessage,
  type RequestMessage,
  type ResponseMessage,
} from './protocol.ts'

export {
  LspClient,
  type ClientOptions,
  type Diagnostic,
  type DiagnosticSeverity,
  type Location,
  type Position,
  type Range,
  type SymbolInfo,
} from './client.ts'

export { LspManager, type ManagerOptions } from './manager.ts'

export {
  NativeLanguageServers,
  type CodeActionInfo,
  type DiagnosticsResult,
  type EngineOptions,
  type EngineStatus,
  type FileChange,
  type HierarchyItem,
  type NativeDiagnostic,
  type NativeLocation,
  type NativeSymbol,
  type ServerInfo,
  type Target,
} from './native.ts'

export {
  availableServers,
  BUILTIN_SERVERS,
  clearBinaryCache,
  findRoot,
  hasBinary,
  serverFor,
  type ServerMatch,
  type ServerSpec,
} from './servers.ts'

export { extensionOf, LANGUAGE_BY_EXTENSION, languageOf } from './languages.ts'

export {
  applyEdits,
  codeActions,
  codeLenses,
  declaration,
  formatting,
  incomingCalls,
  outgoingCalls,
  rangeFormatting,
  willRenameFiles,
  type CodeAction,
  type CodeLens,
  type TextEdit,
} from './operations.ts'

export { createLspTools, formatDiagnostics } from './tools.ts'
