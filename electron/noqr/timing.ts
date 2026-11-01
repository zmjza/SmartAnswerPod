export type NoqrTimingAccumulator = {
  answeredQuestionCount: number
  answeringDurationMs: number
  maxQuestionDurationMs: number
}

export type NoqrHomeworkTiming = {
  noqrAnsweredQuestionCount: number
  noqrAverageQuestionDurationMs: number
  noqrMaxQuestionDurationMs: number
  noqrTotalDurationMs: number
}

export const NOQR_MIN_MS_PER_SAVED_QUESTION = 3_000

export function noqrPacingDelayMs(
  elapsedMs: number,
  questionCount: number,
  minimumMsPerQuestion = NOQR_MIN_MS_PER_SAVED_QUESTION,
): number {
  const elapsed = Math.max(0, Math.trunc(Number(elapsedMs) || 0))
  const count = Math.max(1, Math.trunc(Number(questionCount) || 0))
  const minimum = Math.max(0, Math.trunc(Number(minimumMsPerQuestion) || 0))
  return Math.max(0, count * minimum - elapsed)
}

export function createNoqrTimingAccumulator(): NoqrTimingAccumulator {
  return {
    answeredQuestionCount: 0,
    answeringDurationMs: 0,
    maxQuestionDurationMs: 0,
  }
}

export function recordNoqrGroupTiming(
  timing: NoqrTimingAccumulator,
  durationMs: number,
  questionCount: number,
): void {
  const duration = Math.max(0, Math.trunc(Number(durationMs) || 0))
  const count = Math.max(0, Math.trunc(Number(questionCount) || 0))
  if (!duration || !count) return
  timing.answeredQuestionCount += count
  timing.answeringDurationMs += duration
  timing.maxQuestionDurationMs = Math.max(
    timing.maxQuestionDurationMs,
    duration / count,
  )
}

export function snapshotNoqrTiming(
  timing: NoqrTimingAccumulator,
  totalDurationMs: number,
): NoqrHomeworkTiming {
  return {
    noqrAnsweredQuestionCount: timing.answeredQuestionCount,
    noqrAverageQuestionDurationMs: timing.answeredQuestionCount
      ? timing.answeringDurationMs / timing.answeredQuestionCount
      : 0,
    noqrMaxQuestionDurationMs: timing.maxQuestionDurationMs,
    noqrTotalDurationMs: Math.max(0, Math.trunc(Number(totalDurationMs) || 0)),
  }
}
