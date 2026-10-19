/**
 * Minimal durable JSON KV store. The OpenCode plugin context wires
 * `ctx.storage` into this shape; tests use in-memory fakes.
 */
export interface KeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  /** All keys with the given prefix, with their values. */
  scan(prefix: string): Promise<Array<{ key: string; value: unknown }>>
}
