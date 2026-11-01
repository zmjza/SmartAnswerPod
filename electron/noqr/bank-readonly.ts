import type { QType } from '../core/hash.ts'

export type ReadOnlyBankRow = {
  id: string
  qtype: QType
  stem: string
  options: string[]
  answer_texts: string[]
  course_names: string[]
  updated_at?: string
}

export type ReadOnlyBankResult =
  | { ok: true; row: ReadOnlyBankRow | null }
  | { ok: false; error: string }

type BankSettings = {
  supabase_url: string
  supabase_anon: string
}

type ReadOnlyBankDeps = {
  settings?: () => BankSettings
  fetchImpl?: typeof fetch
}

const SELECT = 'id,qtype,stem,options,answer_texts,course_names,updated_at'

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
      !row.stem.trim() || !row.options.length || !row.answer_texts.length) {
    return null
  }
  return {
    id: row.id,
    qtype: row.qtype,
    stem: row.stem,
    options: row.options,
    answer_texts: row.answer_texts,
    course_names: row.course_names,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
  }
}

function endpoint(base: string, hash: string): string {
  const root = base.replace(/\/+$/, '')
  const params = new URLSearchParams({
    select: SELECT,
    content_hash: `eq.${hash}`,
    limit: '1',
  })
  return `${root}/rest/v1/questions?${params.toString()}`
}

export class ReadOnlyBankClient {
  private readonly readSettings?: () => BankSettings
  private readonly fetchImpl: typeof fetch

  constructor(deps: ReadOnlyBankDeps = {}) {
    this.readSettings = deps.settings
    this.fetchImpl = deps.fetchImpl || fetch
  }

  async getByHash(hash: string): Promise<ReadOnlyBankResult> {
    if (!/^[a-f0-9]{64}$/i.test(hash)) return { ok: false, error: '题库读取身份无效' }
    let settings: BankSettings
    try {
      settings = this.readSettings
        ? this.readSettings()
        : (await import('../store.ts')).getSettings()
    } catch {
      return { ok: false, error: '题库配置读取失败' }
    }
    if (!settings.supabase_url || !settings.supabase_anon) return { ok: false, error: '题库未配置' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await this.fetchImpl(endpoint(settings.supabase_url, hash), {
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
      if (payload.length === 0) return { ok: true, row: null }
      if (payload.length !== 1) return { ok: false, error: '题库读取结果不唯一' }
      const row = parseRow(payload[0])
      return row ? { ok: true, row } : { ok: false, error: '题库返回字段缺失或损坏' }
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? '题库读取超时' : '题库网络读取失败'
      return { ok: false, error: reason }
    } finally {
      clearTimeout(timer)
    }
  }
}

export function createReadOnlyBankClient(deps: ReadOnlyBankDeps = {}): ReadOnlyBankClient {
  return new ReadOnlyBankClient(deps)
}
