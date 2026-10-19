import { DEFAULT_MODELS, isProviderId, type ProviderId } from "../domain/decision-types"
import type { KeyValueStore } from "../ports/storage"

export type Mode = "on" | "off"

export interface Selection {
  mode: Mode
  provider: ProviderId
  /** Pinned model; null = provider default. */
  model: string | null
}

export const DEFAULT_SELECTION: Selection = { mode: "on", provider: "openrouter", model: null }

const KEY = "decision-mode/selection"

/**
 * Authoritative selection state, persisted in plugin storage. The server owns
 * it; the TUI reads and mutates it over RPC so every interface agrees.
 */
export class SelectionStore {
  private current: Selection = { ...DEFAULT_SELECTION }

  constructor(private readonly storage: KeyValueStore) {}

  /** Load persisted selection (call once during setup). */
  async load(): Promise<Selection> {
    const stored = await this.storage.get(KEY)
    this.current = normalizeSelection(stored)
    return this.current
  }

  get(): Selection {
    return this.current
  }

  /** Effective model: pinned model or the provider default. */
  model(): string {
    return this.current.model ?? DEFAULT_MODELS[this.current.provider]
  }

  async set(patch: Partial<Selection>): Promise<Selection> {
    const next = normalizeSelection({ ...this.current, ...patch })
    this.current = next
    await this.storage.set(KEY, next)
    return next
  }
}

export function normalizeSelection(value: unknown): Selection {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_SELECTION }
  const raw = value as Record<string, unknown>
  const mode: Mode = raw["mode"] === "off" ? "off" : "on"
  const provider: ProviderId = isProviderId(raw["provider"]) ? raw["provider"] : DEFAULT_SELECTION.provider
  const model = typeof raw["model"] === "string" && raw["model"].length > 0 ? raw["model"] : null
  return { mode, provider, model }
}
