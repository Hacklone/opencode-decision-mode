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
  type Added = {
    name: string
    options?: { namespace?: string }
    execute: (input: Record<string, unknown>, context: { signal: AbortSignal; progress: (u: Record<string, unknown>) => Promise<void> }) => Promise<unknown>
  }
  const added: Added[] = []
  const namespaceCalls: Array<{ name: string; description: string }> = []
  const contextHooks: Array<(event: { system: Array<{ type: string; text: string }> }) => void> = []
  const rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {}
  const transforms: Array<(editor: { add: (tool: Added) => void; namespace: (ns: { name: string; description: string }) => void }) => void> = []
  const commandDefs: Array<{ name: string; execute: (inv: { sessionID: string; prompt: { text: string } }) => Promise<void> }> = []
  const syntheses: Array<{ sessionID: string; text: string; resume?: boolean }> = []

  // ctx.tool.reload() replays every registered transform against a fresh
  // registry: mirror that here by clearing and re-running.
  const reload = vi.fn(async () => {
    added.length = 0
    namespaceCalls.length = 0
    for (const transform of transforms) transform({ add: (tool) => added.push(tool), namespace: (ns) => namespaceCalls.push(ns) })
  })

  const ctx = {
    storage,
    location: { directory: "/ws" },
    integration: {
      connection: {
        active: vi.fn(async () => undefined),
        resolve: vi.fn(async () => undefined),
      },
    },
    command: {
      transform: vi.fn(async (transform: (editor: { add: (def: { name: string; execute: (inv: { sessionID: string; prompt: { text: string } }) => Promise<void> }) => void }) => void) => {
        transform({ add: (def) => commandDefs.push(def) })
        return { dispose: vi.fn() }
      }),
    },
    tool: {
      transform: vi.fn(async (transform: (editor: { add: (tool: never) => void; namespace: (ns: { name: string; description: string }) => void }) => void) => {
        transforms.push(transform as never)
        transform({ add: (tool) => added.push(tool as never), namespace: (ns) => namespaceCalls.push(ns) })
        return { dispose: vi.fn() }
      }),
      reload,
    },
    session: {
      hook: vi.fn(async (_event: string, hook: (e: never) => void) => {
        contextHooks.push(hook as never)
        return { dispose: vi.fn() }
      }),
      synthetic: vi.fn(async (input: { sessionID: string; text: string; resume?: boolean }) => {
        syntheses.push(input)
      }),
    },
    rpc: {
      register: vi.fn((_def: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
        Object.assign(rpcHandlers, handlers)
      }),
    },
  }
  return { ctx, added, namespaceCalls, contextHooks, rpcHandlers, reload, commandDefs, syntheses }
}

