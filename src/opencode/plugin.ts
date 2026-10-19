import { Plugin } from "@opencode/plugin"
import { DecisionService } from "../application/decision-service"
import { BulkMapService } from "../application/bulk-map-service"
import { ResultQueryService } from "../application/result-query-service"
import { StorageCache } from "../adapters/persistence/opencode-cache"
import { StorageRunStore } from "../adapters/persistence/opencode-run-store"
import { FsSourceReader } from "../adapters/sources/fs-source-reader"
import { BackendManager } from "./backend-manager"
import { credentialStatus, OpencodeCredentials } from "./credentials"
import { OpencodeStorage } from "./storage-adapter"
import { SelectionStore } from "./selection"
import { buildTools } from "./tools"
import { DecisionRpc } from "../rpc"
import type { DecisionSelectInput, DecisionStatus } from "../rpc"

/**
 * Kept deliberately tiny: this text is pushed into the controller model's
 * system context on every request while Decision mode is ON. Off mode pushes
 * nothing and strips the tools, so the token overhead is exactly zero.
 */
export const ON_INSTRUCTION = [
  "Decision mode is ON: a separate decision runtime (Jev / gpt-6-luna) is available as the data plane.",
  "Delegate judgments — boolean checks (noul), classifications (choice), gradings (score) — with `decision` for one item and `decision_map` for CSV/JSONL files; inspect runs with `decision_results`.",
  "You remain the controller: plan, call, read verdicts (PASS/REVIEW/FAIL) — do not judge records yourself.",
].join(" ")

export default Plugin.define({
  id: "decision-mode",
  async setup(ctx) {
    const storage = new OpencodeStorage(ctx.storage)
    const selection = new SelectionStore(storage)
    await selection.load()

    const credentials = new OpencodeCredentials(ctx)
    const backends = new BackendManager(credentials)
    await backends.bootstrap()

    const cache = new StorageCache(storage)
    const store = new StorageRunStore(storage)
    const reader = new FsSourceReader(ctx.location.directory)
    const decision = new DecisionService(backends.registry, cache)
    const bulk = new BulkMapService(backends.registry, cache, store, reader)
    const results = new ResultQueryService(store)

    const tools = buildTools({ selection, backends, decision, bulk, results })
    const toolRegistration = await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.inputSchema,
          execute: (input: unknown, context: { signal: AbortSignal; progress: (update: Record<string, unknown>) => Promise<void> }) =>
            tool.execute(input as Record<string, unknown>, context),
        })
      }
    })

    const sessionHook = await ctx.session.hook("context", (event: { tools: Record<string, unknown>; system: Array<{ type: string; text: string }> }) => {
      if (selection.get().mode === "off") {
        for (const tool of tools) delete event.tools[tool.name]
        return
      }
      event.system.push({ type: "text", text: ON_INSTRUCTION })
    })

    // Runtime shapes match; the cast bridges Rpc.define's codec-typed contract
    // and register's portable (raw JSON schema) variant.
    ctx.rpc.register(DecisionRpc as never, {
      status: async () => statusPayload(selection, credentials),
      select: async (input: DecisionSelectInput) => {
        await selection.set(input)
        // A provider that had no credentials at setup gets another chance.
        if (input.provider !== undefined) await backends.ensure(input.provider)
        return statusPayload(selection, credentials)
      },
    })

    return () => {
      toolRegistration.dispose()
      sessionHook.dispose()
    }
  },
})

async function statusPayload(
  selection: SelectionStore,
  credentials: OpencodeCredentials,
): Promise<DecisionStatus> {
  return {
    mode: selection.get().mode,
    provider: selection.get().provider,
    model: selection.model(),
    credentials: await credentialStatus(credentials),
  }
}
