import { z } from "zod"
import { Rpc } from "@opencode/plugin/rpc"
import { PROVIDER_IDS, type ProviderId } from "./domain/decision-types"

/**
 * RPC contract shared between the server plugin and the TUI plugin.
 * Import this module contract-only (package export "./rpc").
 *
 * Schemas are zod (Standard Schema): the runtime's rpc.register requires
 * real Standard Schema objects — raw JSON Schema literals are silently
 * ignored, which was verified empirically.
 */
const providerEnum = z.enum(PROVIDER_IDS)

const statusOutput = z.object({
  mode: z.enum(["on", "off"]),
  provider: providerEnum,
  model: z.string(),
  credentials: z.record(providerEnum, z.boolean()),
})

export const DecisionRpc = Rpc.define({
  id: "decision-mode",
  methods: {
    status: {
      input: z.object({}),
      output: statusOutput,
    },
    select: {
      input: z.object({
        mode: z.enum(["on", "off"]).optional(),
        provider: providerEnum.optional(),
        model: z.string().nullable().optional(),
      }),
      output: statusOutput,
    },
  },
  events: {},
})

export type DecisionStatus = z.infer<typeof statusOutput>

export type DecisionSelectInput = {
  mode?: "on" | "off"
  provider?: ProviderId
  model?: string | null
}
