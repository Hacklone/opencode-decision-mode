import { Rpc } from "@opencode/plugin/rpc"

/**
 * RPC contract shared between the server plugin and the TUI plugin.
 * Import this module contract-only (package export "./rpc").
 */
export const DecisionRpc = Rpc.define({
  id: "decision-mode",
  methods: {
    status: {
      input: { type: "object" },
      output: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["on", "off"] },
          provider: { type: "string" },
          model: { type: "string" },
          credentials: {
            type: "object",
            properties: {
              openrouter: { type: "boolean" },
              typesafe: { type: "boolean" },
              openai: { type: "boolean" },
            },
          },
        },
        required: ["mode", "provider", "model", "credentials"],
      },
    },
    select: {
      input: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["on", "off"] },
          provider: { type: "string", enum: ["openrouter", "typesafe", "openai"] },
          model: { type: ["string", "null"] },
        },
      },
      output: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["on", "off"] },
          provider: { type: "string" },
          model: { type: "string" },
          credentials: {
            type: "object",
            properties: {
              openrouter: { type: "boolean" },
              typesafe: { type: "boolean" },
              openai: { type: "boolean" },
            },
          },
        },
        required: ["mode", "provider", "model", "credentials"],
      },
    },
  },
  events: {},
})

export type DecisionStatus = {
  mode: "on" | "off"
  provider: string
  model: string
  credentials: { openrouter: boolean; typesafe: boolean; openai: boolean }
}

export type DecisionSelectInput = {
  mode?: "on" | "off"
  provider?: "openrouter" | "typesafe" | "openai"
  model?: string | null
}
