/**
 * `@jean/dap` — Debug Adapter Protocol (architecture §8.3).
 *
 * Drives real debuggers: `lldb` for a C segfault, `dlv` for a hung Go service,
 * `debugpy` for wedged Python. A stack trace with live variable values answers
 * "why is this wrong" in one step, where reading code and adding print
 * statements takes many turns and often reaches the wrong conclusion.
 */

export {
  Connection,
  DapError,
  type Event,
  type Message,
  type Request,
  type Response,
} from './protocol.ts'

export {
  DebugSession,
  type Breakpoint,
  type Scope,
  type SessionOptions,
  type StackFrame,
  type StoppedState,
  type Thread,
  type Variable,
} from './session.ts'

export {
  adapterFor,
  availableAdapters,
  BUILTIN_ADAPTERS,
  clearAdapterCache,
  findRoot,
  hasAdapter,
  type AdapterSpec,
} from './adapters.ts'

export { createDebugTools, DebugRegistry, renderSnapshot, type RegistryOptions } from './tools.ts'

export {
  NativeDebuggers,
  type AdapterInfo,
  type BreakpointLine,
  type EngineOptions as DebugEngineOptions,
  type Frame,
  type SessionInfo,
  type Snapshot,
  type StartOptions,
  type Value,
} from './native.ts'
