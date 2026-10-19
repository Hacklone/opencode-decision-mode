import { Plugin } from "@opencode/plugin"
import { DecisionService } from "../application/decision-service"
import { BulkMapService } from "../application/bulk-map-service"
import { ResultQueryService } from "../application/result-query-service"
import { ResultsExportService } from "../application/export-service"
import { StorageCache } from "../adapters/persistence/opencode-cache"
import { StorageRunStore } from "../adapters/persistence/opencode-run-store"
import { FsSourceReader } from "../adapters/sources/fs-source-reader"
import { FsFileSink } from "../adapters/sinks/fs-file-sink"
import { BackendManager } from "./backend-manager"
import { describeStatus, parseDecisionArgs } from "./command"
import { credentialStatus, OpencodeCredentials } from "./credentials"
import { OpencodeStorage } from "./storage-adapter"
import { SelectionStore } from "./selection"
import { NAMESPACE, buildTools } from "./tools"
import { DecisionRpc } from "../rpc"
import type { DecisionSelectInput, DecisionStatus } from "../rpc"

/**
 * Kept deliberately tiny: this text is pushed into the controller model's
 * system context on every request while Decision mode is ON. Off mode pushes
 * nothing and registers no tools at all, so the token overhead is exactly
 * zero. (Empirically the Code Mode catalog is sourced from the tool registry,
 * NOT from the per-request `event.tools` — so visibility is enforced by
 * gating `editor.add` on the mode and calling `ctx.tool.reload()` whenever
 * the selection changes it. Deleting `event.tools` keys does nothing here.)
 */
export const ON_INSTRUCTION = [
  "Decision mode is ON: a separate decision runtime (Jev / gpt-6-luna) is available as the data plane.",
  "Delegate judgments — boolean checks (noul), classifications (choice), gradings (score) — with `decision.decision` for one item and `decision.decision_map` for CSV/JSONL files; inspect runs with `decision.decision_results` (set `output` to write full results to a file with a checksum instead of paging rows through context).",
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
    const sink = new FsFileSink(ctx.location.directory)
    const decision = new DecisionService(backends.registry, cache)
    const bulk = new BulkMapService(backends.registry, cache, store, reader)
    const results = new ResultQueryService(store)
    const exporter = new ResultsExportService(store, sink)

    const tools = buildTools({ selection, backends, decision, bulk, results, exporter })
    const toolRegistration = await ctx.tool.transform((editor) => {
      if (selection.get().mode === "off") return
      editor.namespace({
        name: NAMESPACE,
        description: "Judgment primitives (typed answers + probabilities) from the decision runtime: Jev via OpenRouter/TypeSafe, gpt-6-luna via OpenAI.",
      })
      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.inputSchema,
          options: { namespace: NAMESPACE },
          execute: (input: unknown, context: { signal: AbortSignal; progress: (update: Record<string, unknown>) => Promise<void> }) =>
            tool.execute(input as Record<string, unknown>, context),
        })
      }
    })

    const sessionHook = await ctx.session.hook("context", (event: { system: Array<{ type: string; text: string }> }) => {
      if (selection.get().mode === "off") return
      event.system.push({ type: "text", text: ON_INSTRUCTION })
    })

    // Shared mutation path: RPC `select` (TUI dialog) and the `decision`
    // server command (web UI / any client) must behave identically.
    const apply = async (input: DecisionSelectInput): Promise<DecisionStatus> => {
      const before = selection.get().mode
      await selection.set(input)
      // A provider that had no credentials at setup gets another chance.
      if (input.provider !== undefined) await backends.ensure(input.provider)
      // The Code Mode catalog mirrors the registry: re-run the transforms
      // so registering/unregistering the tools follows the new mode.
      if (selection.get().mode !== before) await ctx.tool.reload()
      return statusPayload(selection, credentials)
    }

    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        // Distinct from the TUI's `/decision` slash selector: empirically a
        // same-named server command shadows the client slash entry in the
        // TUI's palette and Enter submits the literal text to the model.
        name: "decision-mode",
        description: "Decision mode: /decision-mode [on|off] [openrouter|typesafe|openai] | /decision-mode status",
        execute: async ({ sessionID, prompt }) => {
          const args = prompt.text.replace(/^\/decision(-mode)?\b\s*/i, "")
          try {
            const patch = parseDecisionArgs(args)
            const next = patch ? await apply(patch) : await statusPayload(selection, credentials)
            // resume:false — empirically, synthetic input schedules a model
            // turn by default; a toggle/status must not wake the controller.
            await ctx.session.synthetic({ sessionID, text: describeStatus(next), resume: false })
          } catch (error) {
            await ctx.session.synthetic({ sessionID, text: `Decision mode: ${(error as Error).message}`, resume: false })
          }
        },
      })
    })

    // Schemas must be real Standard Schema objects (zod); see src/rpc.ts.
    await ctx.rpc.register(DecisionRpc, {
      status: async () => statusPayload(selection, credentials),
      select: (input: DecisionSelectInput) => apply(input),
    })

    return () => {
      toolRegistration.dispose()
      commandRegistration.dispose()
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
