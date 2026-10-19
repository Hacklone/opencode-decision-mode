import type { DecisionCache, CachedEntry } from "../../ports/cache"
import type { KeyValueStore } from "../../ports/storage"

const PREFIX = "decision-cache/"

/** Cache adapter over plugin storage. Keys are content hashes, values are successful responses only. */
export class StorageCache implements DecisionCache {
  constructor(private readonly storage: KeyValueStore) {}

  async get(key: string): Promise<CachedEntry | null> {
    const value = await this.storage.get(PREFIX + key)
    return isEntry(value) ? value : null
  }

  async set(key: string, entry: CachedEntry): Promise<void> {
    await this.storage.set(PREFIX + key, entry)
  }
}

function isEntry(value: unknown): value is CachedEntry {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v["answers"] === "object" &&
    v["answers"] !== null &&
    typeof v["usage"] === "object" &&
    v["usage"] !== null &&
    typeof v["resolvedModel"] === "string"
  )
}
