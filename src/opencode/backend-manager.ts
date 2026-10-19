import type { ProviderId } from "../domain/decision-types"
import { buildBackends, type BackendKeys } from "../adapters/backends/registry"
import type { BackendRegistry, DecisionBackend } from "../ports/decision-backend"
import type { CredentialSource } from "../ports/credential-source"

/**
 * Holds the live backend registry. Built once at setup from resolved
 * credentials; `ensure` rebuilds a provider's backend lazily when it was
 * missing (e.g. the user added a key after startup) or when selection moves
 * to a provider that had no credentials at setup time.
 *
 * The registry object identity is stable — services hold the reference while
 * individual slots are replaced in place.
 */
export class BackendManager {
  readonly registry: BackendRegistry = { openrouter: null, typesafe: null, openai: null }
  private attempted: Partial<Record<ProviderId, boolean>> = {}

  constructor(private readonly credentials: CredentialSource) {}

  /** Resolve credentials for every provider once, up front. */
  async bootstrap(): Promise<void> {
    await this.ensure("openrouter")
    await this.ensure("typesafe")
    await this.ensure("openai")
  }

  async ensure(provider: ProviderId): Promise<DecisionBackend | null> {
    if (this.registry[provider] !== null) return this.registry[provider]
    if (this.attempted[provider]) return null
    this.attempted[provider] = true
    const key = await this.credentials.resolve(provider)
    if (key === null) return null
    const keys: BackendKeys = { openrouter: null, typesafe: null, openai: null }
    keys[provider] = key
    const built = buildBackends(keys)
    this.registry[provider] = built[provider]
    return this.registry[provider]
  }

  /** Force a rebuild attempt for a provider (used by RPC select). */
  async refresh(provider: ProviderId): Promise<DecisionBackend | null> {
    this.attempted[provider] = false
    this.registry[provider] = null
    return this.ensure(provider)
  }
}
