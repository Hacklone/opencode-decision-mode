import { CREDENTIAL_ENV, PROVIDER_ALIASES, type ProviderId } from "../domain/decision-types"
import type { DecisionSelectInput, DecisionStatus } from "../rpc"

export const COMMAND_USAGE = "expected: /decision-mode [on|off] [openrouter|typesafe|openai] | /decision-mode status"

/**
 * Parse `/decision-mode` arguments into an RPC select patch. Tokens are
 * whitespace-separated and combinable ("on ts"); "status" (or no tokens)
 * means report-only. Provider ids accept the short forms the footer uses.
 * Throws on unknown tokens — the message is shown back to the user.
 */
export function parseDecisionArgs(text: string): DecisionSelectInput | undefined {
  const patch: DecisionSelectInput = {}
  for (const token of text.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token === "status") continue
    if (token === "on" || token === "off") {
      patch.mode = token
      continue
    }
    const provider = PROVIDER_ALIASES[token]
    if (provider) {
      patch.provider = provider
      continue
    }
    throw new Error(`unknown argument "${token}" — ${COMMAND_USAGE}`)
  }
  return patch.mode === undefined && patch.provider === undefined ? undefined : patch
}

/** One-line status summary for `session.synthetic` (web UI has no footer). */
export function describeStatus(status: DecisionStatus): string {
  const missing = status.credentials[status.provider] === false
  const suffix = missing ? ` (no ${CREDENTIAL_ENV[status.provider]} — export it or pick another provider)` : ""
  return `Decision mode: ${status.mode} · ${status.provider}/${status.model}${suffix}`
}
