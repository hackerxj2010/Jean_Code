/**
 * `@jean/runtime` — persistent language kernels (architecture §8.4).
 *
 * A long-lived Python or JavaScript interpreter the agent sends code to, with
 * state that persists across calls and a loopback bridge letting kernel code
 * call back into agent tools.
 */

export {
  Kernel,
  type ExecuteResult,
  type KernelLanguage,
  type KernelOptions,
} from './kernel.ts'

export { createKernelTools, KernelRegistry } from './tools.ts'
