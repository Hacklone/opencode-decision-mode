import type { KeyValueStore } from "../ports/storage"

/** The subset of `ctx.storage` the plugin relies on. */
export interface OpencodeStorageApi {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<unknown>
}

/**
 * `ctx.storage.scan` returns `StorageScanResult { entries, next? }` and pages
 * its results; the adapter follows the cursor so the port's `scan(prefix)`
 * always sees the whole prefix. Page cap is a runaway-loop guard, not a
 * functional limit (100 pages × 200 entries covers any realistic run store).
 */
const SCAN_PAGE_LIMIT = 200
const MAX_SCAN_PAGES = 100

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
    const out: Array<{ key: string; value: unknown }> = []
    let after: string | undefined
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      const raw = await this.storage.scan({ prefix, after, limit: SCAN_PAGE_LIMIT })
      const entries = normalizeScan(raw)
      out.push(...entries)
      const next = nextCursor(raw)
      if (next === undefined || entries.length === 0) break
      after = next
    }
    return out
  }
}

/** The scan page's continuation cursor, when another page exists. */
function nextCursor(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const next = (raw as Record<string, unknown>)["next"]
  return typeof next === "string" && next.length > 0 ? next : undefined
}

/**
 * Tolerant normalization. The documented shape is `{ entries: [...] }`; bare
 * arrays and `{ items }` wrappers are accepted for resilience, everything
 * else (and junk entries) is dropped.
 */
export function normalizeScan(raw: unknown): Array<{ key: string; value: unknown }> {
  const list = typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>)["entries"])
    ? ((raw as Record<string, unknown>)["entries"] as unknown[])
    : Array.isArray(raw)
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
