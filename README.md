# opencode-decision-mode

An [OpenCode v2](https://opencode.ai/v2/docs/) plugin that adds a **decision runtime** as a data plane for your coding sessions.

Your controller model (Claude, GPT, …) stays the control plane: it plans, calls tools, and reads results. Judgments — boolean checks, classifications, gradings over record sets — are delegated to cheap, fast, calibrated **decision models**: [TypeSafe Jev](https://docs.typesafe.ai/) via OpenRouter or direct, or OpenAI's native `/v1/decisions` endpoint (`gpt-6-luna`).

## What you get

| Tool | Purpose |
| --- | --- |
| `decision` | Judge **one item**: pass state + questions (`noul`/`choice`/`score`), get typed answers, probabilities, verdicts and token cost. |
| `decision_map` | Judge **every record** in a CSV/JSONL file. State is projected per record from a template; runs with bounded concurrency; per-record errors isolated; the run is persisted server-side. |
| `decision_results` | Inspect runs: filter by status/verdict, paginate, and choose compact vs. full detail. |

Plus a `/decision` slash command in the TUI to toggle the mode and pick the provider.

### Providers

| Provider | Default model | Cost basis |
| --- | --- | --- |
| OpenRouter (primary) | `typesafe/jev-1.14` | provider-reported `usage.cost` |
| TypeSafe direct | `jev-latest` | estimated: $42 / 1B input tokens, output free |
| OpenAI native | `gpt-6-luna` | estimated: $0.10 / 1M input tokens (decisions endpoint, output free) |

### Token-efficiency invariants

- **Off mode costs exactly zero tokens**: the tools are stripped from every model request via the `context` hook and no instruction is pushed.
- **On mode pushes ~3 lines** of system instruction — the controller's delegation contract, nothing more.
- Identical requests (provider, model, state, questions, options) are served from a content-hashed cache — repeats never touch the provider.
- One record with all of its questions is **one provider request**; records are never packed together.
- Result pages are compact by default: decisions without distributions.

### Verdict policy

Boolean (`noul`) answers get verdicts from a deterministic threshold policy: `p >= failAt → FAIL`, else `p >= reviewAt → REVIEW`, else `PASS` (defaults: `reviewAt = 0.6`, `failAt = 0.85`). Set globally, per call, or per question via `policy: { default, questions }`.

## Install

```sh
opencode plugin add opencode-decision-mode
```

or add it to `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-decision-mode"]
}
```

Local checkouts also work: copy (or link) this directory into `.opencode/plugins/decision-mode/` — local discovery loads `<dir>/index.ts` directly, so the root `index.ts` shim covers that path (npm installs use the `exports` map).

## Credentials

Resolution order per provider:

1. Environment: `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `OPENAI_API_KEY`
2. OpenCode-managed integration connections (probed defensively)

Without credentials a provider is simply unavailable; `/decision` shows what's detected.

## Usage sketch

```jsonc
// decision_map
{
  "source": { "path": "tickets.csv" },
  "state": { "ticket": "{{title}}", "body": "{{body}}" },  // or "$record" for the whole row
  "questions": [
    { "id": "duplicate", "type": "noul", "instructions": "Is this ticket a duplicate of an existing open ticket?" },
    { "id": "severity", "type": "score", "instructions": "Severity of the reported problem", "criteria": ["cosmetic", "annoying", "blocking", "data loss"] }
  ],
  "policy": { "questions": { "duplicate": { "reviewAt": 0.5, "failAt": 0.9 } } },
  "concurrency": 8
}
```

Then `decision_results { "run": "<id>", "verdict": "FAIL", "detail": "full" }`.

## Architecture

```
src/
  domain/        pure vocabulary: questions, answers, verdicts, usage
  application/   services: single decision, bulk map, result query (no platform imports)
  ports/         seams: backend, credentials, run store, cache, source reader, storage
  adapters/      backends (OpenRouter/TypeSafe/OpenAI SDKs), CSV/JSONL sources, fs reader,
                 plugin-storage persistence
  opencode/      plugin wiring: tools, context hook, RPC, credentials, selection
  tui.tsx        TUI plugin: /decision selector + home-footer status
  rpc.ts         shared RPC contract (export "./rpc")
```

The application/domain layers never import `@opencode/plugin`; every service is instantiated with fakes in tests.

## Development

```sh
npm install
npm test          # vitest + 100% coverage gate (statements/branches/functions/lines)
npm run typecheck
```

Node ≥ 22.15 (the TypeSafe SDK's zstd compression floor). The TUI entry requires OpenCode's OpenTUI runtime and is exercised manually against a live TUI.
