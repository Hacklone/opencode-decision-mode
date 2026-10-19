import type { ProviderId } from "../../domain/decision-types"
import type { BackendRegistry } from "../../ports/decision-backend"
import { OpenAIBackend } from "./openai-backend"
import { OpenRouterBackend } from "./openrouter-backend"
import { TypesafeBackend } from "./typesafe-backend"

export interface BackendKeys {
  openrouter: string | null
  typesafe: string | null
  openai: string | null
}

/** Build the backend registry; providers without credentials are absent (null). */
export function buildBackends(keys: BackendKeys): BackendRegistry {
  const registry: BackendRegistry = {
    openrouter: keys.openrouter === null ? null : new OpenRouterBackend(keys.openrouter),
    typesafe: keys.typesafe === null ? null : new TypesafeBackend(keys.typesafe),
    openai: keys.openai === null ? null : new OpenAIBackend(keys.openai),
  }
  return registry
}

export function availableProviders(registry: BackendRegistry): ProviderId[] {
  return (Object.keys(registry) as ProviderId[]).filter((p) => registry[p] !== null)
}
