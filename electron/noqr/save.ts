export type NoqrSaveEvidenceInput = {
  requestObserved: boolean
  responseObserved: boolean
  responseAccepted: boolean
  pageAdvanced: boolean
  lastQuestionNotice: boolean
  stopRequested: boolean
}

export type NoqrSaveState =
  | 'waiting_request'
  | 'waiting_response'
  | 'unconfirmed_page_change'
  | 'submitted_uncertain'
  | 'failed'
  | 'awaiting_advance'
  | 'ready'

export type NoqrSaveEvidence = {
  state: NoqrSaveState
  saved: boolean
  canAdvance: boolean
}

/**
 * L1 request + L2 accepted response is a saved answer. L3 page advancement or
 * the last-question notice is additionally required before another action.
 */
export function evaluateNoqrSaveEvidence(input: NoqrSaveEvidenceInput): NoqrSaveEvidence {
  if (!input.requestObserved) {
    return input.pageAdvanced
      ? { state: 'unconfirmed_page_change', saved: false, canAdvance: false }
      : { state: 'waiting_request', saved: false, canAdvance: false }
  }
  if (input.stopRequested && (!input.responseObserved || !input.responseAccepted)) {
    return { state: 'submitted_uncertain', saved: false, canAdvance: false }
  }
  if (!input.responseObserved) {
    return { state: 'waiting_response', saved: false, canAdvance: false }
  }
  if (!input.responseAccepted) {
    return { state: 'failed', saved: false, canAdvance: false }
  }
  if (!input.pageAdvanced && !input.lastQuestionNotice) {
    return { state: 'awaiting_advance', saved: true, canAdvance: false }
  }
  return { state: 'ready', saved: true, canAdvance: true }
}

export type NoqrBusinessEnvelope = {
  success?: unknown
  result?: {
    status?: unknown
  } | null
}

export function isNoqrHttpSuccess(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300
}

export function isNoqrBusinessSuccess(payload: NoqrBusinessEnvelope | null | undefined): boolean {
  return payload?.success === true && payload.result?.status === 'success'
}

export function isNoqrRequestAccepted(status: number, payload: NoqrBusinessEnvelope | null | undefined): boolean {
  return isNoqrHttpSuccess(status) && isNoqrBusinessSuccess(payload)
}
