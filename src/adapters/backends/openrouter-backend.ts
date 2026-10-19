import { OpenRouter } from "@openrouter/sdk"
import type { Question, Usage } from "../../domain/decision-types"
import { BackendError, type BackendRequest, type BackendResponse, type DecisionBackend } from "../../ports/decision-backend"
import { asNumber, asRecord, asString, toBackendError, withSignal } from "./normalize"
import { normalizeAnswers as normalizeProviderAnswers } from "./answers"
const APP_TITLE = "opencode-decision-mode"

/**
 * OpenRouter Decisions API backend (`POST /api/alpha/decisions`).
 * Jev via OpenRouter; usage.cost is provider-reported when present.
 */
export class OpenRouterBackend implements DecisionBackend {
  readonly provider = "openrouter" as const
  private readonly client: OpenRouter

  constructor(apiKey: string) {
    this.client = new OpenRouter({ apiKey, appTitle: APP_TITLE })
  }

  async decide(request: BackendRequest): Promise<BackendResponse> {
    const questions: Record<string, unknown> = {}
    for (const question of request.questions) {
      questions[question.id] = toOpenRouterQuestion(question)
    }

    let raw: unknown
    try {
      const response = await withSignal(
        this.client.alpha.decisions.create({
          decisionsRequest: {
            model: request.model,
            state: request.state,
            // Structurally identical to the SDK's question map; cast decouples
            // us from SDK type drift.
            questions: questions as never,
          },
        }),
        request.signal,
      )
      raw = response
    } catch (error) {
      throw toBackendError(error, "openrouter")
    }

    const body = asRecord(raw)
    if (body === null) throw new BackendError("openrouter: response was not an object")

    const answers = normalizeProviderAnswers(body["answers"], request.questions, "openrouter")
    const usage = normalizeUsage(body["usage"])
    const resolvedModel = asString(body["model"]) ?? request.model
    return { provider: this.provider, requestedModel: request.model, resolvedModel, answers, usage }
  }
}

function toOpenRouterQuestion(question: Question): unknown {
  if (question.type === "noul") {
    return question.criteria === undefined
      ? { type: "noul", instructions: question.instructions }
      : { type: "noul", instructions: question.instructions, criteria: question.criteria }
  }
  return { type: question.type, instructions: question.instructions, criteria: question.criteria }
}

export function normalizeUsage(raw: unknown): Usage {
  const record = asRecord(raw)
  const inputTokens = record === null ? null : asNumber(record["input_tokens"])
  const outputTokens = record === null ? null : asNumber(record["output_tokens"])
  const cost = record === null ? null : asNumber(record["cost"])
  return {
    inputTokens: inputTokens === null ? null : Math.max(0, Math.round(inputTokens)),
    outputTokens: outputTokens === null ? null : Math.max(0, Math.round(outputTokens)),
    costUsd: cost,
    costSource: cost === null ? null : "provider",
  }
}
