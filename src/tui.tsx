import { Plugin } from "@opencode/plugin/tui"
import { createStore } from "solid-js/store"

type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
import { DecisionRpc } from "./rpc"
import { DEFAULT_MODELS, PROVIDERS, type ProviderId } from "./domain/decision-types"

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  typesafe: "TypeSafe direct",
  openai: "OpenAI native",
}

interface Status {
  mode: "on" | "off"
  provider: string
  model: string
  credentials: Record<string, boolean>
}

/**
 * TUI plugin: `/decision` slash command (also in the palette) opens a
 * selector for mode and provider; a status line lives in the home footer.
 * All state is server-authoritative, read and mutated over RPC.
 */
export default Plugin.define({
  id: "decision-mode",
  setup(context: TuiContext) {
    const [status, setStatus] = createStore<{ current: Status | null }>({ current: null })

    const refresh = async (): Promise<void> => {
      const next = (await context.client.rpc(DecisionRpc).status(undefined)) as unknown
      if (isStatus(next)) setStatus("current", next)
    }

    const apply = async (patch: { mode?: "on" | "off"; provider?: ProviderId }): Promise<void> => {
      const next = (await context.client.rpc(DecisionRpc).select(patch)) as unknown
      if (isStatus(next)) {
        setStatus("current", next)
        context.ui.toast.show({
          title: "Decision mode",
          message: describe(next),
          variant: next.mode === "on" && !next.credentials[next.provider] ? "warning" : "success",
        })
      }
    }

    const openSelector = async (): Promise<void> => {
      await refresh()
      const current = status.current
      const options = [
        {
          title: current?.mode === "off" ? "Turn On" : "Turn Off",
          value: "mode" as const,
          description: current?.mode === "off"
            ? "Expose decision tools to the controller model"
            : "Strip decision tools from every request (zero token overhead)",
          category: "Mode",
        },
        ...PROVIDERS.map((provider) => ({
          title: PROVIDER_LABELS[provider],
          value: provider as ProviderId | "mode",
          description: `${DEFAULT_MODELS[provider]}${
            current?.credentials[provider] === false ? "  (no credentials detected)" : ""
          }`,
          category: "Provider",
        })),
      ]
      const selected = await context.ui.dialog.select<ProviderId | "mode">({
        title: "Decision mode",
        current: current === null || current.mode === "off" ? "mode" : (current.provider as ProviderId),
        options,
      })
      if (selected === undefined) return
      if (selected === "mode") {
        await apply({ mode: current?.mode === "off" ? "on" : "off" })
        return
      }
      await apply({ provider: selected, mode: "on" })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "decision-mode.select",
          title: "Decision mode: configure",
          description: "Toggle decision delegation and pick the decision provider",
          group: "Decision",
          palette: true,
          slash: { name: "decision" },
          suggested: true,
          run: () => void openSelector(),
        },
      ],
    }))

    const disposeSlot = context.ui.slot({
      append: "home.footer.status",
      render: () => <text>{status.current === null ? "" : describe(status.current)}</text>,
    })

    void refresh()

    return () => {
      disposeSlot()
    }
  },
})

function describe(status: Status): string {
  const base = `decision: ${status.mode} · ${status.provider}/${status.model}`
  if (status.mode === "on" && status.credentials[status.provider] === false) {
    return `${base}  (no credentials — set ${status.provider === "openrouter" ? "OPENROUTER_API_KEY" : status.provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY"})`
  }
  return base
}

function isStatus(value: unknown): value is Status {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    (record["mode"] === "on" || record["mode"] === "off") &&
    typeof record["provider"] === "string" &&
    typeof record["model"] === "string" &&
    typeof record["credentials"] === "object" &&
    record["credentials"] !== null
  )
}
