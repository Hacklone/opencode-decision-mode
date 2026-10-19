import { describe, expect, it } from "vitest"
import { COMMAND_USAGE, describeStatus, parseDecisionArgs } from "../../src/opencode/command"
import type { ProviderId } from "../../src/domain/decision-types"
import type { DecisionStatus } from "../../src/rpc"

const allCreds = { openrouter: true, typesafe: true, openai: true }

function status(mode: "on" | "off", provider: ProviderId, model: string, credentials = allCreds): DecisionStatus {
  return { mode, provider, model, credentials }
}

describe("parseDecisionArgs", () => {
  it("maps mode tokens case-insensitively", () => {
    expect(parseDecisionArgs("off")).toEqual({ mode: "off" })
    expect(parseDecisionArgs("ON")).toEqual({ mode: "on" })
  })

  it("maps provider names and short aliases", () => {
    expect(parseDecisionArgs("openrouter")).toEqual({ provider: "openrouter" })
    expect(parseDecisionArgs("or")).toEqual({ provider: "openrouter" })
    expect(parseDecisionArgs("typesafe")).toEqual({ provider: "typesafe" })
    expect(parseDecisionArgs("ts")).toEqual({ provider: "typesafe" })
    expect(parseDecisionArgs("openai")).toEqual({ provider: "openai" })
    expect(parseDecisionArgs("oai")).toEqual({ provider: "openai" })
  })

  it("combines tokens", () => {
    expect(parseDecisionArgs("on  typesafe")).toEqual({ mode: "on", provider: "typesafe" })
  })

  it("report-only forms yield undefined", () => {
    expect(parseDecisionArgs("")).toBeUndefined()
    expect(parseDecisionArgs("   ")).toBeUndefined()
    expect(parseDecisionArgs("status")).toBeUndefined()
  })

  it("rejects unknown tokens with usage guidance", () => {
    expect(() => parseDecisionArgs("bogus")).toThrowError(/unknown argument "bogus"/)
    expect(() => parseDecisionArgs("on bogus")).toThrow(COMMAND_USAGE)
  })
})

describe("describeStatus", () => {
  it("renders mode · provider/model", () => {
    expect(describeStatus(status("on", "typesafe", "jev-latest"))).toBe("Decision mode: on · typesafe/jev-latest")
    expect(describeStatus(status("off", "openrouter", "typesafe/jev-1.14"))).toBe(
      "Decision mode: off · openrouter/typesafe/jev-1.14",
    )
  })

  it("flags the active provider's missing credential", () => {
    const none = { openrouter: false, typesafe: false, openai: false }
    expect(describeStatus(status("on", "openai", "gpt-6-luna", none))).toContain("(no OPENAI_API_KEY")
  })
})
