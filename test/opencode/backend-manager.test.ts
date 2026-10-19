import { describe, expect, it } from "vitest"
import { BackendManager } from "../../src/opencode/backend-manager"
import type { CredentialSource } from "../../src/ports/credential-source"

function credentialsWith(keys: Partial<Record<"openrouter" | "typesafe" | "openai", string | null>>): CredentialSource {
  return {
    resolve: async (provider) => keys[provider] ?? null,
    available: async (provider) => (keys[provider] ?? null) !== null,
  }
}

describe("BackendManager", () => {
  it("bootstraps backends for providers with credentials", async () => {
    const manager = new BackendManager(credentialsWith({ openrouter: "k", typesafe: null, openai: null }))
    await manager.bootstrap()
    expect(manager.registry.openrouter).not.toBeNull()
    expect(manager.registry.typesafe).toBeNull()
    expect(manager.registry.openai).toBeNull()
  })

  it("memoizes ensure() and later builds a provider once credentials exist", async () => {
    let openrouterKey: string | null = null
    const manager = new BackendManager({
      resolve: async () => openrouterKey,
      available: async () => openrouterKey !== null,
    })
    await manager.bootstrap()
    expect(manager.registry.openrouter).toBeNull()
    expect(await manager.ensure("openrouter")).toBeNull() // attempted, still null
    openrouterKey = "new-key"
    expect(await manager.ensure("openrouter")).toBeNull() // memoized attempt
    expect(await manager.refresh("openrouter")).not.toBeNull() // forced rebuild
    expect(await manager.ensure("openrouter")).not.toBeNull()
  })
})
