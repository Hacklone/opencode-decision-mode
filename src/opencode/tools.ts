import type { Answer, PolicySpec, ProviderId, Question } from "../domain/decision-types"
import { DEFAULT_MODELS, PROVIDERS, isProviderId, parsePolicySpec, parseQuestions } from "../domain/decision-types"
import type { DecisionService } from "../application/decision-service"
import {
  MAX_PREVIEW_SIZE,
  PREVIEW_SIZE,
  SYSTEMATIC_ABORT_AFTER,
  type BulkMapService,
} from "../application/bulk-map-service"
import type { ResultQueryService } from "../application/result-query-service"
import type { ResultsExportService } from "../application/export-service"
import { formatFromPath } from "../application/projection"
import type { BackendManager } from "./backend-manager"
import type { SelectionStore } from "./selection"

export interface ToolDeps {
  selection: SelectionStore
  backends: BackendManager
  decision: DecisionService
  bulk: BulkMapService
  results: ResultQueryService
  exporter: ResultsExportService
}

/**
 * Code Mode namespace for all three tools. Empirically (v2.0.32): namespaced
 * tools are exposed to the provider as `<namespace>_<name>` and listed in the
 * catalog under `tools.<namespace>["<name>"]`.
 */
export const NAMESPACE = "decision"

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
        type: { const: "noul", description: "Boolean judgment; answer is the probability of true (pTrue). Phrase so TRUE is the violation/bad outcome — verdicts escalate with pTrue (p>=failAt → FAIL). Noul answers carry no confidence value on the provider wire. pTrue near 0.5 means the judgment is uncertain: gate that by lowering reviewAt so the REVIEW band covers the middle, or use a score question when you need a real confidence value. |2*pTrue - 1| measures extremity, not reliability." },
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
        type: { const: "score", description: "Degree along ordered levels; answer is a probability-weighted position in [0, levels-1] (0-based, may be fractional, clamped) plus the nearest level label" },
        instructions: {},
        criteria: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 10,
          description: "Level descriptions, lowest → highest. Plain strings only — the provider wire format does not accept structured {what, examples} objects. Sharper, concrete level descriptions measurably improve answers.",
        },
      },
      required: ["id", "type", "instructions", "criteria"],
    },
  ],
} as const

const POLICY_SCHEMA = {
  type: "object",
  description:
    "Verdict policy for boolean questions: reviewAt/failAt in [0,1]. Either flat, or {default, questions: {id: policy}}. POLARITY: phrase boolean questions so TRUE is the BAD outcome — higher p(True) escalates the verdict (p>=failAt → FAIL, p>=reviewAt → REVIEW, else PASS). With positive phrasing (TRUE = good) verdicts invert. Defaults: reviewAt 0.6, failAt 0.85.",
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

const CACHE_SCHEMA = {
  type: "string",
  enum: ["bypass"],
  description:
    "Skip the cache read so identical inputs are re-sampled (variance/repeatability studies); the fresh answer is written back to the cache.",
} as const

const OUTPUT_SCHEMA = {
  type: "object",
  description:
    "Write the full (filtered) result set to a file instead of paging rows through context. The response then carries only {path, format, records, total, bytes, sha256}; parent directories are created.",
  properties: {
    path: { type: "string", description: "Destination file (absolute or workspace-relative)" },
    format: {
      type: "string",
      enum: ["jsonl", "csv"],
      description:
        "Inferred from the .jsonl/.ndjson/.csv/.tsv extension when omitted. jsonl: full rows including the record snapshot (score level labels are stored once per run in the summary, not per row). csv: one row per record — _index,_key,_status,_error, one column per question id (+ <qid>_verdict), then the source record's own columns.",
    },
  },
  required: ["path"],
} as const

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
      "Delegate judgments about ONE item to the decision runtime (Jev / gpt-6-luna). Pass state and questions (noul/choice/score); get typed answers, probabilities, verdicts (PASS/REVIEW/FAIL) and token cost. Use for boolean checks, classifications, scoring. Phrase boolean (noul) questions so TRUE is the bad outcome — verdicts escalate with pTrue. `cache: \"bypass\"` re-samples an identical request instead of serving the cached answer. You stay the controller: plan and interpret — do not judge the item yourself.",
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
        cache: CACHE_SCHEMA,
        ...targetSchema(),
      },
      required: ["state", "questions"],
    },
    async execute(input, context) {
      const questions = parseQuestions(input["questions"])
      const policy = input["policy"] === undefined ? undefined : parsePolicySpec(input["policy"])
      const cache = parseCache(input["cache"])
      const { provider, model } = resolveTarget(deps, input)
      const outcome = await deps.decision.decide({
        state: input["state"] as string | object | unknown[],
        questions,
        policy,
        provider,
        model,
        cache,
        signal: context.signal,
      })
      const warnings = polarityWarnings(questions, policy)
      return {
        content: JSON.stringify({
        provider: outcome.provider,
        model: outcome.resolvedModel,
        cached: outcome.cacheHit,
        verdict: outcome.verdict ?? null,
        answers: compactAnswers(outcome.answers),
        verdicts: outcome.verdicts,
        usage: outcome.usage,
        ...(warnings.length > 0 ? { warnings } : {}),
        }),
      }
    },
  }
}

function decisionMapTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "decision_map",
    description:
      "Decide every record in a CSV/JSONL file via the decision runtime. Give a source path, a state projection (`project: [fields]` — the safe default) or a state template ({{field}} placeholders; \"$record\" = whole row, a leakage footgun when the file carries prior scores) and questions; get a run id, summary (verdict tallies, cost, cache hits) and a preview. CSV parsing handles quoted fields, escaped quotes and embedded newlines — judge the original file, no pre-conversion. Results stay server-side; set `output` to write the FULL result set to a file in this call (token-cheap), or fetch slices with decision_results. On large runs set `preview: false` — the response then carries the summary only. `cache: \"bypass\"` re-samples identical inputs for variance studies. Phrase boolean (noul) questions so TRUE is the violation/bad outcome — verdicts escalate with pTrue. Set source.sample to peek at records without judging.",
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
            sample: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description:
                "Peek instead of judge: return the first N records as JSON (no provider calls, no run). Use it to design questions against real data shape.",
            },
          },
          required: ["path"],
        },
        state: {
          description:
            'State template projected per record: strings interpolate {{field}} / {{a.b}} placeholders; the literal value "$record" uses the whole row. Prefer `project` instead when you just need a few fields — "$record" sends the entire row, including prior scores or annotations, which leaks the answer into the judgment. Required unless source.sample or project is set.',
        },
        project: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Project the named record fields as the state object with raw values (types preserved, unlike string templates). The safe default over \"$record\": state contains exactly the fields you name, so prior scores or editorial columns cannot leak into the judgment.",
        },
        questions: { type: "array", minItems: 1, items: QUESTION_SCHEMA },
        policy: POLICY_SCHEMA,
        concurrency: { type: "integer", minimum: 1, maximum: 32, description: "Parallel provider requests (default 4)" },
        preview: {
          anyOf: [{ type: "boolean" }, { type: "integer", minimum: 0, maximum: 50 }],
          description:
            "Preview records in the response (default 10). false omits the preview entirely — the token-safe choice for large runs, where the full result set lives server-side.",
        },
        cache: CACHE_SCHEMA,
        output: OUTPUT_SCHEMA,
        ...targetSchema(),
      },
      required: ["source"],
    },
    async execute(input, context) {
      const source = asRecord(input["source"], "source")
      const path = source["path"]
      if (typeof path !== "string" || path.length === 0) {
        throw new Error("source.path must be a non-empty string")
      }
      const format = resolveFormat(source["format"], path)

      const sample = asInteger(source["sample"])
      if (sample !== undefined) {
        const records = await deps.bulk.sample({ path, format, limit: sample })
        return { content: JSON.stringify({ path, format, sampled: records.length, records }) }
      }

      const project = parseProject(input["project"])
      if (project !== undefined && input["state"] !== undefined) {
        throw new Error("state and project are mutually exclusive — pass one")
      }
      if (input["state"] === undefined && project === undefined) {
        throw new Error("state or project is required")
      }
      const questions = parseQuestions(input["questions"])
      const policy = input["policy"] === undefined ? undefined : parsePolicySpec(input["policy"])
      const preview = parsePreview(input["preview"])
      const cache = parseCache(input["cache"])
      // Validate the destination BEFORE spending provider calls on the run.
      const output = parseOutput(input["output"])
      const { provider, model } = resolveTarget(deps, input)
      const concurrency = typeof input["concurrency"] === "number" ? input["concurrency"] : 4
      const state = input["state"]

      await reportProgress(context, "decision_map: starting run")
      const outcome = await deps.bulk.map({
        path,
        format,
        state,
        project,
        questions,
        policy,
        provider,
        model,
        concurrency,
        preview,
        cache,
        onProgress: (done, total) => {
          void reportProgress(context, `decision_map: judged ${done}/${total}`)
        },
        offset: asInteger(source["offset"]),
        limit: asInteger(source["limit"]),
        signal: context.signal,
      })
      const response: Record<string, unknown> = {
        run: outcome.summary.id,
        summary: outcome.summary,
        ...(outcome.preview.length > 0 ? { preview: outcome.preview } : {}),
      }
      if (outcome.aborted !== null) {
        response["aborted"] = outcome.aborted
      }
      if (output !== undefined) {
        response["export"] = await deps.exporter.export({ run: outcome.summary.id, path: output.path, format: output.format })
      }
      const warnings: string[] = []
      if (outcome.aborted !== null) {
        warnings.push(
          `Systematic failure: ${outcome.aborted.error} hit ${SYSTEMATIC_ABORT_AFTER} records; ${outcome.aborted.skipped} remaining records were skipped without provider calls. Fix the questions/input and re-run — identical inputs hit the cache.`,
        )
      } else if (outcome.summary.total > 0 && outcome.summary.error / outcome.summary.total >= 0.5) {
        warnings.push(
          `High error rate (${outcome.summary.error}/${outcome.summary.total}); inspect with decision_results {run, status: "error"}.`,
        )
      }
      warnings.push(...polarityWarnings(questions, policy))
      if (warnings.length > 0) response["warnings"] = warnings
      return { content: JSON.stringify(response) }
    },
  }
}

function decisionResultsTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "decision_results",
    description:
      "Inspect decision_map runs. Omit `run` (or set list:true) to list recent runs; otherwise fetch filtered, paginated records (status ok/error, verdict PASS/REVIEW/FAIL). detail \"compact\" keeps decisions only; \"full\" adds distributions, usage, errors verbatim, and the record's own fields (snapshot taken at run time) so failing records can be reported without re-reading the source file. Each row's `key` echoes the source record's id/key/_id field (null when absent) and `index` is its 0-based position in the source — ids are not row numbers. Pass `policy` to re-derive verdicts from the stored answers under a different policy — policy iteration without re-running the provider; the verdict filter then applies to the re-derived verdicts (the stored summary still reflects the original run). Raw answers are the stable artifact. Set `output` to write the full filtered result set to a file and get back {path, records, bytes, sha256} only — the token-cheap way to hand results to code, and the checksum lets you prove a derived file matches the run.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string", description: "Run id returned by decision_map" },
        list: { type: "boolean", description: "List recent runs instead of querying one" },
        status: { type: "string", enum: ["ok", "error"] },
        verdict: { type: "string", enum: ["PASS", "REVIEW", "FAIL"] },
        policy: {
          ...POLICY_SCHEMA,
          description:
            "Re-derive verdicts from the stored answers under this policy instead of the run-time one. Iterate on thresholds without spending provider calls; the verdict filter applies to the re-derived verdicts.",
        },
        detail: { type: "string", enum: ["compact", "full"] },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 20" },
        output: OUTPUT_SCHEMA,
      },
    },
    async execute(input) {
      if (input["list"] === true || typeof input["run"] !== "string") {
        return { content: JSON.stringify({ runs: await deps.results.listRuns(10) }) }
      }
      const run = input["run"]
      const status = input["status"]
      if (status !== undefined && status !== "ok" && status !== "error") {
        throw new Error('status must be "ok" or "error"')
      }
      const verdict = input["verdict"]
      if (verdict !== undefined && verdict !== "PASS" && verdict !== "REVIEW" && verdict !== "FAIL") {
        throw new Error('verdict must be "PASS", "REVIEW" or "FAIL"')
      }
      const policy = input["policy"] === undefined ? undefined : parsePolicySpec(input["policy"])
      const output = parseOutput(input["output"])
      if (output !== undefined) {
        const meta = await deps.exporter.export({ run, path: output.path, format: output.format, status, verdict, policy })
        return { content: JSON.stringify({ export: meta }) }
      }
      const page = await deps.results.query({
        run,
        status,
        verdict,
        policy,
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

function resolveFormat(value: unknown, path: string, label: "source" | "output" = "source"): "csv" | "jsonl" {
  if (value === "csv" || value === "jsonl") return value
  const inferred = formatFromPath(path)
  if (inferred !== null) return inferred
  throw new Error(`cannot infer ${label} format for ${path}; pass ${label}.format`)
}

function parseOutput(value: unknown): { path: string; format: "csv" | "jsonl" } | undefined {
  if (value === undefined) return undefined
  const output = asRecord(value, "output")
  const path = output["path"]
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("output.path must be a non-empty string")
  }
  return { path, format: resolveFormat(output["format"], path, "output") }
}

function parseProject(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("project must be a non-empty array of field names")
  }
  return value.map((name, i) => {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`project[${i}] must be a non-empty string`)
    }
    return name
  })
}

/** false → 0 (no preview), true → default size, integer → clamped count. */
function parsePreview(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "boolean") return value ? PREVIEW_SIZE : 0
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_PREVIEW_SIZE) {
    return value
  }
  throw new Error(`preview must be a boolean or an integer between 0 and ${MAX_PREVIEW_SIZE}`)
}

function parseCache(value: unknown): "bypass" | undefined {
  if (value === undefined) return undefined
  if (value === "bypass") return "bypass"
  throw new Error('cache must be "bypass"')
}

/**
 * Deterministic polarity guardrail: noul questions under the DEFAULT policy
 * escalate toward FAIL with pTrue — agents that phrase TRUE=good silently
 * invert their verdicts. Without an explicit policy, say so in the response.
 */
function polarityWarnings(questions: readonly Question[], policy: PolicySpec | undefined): string[] {
  if (policy !== undefined || !questions.some((q) => q.type === "noul")) return []
  return [
    "noul verdicts use the default policy (reviewAt 0.6, failAt 0.85) with TRUE=bad polarity: higher p(True) escalates toward FAIL. If these questions are phrased TRUE=good, the verdict labels are inverted — rephrase the questions or pass an explicit policy.",
  ]
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
export function compactAnswers(answers: Record<string, Answer>) {
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
