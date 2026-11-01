import type { Page, Response } from 'patchright'
import { NOQR_API, NOQR_SEL } from './selectors.ts'
import { newestNoqrScoreRecord, parseNoqrTimestamp } from './score.ts'
import type { NoqrScoreRecord } from './types.ts'
import { classifyNoqrPage, NoqrNetworkActivity, NoqrSessionError, reloadNoqrPage, sleepNoqr } from './session.ts'

export type NoqrHistoryRecord = NoqrScoreRecord & {
  homeWorkUniqueFlag?: string
  paperStructUniqueFlag?: string
}

export type NoqrHistoryReadResult = {
  ok: boolean
  records: NoqrHistoryRecord[]
  latest: NoqrHistoryRecord | null
  apiCount: number
  domCount: number
  error?: string
}

export type NoqrHistoryDomWaitResult = {
  ok: boolean
  domRecords: NoqrHistoryRecord[]
  error?: string
}

function recordArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const directKeys = ['items', 'records', 'list', 'data']
  for (const key of directKeys) {
    if (Array.isArray(root[key])) return root[key] as unknown[]
  }
  for (const key of ['result', 'response']) {
    const nested = recordArray(root[key])
    if (nested) return nested
  }
  return null
}

function parseRecord(value: unknown): NoqrHistoryRecord | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const finishedTime = String(
    row.finishedTime ??
    row.finished_time ??
    row.finishTime ??
    row.submitTime ??
    '',
  ).trim()
  if (!finishedTime || parseNoqrTimestamp(finishedTime) == null) return null
  const scoreValue = row.score ?? row.totalScore ?? row.finalScore
  if (scoreValue == null || scoreValue === '') return null
  const score = Number(scoreValue)
  if (!Number.isFinite(score) || score < 0) return null
  const markedValue = row.isMarked ?? row.marked ?? row.is_marked
  if (!(markedValue === true || markedValue === 1 || markedValue === '1' || markedValue === 'true')) return null
  const status = String(row.status ?? row.state ?? row.remark ?? '').trim()
  if (/未完成|未提交|草稿|续做|unfinished|draft|continue/i.test(status)) return null
  return {
    finishedTime,
    score,
    isMarked: true,
    status,
    useTime: typeof row.useTime === 'number' || typeof row.useTime === 'string' ? row.useTime : undefined,
    paperId: typeof row.paperId === 'string' ? row.paperId : undefined,
    remark: typeof row.remark === 'string' ? row.remark : undefined,
    homeWorkUniqueFlag: typeof row.homeWorkUniqueFlag === 'string' ? row.homeWorkUniqueFlag : undefined,
    paperStructUniqueFlag: typeof row.paperStructUniqueFlag === 'string' ? row.paperStructUniqueFlag : undefined,
  }
}

