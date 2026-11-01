export const WORK_MODE_ORDER = ['answer', 'extract', 'noqr'] as const

export type WorkMode = (typeof WORK_MODE_ORDER)[number]
export type LegacyWorkMode = 'answer' | 'extract'

export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === 'string' && (WORK_MODE_ORDER as readonly string[]).includes(value)
}

/**
 * Persisted accounts created before T005 have no work_mode. Unknown values
 * must stay on the legacy answer path rather than reaching a runner branch.
 */
export function normalizeWorkMode(value: unknown): WorkMode {
  return isWorkMode(value) ? value : 'answer'
}

export function normalizeLegacyWorkMode(value: unknown): LegacyWorkMode | null {
  return value === 'answer' || value === 'extract' ? value : null
}
