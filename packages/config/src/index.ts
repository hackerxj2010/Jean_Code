/**
 * `@jean/config` — configuration management.
 *
 * Resolves the effective config from six layers (defaults, imported foreign
 * config, global, project, environment, flags), validates it without failing
 * the whole load on one bad key, and writes settings back.
 */
export * from './types.ts'
export { defaultConfig, globalConfigPath, jeanHome } from './defaults.ts'
export { authPath, readAuth, removeKey, saveKey, savedKey } from './auth.ts'
export type { SavedCredential } from './auth.ts'
export {
  expandEnv,
  merge,
  parseJsonc,
  resolveRoles,
  splitModelRef,
  stripJsonComments,
  validate,
} from './parser.ts'
export {
  configFromEnv,
  configuredProviders,
  parseDotenv,
  providerKeyFromEnv,
  PROVIDER_KEY_ENV,
} from './env.ts'
export { importForeignConfig, supportedFormats } from './import/index.ts'
export type { ImportedConfig } from './import/index.ts'
export {
  ensureJeanHome,
  getSetting,
  loadConfig,
  maskSecret,
  redactSecrets,
  resolvePath,
  setSetting,
} from './settings.ts'
export type { LoadOptions } from './settings.ts'