async function responsePayload(response: Response): Promise<unknown> {
  await response.finished()
  const text = await response.text().catch(() => '')
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/**
 * Wait for the already-recorded API score to appear in the DOM. The school
 * can take minutes to refresh this page, so this loop has no fixed attempt
 * limit; it only exits on a verified match, an explicit stop, or a page error.
 */
export async function waitForNoqrHistoryDomMatch(opts: {
  matches: (records: NoqrHistoryRecord[]) => boolean
  readDom: () => Promise<NoqrHistoryRecord[]>
  stopRequested: () => boolean
  sleep: () => Promise<void>
  recover?: () => Promise<void>
  onWaiting?: (elapsedMs: number) => void
}): Promise<NoqrHistoryDomWaitResult> {
  const startedAt = Date.now()
  for (;;) {
    const domRecords = await opts.readDom()
    if (opts.matches(domRecords)) return { ok: true, domRecords }
    if (opts.stopRequested()) {
      return { ok: false, domRecords, error: '任务已停止' }
    }
    opts.onWaiting?.(Date.now() - startedAt)
    await opts.recover?.()
    await opts.sleep()
  }
}

async function refreshBlankRecordPage(
  page: Page,
  network: NoqrNetworkActivity,
  attempts: { value: number; budget: number },
  stopRequested: () => boolean,
  requireRecordDom = false,
): Promise<void> {
  if (stopRequested()) throw new NoqrSessionError('stopped', '任务已停止')
  if (network.isActive()) return
  const surface = await classifyNoqrPage(page)
  if (surface === 'auth_blocked' || surface === 'login') {
    throw new NoqrSessionError('auth_blocked', '作答记录页回到登录或人工认证，已暂停当前作业')
  }
  if (surface === 'error') {
    throw new NoqrSessionError('page_error', '作答记录页显示明确错误')
  }
  if (surface === 'record') {
    const recordCount = await page.locator(NOQR_SEL.recordItem).count().catch(() => 0)
    if (recordCount > 0) return
    // The record page mounts its title before its script starts the API call.
    // Debounce blank recovery so a reload cannot cancel that in-flight request.
    await sleepNoqr(page, 300)
    if (network.isActive()) return
    const explicitEmpty = await page.evaluate((itemSelector) => {
      const items = document.querySelectorAll(itemSelector).length
      const text = document.body?.innerText || ''
      return items === 0 && /暂无|没有记录|无记录/.test(text)
    }, NOQR_SEL.recordItem).catch(() => false)
    if (!requireRecordDom && explicitEmpty) return
    if (attempts.value >= attempts.budget) {
      throw new NoqrSessionError('blank_page', '作答记录页连续刷新后仍没有记录卡')
    }
    attempts.value++
    await reloadNoqrPage(page, { stopRequested })
    return
  }
  const refreshable = surface === 'blank' || surface === 'home_blank' ||
    surface === 'unknown' || surface === 'home' || surface === 'submit_success'
  if (!refreshable) return
  if (attempts.value >= attempts.budget) {
    if (surface === 'blank') {
      throw new NoqrSessionError('blank_page', '作答记录页连续刷新后仍为空白')
    }
    return
  }
  attempts.value++
  await reloadNoqrPage(page, { stopRequested })
}

export async function readNoqrHistoryAfterOpen(opts: {
  page: Page
  workId: string
  open: () => Promise<void>
  stopRequested: () => boolean
  refreshBudget?: number
  onWaiting?: (elapsedMs: number) => void
}): Promise<NoqrHistoryReadResult> {
  let capturedUrl = ''
  let captured: Promise<{ status: number; payload: unknown | null } | null> | null = null
  const listener = (response: Response) => {
    try {
      if (response.request().method() !== 'GET') return
      const url = new URL(response.url())
      if (!url.pathname.endsWith(NOQR_API.history)) return
      capturedUrl = url.href
      if (!captured) captured = responsePayload(response).then((payload) => ({ status: response.status(), payload }))
    } catch {
      /* ignore malformed unrelated responses */
    }
  }
  opts.page.on('response', listener)
  const network = new NoqrNetworkActivity(opts.page)
  const startedAt = Date.now()
  const refreshAttempts = { value: 0, budget: Math.max(0, opts.refreshBudget ?? 3) }
  try {
    await opts.open()
    while (!captured) {
      if (opts.stopRequested()) return { ok: false, records: [], latest: null, apiCount: 0, domCount: 0, error: '任务已停止' }
      await refreshBlankRecordPage(opts.page, network, refreshAttempts, opts.stopRequested)
      if (!network.isActive()) {
        const emptyState = await opts.page.evaluate((itemSelector) => {
          const items = document.querySelectorAll(itemSelector).length
          const text = document.body?.innerText || ''
          return items === 0 && /暂无|没有记录|无记录/.test(text)
        }, NOQR_SEL.recordItem).catch(() => false)
        if (emptyState) return { ok: true, records: [], latest: null, apiCount: 0, domCount: 0 }
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(opts.page, 100)
    }
    let actualWorkId = opts.workId
    try { actualWorkId ||= new URL(opts.page.url()).searchParams.get('workId') || '' } catch { /* ignore */ }
    let capturedWorkId = ''
    try {
      const captured = new URL(capturedUrl)
      capturedWorkId = captured.searchParams.get('workId') || captured.searchParams.get('id') || ''
    } catch { /* ignore */ }
    if (actualWorkId && capturedWorkId && actualWorkId !== capturedWorkId) {
      return { ok: false, records: [], latest: null, apiCount: 0, domCount: 0, error: '作答记录接口与当前作业身份不一致' }
    }
    const responsePromise = captured as Promise<{ status: number; payload: unknown | null } | null>
    const response = await responsePromise
    if (!response || response.status < 200 || response.status >= 300) {
      return { ok: false, records: [], latest: null, apiCount: 0, domCount: 0, error: `作答记录接口失败（HTTP ${response?.status || '未知'}）` }
    }
    const apiRows = recordArray(response.payload)
    if (!apiRows) return { ok: false, records: [], latest: null, apiCount: 0, domCount: 0, error: '作答记录接口返回格式错误' }
    if (apiRows.length === 0) {
      const domRecords = await readDomRecords(opts.page)
      const emptyState = await opts.page.evaluate((itemSelector) => {
        const items = document.querySelectorAll(itemSelector).length
        const text = document.body?.innerText || ''
        return items === 0 && /暂无|没有记录|无记录/.test(text)
      }, NOQR_SEL.recordItem).catch(() => false)
      if (!domRecords.length && emptyState) return { ok: true, records: [], latest: null, apiCount: 0, domCount: 0 }
      return { ok: false, records: [], latest: null, apiCount: 0, domCount: domRecords.length, error: '作答记录接口为空但页面无明确空态' }
    }
    const apiRecords = apiRows.map(parseRecord).filter((row): row is NoqrHistoryRecord => Boolean(row))
    let domRecords = await readDomRecords(opts.page)
    const latest = newestNoqrScoreRecord(apiRecords) as NoqrHistoryRecord | null
    if (!latest) return { ok: false, records: apiRecords, latest: null, apiCount: apiRows.length, domCount: domRecords.length, error: '没有可确认的已完成有效分数' }
    const domMatches = (records: NoqrHistoryRecord[]) => records.some((row) =>
      row.score === latest.score &&
      (parseNoqrTimestamp(row.finishedTime) === parseNoqrTimestamp(latest.finishedTime) ||
        row.finishedTime.includes(latest.finishedTime) ||
        latest.finishedTime.includes(row.finishedTime)))
    const waited = await waitForNoqrHistoryDomMatch({
      matches: domMatches,
      readDom: () => readDomRecords(opts.page),
      stopRequested: opts.stopRequested,
      sleep: () => sleepNoqr(opts.page, 200),
      recover: () => refreshBlankRecordPage(opts.page, network, refreshAttempts, opts.stopRequested, true),
      onWaiting: () => opts.onWaiting?.(Date.now() - startedAt),
    })
    domRecords = waited.domRecords
    if (!waited.ok) {
      return {
        ok: false,
        records: apiRecords,
        latest,
        apiCount: apiRecords.length,
        domCount: domRecords.length,
        error: waited.error || '最新作答记录未能与页面分数交叉核对',
      }
    }
    return { ok: true, records: apiRecords, latest, apiCount: apiRecords.length, domCount: domRecords.length }
  } finally {
    opts.page.off('response', listener)
    network.dispose()
  }
}

async function readDomRecords(page: Page): Promise<NoqrHistoryRecord[]> {
  return page.locator(NOQR_SEL.recordItem).evaluateAll((nodes) => nodes.map((node) => {
    const infos = [...node.querySelectorAll('.record-info')]
      .map((entry) => (entry.textContent || '').replace(/\s+/g, ' ').trim())
    const finishedText = infos.find((text) => /完成时间/.test(text)) || ''
    const finishedTime = finishedText.replace(/^完成时间\s*[:：]?\s*/, '').trim()
    const scoreText = (node.querySelector('.score-num')?.textContent || '').replace(/\s+/g, ' ').trim()
    return {
      finishedTime,
      score: Number(scoreText),
      isMarked: true,
      status: '已批阅',
    }
  }).filter((row) => row.finishedTime && Number.isFinite(row.score)))
}

export function historyRecordKey(row: NoqrHistoryRecord): string {
  return [
    row.finishedTime,
    row.score,
    row.paperId || '',
    row.homeWorkUniqueFlag || '',
  ].join('|')
}

export function hasNewNoqrHistoryRecord(records: NoqrHistoryRecord[], baseline: NoqrHistoryRecord[]): NoqrHistoryRecord | null {
  const before = new Set(baseline.map(historyRecordKey))
  const fresh = records.filter((row) => !before.has(historyRecordKey(row)))
  return newestNoqrScoreRecord(fresh) as NoqrHistoryRecord | null
}
