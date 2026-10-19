import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The TUI entry is JSX rendered by OpenCode's OpenTUI runtime; it is
      // exercised manually against a live TUI, not under vitest.
      // src/ports/storage.ts is a type-only contract (no runtime statements).
      exclude: ["src/tui.tsx", "src/ports/storage.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
