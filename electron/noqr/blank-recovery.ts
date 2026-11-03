// Non-answer pages may be refreshed after one minute of quiet blank state.
// In-flight business requests still block recovery, so a known slow response
// is never cancelled by this threshold.
export const NOQR_BLANK_GRACE_MS = 60_000
// Non-answer recovery rule: 60s quiet -> refresh; repeated short activity or
// a stalled business request gets a bounded 90s/120s ceiling. Answer pages do
// not use this as a refresh policy; their separate 240s limits only allow a
// safe stop and never reload an in-progress page.
export const NOQR_BLANK_MAX_HEARTBEAT_WAIT_MS = 90_000
export const NOQR_BLANK_MAX_ACTIVE_WAIT_MS = 120_000
export const NOQR_BLANK_REFRESH_BUDGET = 3

export type NoqrBlankRecoveryAction = 'ready' | 'wait' | 'refresh' | 'stop'

export type NoqrBlankObservation = {
  now: number
  activityVersion: number
  empty: boolean
  active: boolean
  ready?: boolean
  stopRequested?: boolean
}

export type NoqrBlankDecision = {
  action: NoqrBlankRecoveryAction
  quietForMs: number
  refreshAttempts: number
}

type NoqrBlankRecoveryGateOptions = {
  graceMs?: number
  refreshBudget?: number
  maxHeartbeatWaitMs?: number
  maxActiveWaitMs?: number
}

/**
 * Recover non-answer pages only after a quiet, no-progress period. Request
 * activity and business progress advance the version and restart the grace.
 */
export class NoqrBlankRecoveryGate {
  readonly graceMs: number
  readonly refreshBudget: number
  readonly maxHeartbeatWaitMs: number
  readonly maxActiveWaitMs: number
  private quietSince: number | null = null
  private emptySince: number | null = null
  private activeSince: number | null = null
  private lastActivityVersion = Number.NaN
  private wasActive = false
  private refreshAttempts = 0

  constructor(opts: NoqrBlankRecoveryGateOptions = {}) {
    this.graceMs = Math.max(0, Number(opts.graceMs ?? NOQR_BLANK_GRACE_MS) || 0)
    this.maxHeartbeatWaitMs = Math.max(
      this.graceMs,
      Number(opts.maxHeartbeatWaitMs ?? NOQR_BLANK_MAX_HEARTBEAT_WAIT_MS) || 0,
    )
    this.maxActiveWaitMs = Math.max(
      this.graceMs,
      Number(opts.maxActiveWaitMs ?? NOQR_BLANK_MAX_ACTIVE_WAIT_MS) || 0,
    )
    this.refreshBudget = Math.max(
      0,
      Math.floor(Number(opts.refreshBudget ?? NOQR_BLANK_REFRESH_BUDGET) || 0),
    )
  }

  observe(input: NoqrBlankObservation): NoqrBlankDecision {
    if (input.stopRequested) {
      this.quietSince = null
      this.emptySince = null
      this.activeSince = null
      this.wasActive = false
      return {
        action: 'stop',
        quietForMs: 0,
        refreshAttempts: this.refreshAttempts,
      }
    }
    if (input.ready || !input.empty) {
      this.quietSince = null
      this.emptySince = null
      this.activeSince = null
      this.lastActivityVersion = input.activityVersion
      this.wasActive = false
      return {
        action: input.ready ? 'ready' : 'wait',
        quietForMs: 0,
        refreshAttempts: this.refreshAttempts,
      }
    }

    this.emptySince ??= input.now
    const activeEnded = this.wasActive && !input.active
    if (input.active && !this.wasActive) this.activeSince = input.now
    if (!input.active) this.activeSince = null
    const activeTooLong = input.active &&
      this.activeSince !== null &&
      input.now - this.activeSince >= this.maxActiveWaitMs
    this.wasActive = input.active
    if (activeEnded) {
      // A slow request may finish after the heartbeat ceiling. Start the full
      // quiet grace from completion so the response can render before reload.
      this.quietSince = input.now
      this.lastActivityVersion = input.activityVersion
      return {
        action: 'wait',
        quietForMs: 0,
        refreshAttempts: this.refreshAttempts,
      }
    }
    const heartbeatTooLong = input.now - this.emptySince >= this.maxHeartbeatWaitMs
    if (activeTooLong) {
      this.quietSince = this.emptySince
      this.lastActivityVersion = input.activityVersion
    }
    if (heartbeatTooLong && !input.active && input.activityVersion !== this.lastActivityVersion) {
      // Once repeated short activity has exceeded the safety ceiling, measure
      // quiet time from the original empty-page observation. A genuinely
      // active request still takes the branch below and keeps waiting.
      this.quietSince = this.emptySince
      this.lastActivityVersion = input.activityVersion
    }
    if (
      (input.active && !activeTooLong) ||
      this.quietSince === null ||
      (!activeTooLong && input.activityVersion !== this.lastActivityVersion && !heartbeatTooLong)
    ) {
      this.quietSince = input.now
      this.lastActivityVersion = input.activityVersion
      if (input.active && !activeTooLong) {
        return {
          action: 'wait',
          quietForMs: 0,
          refreshAttempts: this.refreshAttempts,
        }
      }
    }

    const quietForMs = Math.max(0, input.now - this.quietSince)
    if (quietForMs < this.graceMs) {
      return {
        action: 'wait',
        quietForMs,
        refreshAttempts: this.refreshAttempts,
      }
    }
    if (this.refreshAttempts >= this.refreshBudget) {
      return {
        action: 'stop',
        quietForMs,
        refreshAttempts: this.refreshAttempts,
      }
    }

    this.refreshAttempts++
    this.quietSince = input.now
    this.lastActivityVersion = input.activityVersion
    return {
      action: 'refresh',
      quietForMs,
      refreshAttempts: this.refreshAttempts,
    }
  }
}
