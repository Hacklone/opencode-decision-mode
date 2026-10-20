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
  applied *after* cache retrieval (policy is not part of the key). This
  composition is documented user-facing (feedback round 3): cache behavior
  must be inferable, not discovered by experiment. `cache: "bypass"` skips
  the *read* only — writes always refresh the cache, so bypass runs leave
  the cache fresher, never stale.
- **Raw answers are the stable artifact; verdicts are derived data.**
  Policy-only changes must be re-derivable at query time
  (`decision_results {run, policy}` re-derives from stored answers) — never
  force a provider re-run for a threshold change.
- **Derivable payload is stored once, not per row.** Score legends repeat a
  level string per record; stored rows carry `legend: null` and the labels
  live once in `RunSummary.levels` (feedback round 4: a 6.6 MB run file was
  mostly duplicated legend text). Readers reconstruct via `legendFor`; legacy
  runs with inline legends stay readable.
- **State projection is the safe default; `$record` is the footgun.**
  `project: [fields]` sends exactly the named raw-typed fields; `"$record"`
  sends the whole row and turns prior scores/annotations into grading
  leakage. Missing projected fields are hard per-record errors (same rule as
  unknown placeholders).
- **Framing is part of the instrument; give it a first-class channel.**
  `context` composes a constant preamble into every state — prepended to
  strings/arrays, added as the reserved `$context` key on objects (a source
  field of that name is a hard error, never a silent shadow). Feedback round
  5: losing a ~40-word preamble moved 56% of verdicts — "silently different
  model input" is the worst failure mode a scoring pipeline has, so every
  run summary carries `inputHash` (state composition + questions; provider,
  policy, per-record state excluded) and docs tell users to diff it before
  comparing runs. State serialization is itself part of the instrument —
  template vs `project`/`context` composition shifted 93.9% → 89.0% agreement
  in a real catalog run with identical content — so docs say "keep one
  composition per scoring program".
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
- **Noul has no confidence, and we don't fake one.** Verified on the wire
  (Oct 2026): noul answers are `{type, noul}` only. `|2*pTrue - 1|` measures
  *extremity*, not reliability (0.49 and 0.51 both score ~0.02; a
  confidently-wrong 0.9 scores high) — docs must never recommend it as an
  uncertainty gate. The honest plugin-side gates are the REVIEW band around
  0.5 and two-level score questions — now first-class: `withConfidence: true`
  on a noul question desugars to a two-level score (level 0 = false, level 1
  = true) before the provider and resugars the answer back to
  `{type: "noul", pTrue, confidence}` (domain/noul-confidence.ts). The cache
  keys and stores the desugared (provider) shape; stored rows carry the
  resugared shape. Empirically faithful: mean |Δ| 0.067 vs plain noul,
  100% same-side-of-0.5 agreement over 120 gate judgments (feedback round 5).
- Run results persist in chunks (`runs/<id>/p/<page>`, summary written last);
  page order is reassembled numerically, never trusted from scan order.

## Style

- Concise, imperative code; comments explain *why* (invariants, empirical
  findings), never restate the code.
- No speculative exports or re-exports; each module's surface is what its
  consumers use.
