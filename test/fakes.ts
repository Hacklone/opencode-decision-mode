import type { KeyValueStore } from "../src/ports/storage"

/** Deterministic in-memory KV store mirroring the storage port. */
export class MemoryKv implements KeyValueStore {
  private readonly map = new Map<string, unknown>()

  async get(key: string): Promise<unknown> {
    return this.map.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value))
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }

  async scan(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const out: Array<{ key: string; value: unknown }> = []
    for (const key of [...this.map.keys()].sort()) {
      if (key.startsWith(prefix)) out.push({ key, value: structuredClone(this.map.get(key)) })
    }
    return out
  }
}

export function kv(): MemoryKv {
  return new MemoryKv()
}
