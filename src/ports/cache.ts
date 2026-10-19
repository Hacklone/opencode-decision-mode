import type { Answer, ProviderId, Question, Usage } from "../domain/decision-types"

/** Everything that materially changes a provider response — the cache key input. */
export interface CacheFingerprint {
  provider: ProviderId
  model: string
  state: unknown
  questions: unknown
  schemaVersion: number
}

export interface CachedEntry {
  answers: Record<string, Answer>
  usage: Usage
  resolvedModel: string
}

/**
 * Response cache for identical decision requests. Only successful responses
 * are cached; errors are always retried.
 */
export interface DecisionCache {
  get(key: string): Promise<CachedEntry | null>
  set(key: string, entry: CachedEntry): Promise<void>
}

export const CACHE_SCHEMA_VERSION = 1
