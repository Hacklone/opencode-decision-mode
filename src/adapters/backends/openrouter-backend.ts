import { OpenRouter } from "@openrouter/sdk"
import type { Answer, Question, Usage } from "../../domain/decision-types"
import { BackendError, type BackendRequest, type BackendResponse, type DecisionBackend } from "../../ports/decision-backend"
import { asNumber, asRecord, asString, clamp01, scoreIndex, toBackendError, withSignal } from "./normalize"

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

    const answers = normalizeAnswers(body["answers"], request.questions)
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

export function normalizeAnswers(raw: unknown, questions: readonly Question[]): Record<string, Answer> {
  const map = asRecord(raw)
  if (map === null) throw new BackendError("openrouter: response.answers was not an object")

  const answers: Record<string, Answer> = {}
  for (const question of questions) {
    const rawAnswer = map[question.id]
    const record = asRecord(rawAnswer)
    if (record === null) {
      throw new BackendError(`openrouter: missing answer for question ${JSON.stringify(question.id)}`)
    }
    answers[question.id] = normalizeAnswer(record, question)
  }
  return answers
}

export function normalizeAnswer(record: Record<string, unknown>, question: Question): Answer {
  const type = asString(record["type"])
  if (type === "noul") {
    const pTrue = asNumber(record["noul"])
    if (pTrue === null) throw new BackendError("openrouter: noul answer missing probability")
    return { type: "noul", pTrue: clamp01(pTrue) }
  }
  if (type === "choice") {
    const choice = asString(record["choice"])
    if (choice === null) throw new BackendError("openrouter: choice answer missing selection")
    const answer: Answer = {
      type: "choice",
      choice,
      probabilities: normalizeProbabilityMap(record["probabilities"]),
    }
    const confidence = asNumber(record["confidence"])
    if (confidence !== null) return { ...answer, confidence: clamp01(confidence) }
    return answer
  }
  if (type === "score") {
    if (question.type !== "score") {
      throw new BackendError(`openrouter: score answer for ${question.type} question ${question.id}`)
    }
    const score = scoreIndex(record["score"], question.criteria)
    const legend = asString(record["legend"])
    const answer: Answer = {
      type: "score",
      score,
      // scoreIndex guarantees a valid index, so criteria[score] is always defined.
      legend: legend ?? question.criteria[score]!,
      probabilities: normalizeProbabilityMap(record["probabilities"]),
    }
    const confidence = asNumber(record["confidence"])
    if (confidence !== null) return { ...answer, confidence: clamp01(confidence) }
    return answer
  }
  throw new BackendError(`openrouter: unrecognized answer type ${JSON.stringify(type)}`)
}

export function normalizeProbabilityMap(raw: unknown): Record<string, number> {
  const map = asRecord(raw)
  if (map === null) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(map)) {
    const n = asNumber(value)
    if (n !== null) out[key] = n
  }
  return out
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
