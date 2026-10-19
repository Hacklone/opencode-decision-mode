import { Plugin } from "@opencode/plugin/tui"
import { createStore } from "solid-js/store"

type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
import { DecisionRpc } from "./rpc"
import {
  CREDENTIAL_ENV,
  DEFAULT_MODELS,
  PROVIDER_SHORT,
  PROVIDERS,
  isProviderId,
  type ProviderId,
} from "./domain/decision-types"

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  typesafe: "TypeSafe direct",
  openai: "OpenAI native",
}

interface Status {
  mode: "on" | "off"
  provider: ProviderId
  model: string
  credentials: Record<ProviderId, boolean>
}

/**
 * TUI plugin: `/decision` slash command (also in the palette) opens a
 * selector for mode and provider; a status line renders in the home footer
 * and in the in-session prompt footer (each slot exists on only one screen).
 * All state is server-authoritative, read and mutated over RPC.
 */
export default Plugin.define({
  id: "decision-mode",
  setup(context: TuiContext) {
    const [status, setStatus] = createStore<{ current: Status | null }>({ current: null })

    const refresh = async (): Promise<void> => {
      try {
        const next = await context.client.rpc(DecisionRpc).status({})
        if (isStatus(next)) setStatus("current", next)
      } catch {
        // The server plugin may not be ready yet at TUI boot; retry quietly.
        setTimeout(() => void refresh(), 2000)
      }
    }

    const apply = async (patch: { mode?: "on" | "off"; provider?: ProviderId }): Promise<void> => {
      const next = await context.client.rpc(DecisionRpc).select(patch)
      if (isStatus(next)) {
        setStatus("current", next)
        context.ui.toast.show({
          title: "Decision mode",
          message: describe(next),
          variant: next.mode === "on" && !hasCredential(next) ? "warning" : "success",
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
        current: current === null || current.mode === "off" ? "mode" : current.provider,
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

    const statusLine = () => {
      const current = status.current
      if (current === null) return <text></text>
      if (current.mode === "off") {
        // Off mode: the whole line ("Decision off") in a softer red —
        // notice-able, but calmer than full-brightness ANSI red.
        return (
          <text>
            <span style={{ fg: "#e57373" }}>Decision off</span>
          </text>
        )
      }
      return (
        <text>
          <span style={{ fg: "green" }}>Decision</span>
          {` ${statusTail(current)}`}
        </text>
      )
    }
    // The home footer slot only exists on the home screen; sessions render the
    // prompt footer, so the status would otherwise vanish mid-session.
    const disposeSlots = [
      context.ui.slot({ append: "home.footer.status", render: statusLine }),
      context.ui.slot({ append: "prompt.footer.status", render: statusLine }),
    ]

    void refresh()

    return () => {
      for (const dispose of disposeSlots) dispose()
    }
  },
})

function hasCredential(status: Status): boolean {
  return status.credentials[status.provider]
}

// Status bar space is scarce: provider and model use their short forms.
// When on, the word "Decision" is green; when off, the whole line is a soft
// red. This string is the mode-dependent remainder (toasts reuse it, plain).
function statusTail(status: Status): string {
  if (status.mode === "off") return "off"
  const model = status.model.includes("/") ? status.model.slice(status.model.lastIndexOf("/") + 1) : status.model
  const missing = hasCredential(status) ? "" : `  (no ${CREDENTIAL_ENV[status.provider]})`
  return `${PROVIDER_SHORT[status.provider]}/${model}${missing}`
}

function describe(status: Status): string {
  return `Decision ${statusTail(status)}`
}

function isStatus(value: unknown): value is Status {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  const credentials = record["credentials"]
  if (typeof credentials !== "object" || credentials === null) return false
  const creds = credentials as Record<string, unknown>
  return (
    (record["mode"] === "on" || record["mode"] === "off") &&
    isProviderId(record["provider"]) &&
    typeof record["model"] === "string" &&
    PROVIDERS.every((id) => typeof creds[id] === "boolean")
  )
}
