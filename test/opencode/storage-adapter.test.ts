import { describe, expect, it, vi } from "vitest"
import { OpencodeStorage, normalizeScan } from "../../src/opencode/storage-adapter"

function fakeStorage(pageSize = Infinity) {
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
    // Mirrors the documented StorageScanResult contract: paged {entries, next}.
    scan: vi.fn(async (options: { prefix: string; after?: string; limit?: number }) => {
      const limit = Math.min(options.limit ?? pageSize, pageSize)
      const all = [...map.entries()]
        .filter(([k]) => k.startsWith(options.prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
      const start = options.after === undefined ? 0 : all.findIndex(([k]) => k > options.after!)
      const page = all.slice(Math.max(0, start), Math.max(0, start) + limit)
        .map(([key, value]) => ({ key, value }))
      const next = page.length > 0 && Math.max(0, start) + limit < all.length
        ? page[page.length - 1]!.key
        : undefined
      return next === undefined ? { entries: page } : { entries: page, next }
    }),
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
    expect(storage.scan).toHaveBeenCalledWith({ prefix: "", after: undefined, limit: 200 })
  })

  it("follows the scan cursor across pages (regression: {entries, next} shape)", async () => {
    const storage = fakeStorage(2)
    const adapter = new OpencodeStorage(storage)
    for (const key of ["runs/r1/meta", "runs/r1/p/000000", "runs/r1/p/000001", "runs/r2/meta"]) {
      await adapter.set(key, { key })
    }
    expect(await adapter.scan("runs/")).toEqual([
      { key: "runs/r1/meta", value: { key: "runs/r1/meta" } },
      { key: "runs/r1/p/000000", value: { key: "runs/r1/p/000000" } },
      { key: "runs/r1/p/000001", value: { key: "runs/r1/p/000001" } },
      { key: "runs/r2/meta", value: { key: "runs/r2/meta" } },
    ])
    expect(storage.scan).toHaveBeenCalledTimes(2)
  })

  it("stops paging when the server keeps returning a cursor without entries", async () => {
    const storage = fakeStorage()
    storage.scan.mockImplementation(async () => ({ entries: [], next: "stuck" }))
    const adapter = new OpencodeStorage(storage)
    expect(await adapter.scan("runs/")).toEqual([])
    expect(storage.scan).toHaveBeenCalledTimes(1)
  })

  it("tolerates a null scan page", async () => {
    const storage = fakeStorage()
    // Runtime tolerance: the platform may hand back a null page.
    storage.scan.mockResolvedValue(null as unknown as { entries: [] })
    const adapter = new OpencodeStorage(storage)
    expect(await adapter.scan("runs/")).toEqual([])
  })
})

describe("normalizeScan", () => {
  it("accepts the documented {entries} shape, plus tolerant fallbacks; drops junk", () => {
    expect(normalizeScan({ entries: [{ key: "a", value: 1 }, { value: 2 }, "junk", null] }))
      .toEqual([{ key: "a", value: 1 }])
    expect(normalizeScan([
      { key: "a", value: 1 },
      { value: 2 },
      "junk",
      null,
    ])).toEqual([{ key: "a", value: 1 }])
    expect(normalizeScan({ items: [{ key: "b", value: 2 }] })).toEqual([{ key: "b", value: 2 }])
    expect(normalizeScan(null)).toEqual([])
    expect(normalizeScan("junk")).toEqual([])
    expect(normalizeScan([{ key: 1 }])).toEqual([])
  })
})
