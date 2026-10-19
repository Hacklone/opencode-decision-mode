import { afterEach, describe, expect, it, vi } from "vitest"
import plugin from "../../src/opencode/plugin"
import { ON_INSTRUCTION } from "../../src/opencode/plugin"
import type { OpencodeStorageApi } from "../../src/opencode/storage-adapter"

const TOOL_NAMES = ["decision", "decision_map", "decision_results"]

function fakeCtx() {
  const map = new Map<string, unknown>()
  const storage: OpencodeStorageApi = {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, structuredClone(value))
    },
    remove: async (key) => {
      map.delete(key)
    },
    scan: async ({ prefix }) =>
      [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
  }
  const added: Array<{ name: string; execute: (input: Record<string, unknown>, context: { signal: AbortSignal; progress: (u: Record<string, unknown>) => Promise<void> }) => Promise<unknown> }> = []
  const contextHooks: Array<(event: { tools: Record<string, unknown>; system: Array<{ type: string; text: string }> }) => void> = []
  const rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {}

  const ctx = {
    storage,
    location: { directory: "/ws" },
    integration: {
      connection: {
        active: vi.fn(async () => undefined),
        resolve: vi.fn(async () => undefined),
      },
    },
    tool: {
      transform: vi.fn(async (transform: (editor: { add: (tool: never) => void }) => void) => {
        transform({ add: (tool) => added.push(tool as never) })
        return { dispose: vi.fn() }
      }),
    },
    session: {
      hook: vi.fn((_event: string, hook: (e: never) => void) => {
        contextHooks.push(hook as never)
        return { dispose: vi.fn() }
      }),
    },
    rpc: {
      register: vi.fn((_def: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
        Object.assign(rpcHandlers, handlers)
      }),
    },
  }
  return { ctx, added, contextHooks, rpcHandlers }
}

describe("decision-mode plugin setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("registers three tools, a context hook and RPC handlers; ON mode keeps them", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key")
    const { ctx, added, contextHooks, rpcHandlers } = fakeCtx()
    const cleanup = await plugin.setup(ctx as never)

    expect(added.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())

    // The tool execute wrappers are live: decision_results list mode works end-to-end.
    const resultsTool = added.find((t) => t.name === "decision_results")!
    const listed = (await resultsTool.execute({}, { signal: new AbortController().signal, progress: async () => {} })) as {
      content: string
    }
    expect(JSON.parse(listed.content).runs).toEqual([])
    expect(contextHooks).toHaveLength(1)
    expect(Object.keys(rpcHandlers).sort()).toEqual(["select", "status"])

    const event = { tools: { decision: {}, decision_map: {}, decision_results: {}, bash: {} }, system: [] }
    contextHooks[0]!(event)
    expect(event.tools["decision"]).toBeDefined()
    expect(event.system).toEqual([{ type: "text", text: ON_INSTRUCTION }])

    const status = (await rpcHandlers.status!(undefined)) as { mode: string; provider: string; credentials: Record<string, boolean> }
    expect(status.mode).toBe("on")
    expect(status.provider).toBe("openrouter")
    expect(status.credentials.openrouter).toBe(true)

    const afterSelect = (await rpcHandlers.select!({ mode: "off" })) as { mode: string }
    expect(afterSelect.mode).toBe("off")
    const offEvent = { tools: { decision: {}, decision_map: {}, decision_results: {}, bash: {} }, system: [] }
    contextHooks[0]!(offEvent)
    expect(offEvent.tools["decision"]).toBeUndefined()
    expect(offEvent.tools["decision_map"]).toBeUndefined()
    expect(offEvent.tools["decision_results"]).toBeUndefined()
    expect(offEvent.tools["bash"]).toBeDefined()
    expect(offEvent.system).toEqual([])

    // Selecting a provider without credentials leaves its backend absent but succeeds.
    const switched = (await rpcHandlers.select!({ provider: "openai", mode: "on" })) as { provider: string }
    expect(switched.provider).toBe("openai")

    if (typeof cleanup === "function") cleanup()
    expect(vi.mocked(ctx.tool.transform).mock.results[0]!.value).toBeDefined()
  })
})
