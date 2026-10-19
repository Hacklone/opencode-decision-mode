import { TypeSafeClient } from "@typesafe-ai/sdk"
import type { Answer, Usage } from "../../domain/decision-types"
import { ESTIMATED_PRICING, estimateCost } from "../../domain/usage"
import { BackendError, type BackendRequest, type BackendResponse, type DecisionBackend } from "../../ports/decision-backend"
import { asNumber, asRecord, asString, toBackendError, withSignal } from "./normalize"
import { normalizeAnswers } from "./openrouter-backend"

/**
 * TypeSafe direct backend (`POST https://api.typesafe.ai/v1/systemone`).
 * Output tokens are free; input cost is estimated at $42 / 1B tokens.
 */
export class TypesafeBackend implements DecisionBackend {
  readonly provider = "typesafe" as const
  private readonly client: TypeSafeClient

  constructor(apiKey: string, options?: { compression?: boolean }) {
    this.client = new TypeSafeClient({
      apiKey,
      ...(options?.compression === false ? { compression: false } : {}),
    })
  }

  async decide(request: BackendRequest): Promise<BackendResponse> {
    const questions: Record<string, unknown> = {}
    for (const question of request.questions) {
      // The TypeSafe System One wire shape matches the plugin's question shape.
      questions[question.id] = question
    }

    let raw: unknown
    try {
      const response = await withSignal(
        this.client.systemOne({
          state: request.state as never,
          // Structurally identical to the SDK's question map; cast keeps us
          // decoupled from SDK type drift.
          questions: questions as never,
          model: request.model,
        }),
        request.signal,
      )
      raw = response
    } catch (error) {
      throw toBackendError(error, "typesafe")
    }

    const body = asRecord(raw)
    if (body === null) throw new BackendError("typesafe: response was not an object")

    const answers = normalizeAnswers(body["answers"], request.questions)
    const usage = estimateTypesafeUsage(body["usage"])
    const resolvedModel = asString(body["model"]) ?? request.model
    return { provider: this.provider, requestedModel: request.model, resolvedModel, answers, usage }
  }
}

export function estimateTypesafeUsage(raw: unknown): Usage {
  const record = asRecord(raw)
  const inputTokens = record === null ? null : asNumber(record["input_tokens"])
  const outputTokens = record === null ? null : asNumber(record["output_tokens"])
  const input = inputTokens === null ? null : Math.max(0, Math.round(inputTokens))
  const output = outputTokens === null ? null : Math.max(0, Math.round(outputTokens))
  const cost = estimateCost(input, ESTIMATED_PRICING.typesafe)
  return { inputTokens: input, outputTokens: output, costUsd: cost, costSource: cost === null ? null : "estimated" }
}
