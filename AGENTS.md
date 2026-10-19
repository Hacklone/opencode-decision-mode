# AGENTS.md — working rules for this repository

`opencode-decision-mode` is an OpenCode v2 plugin: a **controller model** (the
agent you talk to) stays the control plane and delegates judgments to a
**decision runtime** (Jev via OpenRouter/TypeSafe, gpt-6-luna via OpenAI) as
the data plane. Three tools (`decision`, `decision_map`, `decision_results`),
a `/decision` TUI selector, server-authoritative selection state.

## Architecture rules (non-negotiable)

- **Dependency rule**: `src/domain/`, `src/application/`, and `src/ports/`
  never import `@opencode/plugin` (or any OpenCode/platform SDK). Only
  `src/adapters/` and `src/opencode/` touch the platform.
- **Extraction test**: every application service must be instantiable with
  fakes alone. If a service needs the real plugin context to be constructed
  or tested, the seam is wrong — add a port.
- **Domain is pure vocabulary**: types, deterministic policies, normalization.
  No I/O, no clocks, no randomness. Side effects (time, ids) are injected
  (`now: () => number`).
- **Ports are the only seams**: backends, credentials, run store, cache,
  source reader, storage. Adapters implement ports; never let application
  code import an adapter directly.
- **No dead knobs**: a parameter that no caller sets is removed, not kept
  "for later". Revisit when a real caller appears (bump the cache schema
  version if a fingerprint field changes).

## TypeScript conventions

- `strict` + `noUncheckedIndexedAccess` always on. No `any`.
- Non-null assertions (`!`) only where the invariant is provable and stated in
  a comment (e.g. `scoreIndex` guarantees a valid criteria index).
- Validate at the boundary (tool input → `parseQuestions`/`parsePolicySpec`),
  trust types inside. Invalid input throws with a message that names the
  offending field — the message is the model's only feedback.
- Provider responses are untrusted: every backend normalizes through
  defensive readers (`asNumber`/`asString`/`asRecord`), and missing or
  malformed answers are hard errors, never silently coerced.
- Tool results must be `{ content: string }` — verified empirically, OpenCode
  surfaces `content` to the model; `output` alone does not.

## Testing rules

- **Coverage gate is 100%** for statements, branches, functions, and lines
  (`vitest run --coverage` fails otherwise). If a branch is unreachable,
  delete the branch instead of weakening the gate.
- Tests assert **behavior**, not implementation: services are exercised
  through their public methods with in-memory fakes (`test/fakes.ts`).
- Every provider adapter is tested with a mocked SDK module; error mapping,
  abort handling, and malformed-payload paths are all covered.
- Determinism: no sleeps, no real network, no real clocks. Runs get injected
  `now`; abort tests drive their own `AbortController`.
- Bug fixes add a regression test that fails without the fix.

## Verification workflow

```sh
npm install          # once
npm run typecheck    # tsc --noEmit — must be clean
npm test             # vitest + 100% coverage gate
```

**Live smoke test** (after changes that touch tool wiring or plugin loading):
copy `src/` into a sandbox project's `.opencode/plugins/decision-mode/`
(keep the root `index.ts` shim — local discovery loads `<dir>/index.ts`),
then `opencode run "…ask the model to call decision…"`. Verify the tool
loads (`--print-logs run --standalone`), the model sees the tools, and a real
round-trip returns answers, verdicts, provider cost, and cache hits.

## Plugin-specific invariants (from the spec)

- **Off mode costs zero tokens**: visibility is enforced at the tool
  registry — the transform registers nothing while off and `ctx.tool.reload()`
  re-runs it when `/decision` flips the mode (empirically the Code Mode
  catalog mirrors the registry, NOT the per-request `event.tools`, so
  deleting those keys does nothing). No instruction is pushed while off;
  on mode pushes ~3 lines, nothing more.
- **Clients agree through the server**: selection state is server-owned; the
  TUI uses RPC + the `/decision` selector, every other client (web, app, API)
  uses the `decision-mode` server command — deliberately renamed because a
  same-named server command shadows the TUI client slash entry (empirical:
  Enter then submits the literal text to the model). Command feedback is
  admitted via `session.synthetic` with `resume: false` — empirically
  synthetic input schedules a model turn by default, which would silently
  wake the controller on every toggle.
- **One record + all its questions = one provider request.** Never pack
  multiple records into one call.
- **Cache** keys are content hashes over {provider, model, state, questions,
  schemaVersion}; only successful responses are cached; verdict policies are
  applied *after* cache retrieval (policy is not part of the key).
- **Errors are semantic answers' siblings**: per-record OK/ERROR in runs; a
  backend error never corrupts other records. When 6 failures share the same
  signature (digits masked), the run bails out early and the rest are marked
  `skipped after systematic failure: …` — a broken assumption must not burn
  the whole input; the tool response carries `aborted` + a warning.
- **Score answers are positions, not indexes**: Jev returns
  probability-weighted fractional positions (e.g. 1.33); backends clamp to the
  level range and label with the nearest level. Never reject a finite number.
- **Usage honesty**: provider-reported cost is reported as such; estimates are
  labeled `"estimated"`, unknowns stay `null` (never coerced to zero).
- Run results persist in chunks (`runs/<id>/p/<page>`, summary written last);
  page order is reassembled numerically, never trusted from scan order.

## Style

- Concise, imperative code; comments explain *why* (invariants, empirical
  findings), never restate the code.
- No speculative exports or re-exports; each module's surface is what its
  consumers use.
