import { describe, expect, it, vi } from "vitest"
import { OpencodeStorage, normalizeScan } from "../../src/opencode/storage-adapter"

function fakeStorage() {
  const map = new Map<string, unknown>()
  return {
    map,
    get: vi.fn(async (key: string) => map.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      map.set(key, structuredClone(value))
    }),
    remove: vi.fn(async (key: string) => {
      map.delete(key)
    }),
    scan: vi.fn(async (options: { prefix: string }) =>
      [...map.entries()]
        .filter(([k]) => k.startsWith(options.prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, value]) => ({ key, value })),
    ),
  }
}

describe("OpencodeStorage", () => {
  it("delegates get/set/remove and scans with normalized entries", async () => {
    const storage = fakeStorage()
    const adapter = new OpencodeStorage(storage)
    await adapter.set("a", { x: 1 })
    expect(await adapter.get("a")).toEqual({ x: 1 })
    await adapter.set("b", 2)
    expect(await adapter.scan("")).toEqual([
      { key: "a", value: { x: 1 } },
      { key: "b", value: 2 },
    ])
    await adapter.remove("a")
    expect(await adapter.get("a")).toBeUndefined()
    expect(storage.scan).toHaveBeenCalledWith({ prefix: "" })
  })
})

describe("normalizeScan", () => {
  it("accepts bare arrays and {items} wrappers, drops junk entries", () => {
    const direct = normalizeScan([
      { key: "a", value: 1 },
      { value: 2 },
      "junk",
      null,
    ])
    expect(direct).toEqual([{ key: "a", value: 1 }])
    expect(normalizeScan({ items: [{ key: "b", value: 2 }] })).toEqual([{ key: "b", value: 2 }])
    expect(normalizeScan(null)).toEqual([])
    expect(normalizeScan("junk")).toEqual([])
    expect(normalizeScan([{ key: 1 }])).toEqual([])
  })
})
