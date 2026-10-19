import { describe, expect, it } from "vitest"
import plugin, { ON_INSTRUCTION } from "../src/index"
import serverPlugin from "../src/opencode/plugin"

describe("package entry", () => {
  it("re-exports the server plugin and instruction", () => {
    expect(plugin).toBe(serverPlugin)
    expect(ON_INSTRUCTION).toContain("Decision mode is ON")
  })
})
