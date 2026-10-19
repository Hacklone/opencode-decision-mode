import type { ProviderId } from "../domain/decision-types"
import { DEFAULT_MODELS, PROVIDERS, isProviderId, parsePolicySpec, parseQuestions } from "../domain/decision-types"
import type { DecisionService } from "../application/decision-service"
import type { BulkMapService } from "../application/bulk-map-service"
import type { ResultQueryService } from "../application/result-query-service"
import { formatFromPath } from "../application/projection"
import type { BackendManager } from "./backend-manager"
import type { SelectionStore } from "./selection"

export interface ToolDeps {
  selection: SelectionStore
  backends: BackendManager
  decision: DecisionService
  bulk: BulkMapService
  results: ResultQueryService
  workspaceRoot: string | null
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolOutput>
}

export interface ToolContext {
  signal: AbortSignal
  progress(update: Record<string, unknown>): Promise<void>
}

/** Tool result: `content` is the text surfaced to the controller model. */
export interface ToolOutput {
  content: string
}

/** Tool context progress may misbehave; failures never break the tool. */
export async function reportProgress(context: ToolContext, status: string): Promise<void> {
  try {
    await context.progress({ status })
  } catch {
    // Progress reporting is best effort.
  }
}

const QUESTION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        id: { type: "string", description: "Stable key used in results" },
        type: { const: "noul", description: "Boolean judgment; answer is the probability of true" },
        instructions: { description: "What to judge; string or structured object" },
        criteria: {
          type: "object",
          properties: { true: {}, false: {} },
          description: "Optional descriptions of what true/false mean",
        },
      },
      required: ["id", "type", "instructions"],
    },
    {
      type: "object",
      properties: {
        id: { type: "string" },
        type: { const: "choice", description: "Pick one option; answer includes the distribution" },
        instructions: {},
        criteria: {
          type: "object",
          additionalProperties: { type: ["string", "null"] },
          description: "Option value → description (null = self-describing); 1–255 options",
        },
      },
      required: ["id", "type", "instructions", "criteria"],
    },
    {
      type: "object",
      properties: {
        id: { type: "string" },
        type: { const: "score", description: "Degree along ordered levels; answer is the selected level" },
        instructions: {},
        criteria: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 10,
          description: "Level descriptions, lowest → highest",
        },
      },
      required: ["id", "type", "instructions", "criteria"],
    },
  ],
} as const

const POLICY_SCHEMA = {
  type: "object",
  description:
    "Verdict policy for boolean questions: reviewAt/failAt in [0,1]. Either flat, or {default, questions: {id: policy}}. p>=failAt → FAIL, p>=reviewAt → REVIEW, else PASS. Defaults: reviewAt 0.6, failAt 0.85.",
  properties: {
    reviewAt: { type: "number" },
    failAt: { type: "number" },
    default: { type: "object", properties: { reviewAt: { type: "number" }, failAt: { type: "number" } } },
    questions: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { reviewAt: { type: "number" }, failAt: { type: "number" } },
      },
    },
  },
} as const

const PROVIDER_SCHEMA = { type: "string", enum: [...PROVIDERS] } as const

function targetSchema(): Record<string, unknown> {
  return {
    provider: { ...PROVIDER_SCHEMA, description: "Override the selected provider for this call" },
    model: { type: "string", description: "Override the selected model for this call" },
  }
}

/** Builds the three decision tools. Registered unconditionally; stripped per-request when Off. */
export function buildTools(deps: ToolDeps): ToolDefinition[] {
  return [decisionTool(deps), decisionMapTool(deps), decisionResultsTool(deps)]
}

function decisionTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "decision",
    description:
      "Delegate judgments about ONE item to the decision runtime (Jev / gpt-6-luna). Pass state and questions (noul/choice/score); get typed answers, probabilities, verdicts (PASS/REVIEW/FAIL) and token cost. Use for boolean checks, classifications, scoring. You stay the controller: plan and interpret — do not judge the item yourself.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          description:
            "Everything the judgment needs: source text, identities, policies, current facts. String, JSON object or array.",
          anyOf: [{ type: "string" }, { type: "object" }, { type: "array" }],
        },
        questions: { type: "array", minItems: 1, items: QUESTION_SCHEMA, description: "Ask one narrow judgment per question; independent questions run in parallel in one request." },
        policy: POLICY_SCHEMA,
        ...targetSchema(),
      },
      required: ["state", "questions"],
    },
    async execute(input, context) {
      const questions = parseQuestions(input["questions"])
      const policy = input["policy"] === undefined ? undefined : parsePolicySpec(input["policy"])
      const { provider, model } = resolveTarget(deps, input)
      const outcome = await deps.decision.decide({
        state: input["state"] as string | object | unknown[],
        questions,
        policy,
        provider,
        model,
        signal: context.signal,
      })
      return {
        content: JSON.stringify({
        provider: outcome.provider,
        model: outcome.resolvedModel,
        cached: outcome.cacheHit,
        verdict: outcome.verdict ?? null,
        answers: compactAnswers(outcome.answers),
        verdicts: outcome.verdicts,
        usage: outcome.usage,
        }),
      }
    },
  }
}

function decisionMapTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "decision_map",
    description:
      "Decide every record in a CSV/JSONL file via the decision runtime. Give a source path, a state template ({{field}} placeholders, or \"$record\" for the whole row) and questions; get a run id, summary (verdict tallies, cost, cache hits) and a preview. Results stay server-side; fetch rows with decision_results.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "object",
          properties: {
            path: { type: "string", description: "CSV/TSV/JSONL/NDJSON file path (absolute or workspace-relative)" },
            format: { type: "string", enum: ["csv", "jsonl"], description: "Inferred from the extension when omitted" },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1 },
          },
          required: ["path"],
        },
        state: {
          description:
            'State template projected per record: strings interpolate {{field}} / {{a.b}} placeholders; the literal value "$record" uses the whole row.',
        },
        questions: { type: "array", minItems: 1, items: QUESTION_SCHEMA },
        policy: POLICY_SCHEMA,
        concurrency: { type: "integer", minimum: 1, maximum: 32, description: "Parallel provider requests (default 4)" },
        ...targetSchema(),
      },
      required: ["source", "state", "questions"],
    },
    async execute(input, context) {
      const source = asRecord(input["source"], "source")
      const path = source["path"]
      if (typeof path !== "string" || path.length === 0) {
        throw new Error("source.path must be a non-empty string")
      }
      const format = resolveFormat(source["format"], path)
      const questions = parseQuestions(input["questions"])
      const policy = input["policy"] === undefined ? undefined : parsePolicySpec(input["policy"])
      const { provider, model } = resolveTarget(deps, input)
      const concurrency = typeof input["concurrency"] === "number" ? input["concurrency"] : 4
      const state = input["state"]

      await reportProgress(context, "decision_map: starting run")
      const outcome = await deps.bulk.map({
        path,
        format,
        state,
        questions,
        policy,
        provider,
        model,
        concurrency,
        offset: asInteger(source["offset"]),
        limit: asInteger(source["limit"]),
        signal: context.signal,
      })
      return { content: JSON.stringify({ run: outcome.summary.id, summary: outcome.summary, preview: outcome.preview }) }
    },
  }
}

function decisionResultsTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "decision_results",
    description:
      "Inspect decision_map runs. Omit `run` (or set list:true) to list recent runs; otherwise fetch filtered, paginated records (status ok/error, verdict PASS/REVIEW/FAIL). detail \"compact\" keeps decisions only; \"full\" adds distributions, usage and errors verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string", description: "Run id returned by decision_map" },
        list: { type: "boolean", description: "List recent runs instead of querying one" },
        status: { type: "string", enum: ["ok", "error"] },
        verdict: { type: "string", enum: ["PASS", "REVIEW", "FAIL"] },
        detail: { type: "string", enum: ["compact", "full"] },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 20" },
      },
    },
    async execute(input) {
      if (input["list"] === true || typeof input["run"] !== "string") {
        return { content: JSON.stringify({ runs: await deps.results.listRuns(10) }) }
      }
      const page = await deps.results.query({
        run: input["run"],
        status: input["status"] === "ok" || input["status"] === "error" ? input["status"] : undefined,
        verdict:
          input["verdict"] === "PASS" || input["verdict"] === "REVIEW" || input["verdict"] === "FAIL"
            ? input["verdict"]
            : undefined,
        detail: input["detail"] === "full" ? "full" : "compact",
        offset: asInteger(input["offset"]),
        limit: asInteger(input["limit"]),
      })
      return { content: JSON.stringify(page) }
    },
  }
}

export function resolveTarget(
  deps: ToolDeps,
  input: Record<string, unknown>,
): { provider: ProviderId; model: string } {
  const selection = deps.selection.get()
  const provider: ProviderId =
    isProviderId(input["provider"]) ? input["provider"] : selection.provider
  const model =
    typeof input["model"] === "string" && input["model"].length > 0
      ? input["model"]
      : input["model"] === undefined && selection.model !== null && selection.provider === provider
        ? selection.model
        : DEFAULT_MODELS[provider]
  return { provider, model }
}

function resolveFormat(value: unknown, path: string): "csv" | "jsonl" {
  if (value === "csv" || value === "jsonl") return value
  const inferred = formatFromPath(path)
  if (inferred !== null) return inferred
  throw new Error(`cannot infer source format for ${path}; pass source.format`)
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined
}

/** Token-efficient single-decision answers: the decision, not the full distribution. */
export function compactAnswers(answers: Record<string, import("../domain/decision-types").Answer>) {
  const out: Record<string, unknown> = {}
  for (const [id, answer] of Object.entries(answers)) {
    switch (answer.type) {
      case "noul":
        out[id] = { type: "noul", pTrue: round(answer.pTrue) }
        break
      case "choice":
        out[id] = withConfidence({ type: "choice", choice: answer.choice }, answer.confidence)
        break
      case "score":
        out[id] = withConfidence(
          { type: "score", level: answer.legend ?? String(answer.score) },
          answer.confidence,
        )
        break
    }
  }
  return out
}

function withConfidence(base: Record<string, unknown>, confidence: number | undefined) {
  if (confidence === undefined) return base
  return { ...base, confidence: round(confidence) }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}
