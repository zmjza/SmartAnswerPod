import { contentHash, mergeCourseNames, sameAnswerTexts, sameCourseNames, hasReadableQuestionText, type QType } from './core/hash'
import { removeRejectedAnswer } from './core/bank-delete'
import { getSettings, getWriteback, isReferenceHashProtected, protectReferenceHash } from './store'
import { withTimeout } from './core/timeout'
import { buildBankQuery, type BankQuery } from './core/bank-query'

export type QuestionRow = {
  id: string
  qtype: QType
  stem: string
  options: string[]
  answer_texts: string[]
  content_hash: string
  course_names: string[]
  source: string
  verified: boolean
  conflict: boolean
  updated_at: string
}

const rejectedHashes = new Set<string>()

function headers(anon: string) {
  return {
    apikey: anon,
    Authorization: 'Bearer ' + anon,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
}

function rest(url: string, path: string) {
  return url.replace(/\/$/, '') + '/rest/v1' + path
}

export async function lookupByHash(hash: string): Promise<QuestionRow | null> {
  const blocked = () => rejectedHashes.has(hash) || getWriteback().some((item) => item.need_delete_hashes.includes(hash))
  if (blocked()) return null
  try {
    const row = await readQuestion(hash)
    return blocked() || row?.conflict ? null : row
  } catch { return null }
}

// Reads used to confirm a mutation must distinguish network failure from absence.
async function readQuestion(hash: string): Promise<QuestionRow | null> {
  const { supabase_url, supabase_anon } = getSettings()
  if (!supabase_url || !supabase_anon) throw new Error('题库未配置')
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    try {
      const res = await withTimeout(fetch(rest(supabase_url, '/questions?content_hash=eq.' + encodeURIComponent(hash) + '&select=*&limit=1'), {
        headers: headers(supabase_anon),
        signal: ctrl.signal,
      }), 2000, () => ctrl.abort())
      if (!res.ok) throw new Error('题库读取失败')
      const rows = (await res.json()) as QuestionRow[]
      if (!Array.isArray(rows)) throw new Error('题库返回格式错误')
      return rows[0] || null
    } catch (error) {
      lastError = error
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      clearTimeout(t)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('题库读取失败')
}

export async function upsertQuestion(item: {
  qtype: QType
  stem: string
  options: string[]
  answer_texts: string[]
  course_name?: string
  source: 'import' | 'extract' | 'ai_verified'
  verified?: boolean
  referenceAnswer?: boolean
}, retried = false): Promise<'added' | 'updated' | 'merged' | 'conflict' | 'failed'> {
  if (!hasReadableQuestionText(item.stem, item.options) ||
      !hasReadableQuestionText(item.stem, item.answer_texts)) return 'failed'
  const { supabase_url, supabase_anon } = getSettings()
  if (!supabase_url || !supabase_anon) return 'failed'
  const hash = contentHash(item.qtype, item.stem, item.options)
  try { if (item.referenceAnswer && !protectReferenceHash(hash)) return 'failed' } catch { return 'failed' }
  let old: QuestionRow | null
  try { old = await readQuestion(hash) } catch { return 'failed' }
  const course_names = mergeCourseNames(old?.course_names, item.course_name)
  if (old) {
    const same = sameAnswerTexts(old.answer_texts, item.answer_texts, item.qtype)
    if (same && sameCourseNames(old.course_names, course_names) && !old.conflict && old.verified === (item.verified ?? item.source !== 'import')) {
      return 'merged'
    }
    if (item.referenceAnswer) {
      const ok = await patch(hash, {
        answer_texts: item.answer_texts, source: item.source, verified: true, conflict: false, course_names,
      })
      if (!ok) return 'failed'
      try {
        const confirmed = await readQuestion(hash)
        return confirmed && !confirmed.conflict && confirmed.verified &&
          sameAnswerTexts(confirmed.answer_texts, item.answer_texts, item.qtype) &&
          sameCourseNames(confirmed.course_names, course_names) ? (same ? 'merged' : 'updated') : 'failed'
      } catch { return 'failed' }
    }
    if (!same && old.verified) {
      return (await patch(hash, { course_names, conflict: true })) ? 'conflict' : 'failed'
    }
    if (item.verified && !old.verified) {
      const ok = await patch(hash, {
        answer_texts: item.answer_texts,
        source: item.source,
        verified: true,
        conflict: false,
        course_names,
      })
      return ok ? 'merged' : 'failed'
    }
    const ok = await patch(hash, { course_names })
    if (!ok) return 'failed'
    return 'merged'
  }
  try {
  const res = await fetch(rest(supabase_url, '/questions?on_conflict=content_hash'), {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { ...headers(supabase_anon), Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify({
      qtype: item.qtype,
      stem: item.stem,
      options: item.options,
      answer_texts: item.answer_texts,
      content_hash: hash,
      course_names,
      source: item.source,
      verified: item.verified ?? item.source !== 'import',
      conflict: false,
      updated_at: new Date().toISOString(),
    }),
  })
  if (!res.ok) return 'failed'
  const rows = await res.json() as QuestionRow[]
  if (!Array.isArray(rows)) return 'failed'
  if (rows.length) {
    try {
      const confirmed = await readQuestion(hash)
      return confirmed && sameAnswerTexts(confirmed.answer_texts, item.answer_texts, item.qtype) ? 'added' : 'failed'
    } catch {
      return 'failed'
    }
  }
  // Another student inserted the same hash; merge through the normal conflict rules.
  return retried ? 'failed' : upsertQuestion(item, true)
  } catch { return 'failed' }
}

async function patch(hash: string, body: Record<string, unknown>): Promise<boolean> {
  const { supabase_url, supabase_anon } = getSettings()
  try {
    const res = await fetch(rest(supabase_url, '/questions?content_hash=eq.' + encodeURIComponent(hash)), {
      method: 'PATCH',
      signal: AbortSignal.timeout(8000),
      headers: headers(supabase_anon),
      body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
    })
    if (!res.ok) return false
    const rows = await res.json() as QuestionRow[]
    return Array.isArray(rows) && rows.some((row) => row.content_hash === hash)
  } catch {
    return false
  }
}

export async function deleteByHash(hash: string, rejectedAnswers: string[]): Promise<'deleted' | 'protected' | 'failed'> {
  try { if (isReferenceHashProtected(hash)) return 'protected' } catch { return 'failed' }
  rejectedHashes.add(hash)
  const { supabase_url, supabase_anon } = getSettings()
  if (!supabase_url || !supabase_anon) return 'failed'
  const removed = await removeRejectedAnswer(rejectedAnswers, () => readQuestion(hash), async (observed) => {
  const filter = '&answer_texts=eq.' + encodeURIComponent(JSON.stringify(observed))
  const res = await fetch(rest(supabase_url, '/questions?content_hash=eq.' + encodeURIComponent(hash) + filter), {
    method: 'DELETE',
    signal: AbortSignal.timeout(8000),
    headers: headers(supabase_anon),
  })
  return res.ok
  })
  if (removed) rejectedHashes.delete(hash)
  return removed ? 'deleted' : 'failed'
}

export async function testConn(): Promise<{ ok: boolean; error?: string }> {
  const { supabase_url, supabase_anon, siliconflow_key } = getSettings()
  if (!supabase_url || !supabase_anon) return { ok: false, error: '未配置 Supabase' }
  try {
    const res = await fetch(rest(supabase_url, '/questions?select=id&limit=1'), { headers: headers(supabase_anon) })
    if (!res.ok) return { ok: false, error: '题库不可读' }
    if (!siliconflow_key) return { ok: true }
    return { ok: true }
  } catch {
    return { ok: false, error: '网络失败' }
  }
}

export async function listQuestions(query: BankQuery) {
  const { supabase_url, supabase_anon } = getSettings()
  if (!supabase_url || !supabase_anon) return { ok: false, error: '题库未配置', rows: [], total: 0, page: 1, pageSize: query.pageSize }
  const built = buildBankQuery(query)
  try {
    const res = await fetch(rest(supabase_url, built.path), {
      signal: AbortSignal.timeout(12_000),
      headers: { ...headers(supabase_anon), Prefer: 'count=exact', Range: `${built.from}-${built.to}` },
    })
    if (!res.ok) return { ok: false, error: `题库查询失败（HTTP ${res.status}）`, rows: [], total: 0, page: built.page, pageSize: built.pageSize }
    const rows = await res.json() as QuestionRow[]
    if (!Array.isArray(rows)) throw new Error('题库返回格式错误')
    const total = Number((res.headers.get('content-range') || '').split('/')[1]) || rows.length
    return { ok: true, rows, total, page: built.page, pageSize: built.pageSize }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '题库查询失败', rows: [], total: 0, page: built.page, pageSize: built.pageSize }
  }
}

export async function listQuestionCourses() {
  const { supabase_url, supabase_anon } = getSettings()
  if (!supabase_url || !supabase_anon) return { ok: false, error: '题库未配置', courses: [] as string[] }
  const courses = new Set<string>()
  try {
    for (let from = 0; ; from += 1000) {
      const res = await fetch(rest(supabase_url, '/questions?select=course_names&order=updated_at.desc'), {
        signal: AbortSignal.timeout(10_000),
        headers: { ...headers(supabase_anon), Range: `${from}-${from + 999}` },
      })
      if (!res.ok) throw new Error(`课程分类读取失败（HTTP ${res.status}）`)
      const rows = await res.json() as { course_names?: string[] }[]
      for (const row of rows) for (const name of row.course_names || []) if (name.trim()) courses.add(name.trim())
      if (rows.length < 1000) break
    }
    return { ok: true, courses: [...courses].sort((a, b) => a.localeCompare(b, 'zh-CN')) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '课程分类读取失败', courses: [] as string[] }
  }
}

export async function deleteQuestions(ids: string[]) {
  const { supabase_url, supabase_anon } = getSettings()
  const requestedIds = [...new Set(ids.filter(Boolean))]
  const deletedIds: string[] = []
  const failed: { id: string; reason: string }[] = []
  if (!supabase_url || !supabase_anon) return { requestedIds, deletedIds, failed: requestedIds.map((id) => ({ id, reason: '题库未配置' })), readbackConfirmed: false }
  for (const id of requestedIds) {
    try {
      const endpoint = rest(supabase_url, '/questions?id=eq.' + encodeURIComponent(id))
      const deleted = await withTimeout(fetch(endpoint, { method: 'DELETE', signal: AbortSignal.timeout(8000), headers: { ...headers(supabase_anon), Prefer: 'return=minimal' } }), 9000)
      if (!deleted.ok) throw new Error(`HTTP ${deleted.status}`)
      const readback = await withTimeout(fetch(endpoint + '&select=id&limit=1', { signal: AbortSignal.timeout(8000), headers: headers(supabase_anon) }), 9000)
      if (!readback.ok) throw new Error(`回读 HTTP ${readback.status}`)
      const rows = await readback.json() as { id: string }[]
      if (rows.length) throw new Error('删除后回读仍存在')
      deletedIds.push(id)
    } catch (error) {
      failed.push({ id, reason: error instanceof Error ? error.message : '删除失败' })
    }
  }
  return { requestedIds, deletedIds, failed, readbackConfirmed: failed.length === 0 }
}
