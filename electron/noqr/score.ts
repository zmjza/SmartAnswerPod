import type { NoqrScoreRecord } from './types.ts'

type ScoreCandidate = Partial<NoqrScoreRecord> & {
  score?: unknown
  isMarked?: unknown
  status?: unknown
  finishedTime?: unknown
}

const INVALID_STATUS = /未完成|未提交|草稿|续做|unfinished|draft|continue/i

export function parseNoqrTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .trim()
    .replace(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/, '$1-$2-$3')
    .replace(/\s+/g, ' ')
  if (!/^\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/.test(normalized)) return null
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function validScore(value: unknown): value is number {
  if (value == null || value === '') return false
  const score = Number(value)
  return Number.isFinite(score) && score >= 0
}

function validRecord(value: unknown): value is NoqrScoreRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as ScoreCandidate
  if (!validScore(record.score)) return false
  const marked = record.isMarked as unknown
  if (!(marked === true || marked === 1 || marked === '1' || marked === 'true')) return false
  if (typeof record.status === 'string' && INVALID_STATUS.test(record.status)) return false
  return parseNoqrTimestamp(record.finishedTime) !== null
}

/**
 * History DOM/API order is not chronological. Exclude unfinished and
 * ungraded records, then compare parsed completion times.
 */
export function newestNoqrScoreRecord(records: readonly unknown[]): NoqrScoreRecord | null {
  const valid: Array<{ record: NoqrScoreRecord; time: number; token: string }> = []
  let newestTime = Number.NEGATIVE_INFINITY
  for (const candidate of records) {
    if (!validRecord(candidate)) continue
    const record = candidate as ScoreCandidate
    const time = parseNoqrTimestamp(record.finishedTime)
    if (time == null) continue
    const raw = candidate as Record<string, unknown>
    const normalized = {
        finishedTime: String(record.finishedTime),
        score: Number(record.score),
        isMarked: true,
        status: typeof record.status === 'string' ? record.status : '',
        useTime: record.useTime as string | number | undefined,
        paperId: typeof record.paperId === 'string' ? record.paperId : undefined,
        remark: typeof record.remark === 'string' ? record.remark : undefined,
        homeWorkUniqueFlag: typeof raw.homeWorkUniqueFlag === 'string' ? raw.homeWorkUniqueFlag : undefined,
        paperStructUniqueFlag: typeof raw.paperStructUniqueFlag === 'string' ? raw.paperStructUniqueFlag : undefined,
    }
    const token = [
      normalized.score,
      normalized.paperId || '',
      typeof raw.homeWorkUniqueFlag === 'string' ? raw.homeWorkUniqueFlag : '',
    ].join('|')
    valid.push({ record: normalized, time, token })
    newestTime = Math.max(newestTime, time)
  }
  if (!valid.length) return null
  const latest = valid.filter((item) => item.time === newestTime)
  if (new Set(latest.map((item) => item.token)).size > 1) return null
  return latest[0].record
}
