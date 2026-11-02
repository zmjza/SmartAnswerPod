export type NoqrHomeworkFailureStatus = 'score_unavailable'

const NOQR_FATAL_SESSION_CODES = new Set([
  'auth_blocked',
  'login_failed',
  'credentials_missing',
  'stopped',
  'blank_page',
  'page_error',
  'answer_interrupted',
  'submitted_uncertain',
])

export class NoqrScoreUnavailableError extends Error {
  readonly code = 'score_unavailable'
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'NoqrScoreUnavailableError'
    this.cause = cause
  }
}

export function noqrHomeworkFailureStatus(error: unknown): NoqrHomeworkFailureStatus | null {
  if (error instanceof NoqrScoreUnavailableError) return 'score_unavailable'
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'score_unavailable'
  ) {
    return 'score_unavailable'
  }
  return null
}

export function isNoqrFatalWorkflowError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return NOQR_FATAL_SESSION_CODES.has(String((error as { code?: unknown }).code || ''))
}

export function shouldDegradeNoqrBaselineFailure(error: unknown): boolean {
  return !isNoqrFatalWorkflowError(error)
}
