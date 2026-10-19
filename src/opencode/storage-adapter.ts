import type { KeyValueStore } from "../ports/storage"

/** The subset of `ctx.storage` the plugin relies on. */
export interface OpencodeStorageApi {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<unknown>
}

/** Adapts `ctx.storage` to the plugin's KeyValueStore port. */
export class OpencodeStorage implements KeyValueStore {
  constructor(private readonly storage: OpencodeStorageApi) {}

  async get(key: string): Promise<unknown> {
    return this.storage.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.storage.set(key, value)
  }

  async remove(key: string): Promise<void> {
    await this.storage.remove(key)
  }

  async scan(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const raw = await this.storage.scan({ prefix })
    return normalizeScan(raw)
  }
}

/** Tolerant normalization: the scan page may be a bare array or wrapped. */
export function normalizeScan(raw: unknown): Array<{ key: string; value: unknown }> {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>)["items"])
      ? ((raw as Record<string, unknown>)["items"] as unknown[])
      : []
  const out: Array<{ key: string; value: unknown }> = []
  for (const entry of list) {
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>
      const key = record["key"]
      if (typeof key === "string") out.push({ key, value: record["value"] })
    }
  }
  return out
}
