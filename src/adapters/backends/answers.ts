import type { Answer, Question } from "../../domain/decision-types"
import { BackendError } from "../../ports/decision-backend"
import { asNumber, asRecord, asString, clamp01, scoreIndex } from "./normalize"

/**
 * Shared answer normalization for the OpenRouter and TypeSafe backends, whose
 * wire shapes are identical: `{type:"noul", noul}`, `{type:"choice", ...}`,
 * `{type:"score", ...}` keyed by question id.
 */
export function normalizeAnswers(
  raw: unknown,
  questions: readonly Question[],
  provider: string,
): Record<string, Answer> {
  const map = asRecord(raw)
  if (map === null) throw new BackendError(`${provider}: response.answers was not an object`)

  const answers: Record<string, Answer> = {}
  for (const question of questions) {
    const rawAnswer = map[question.id]
    const record = asRecord(rawAnswer)
    if (record === null) {
      throw new BackendError(`${provider}: missing answer for question ${JSON.stringify(question.id)}`)
    }
    answers[question.id] = normalizeAnswer(record, question, provider)
  }
  return answers
}

export function normalizeAnswer(record: Record<string, unknown>, question: Question, provider: string): Answer {
  const type = asString(record["type"])
  if (type === "noul") {
    const pTrue = asNumber(record["noul"])
    if (pTrue === null) throw new BackendError(`${provider}: noul answer missing probability`)
    return { type: "noul", pTrue: clamp01(pTrue) }
  }
  if (type === "choice") {
    const choice = asString(record["choice"])
    if (choice === null) throw new BackendError(`${provider}: choice answer missing selection`)
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
      throw new BackendError(`${provider}: score answer for ${question.type} question ${question.id}`)
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
  throw new BackendError(`${provider}: unrecognized answer type ${JSON.stringify(type)}`)
}

/** Keep only numeric entries; distributions tolerate partial provider output. */
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
