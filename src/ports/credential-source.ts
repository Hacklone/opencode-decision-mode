import type { ProviderId } from "../domain/decision-types"

/**
 * Resolves API credentials for a provider. Implementations try sources in
 * priority order (environment, OpenCode integration connections) and report
 * availability without leaking secret material.
 */
export interface CredentialSource {
  /** Resolve an API key, or null when unavailable. Never log the value. */
  resolve(provider: ProviderId): Promise<string | null>
  /** Cheap availability probe used for status display. */
  available(provider: ProviderId): Promise<boolean>
}

export const ENV_VARS: Record<ProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
  openai: "OPENAI_API_KEY",
}
