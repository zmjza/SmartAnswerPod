import { contentHash, type QType } from '../core/hash.ts'

export type ReadOnlyBankRow = {
  id: string
  qtype: QType
  stem: string
  options: string[]
  answer_texts: string[]
  course_names: string[]
  conflict: boolean
  updated_at?: string
  content_hash?: string
}

export type ReadOnlyBankResult =
  | { ok: true; row: ReadOnlyBankRow | null }
  | { ok: false; error: string }

export type ReadOnlyBankBatchResult =
  | { ok: true; rows: ReadOnlyBankRow[]; conflicts: number }
  | { ok: false; error: string }

export type ReadOnlyBankQueryStats = {
  requests: number
  hashLookups: number
  cacheHits: number
  hitHashes: number
  missHashes: number
  conflictHashes: number
  budgetExceeded: number
}

export const NOQR_BANK_REQUEST_BUDGET = 60

type BankSettings = {
  supabase_url: string
  supabase_anon: string
}

type ReadOnlyBankDeps = {
  settings?: () => BankSettings
  fetchImpl?: typeof fetch
  maxRequests?: number
}

const SELECT = 'id,qtype,stem,options,answer_texts,course_names,conflict,updated_at,content_hash'

function isQuestionType(value: unknown): value is QType {
  return value === 'single' || value === 'multiple' || value === 'judge'
}

function textArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseRow(value: unknown): ReadOnlyBankRow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !isQuestionType(row.qtype) || typeof row.stem !== 'string' ||
      !textArray(row.options) || !textArray(row.answer_texts) || !textArray(row.course_names) ||
      typeof row.conflict !== 'boolean' || !row.stem.trim() || !row.options.length || !row.answer_texts.length) {
    return null
  }
  return {
    id: row.id,
    qtype: row.qtype,
    stem: row.stem,
    options: row.options,
    answer_texts: row.answer_texts,
    course_names: row.course_names,
    conflict: row.conflict,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
    content_hash: typeof row.content_hash === 'string' ? row.content_hash : undefined,
  }
}

function endpoint(base: string, hash: string): string {
  const root = base.replace(/\/+$/, '')
  const params = new URLSearchParams({
    select: SELECT,
    content_hash: `eq.${hash}`,
    // Fetch one extra row so an unexpected duplicate is visible to the
    // client instead of being hidden by the server-side limit.
    limit: '2',
  })
  return `${root}/rest/v1/questions?${params.toString()}`
}

function endpointForHashes(base: string, hashes: string[]): string {
  const root = base.replace(/\/+$/, '')
  const params = new URLSearchParams({
    select: SELECT,
    content_hash: `in.(${hashes.join(',')})`,
    limit: String(Math.min(100, Math.max(hashes.length + 1, hashes.length * 2))),
  })
  return `${root}/rest/v1/questions?${params.toString()}`
}

export class ReadOnlyBankClient {
  private readonly readSettings?: () => BankSettings
  private readonly fetchImpl: typeof fetch
  private readonly maxRequests: number
  private requestCount = 0
  private hashLookupCount = 0
  private cacheHitCount = 0
  private budgetExceededCount = 0
  private readonly hitHashes = new Set<string>()
  private readonly missHashes = new Set<string>()
  private readonly conflictHashes = new Set<string>()
  private readonly cache = new Map<string, { row: ReadOnlyBankRow | null; conflict: boolean }>()

  constructor(deps: ReadOnlyBankDeps = {}) {
    this.readSettings = deps.settings
    this.fetchImpl = deps.fetchImpl || fetch
    this.maxRequests = Number.isInteger(deps.maxRequests) && Number(deps.maxRequests) > 0
      ? Number(deps.maxRequests)
      : NOQR_BANK_REQUEST_BUDGET
  }

  queryStats(): ReadOnlyBankQueryStats {
    return {
      requests: this.requestCount,
      hashLookups: this.hashLookupCount,
      cacheHits: this.cacheHitCount,
      hitHashes: this.hitHashes.size,
      missHashes: this.missHashes.size,
      conflictHashes: this.conflictHashes.size,
      budgetExceeded: this.budgetExceededCount,
    }
  }

  private async settings(): Promise<BankSettings | null> {
    try {
      const value = this.readSettings
        ? this.readSettings()
        : (await import('../store.ts')).getSettings()
      return value.supabase_url && value.supabase_anon ? value : null
    } catch {
      return null
    }
  }