describe("decision-mode plugin setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("registers namespaced tools while ON; OFF unregisters via reload; mode flips trigger reload only", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key")
    const { ctx, added, namespaceCalls, contextHooks, rpcHandlers, reload } = fakeCtx()
    const cleanup = await plugin.setup(ctx as never)

    expect(added.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(added.every((t) => t.options?.namespace === "decision")).toBe(true)
    expect(namespaceCalls).toHaveLength(1)
    expect(namespaceCalls[0]!.name).toBe("decision")

    // The tool execute wrappers are live: decision_results list mode works end-to-end.
    const resultsTool = added.find((t) => t.name === "decision_results")!
    const listed = (await resultsTool.execute({}, { signal: new AbortController().signal, progress: async () => {} })) as {
      content: string
    }
    expect(JSON.parse(listed.content).runs).toEqual([])
    expect(contextHooks).toHaveLength(1)
    expect(Object.keys(rpcHandlers).sort()).toEqual(["select", "status"])

    const status = (await rpcHandlers.status!(undefined)) as { mode: string; provider: string; credentials: Record<string, boolean> }
    expect(status.mode).toBe("on")
    expect(status.provider).toBe("openrouter")
    expect(status.credentials.openrouter).toBe(true)

    // ON mode: the context hook pushes the instruction.
    const onEvent = { system: [] as Array<{ type: string; text: string }> }
    contextHooks[0]!(onEvent)
    expect(onEvent.system).toEqual([{ type: "text", text: ON_INSTRUCTION }])

    // Turning OFF flips the registry: reload replays the transform, which
    // now adds nothing (Code Mode catalog mirrors the registry, so OFF means
    // the tools are simply absent).
    const afterOff = (await rpcHandlers.select!({ mode: "off" })) as { mode: string }
    expect(afterOff.mode).toBe("off")
    expect(reload).toHaveBeenCalledTimes(1)
    expect(added).toEqual([])
    expect(namespaceCalls).toEqual([])
    const offEvent = { system: [] as Array<{ type: string; text: string }> }
    contextHooks[0]!(offEvent)
    expect(offEvent.system).toEqual([])

    // Provider-only change does not touch registration.
    const switched = (await rpcHandlers.select!({ provider: "typesafe" })) as { provider: string; model: string }
    expect(switched.provider).toBe("typesafe")
    expect(switched.model).toBe("jev-latest")
    expect(reload).toHaveBeenCalledTimes(1)

    // Turning ON re-registers via reload; selecting a provider without
    // credentials still succeeds (backend stays absent).
    const afterOn = (await rpcHandlers.select!({ mode: "on", provider: "openai" })) as { mode: string; provider: string }
    expect(afterOn.mode).toBe("on")
    expect(afterOn.provider).toBe("openai")
    expect(reload).toHaveBeenCalledTimes(2)
    expect(added.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())

    if (typeof cleanup === "function") cleanup()
    expect(vi.mocked(ctx.tool.transform).mock.results[0]!.value).toBeDefined()
  })

  it("decision command: mutates via args, reports status, rejects unknown tokens", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key")
    const { ctx, commandDefs, syntheses, reload } = fakeCtx()
    await plugin.setup(ctx as never)

    expect(commandDefs.map((c) => c.name)).toEqual(["decision-mode"])
    const cmd = commandDefs[0]!

    // No args: report-only, no registry churn. resume:false keeps the
    // confirmation from waking the controller model (empirical: admitted
    // synthetic input schedules a turn by default).
    await cmd.execute({ sessionID: "ses_1", prompt: { text: "" } })
    expect(syntheses[0]!.text).toBe("Decision mode: on · openrouter/typesafe/jev-1.14")
    expect(syntheses[0]!.resume).toBe(false)
    expect(reload).not.toHaveBeenCalled()

    // "/decision-mode off" — the leading token is tolerated (clients send it).
    await cmd.execute({ sessionID: "ses_1", prompt: { text: "/decision-mode off" } })
    expect(syntheses[1]!.text).toBe("Decision mode: off · openrouter/typesafe/jev-1.14")
    expect(reload).toHaveBeenCalledTimes(1)

    // Mode + provider alias combined; the legacy bare "/decision" token is
    // also stripped (kept tolerant so clients cannot wedge on it).
    await cmd.execute({ sessionID: "ses_1", prompt: { text: "/decision on ts" } })
    expect(syntheses[2]!.text).toBe(
      "Decision mode: on · typesafe/jev-latest (no TYPESAFE_API_KEY — export it or pick another provider)",
    )
    expect(reload).toHaveBeenCalledTimes(2)

    // Unknown token: usage message, state unchanged.
    await cmd.execute({ sessionID: "ses_1", prompt: { text: "bogus" } })
    expect(syntheses[3]!.text).toContain('unknown argument "bogus"')
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("boots OFF: no tools registered, no instruction pushed", async () => {
    const { ctx, added, contextHooks } = fakeCtx()
    await plugin.setup(ctx as never)
    // No OPENROUTER_API_KEY and default selection is ON... registration
    // happens regardless of credentials; verify pre-persisted off state.
    expect(added.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())

    const rpcHandlers = (ctx.rpc.register as unknown as { mock: { calls: Array<[unknown, Record<string, (i: unknown) => Promise<unknown>>]> } }).mock
      .calls[0]![1]
    await rpcHandlers.select!({ mode: "off" })
    expect(added).toEqual([])
    const event = { system: [] as Array<{ type: string; text: string }> }
    contextHooks[0]!(event)
    expect(event.system).toEqual([])
  })
})
