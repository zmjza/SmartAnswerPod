import type { Page, Request, Response } from 'patchright'
import { NoqrBlankRecoveryGate } from './blank-recovery.ts'
import { NOQR_HISTORY_RESPONSE_HARD_WAIT_MS } from './limits.ts'
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
  failureKind?: 'network'
  error?: string
}

export type NoqrHistoryDomWaitResult = {
  ok: boolean
  domRecords: NoqrHistoryRecord[]
  error?: string
}

export type NoqrFreshRecordEvidence = {
  baselineReliable: boolean
  submittedAt: number
  homeWorkUniqueFlag?: string
  paperStructUniqueFlag?: string
}

const NOQR_FRESH_RECORD_CLOCK_SKEW_MS = 5 * 60_000

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
  try {
    await response.finished()
    const text = await response.text()
    if (!text) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Wait for the already-recorded API score to appear in the DOM. The school
 * may need minutes to refresh this page. A long safety ceiling prevents an
 * unrelated stale card from waiting forever; it never refreshes an answer page.
 */
export async function waitForNoqrHistoryDomMatch(opts: {
  matches: (records: NoqrHistoryRecord[]) => boolean
  readDom: () => Promise<NoqrHistoryRecord[]>
  stopRequested: () => boolean
  sleep: () => Promise<void>
  recover?: () => Promise<void>
  onWaiting?: (elapsedMs: number) => void
  hardDeadlineMs?: number
}): Promise<NoqrHistoryDomWaitResult> {
  const startedAt = Date.now()
  const hardDeadlineMs = Math.max(
    50,
    Number(opts.hardDeadlineMs) || NOQR_HISTORY_RESPONSE_HARD_WAIT_MS,
  )
  for (;;) {
    const domRecords = await opts.readDom()
    if (opts.matches(domRecords)) return { ok: true, domRecords }
    if (opts.stopRequested()) {
      return { ok: false, domRecords, error: '任务已停止' }
    }
    if (Date.now() - startedAt >= hardDeadlineMs) {
      return { ok: false, domRecords, error: '作答记录页面未在安全上限内同步本次分数' }
    }
    opts.onWaiting?.(Date.now() - startedAt)
    await opts.recover?.()
    await opts.sleep()
  }
}

async function refreshBlankRecordPage(
  page: Page,
  network: NoqrNetworkActivity,
  recovery: NoqrBlankRecoveryGate,
  stopRequested: () => boolean,
  requireRecordDom = false,
  requireFreshRecord = false,
): Promise<void> {
  if (stopRequested()) throw new NoqrSessionError('stopped', '任务已停止')
  const surface = await classifyNoqrPage(page)
  if (surface === 'auth_blocked' || surface === 'login') {
    throw new NoqrSessionError('auth_blocked', '作答记录页回到登录或人工认证，已暂停当前作业')
  }
  if (surface === 'error') {
    throw new NoqrSessionError('page_error', '作答记录页显示明确错误')
  }
  if (surface === 'record') {
    const recordCount = await page.locator(NOQR_SEL.recordItem).count().catch(() => 0)
    // Existing record cards may be stale DOM from the previous attempt. When a
    // fresh record is required, only the new history response can prove that
    // this page finished loading its current data.
    if (recordCount > 0 && !requireFreshRecord) return
    const explicitEmpty = await page.evaluate((itemSelector) => {
      const items = document.querySelectorAll(itemSelector).length
      const text = document.body?.innerText || ''
      return items === 0 && /暂无|没有记录|无记录/.test(text)
    }, NOQR_SEL.recordItem).catch(() => false)
    if (!requireRecordDom && !requireFreshRecord && explicitEmpty) return
    const decision = recovery.observe({
      now: Date.now(),
      activityVersion: network.businessActivityVersion,
      empty: true,
      active: network.isBusinessActive(),
      stopRequested: stopRequested(),
    })
    if (decision.action === 'refresh') {
      await reloadNoqrPage(page, { stopRequested })
      return
    }
    if (decision.action === 'stop') {
      throw new NoqrSessionError('blank_page', '作答记录页连续刷新后仍没有记录卡')
    }
    return
  }
  const refreshable = surface === 'blank' || surface === 'home_blank' ||
    surface === 'unknown' || surface === 'home' || surface === 'submit_success'
  if (!refreshable) return
  const decision = recovery.observe({
    now: Date.now(),
    activityVersion: network.businessActivityVersion,
    empty: true,
    active: network.isBusinessActive(),
    stopRequested: stopRequested(),
  })
  if (decision.action === 'refresh') {
    await reloadNoqrPage(page, { stopRequested })
    return
  }
  if (decision.action === 'stop') {
    if (surface === 'blank') {
      throw new NoqrSessionError('blank_page', '作答记录页连续刷新后仍为空白')
    }
    return
  }
}

export async function readNoqrHistoryAfterOpen(opts: {
  page: Page
  workId?: string
  open: () => Promise<void>
  stopRequested: () => boolean
  refreshBudget?: number
  blankGraceMs?: number
  requireFreshRecord?: boolean
  baseline?: NoqrHistoryRecord[]
  freshEvidence?: NoqrFreshRecordEvidence
  onWaiting?: (elapsedMs: number) => void
  responseHardDeadlineMs?: number
  maxHeartbeatWaitMs?: number
  maxActiveWaitMs?: number
}): Promise<NoqrHistoryReadResult> {
  let capturedUrl = ''
  let capturedResponse: Response | null = null
  let capturedPayload: Promise<unknown | null> | null = null
  let capturedFailure: { url: string; errorText: string } | null = null
  const listener = (response: Response) => {
    try {
      if (response.request().method() !== 'GET') return
      const url = new URL(response.url())
      if (!url.pathname.endsWith(NOQR_API.history)) return
      capturedUrl = url.href
      if (!capturedResponse) {
        capturedResponse = response
        capturedPayload = responsePayload(response)
      }
    } catch {
      /* ignore malformed unrelated responses */
    }
  }
  const failedListener = (request: Request) => {
    try {
      if (capturedResponse || capturedFailure) return
      if (request.method() !== 'GET') return
      const url = new URL(request.url())
      if (!url.pathname.endsWith(NOQR_API.history)) return
      capturedUrl = url.href
      capturedFailure = {
        url: url.href,
        errorText: request.failure()?.errorText || '',
      }
    } catch {
      /* ignore malformed unrelated failures */
    }
  }
  opts.page.on('response', listener)
  opts.page.on('requestfailed', failedListener)
  const network = new NoqrNetworkActivity(opts.page)
  const startedAt = Date.now()
  const responseHardDeadlineMs = Math.max(
    50,
    Number(opts.responseHardDeadlineMs) || NOQR_HISTORY_RESPONSE_HARD_WAIT_MS,
  )
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    refreshBudget: opts.refreshBudget ?? 3,
    maxHeartbeatWaitMs: opts.maxHeartbeatWaitMs,
    maxActiveWaitMs: opts.maxActiveWaitMs,
  })
  try {
    await opts.open()
    while (!capturedResponse && !capturedFailure) {
      if (opts.stopRequested()) return { ok: false, records: [], latest: null, apiCount: 0, domCount: 0, error: '任务已停止' }
      if (Date.now() - startedAt >= responseHardDeadlineMs) {
        return {
          ok: false,
          records: [],
          latest: null,
          apiCount: 0,
          domCount: 0,
          failureKind: 'network',
          error: '作答记录接口未在安全上限内发出或完成响应头读取',
        }
      }
      await refreshBlankRecordPage(
        opts.page,
        network,
        recovery,
        opts.stopRequested,
        false,
        opts.requireFreshRecord === true,
      )
      if (!network.isBusinessActive()) {
        const emptyState = await opts.page.evaluate((itemSelector) => {
          const items = document.querySelectorAll(itemSelector).length
          const text = document.body?.innerText || ''
          return items === 0 && /暂无|没有记录|无记录/.test(text)
        }, NOQR_SEL.recordItem).catch(() => false)
        if (emptyState && !opts.requireFreshRecord) {
          return { ok: true, records: [], latest: null, apiCount: 0, domCount: 0 }
        }
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(opts.page, 100)
    }
    if (capturedFailure) {
      const domRecords = await readDomRecords(opts.page).catch(() => [])
      return {
        ok: false,
        records: [],
        latest: null,
        apiCount: 0,
        domCount: domRecords.length,
        failureKind: 'network',
        // Keep HTTP in the message so the caller treats an exhausted network
        // request as "score unavailable" instead of retrying forever.
        error: '作答记录接口失败（HTTP 网络请求失败）',
      }
    }
    let actualWorkId = ''
    try {
      // Prefer the record page's own identity. The course list URL may still
      // contain a stale workId from the previous homework.
      actualWorkId = new URL(opts.page.url()).searchParams.get('workId') ||
        new URL(opts.page.url()).searchParams.get('id') ||
        opts.workId ||
        ''
    } catch { actualWorkId = opts.workId || '' }
    let capturedWorkId = ''
    try {
      const captured = new URL(capturedUrl)
      capturedWorkId = captured.searchParams.get('workId') || captured.searchParams.get('id') || ''
    } catch { /* ignore */ }
    if (actualWorkId && capturedWorkId && actualWorkId !== capturedWorkId) {
      return { ok: false, records: [], latest: null, apiCount: 0, domCount: 0, error: '作答记录接口与当前作业身份不一致' }
    }
    const response = capturedResponse as Response | null
    if (!response) {
      return { ok: false, records: [], latest: null, apiCount: 0, domCount: 0, error: '作答记录接口失败（未取得响应）' }
    }
    if (response.status() < 200 || response.status() >= 300) {
      return { ok: false, records: [], latest: null, apiCount: 0, domCount: 0, error: `作答记录接口失败（HTTP ${response.status()}）` }
    }
    const payloadStartedAt = Date.now()
    let payload: unknown | null = null
    let payloadError = ''
    const payloadSource = capturedPayload as Promise<unknown | null> | null
    if (!payloadSource) {
      return {
        ok: false,
        records: [],
        latest: null,
        apiCount: 0,
        domCount: 0,
        failureKind: 'network',
        error: '作答记录接口失败（响应读取未启动）',
      }
    }
    const payloadPromise = payloadSource.then((value) => ({
      kind: 'payload' as const,
      value,
    }))
    while (!payloadError) {
      if (opts.stopRequested()) {
        payloadError = '任务已停止'
        break
      }
      if (Date.now() - payloadStartedAt >= responseHardDeadlineMs) {
        payloadError = '作答记录接口响应读取超过安全上限'
        break
      }
      const outcome = await Promise.race([
        payloadPromise,
        sleepNoqr(opts.page, 100).then(() => ({ kind: 'tick' as const })),
      ])
      if (outcome.kind === 'payload') {
        payload = outcome.value
        break
      }
    }
    if (payloadError) {
      return {
        ok: false,
        records: [],
        latest: null,
        apiCount: 0,
        domCount: 0,
        failureKind: 'network',
        error: `作答记录接口失败（${payloadError}）`,
      }
    }
    const apiRows = recordArray(payload)
    if (!apiRows) return { ok: false, records: [], latest: null, apiCount: 0, domCount: 0, error: '作答记录接口返回格式错误' }
    if (apiRows.length === 0) {
      if (opts.requireFreshRecord) {
        return {
          ok: false,
          records: [],
          latest: null,
          apiCount: 0,
          domCount: 0,
          error: '作答记录接口为空，等待交卷后的新记录',
        }
      }
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
    const baseline = Array.isArray(opts.baseline) ? opts.baseline : []
    const latest = (opts.requireFreshRecord
      ? newestFreshNoqrHistoryRecord(apiRecords, baseline, opts.freshEvidence)
      : newestNoqrScoreRecord(apiRecords)) as NoqrHistoryRecord | null
    if (opts.requireFreshRecord && !latest) {
      return {
        ok: false,
        records: apiRecords,
        latest: null,
        apiCount: apiRecords.length,
        domCount: domRecords.length,
        error: '作答记录尚未出现新的有效分数',
      }
    }
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
      recover: () => refreshBlankRecordPage(
        opts.page,
        network,
        recovery,
        opts.stopRequested,
        true,
        opts.requireFreshRecord === true,
      ),
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
    opts.page.off('requestfailed', failedListener)
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

function matchesNoqrFreshMarker(row: NoqrHistoryRecord, evidence: NoqrFreshRecordEvidence): boolean {
  const expected = [
    [row.homeWorkUniqueFlag, evidence.homeWorkUniqueFlag],
    [row.paperStructUniqueFlag, evidence.paperStructUniqueFlag],
  ] as const
  let matched = false
  for (const [actual, wanted] of expected) {
    if (!wanted || !actual) continue
    if (actual !== wanted) return false
    matched = true
  }
  return matched
}

export function newestFreshNoqrHistoryRecord(
  records: NoqrHistoryRecord[],
  baseline: NoqrHistoryRecord[],
  evidence?: NoqrFreshRecordEvidence,
): NoqrHistoryRecord | null {
  if (!evidence) return null
  const hasMarker = Boolean(evidence.homeWorkUniqueFlag || evidence.paperStructUniqueFlag)
  let candidates = records
  if (evidence.baselineReliable) {
    const before = new Set(baseline.map(historyRecordKey))
    candidates = records.filter((row) => !before.has(historyRecordKey(row)))
    if (hasMarker) candidates = candidates.filter((row) => matchesNoqrFreshMarker(row, evidence))
  } else {
    if (!hasMarker || !Number.isFinite(evidence.submittedAt) || evidence.submittedAt <= 0) return null
    const minimumTime = evidence.submittedAt - NOQR_FRESH_RECORD_CLOCK_SKEW_MS
    candidates = records.filter((row) => {
      const completedAt = parseNoqrTimestamp(row.finishedTime)
      return completedAt != null &&
        completedAt >= minimumTime &&
        matchesNoqrFreshMarker(row, evidence)
    })
  }
  return newestNoqrScoreRecord(candidates) as NoqrHistoryRecord | null
}
