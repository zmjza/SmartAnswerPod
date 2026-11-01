import { NOQR_PHASES, type NoqrPhase, type NoqrViewSnapshot } from './types.ts'

type SnapshotInput = Record<string, unknown> | null | undefined

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function positiveOrNull(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null
}

export function isNoqrPhase(value: unknown): value is NoqrPhase {
  return typeof value === 'string' && (NOQR_PHASES as readonly string[]).includes(value)
}

/**
 * Keep the noqr view deliberately separate from legacy verification, QR and
 * extraction state. Unknown input keys are ignored rather than copied.
 */
export function buildNoqrSnapshot(input: SnapshotInput): NoqrViewSnapshot {
  const source = input && typeof input === 'object' ? input : {}
  return {
    mode: 'noqr',
    localId: text(source.localId),
    running: source.running === true,
    phase: isNoqrPhase(source.phase) ? source.phase : 'idle',
    courseName: text(source.courseName),
    homeworkName: text(source.homeworkName),
    questionNo: positiveOrNull(source.questionNo),
    questionTotal: positiveOrNull(source.questionTotal),
    bankCount: count(source.bankCount),
    aiCount: count(source.aiCount),
    attempt: count(source.attempt),
  }
}
