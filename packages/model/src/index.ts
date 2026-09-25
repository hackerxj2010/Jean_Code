/**
 * `@jean/model` — the model layer.
 *
 * Agents request a *role*; this package resolves it to a provider and model,
 * speaks that provider's wire protocol directly over `fetch`, streams the
 * result back in one neutral shape, and falls through a chain of alternates
 * when a provider fails.
 *
 * No vendor SDKs: adding a provider that speaks the OpenAI shape is one entry
 * in `providers/index.ts`.
 */
export * from './types.ts'
export { ModelClient } from './client.ts'
export type { ClientOptions, ResolvedModel, UsageEvent } from './client.ts'
export {
  allModels,
  contextWindow,
  estimateCost,
  estimateTokens,
  findModel,
  modelInfo,
  modelsOf,
  reservedModel,
  supportsThinking,
  supportsTools,
  supportsVision,
} from './catalog.ts'
export {
  apiOfPackage,
  catalogAge,
  catalogFromModelsDev,
  catalogPath,
  liveCatalog,
  MODELS_URL,
  refreshCatalog,
  refreshCatalogInBackground,
  setCatalog,
} from './models-dev.ts'
export type { Catalog, CatalogProvider } from './models-dev.ts'
export {
  catalogIdOf,
  connectedProviders,
  createProvider,
  guessApi,
  hasCredentials,
  listProviders,
  providerEntry,
  providerEnv,
  providerLabel,
  providerNames,
  OPENAI_COMPATIBLE,
  AnthropicProvider,
  GoogleProvider,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
  RoutedProvider,
} from './providers/index.ts'
export type { CreateOptions, ProviderDescriptor, ProviderEntry } from './providers/index.ts'
export {
  chooseModel,
  favoriteModels,
  modelRef,
  recentModels,
  recommendedModel,
  rememberModel,
  toggleFavorite,
} from './selection.ts'
export type { ModelChoice, ModelTier } from './selection.ts'
export {
  applyStreamRules,
  collect,
  defaultStreamRules,
  ruleHitsOf,
} from './streaming.ts'
export type { RuleHit, StreamRule } from './streaming.ts'
export { describeRole, isRole, MODEL_ROLES, ROLES } from './roles.ts'
export type { ModelRole, RoleDescriptor } from './roles.ts'
export { adaptiveEffort, adjustEffort, EFFORT_LEVELS, shouldThink } from './thinking.ts'
export type { Effort } from './thinking.ts'
