# opencode-decision-mode

**Stop paying your coding agent to read your data.** Your controller model
(Claude, GPT, …) stays in charge of the session, while a **decision runtime** —
TypeSafe Jev via OpenRouter or direct, or OpenAI `gpt-6-luna` — handles the
judgment calls: is this ticket a duplicate, is this claim supported, how severe
is this bug. Typed answers with probabilities, back in milliseconds and fractions
of a cent — and none of your data ever scrolls through the controller's context.

Measured in real use: **130 CSV records judged against five rules in ~6
seconds for ~$0.017** — same job through a chat model means 130 reads through
context, minutes of latency, and a bill orders of magnitude higher.

## What you get

| Tool | What it does |
| --- | --- |
| `decision` | Judge **one item**: pass state + questions, get typed answers with probabilities, verdicts, and cost. |
| `decision_map` | Judge **every record** in a CSV/JSONL file with bounded concurrency. Returns a run id, verdict tallies, cost, cache hits — results stay server-side, never in context. |
| `decision_results` | Slice persisted runs by status/verdict, paginate, and **export to a file** with a SHA-256 provenance checksum. |

The controller sees them in Code Mode as `tools.decision["decision_map"](…)`.

Toggle everything with `/decision` in the TUI (styled selector + footer status),
or `/decision-mode [on|off] [provider]` / `/decision-mode status` in the web UI,
app, or API. **Off mode costs exactly zero tokens** — the tools disappear from
every model request, not just the menu.

## What an answer looks like

```jsonc
// decision → one request (typesafe/jev-1.14; answer shapes verbatim, combined for display)
{
  "verdict": "FAIL",
  "answers": {
    "future": { "type": "noul", "pTrue": 0.99 },                      // "is this about prediction?"
    "severity": { "type": "score", "level": "somewhat useful", "confidence": 0.67 }
  },
  "usage": { "costUsd": 0.0000121, "costSource": "provider" }
}
```

Three primitives, all probability-native: **noul** (is a condition true → p),
**choice** (pick one of N options → distribution), **score** (position along
described levels). Verdicts are yours to define: a deterministic threshold
policy (`p ≥ failAt → FAIL`, `p ≥ reviewAt → REVIEW`, else `PASS`) turns raw
probabilities into actionable labels — per call, global, or per question.

## Why it's safe to run big

- **One record = one request; errors are isolated per record** — one bad row never corrupts a run.
- **Systematic-failure bail**: 6 failures with the same signature stop the run and skip the rest, instead of burning your whole input on a broken assumption.
- **Content-hashed cache**: re-run after fixing a question and only what actually changed hits the provider. Free. Cache keys are content hashes over provider, model, state, questions, and a schema version — so you can always tell what a re-run will reuse. Identical inputs returning identical answers makes cache-hit counts a provenance check, and `cache: "bypass"` re-samples identical inputs when you need to measure the model's run-to-run variance instead.
- **Policy iteration is free**: raw answers are the stable artifact and verdicts are derived data. `decision_results {run, policy}` re-derives PASS/REVIEW/FAIL from stored answers under new thresholds without spending a provider call.
- **File export** (`jsonl` lossless / `csv` join-ready, keyed by record id + index) so a 10 000-row job never needs to page its results through a context window.
- **Polarity guardrail**: ask a boolean question without stating your threshold policy and the response warns you about the TRUE-means-bad convention before verdicts silently invert.

## Providers

| Provider | Default model | Pricing |
| --- | --- | --- |
| OpenRouter (primary) | `typesafe/jev-1.14` | provider-reported cost |
| TypeSafe direct | `jev-latest` | $42 / 1B input tokens, output free |
| OpenAI native `/v1/decisions` | `gpt-6-luna` | $0.10 / 1M input tokens, output free |

## Install

```sh
opencode plugin add @coool/opencode-decision-mode
```

Or link this directory into `.opencode/plugins/decision-mode/` in your project.
Set `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, or `OPENAI_API_KEY` for the
provider you want to use.

## Example: triage a ticket dump

```jsonc
// decision_map
{
  "source": { "path": "tickets.csv", "sample": 3 },        // sample = peek at data shape, no provider calls
  "project": ["title", "body"],        // state = exactly these fields, raw values — safer than "$record",
                                       // which sends the whole row (prior scores = grading leakage)
  "questions": [
    { "id": "duplicate", "type": "noul", "instructions": "TRUE if this ticket duplicates an existing one" }
  ],
  "policy": { "reviewAt": 0.6, "failAt": 0.85 },           // phrase booleans so TRUE is the bad outcome
  "output": { "path": "triage.csv" },                       // join-ready CSV + checksum, straight to disk
  "concurrency": 8
}
```

Then in a **new session, if needed**: `decision_results { "run": "<id>",
"verdict": "FAIL", "output": { "path": "fails.jsonl" } }` — runs persist
server-side; losing context never loses results.

## Development

```sh
npm install
npm test          # vitest + 100% coverage gate (186 tests)
npm run typecheck
```

Node ≥ 22.15. See `AGENTS.md` for architecture rules and conventions.

---

*The headline numbers: a real session judging 130 quotes against five blueprint
rules — ~6 s wall time, ~$0.017 total, zero rows passing through the
controller's context. Your data never has to be the model's reading material.*
