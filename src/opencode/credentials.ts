import type { ProviderId } from "../domain/decision-types"
import { ENV_VARS, type CredentialSource } from "../ports/credential-source"

/** Minimal view of the plugin context needed for credential resolution. */
export interface IntegrationContext {
  integration: {
    connection: {
      active(integrationID: string): Promise<unknown>
      resolve(connection: unknown): Promise<unknown>
    }
  }
}

/**
 * Credential resolution order:
 *   1. Environment variable (OPENROUTER_API_KEY / TYPESAFE_API_KEY / OPENAI_API_KEY)
 *   2. OpenCode integration connection (opencode-managed auth), best effort
 *
 * Integration IDs are probed defensively — if the platform renames them the
 * plugin still works from environment variables.
 */
export class OpencodeCredentials implements CredentialSource {
  /** Candidate integration ids per provider; first hit wins. */
  static readonly INTEGRATION_IDS: Record<ProviderId, readonly string[]> = {
    openrouter: ["openrouter"],
    typesafe: ["typesafe"],
    openai: ["openai"],
  }

  constructor(
    private readonly ctx: IntegrationContext | null,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async resolve(provider: ProviderId): Promise<string | null> {
    const fromEnv = this.env[ENV_VARS[provider]]
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv
    return this.fromIntegration(provider)
  }

  async available(provider: ProviderId): Promise<boolean> {
    return (await this.resolve(provider)) !== null
  }

  private async fromIntegration(provider: ProviderId): Promise<string | null> {
    if (this.ctx === null) return null
    for (const integrationID of OpencodeCredentials.INTEGRATION_IDS[provider]) {
      try {
        const connection = await this.ctx.integration.connection.active(integrationID)
        if (connection === undefined || connection === null) continue
        const credential = await this.ctx.integration.connection.resolve(connection)
        const key = extractKey(credential)
        if (key !== null) return key
      } catch {
        // Integration probing is best effort; environment variables remain the
        // deterministic path.
      }
    }
    return null
  }
}

/** Pull an API key string out of a resolved CredentialValue of unknown shape. */
export function extractKey(credential: unknown): string | null {
  if (typeof credential === "string" && credential.length > 0) return credential
  if (typeof credential !== "object" || credential === null) return null
  const record = credential as Record<string, unknown>
  for (const field of ["key", "apiKey", "api_key", "value", "secret", "token"]) {
    const value = record[field]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

/** Availability snapshot for the RPC status payload. */
export async function credentialStatus(
  credentials: CredentialSource,
): Promise<Record<ProviderId, boolean>> {
  const [openrouter, typesafe, openai] = await Promise.all([
    credentials.available("openrouter"),
    credentials.available("typesafe"),
    credentials.available("openai"),
  ])
  return { openrouter, typesafe, openai }
}
