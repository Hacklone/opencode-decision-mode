import { describe, expect, it } from "vitest"
import { availableProviders, buildBackends } from "../../../src/adapters/backends/registry"

describe("buildBackends", () => {
  it("builds only providers with credentials", () => {
    const registry = buildBackends({ openrouter: null, typesafe: "ts-key", openai: null })
    expect(availableProviders(registry)).toEqual(["typesafe"])
    expect(registry["openrouter"]).toBeNull()
    expect(registry["typesafe"]).toBeDefined()
    expect(registry["openai"]).toBeNull()
  })

  it("builds all three when all keys are present", () => {
    const registry = buildBackends({ openrouter: "a", typesafe: "b", openai: "c" })
    expect(availableProviders(registry)).toEqual(["openrouter", "typesafe", "openai"])
  })
})
