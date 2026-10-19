/**
 * Entry shim for local installs: OpenCode's `.opencode/plugins/<dir>`
 * discovery resolves the rpc entry as `<dir>/rpc.*` directly (the package.json
 * `exports` map is only honored for npm-installed plugins).
 */
export * from "./src/rpc.ts"
