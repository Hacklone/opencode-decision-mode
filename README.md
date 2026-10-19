# opencode-decision-mode

OpenCode v2 plugin: your controller model stays the control plane and delegates
judgments to a decision runtime (TypeSafe Jev via OpenRouter or direct, OpenAI
`gpt-6-luna`) as the data plane.

Three tools: `decision` (judge one item), `decision_map` (judge every record of
a CSV/JSONL file), `decision_results` (query persisted runs). Toggle mode and
provider with `/decision` — an interactive selector in the TUI; in the web UI
and other clients use the `/decision-mode` command:
`/decision-mode [on|off] [provider]` or `/decision-mode status`.

## Install

```sh
opencode plugin add opencode-decision-mode
```

Or link this directory into `.opencode/plugins/decision-mode/` in your project.
Set `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, or `OPENAI_API_KEY` for the
provider you want to use.

## Example

```jsonc
// decision_map
{
  "source": { "path": "tickets.csv", "sample": 3 }, // sample = peek, no provider calls
  "state": { "ticket": "{{title}}\n{{body}}" },
  "questions": [
    { "id": "duplicate", "type": "noul", "instructions": "TRUE if this ticket duplicates an existing one" }
  ],
  "policy": { "reviewAt": 0.6, "failAt": 0.85 } // p >= failAt -> FAIL; phrase booleans so TRUE is the bad outcome
}
```

Then `decision_results { "run": "<id>", "verdict": "FAIL", "detail": "full" }`.

## Development

```sh
npm install
npm test          # vitest + 100% coverage gate
npm run typecheck
```

Node ≥ 22.15. See `AGENTS.md` for architecture rules and conventions.