  private async fetchPayload(url: string, settings: BankSettings): Promise<
    { ok: true; payload: unknown[] } | { ok: false; error: string }
  > {
    this.requestCount++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: {
          apikey: settings.supabase_anon,
          Authorization: `Bearer ${settings.supabase_anon}`,
          Accept: 'application/json',
        },
      })
      if (!response.ok) return { ok: false, error: `题库读取失败（HTTP ${response.status}）` }
      const payload = await response.json()
      if (!Array.isArray(payload)) return { ok: false, error: '题库返回格式错误' }
      return { ok: true, payload }
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? '题库读取超时' : '题库网络读取失败'
      return { ok: false, error: reason }
    } finally {
      clearTimeout(timer)
    }
  }

  private consumeRequestBudget(): boolean {
    if (this.requestCount < this.maxRequests) return true
    this.budgetExceededCount++
    return false
  }

  async getByHash(hash: string): Promise<ReadOnlyBankResult> {
    if (!/^[a-f0-9]{64}$/i.test(hash)) return { ok: false, error: '题库读取身份无效' }
    this.hashLookupCount++
    const cached = this.cache.get(hash)
    if (cached) {
      this.cacheHitCount++
      return {
        ok: true,
        row: cached.conflict ? null : cached.row,
      }
    }
    if (!this.consumeRequestBudget()) return { ok: false, error: '题库查询预算已用尽' }
    const settings = await this.settings()
    if (!settings) return { ok: false, error: '题库配置读取失败或未配置' }
    const requested = await this.fetchPayload(endpoint(settings.supabase_url, hash), settings)
    if (!requested.ok) return requested
    if (requested.payload.length === 0) {
      this.cache.set(hash, { row: null, conflict: false })
      this.missHashes.add(hash)
      return { ok: true, row: null }
    }
    if (requested.payload.length !== 1) return { ok: false, error: '题库读取结果不唯一' }
    const row = parseRow(requested.payload[0])
    if (!row) return { ok: false, error: '题库返回字段缺失或损坏' }
    if (row.conflict) {
      this.cache.set(hash, { row: null, conflict: true })
      this.conflictHashes.add(hash)
      return { ok: true, row: null }
    }
    this.cache.set(hash, { row, conflict: false })
    this.hitHashes.add(hash)
    return { ok: true, row }
  }

  async getByHashes(inputHashes: string[]): Promise<ReadOnlyBankBatchResult> {
    const hashes = [...new Set(inputHashes.map((hash) => String(hash).toLowerCase()))]
    if (!hashes.length) return { ok: true, rows: [], conflicts: 0 }
    if (hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
      return { ok: false, error: '题库读取身份无效' }
    }
    this.hashLookupCount += hashes.length
    const rows: ReadOnlyBankRow[] = []
    const unknown: string[] = []
    for (const hash of hashes) {
      const cached = this.cache.get(hash)
      if (!cached) {
        unknown.push(hash)
        continue
      }
      this.cacheHitCount++
      if (!cached.conflict && cached.row) rows.push(cached.row)
    }
    if (!unknown.length) {
      return {
        ok: true,
        rows,
        conflicts: hashes.filter((hash) => this.conflictHashes.has(hash)).length,
      }
    }
    if (!this.consumeRequestBudget()) return { ok: false, error: '题库查询预算已用尽' }
    const settings = await this.settings()
    if (!settings) return { ok: false, error: '题库配置读取失败或未配置' }
    const requested = await this.fetchPayload(endpointForHashes(settings.supabase_url, unknown), settings)
    if (!requested.ok) return requested

    const unknownSet = new Set(unknown)
    const freshRows = new Map<string, ReadOnlyBankRow>()
    const freshConflicts = new Set<string>()
    for (const value of requested.payload) {
      const row = parseRow(value)
      if (!row) return { ok: false, error: '题库返回字段缺失或损坏' }
      const rowHash = (row.content_hash || contentHash(row.qtype, row.stem, row.options)).toLowerCase()
      if (!unknownSet.has(rowHash)) return { ok: false, error: '题库返回身份与请求不一致' }
      if (row.conflict) {
        freshConflicts.add(rowHash)
        continue
      }
      if (freshRows.has(rowHash)) return { ok: false, error: '题库同一身份返回多行' }
      freshRows.set(rowHash, row)
    }

    for (const hash of unknown) {
      if (freshConflicts.has(hash)) {
        this.cache.set(hash, { row: null, conflict: true })
        this.conflictHashes.add(hash)
        continue
      }
      const row = freshRows.get(hash)
      if (row) {
        this.cache.set(hash, { row, conflict: false })
        this.hitHashes.add(hash)
        rows.push(row)
      } else {
        this.cache.set(hash, { row: null, conflict: false })
        this.missHashes.add(hash)
      }
    }
    return {
      ok: true,
      rows,
      conflicts: hashes.filter((hash) => this.conflictHashes.has(hash)).length,
    }
  }
}

export function createReadOnlyBankClient(deps: ReadOnlyBankDeps = {}): ReadOnlyBankClient {
  return new ReadOnlyBankClient(deps)
}
