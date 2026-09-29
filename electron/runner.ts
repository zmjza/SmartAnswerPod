import type { BrowserContext, Page } from 'patchright'
import { app, Notification } from 'electron'
import { loginIam } from './login'
import { detectCourse, listCourses, readHistory, type DetectedCourse, type DetectedHomework } from './detect'
import { answerPage, ListeningBankMissError, type QResult } from './answer'
import { historyHasNew, submitHomework } from './submit'
import { acquire, averageBrowserMemoryBytes, browserMemoryStatus, browserWindowVisible, getContext, isHeld, markOccupied, markVerify, release, slots, toolbarBrowserCount } from './pool'
import { ExtractWritebackSaveError, getExtractWriteback, getSettings, getWriteback, listAccounts, patchAccount, saveExtractWriteback, saveWriteback, type ExtractWritebackItem, type LocalAccount } from './store'
import { emitProgress, onProgress } from './progress'
import { hasQr } from './page-tools'
import { PATH, SEL, isAnswerPath } from './core/selectors'
import { ACCOUNT_ZH, type AccountState, type SlotState } from './core/states'
import { resetAsked } from './ai'
import os from 'node:os'
import { pressureOf, formatMb, recommendConcurrency } from './core/machine'
import { canClickDoHomework } from '../src/verify-gate'
import { contradictoryReferenceHashes, extractReviewedQuestions, readReviewedQuestions, reviewResults, type ReviewedQuestion, type ReviewOutcome, type ReferenceStats } from './review.ts'
import { historyDisplayState, newestHistory, newSubmission } from './core/homework.ts'
import { mergeAccountWriteback } from './core/writeback.ts'
import { upsertHomework, courseOutcome, recordQuestion, emptyExtractStats, addExtractStats, extractCompletionLabel, type ExtractStats, type LiveCourse, type LiveHomeworkGroup, type LiveQuestion } from './core/live-view.ts'
import { mapWithConcurrency } from './core/concurrency.ts'
import { concurrencySnapshot } from './core/concurrency.ts'
import { upsertQuestion } from './bank.ts'
import { progressActionLabel } from './core/progress-label.ts'
import { selectedRunReadiness, selectCoursesForRun, type CourseScope } from './core/course-scope.ts'
import { runtimeLogLevel, sanitizeRuntimeLogText, type RuntimeLogLevel } from './core/runtime-log.ts'
import { qrSnapshotMatches, verificationFailure, type QrSnapshot } from './core/qr.ts'

export type RuntimeCourseLog = {
  time: string
  level: RuntimeLogLevel
  courseName: string
  courseKey?: string
  homeworkName: string
  action: string
  result: string
  reason: string
}

type StudentView = {
  local_id: string
  name: string
  studentNo: string
  major: string
  campus: string
  displayMode: 'headless' | 'visual'
  workMode: 'answer' | 'extract'
  courseScope: CourseScope
  selectedCourseNames: string[]
  selectedCourseKeys: string[]
  awaitingCourseSelection: boolean
  answerRoundLimit: number
  slot: SlotState
  account: AccountState
  action: string
  headline: string
  bankCount: number
  aiCount: number
  extractTotals: ExtractStats
  extractTotalCourses: number
  extractCompletedCourses: number
  extractTotalHomeworks: number
  extractCompletedHomeworks: number
  extractHistoryPages: number
  extractHistoryTotal: number
  extractHistoryCompleted: number
  extractCurrentHistory: string
  needsVerify: boolean
  verified: boolean
  queued: boolean
  logs: string[]
  courseLogs: RuntimeCourseLog[]
  courses: (LiveCourse & { groups: LiveHomeworkGroup[] })[]
  groups: LiveHomeworkGroup[]
  activeCourseName: string
  activeCourseKey: string
}

const views = new Map<string, StudentView>()
type VerificationSession = {
  page?: Page
  kind: 'homework' | 'portal'
  courseName: string
  homeworkName: string
  version: number
  finish: () => void
  promise: Promise<void>
}
const verificationSessions = new Map<string, VerificationSession>()
const qrSnapshots = new Map<string, QrSnapshot>()
const qrVersions = new Map<string, number>()
const verificationWaiters = new Map<string, Set<() => void>>()
const courseSelectionWaiters = new Map<string, () => void>()
const unverifiedClicks = new Map<string, number>()
const verifiedAccounts = new Set<string>()
const stopFlag = new Set<string>()
const stopControllers = new Map<string, AbortController>()
let runConcurrency: ReturnType<typeof concurrencySnapshot> | null = null
let runAccountIds = new Set<string>()
const activeRuns = new Map<string, Promise<void>>()
let stoppingAll = false
let selectionStartRequested = false
const WRITEBACK_RETRY_MS = 3000

function waitMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Update the authoritative snapshot before main.ts publishes it.
onProgress((event) => {
  const v = views.get(event.local_id)
  if (!v || v.account === 'stopped') return
  if (v.needsVerify && event.account !== 'needs_verify') return
  v.account = event.account
  v.action = sanitizeRuntimeLogText(progressActionLabel(event.action, event.questionNo, event.questionTotal))
  v.headline = ACCOUNT_ZH[event.account]
  v.logs = [...v.logs.slice(-99), v.action]
  const courseName = event.courseName || v.activeCourseName || ''
  const courseKey = event.courseKey || v.activeCourseKey || ''
  if (courseName) {
    v.courseLogs = [...v.courseLogs.slice(-499), {
      time: event.time,
      level: runtimeLogLevel(v.action),
      courseName,
      courseKey,
      homeworkName: sanitizeRuntimeLogText(event.homeworkName || ''),
      action: v.action,
      result: ACCOUNT_ZH[event.account],
      reason: sanitizeRuntimeLogText(event.homework || event.click || ''),
    }]
  }
  if (event.courseName) {
    v.activeCourseName = event.courseName
    if (event.courseKey) v.activeCourseKey = event.courseKey
    const course = v.courses.find((c) => c.key === (event.courseKey || v.activeCourseKey)) ||
      (v.courses.filter((c) => c.name === event.courseName).length === 1 ? v.courses.find((c) => c.name === event.courseName) : undefined)
    if (course) { v.groups = course.groups; v.activeCourseKey = course.key || '' }
  }
})

function viewOf(a: LocalAccount): StudentView {
  const cur = views.get(a.local_id)
  if (cur) return cur
  const v: StudentView = {
    local_id: a.local_id,
    name: a.name,
    studentNo: a.username,
    major: a.major || '',
    campus: a.campus || '',
    displayMode: a.display_mode,
    workMode: a.work_mode,
    courseScope: a.course_scope,
    selectedCourseNames: [],
    selectedCourseKeys: [],
    awaitingCourseSelection: false,
    answerRoundLimit: a.answer_round_limit,
    slot: 'queued',
    account: 'idle',
    action: '空闲',
    headline: '空闲',
    bankCount: 0,
    aiCount: 0,
    extractTotals: emptyExtractStats(),
    extractTotalCourses: 0,
    extractCompletedCourses: 0,
    extractTotalHomeworks: 0,
    extractCompletedHomeworks: 0,
    extractHistoryPages: 0,
    extractHistoryTotal: 0,
    extractHistoryCompleted: 0,
    extractCurrentHistory: '',
    needsVerify: false,
    verified: false,
    queued: false,
    logs: [],
    courseLogs: [],
    courses: [],
    groups: [],
    activeCourseName: '',
    activeCourseKey: '',
  }
  views.set(a.local_id, v)
  return v
}

function setState(v: StudentView, account: AccountState, action: string, slot?: SlotState) {
  v.account = account
  v.action = action
  if (slot) v.slot = slot
  v.headline = ACCOUNT_ZH[account]
  v.queued = v.slot === 'queued'
  v.needsVerify = account === 'needs_verify'
  emitProgress({
    local_id: v.local_id,
    slot: v.slot,
    account: v.account,
    action,
    courseName: v.activeCourseName || undefined,
    courseKey: v.activeCourseKey || undefined,
    bankCount: v.bankCount,
    aiCount: v.aiCount,
  })
}

function groupsForDetected(course: DetectedCourse): LiveHomeworkGroup[] {
  const groups = new Map<'onlineHomework' | 'phasedTest', LiveHomeworkGroup>()
  for (const hw of course.homeworks) {
    const title = hw.section === 'onlineHomework' ? '网上记分作业' : '阶段性测验'
    const group = groups.get(hw.section) || { title, rows: [] }
    group.rows.push({ name: hw.name, status: hw.status, previewHref: hw.previewHref, questions: [], extractStats: hw.extractStats })
    groups.set(hw.section, group)
  }
  return [...groups.values()]
}

function syncHomeworkView(v: StudentView, courseKey: string, hw: DetectedHomework, questions?: LiveQuestion[]) {
  const course = v.courses.find((item) => (item.key || item.name) === courseKey)
  if (!course) return
  course.groups = upsertHomework(course.groups, hw.section, hw.name, hw.status, questions)
  const row = course.groups.find((g) => g.title === (hw.section === 'onlineHomework' ? '网上记分作业' : '阶段性测验'))?.rows.find((r) => r.name === hw.name)
  if (row) {
    row.attempt = hw.attempt
    row.score = hw.score
    row.lastAttempt = hw.lastAttempt
    row.lastScore = hw.lastScore
    row.extractStats = hw.extractStats
  }
  course.status = courseOutcome(course.groups.flatMap((g) => g.rows.map((r) => r.status)))
  if (v.workMode === 'extract') {
    const statuses = course.groups.flatMap((g) => g.rows.map((r) => r.status))
    if (statuses.includes('extracting')) course.status = '提取中'
    else if (statuses.length && statuses.every((status) => status === 'extracting_done' || status.startsWith('skip_'))) course.status = '提取完成'
  }
  if (['clicking_do_homework', 'answering', 'submitting', 'waiting_grade', 'reviewing'].includes(hw.status)) course.status = hw.status
  v.activeCourseName = course.name
  v.activeCourseKey = course.key || course.name
  v.groups = course.groups
}

export function snapshot() {
  const accounts = listAccounts()
  const settings = getSettings()
  const students = accounts.map((a) => ({
    ...viewOf(a),
    configLocked: isStudentLocked(a.local_id),
    browserWindowVisible: browserWindowVisible(a.local_id),
  }))
  if (process.env.KAIDA_E2E_MOCK_COURSES === '1') {
    for (const student of students) {
      student.courses = Array.from({ length: 11 }, (_, index) => ({ name: `模拟课程${index + 1}`, status: '已检测', bankCount: 0, aiCount: 0, groups: [] }))
      student.activeCourseName = process.env.KAIDA_E2E_MOCK_ACTIVE_COURSE || '模拟课程11'
    }
  }
  const cpu = os.loadavg()[0] / (os.cpus().length || 1) * 100
  const total = os.totalmem()
  const free = os.freemem()
  const mem = ((total - free) / total) * 100
  const pressure = pressureOf(cpu, mem)
  const recommendation = recommendConcurrency({
    cores: os.cpus().length || 1,
    cpuPct: cpu,
    totalMemBytes: total,
    freeMemBytes: free,
    appMemBytes: process.memoryUsage().rss,
    browserAverageBytes: averageBrowserMemoryBytes(),
    pressure,
  })
  const browserStatus = browserMemoryStatus()
  return {
    machine: {
      cpu: Math.round(cpu) + '%',
      memory: Math.round(mem) + '%',
      app: formatMb(process.memoryUsage().rss),
      browsers: toolbarBrowserCount(),
      pressure,
      recommendedAccount: recommendation.account,
      recommendedCourse: recommendation.course,
      browserAverage: browserStatus === 'unavailable' ? 'unavailable' : formatMb(recommendation.browserBytes),
      recommendationSampled: recommendation.sampled,
    },
    settings: {
      account_parallel: settings.account_parallel,
      course_parallel: settings.course_parallel,
      browser_visible_default: settings.browser_visible_default,
      log_enabled: settings.log_enabled,
      hasSilicon: Boolean(settings.siliconflow_key),
      hasUrl: Boolean(settings.supabase_url),
      hasAnon: Boolean(settings.supabase_anon),
    },
    students,
    running: isRunning(),
  }
}

export function isRunning() {
  return stoppingAll || activeRuns.size > 0
}

export function isStudentLocked(local_id: string) {
  return activeRuns.has(local_id) || isHeld(local_id)
}

export function canApplyAllSettings() {
  return !isRunning()
}

export function applyStudentSettingsToAll(local_id: string) {
  if (!canApplyAllSettings()) return { ok: false, error: '仍有学生运行或排队，请全部停止后再同步' }
  const accounts = listAccounts()
  const source = accounts.find((a) => a.local_id === local_id)
  if (!source) return { ok: false, error: '请先选择学生' }
  const patch = { display_mode: source.display_mode, work_mode: source.work_mode, course_scope: source.course_scope, answer_round_limit: source.answer_round_limit }
  const failed: string[] = []
  let updated = 0
  for (const account of accounts) {
    try {
      const courseScopeChanged = account.course_scope !== patch.course_scope
      patchAccount(account.local_id, { ...patch })
      const v = views.get(account.local_id)
      if (v) {
        v.displayMode = patch.display_mode
        v.workMode = patch.work_mode
        v.courseScope = patch.course_scope
        v.answerRoundLimit = patch.answer_round_limit
        if (courseScopeChanged) v.selectedCourseNames = []
        if (courseScopeChanged) v.selectedCourseKeys = []
      }
      updated++
    } catch { failed.push(account.name) }
  }
  return { ok: failed.length === 0, updated, failed, error: failed.length ? `有 ${failed.length} 名学生保存失败` : undefined }
}

function nextQrVersion(local_id: string) {
  const version = (qrVersions.get(local_id) || 0) + 1
  qrVersions.set(local_id, version)
  qrSnapshots.delete(local_id)
  return version
}

async function captureQrSnapshot(local_id: string, session: VerificationSession, version: number) {
  if (session.kind !== 'homework' || !session.page || !(await hasQr(session.page))) return undefined
  const png = await session.page.locator(SEL.qrDialog).screenshot({ type: 'png' })
  const snapshot: QrSnapshot = {
    localId: local_id,
    courseName: session.courseName,
    homeworkName: session.homeworkName,
    version,
    image: `data:image/png;base64,${png.toString('base64')}`,
    capturedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    status: '等待扫码',
  }
  session.version = version
  qrSnapshots.set(local_id, snapshot)
  return snapshot
}

function clearVerification(local_id: string, finish: boolean) {
  const session = verificationSessions.get(local_id)
  verificationSessions.delete(local_id)
  qrSnapshots.delete(local_id)
  const v = views.get(local_id)
  if (v) v.verified = false
  if (finish) session?.finish()
}

export async function waitForVerify(
  local_id: string,
  page?: Page,
  until: 'qr-gone' | 'portal' = 'qr-gone',
  meta: { courseName?: string; homeworkName?: string } = {},
) {
  const existing = verificationSessions.get(local_id)
  if (existing) return existing.promise
  const v = views.get(local_id)
  if (v) v.slot = 'occupying_verify'
  if (v) v.verified = false
  markVerify(local_id)
  let finish!: () => void
  const promise = new Promise<void>((resolve) => { finish = resolve })
  const session: VerificationSession = {
    page,
    kind: until === 'portal' ? 'portal' : 'homework',
    courseName: meta.courseName || '',
    homeworkName: meta.homeworkName || '',
    version: 0,
    finish,
    promise,
  }
  verificationSessions.set(local_id, session)
  if (session.kind === 'homework' && page) {
    try {
      await captureQrSnapshot(local_id, session, nextQrVersion(local_id))
      if (v) setState(v, 'needs_verify', '等你扫码或验证', 'occupying_verify')
    } catch {
      if (v) setState(v, 'needs_verify', '二维码截图失败，请刷新程序内二维码', 'occupying_verify')
    }
  } else if (v) {
    setState(v, 'needs_verify', '等你扫码或验证', 'occupying_verify')
  }
  return promise
}

function resetVerificationGate(local_id: string) {
  unverifiedClicks.set(local_id, 0)
  verifiedAccounts.delete(local_id)
  const v = views.get(local_id)
  if (v) v.verified = false
}

function markHomeworkVerified(local_id: string) {
  verifiedAccounts.add(local_id)
  const v = views.get(local_id)
  if (v) v.verified = true
  unverifiedClicks.delete(local_id)
  const waiters = verificationWaiters.get(local_id)
  verificationWaiters.delete(local_id)
  for (const resolve of waiters || []) resolve()
}

function waitForVerification(local_id: string) {
  if (verifiedAccounts.has(local_id)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const waiters = verificationWaiters.get(local_id) || new Set<() => void>()
    waiters.add(resolve)
    verificationWaiters.set(local_id, waiters)
  })
}

export function getQrSnapshot(local_id: string) {
  const session = verificationSessions.get(local_id)
  const snapshot = qrSnapshots.get(local_id)
  if (!session || session.kind !== 'homework') return { ok: false, error: '当前没有可查看的作业二维码' }
  if (!snapshot || !qrSnapshotMatches(snapshot, {
    localId: local_id, courseName: session.courseName, homeworkName: session.homeworkName, version: session.version,
  })) return { ok: false, error: '二维码尚未生成或已失效，请刷新二维码' }
  return { ok: true, snapshot }
}

export async function refreshQrSnapshot(local_id: string) {
  const session = verificationSessions.get(local_id)
  if (!session?.page || session.kind !== 'homework') return { ok: false, error: '当前没有可刷新的作业二维码' }
  const version = nextQrVersion(local_id)
  session.version = version
  try {
    const refresh = session.page.locator(`${SEL.qrDialog} a, ${SEL.qrDialog} button, ${SEL.qrDialog} input[type=button]`).filter({ hasText: /刷新/ }).first()
    if (await refresh.count()) await refresh.click({ timeout: 5000 })
    else {
      await session.page.reload({ waitUntil: 'domcontentloaded' })
      await session.page.locator(SEL.doHomework).first().click({ timeout: 8000 })
    }
    for (let i = 0; i < 20 && !(await hasQr(session.page)); i++) await session.page.waitForTimeout(250)
    const snapshot = await captureQrSnapshot(local_id, session, version)
    if (!snapshot) return { ok: false, error: '刷新后未检测到有效二维码' }
    return { ok: true, snapshot }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '二维码刷新失败' }
  }
}

export async function signalVerified(local_id: string) {
  const session = verificationSessions.get(local_id)
  if (!session) return { ok: false, error: '当前没有等待确认的验证任务' }
  let qrOpen = false
  let portalReady = false
  if (session.page) {
    try {
      if (session.kind === 'homework') qrOpen = await hasQr(session.page)
      else {
        portalReady = (await session.page.locator(SEL.tabCourseList).count()) > 0
        if (!portalReady) {
          const url = new URL(session.page.url())
          portalReady = url.protocol.startsWith('http') && !url.hostname.includes(PATH.iamHost)
        }
      }
    } catch {
      return { ok: false, error: '验证页面不可用，请刷新后重试' }
    }
  }
  const failure = verificationFailure(session.kind, { qrOpen, portalReady })
  if (failure) return { ok: false, error: failure }
  const acc = listAccounts().find((a) => a.local_id === local_id)
  const v = views.get(local_id)
  clearVerification(local_id, true)
  if (session.kind === 'homework') markHomeworkVerified(local_id)
  markOccupied(local_id)
  if (v && acc) {
    setState(v, v.account === 'needs_verify' ? 'auto_answering' : v.account, '验证完毕，继续', 'occupied')
  }
  return { ok: true }
}

export async function toggleDisplay(local_id: string, mode: 'headless' | 'visual') {
  if (isStudentLocked(local_id)) return { ok: false, visible: browserWindowVisible(local_id), error: '该学生任务运行中，浏览器模式已锁定；请停止后再切换' }
  if (isHeld(local_id)) return { ok: false, visible: browserWindowVisible(local_id), error: '浏览器仍在占用中；请先停止并释放浏览器后再切换' }
  patchAccount(local_id, { display_mode: mode })
  const v = views.get(local_id)
  if (v) v.displayMode = mode
  return { ok: true, visible: null }
}

export async function setWorkMode(local_id: string, mode: 'answer' | 'extract') {
  if (isStudentLocked(local_id)) return { ok: false, error: '该学生任务运行中，工作模式已锁定' }
  patchAccount(local_id, { work_mode: mode })
  const v = views.get(local_id)
  if (v) v.workMode = mode
  return { ok: true }
}

export function setCourseScope(local_id: string, scope: CourseScope) {
  if (isStudentLocked(local_id)) return { ok: false, error: '该学生任务运行中，课程范围已锁定' }
  patchAccount(local_id, { course_scope: scope })
  const v = views.get(local_id)
  if (v) {
    v.courseScope = scope
    v.selectedCourseNames = []
    v.selectedCourseKeys = []
  }
  return { ok: true }
}

export function setSelectedCourses(local_id: string, keys: string[]) {
  const v = views.get(local_id)
  const editableAfterStop = Boolean(v && !isStudentLocked(local_id) && v.account === 'stopped')
  if (!v || (selectionStartRequested && !editableAfterStop) || (!v.awaitingCourseSelection && !editableAfterStop)) {
    return { ok: false, error: '当前不在课程选择阶段' }
  }
  const selected = new Set(keys)
  v.selectedCourseKeys = v.courses.filter((course) => selected.has(course.key || course.name) || (selected.has(course.name) && v.courses.filter((item) => item.name === course.name).length === 1)).map((course) => course.key || course.name)
  v.selectedCourseNames = v.courses.filter((course) => v.selectedCourseKeys.includes(course.key || course.name)).map((course) => course.name)
  for (const course of v.courses) {
    if (v.selectedCourseKeys.includes(course.key || course.name)) {
      if (course.status === '本轮未选择') course.status = '已检测'
    } else {
      course.status = '本轮未选择'
    }
  }
  return { ok: true, selected: v.selectedCourseKeys.length, selectedNames: [...v.selectedCourseNames], selectedKeys: [...v.selectedCourseKeys] }
}

export function startSelectedCourseExecution() {
  const candidates = [...runAccountIds]
    .map((id) => views.get(id))
    .filter((v): v is StudentView => Boolean(v) && v!.courseScope === 'selected' && !['login_failed', 'stopped', 'round_ended'].includes(v!.account))
  const readiness = selectedRunReadiness(candidates.map((v) => ({
    awaiting: v.awaitingCourseSelection,
    selectedCount: v.selectedCourseKeys.length,
  })))
  if (readiness === 'scanning') return { ok: false, error: '仍有学生正在扫描课程' }
  if (readiness === 'empty') return { ok: false, error: '请至少为一个学生选择一门课程' }
  selectionStartRequested = true
  for (const v of candidates) courseSelectionWaiters.get(v.local_id)?.()
  return { ok: true }
}

export function setAnswerRoundLimit(local_id: string, limit: number) {
  if (isStudentLocked(local_id)) return { ok: false, error: '该学生任务运行中，重新答题次数已锁定' }
  const answerRoundLimit = Math.min(10, Math.max(1, Number(limit) || 10))
  patchAccount(local_id, { answer_round_limit: answerRoundLimit })
  const v = views.get(local_id)
  if (v) v.answerRoundLimit = answerRoundLimit
  return { ok: true }
}

export type HistoryScoreItem = {
  attempt: number
  submittedAt: string
  status: string
  score: number | null
  completed: boolean
  viewable: boolean
  displayState: ReturnType<typeof historyDisplayState>
}

function previewHrefOf(local_id: string, courseName: string, homeworkName: string) {
  const courses = views.get(local_id)?.courses || []
  const course = courses.find((item) => item.key === courseName) ||
    (courses.filter((item) => item.name === courseName).length === 1 ? courses.find((item) => item.name === courseName) : undefined)
  return course?.groups.flatMap((group) => group.rows).find((row) => row.name === homeworkName)?.previewHref || ''
}

async function withStudentContext<T>(local_id: string, run: (context: BrowserContext) => Promise<T>): Promise<T> {
  let context = getContext(local_id)
  let temporary = false
  if (!context) {
    const account = listAccounts().find((item) => item.local_id === local_id)
    if (!account) throw new Error('学生账号不存在')
    const acquired = await acquire(local_id, account.display_mode === 'visual')
    if (!acquired.ok || !acquired.context) throw new Error('当前没有可用浏览器名额')
    context = acquired.context
    temporary = true
  }
  try {
    return await run(context)
  } finally {
    if (temporary) await release(local_id)
  }
}

async function readHomeworkHistory(local_id: string, courseName: string, homeworkName: string) {
  const previewHref = previewHrefOf(local_id, courseName, homeworkName)
  if (!previewHref) throw new Error('该作业没有可靠历史页面链接')
  return withStudentContext(local_id, async (context) => {
    const page = await context.newPage()
    try {
      const response = await page.goto(studyUrl(previewHref), { waitUntil: 'domcontentloaded' })
      if (response && !response.ok()) throw new Error(`历史页面 HTTP ${response.status()}`)
      if ((await page.locator(SEL.historyTable).count()) === 0) throw new Error('登录态已失效，请先登录并刷新课程')
      return await readHistory(page)
    } finally {
      await page.close().catch(() => {})
    }
  })
}

export async function getHomeworkHistory(local_id: string, courseName: string, homeworkName: string) {
  try {
    const rows = (await readHomeworkHistory(local_id, courseName, homeworkName))
      .sort((a, b) => (Date.parse(b.submittedAt) || 0) - (Date.parse(a.submittedAt) || 0))
    const items: HistoryScoreItem[] = rows.map((row, index) => ({
      attempt: row.attempt || Math.max(1, rows.length - index),
      submittedAt: row.submittedAt,
      status: row.status,
      score: row.score,
      completed: !row.hasContinue && !/未完成提交|未提交记录/.test(row.status),
      viewable: row.hasHistoryView && Boolean(row.historyHref),
      displayState: historyDisplayState(row),
    }))
    return { ok: true, items }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '历史成绩读取失败', items: [] as HistoryScoreItem[] }
  }
}

export async function getHistoryPaperImage(local_id: string, courseName: string, homeworkName: string, submittedAt: string) {
  const previewHref = previewHrefOf(local_id, courseName, homeworkName)
  if (!previewHref) return { ok: false, error: '该作业没有可靠历史页面链接' }
  try {
    return await withStudentContext(local_id, async (context) => {
      const preview = await context.newPage()
      try {
        await preview.goto(studyUrl(previewHref), { waitUntil: 'domcontentloaded' })
        const row = (await readHistory(preview)).find((item) => item.submittedAt === submittedAt)
        if (!row?.historyHref) return { ok: false, error: '该记录没有可靠查看入口' }
        const history = await context.newPage()
        try {
          const response = await history.goto(studyUrl(row.historyHref), { waitUntil: 'domcontentloaded' })
          if (response && !response.ok()) throw new Error(`历史答卷 HTTP ${response.status()}`)
          await history.locator('.e-q-body').first().waitFor({ timeout: 20000 })
          const png = await history.screenshot({ fullPage: true, type: 'png' })
          return { ok: true, image: `data:image/png;base64,${png.toString('base64')}` }
        } finally {
          await history.close().catch(() => {})
        }
      } finally {
        await preview.close().catch(() => {})
      }
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '历史答卷读取失败' }
  }
}

export async function openVisual(local_id: string) {
  return { ok: false, error: '当前浏览器模式由启动参数决定；请停止任务后切换模式，扫码使用程序内作业二维码' }
}

export async function stopStudent(local_id: string) {
  stopFlag.add(local_id)
  stopControllers.get(local_id)?.abort()
  clearVerification(local_id, true)
  courseSelectionWaiters.get(local_id)?.()
  courseSelectionWaiters.delete(local_id)
  const v = views.get(local_id)
  if (v) {
    v.awaitingCourseSelection = false
    setState(v, 'stopped', '已停止', 'released')
  }
  await release(local_id)
  await activeRuns.get(local_id)
}

function stopAware<T>(local_id: string, task: Promise<T>): Promise<T> {
  const signal = stopControllers.get(local_id)?.signal
  if (!signal) return task
  if (signal.aborted) return Promise.reject(new Error('任务已停止'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('任务已停止'))
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

export async function deleteStudentRuntime(local_id: string) {
  await stopStudent(local_id)
}

async function runOne(a: LocalAccount) {
  const v = viewOf(a)
  const settings = { ...getSettings(), ...(runConcurrency || {}) }
  v.workMode = a.work_mode
  v.courseScope = a.course_scope
  v.answerRoundLimit = a.answer_round_limit
  v.selectedCourseNames = []
  v.selectedCourseKeys = []
  v.awaitingCourseSelection = false
  v.bankCount = 0
  v.aiCount = 0
  v.extractTotals = emptyExtractStats()
  v.extractTotalCourses = 0
  v.extractCompletedCourses = 0
  v.extractTotalHomeworks = 0
  v.extractCompletedHomeworks = 0
  v.extractHistoryPages = 0
  v.extractHistoryTotal = 0
  v.extractHistoryCompleted = 0
  v.extractCurrentHistory = ''
  resetVerificationGate(a.local_id)
  if (stopFlag.has(a.local_id)) return
  let got = await acquire(a.local_id, a.display_mode === 'visual')
  if (!got.ok) {
    if (got.error) throw new Error(got.error)
    setState(v, 'queued', '等待浏览器名额', 'queued')
    while (!stopFlag.has(a.local_id) && !got.ok) {
      await new Promise((r) => setTimeout(r, 400))
      got = await acquire(a.local_id, a.display_mode === 'visual')
      if (got.error) throw new Error(got.error)
    }
    if (!got.ok) return
  }
  if (stopFlag.has(a.local_id)) return
  v.slot = 'occupied'
  setState(v, 'launching_browser', '启动浏览器', 'occupied')
  const ctx = got.context!
  const page = ctx.pages()[0] || (await ctx.newPage())
  const login = await loginIam({
    page,
    local_id: a.local_id,
    username: a.username,
    password: a.password,
    slot: v.slot,
    onNeedVerify: () => waitForVerify(a.local_id, page, 'portal'),
  })
  if (stopFlag.has(a.local_id)) return
  if (!login.ok) {
    setState(v, 'login_failed', '登录失败，本号停止', 'released')
    await release(a.local_id)
    return
  }
  setState(v, 'logged_in', '已登录', 'occupied')
  let blockedWriteback = new Set<string>()
  if (a.work_mode === 'answer') {
    blockedWriteback = await flushWriteback(a, v, ctx)
    if (stopFlag.has(a.local_id)) return
  }
  await flushExtractWriteback(a, v)
  const courses = await listCourses(page, a.local_id, v.slot)
  v.courses = courses.map((c) => ({ key: c.key || c.name, name: c.name, status: '待检测', groups: [] }))
  v.groups = []
  v.activeCourseName = ''
  v.activeCourseKey = ''
  emitProgress({
    local_id: a.local_id,
    slot: v.slot,
    account: v.account,
    action: '课程列表已更新 ' + courses.length,
    courseTotal: courses.length,
    bankCount: v.bankCount,
    aiCount: v.aiCount,
  })
  const detected: DetectedCourse[] = []
  const parallel = Math.max(1, settings.course_parallel)
  for (let i = 0; i < courses.length; i += parallel) {
    if (stopFlag.has(a.local_id)) return
    const chunk = courses.slice(i, i + parallel)
    for (const c of chunk) {
      const row = v.courses.find((item) => item.key === (c.key || c.name))
      if (row) row.status = '检测中'
    }
   const parts = await Promise.all(
     chunk.map(async (c, j) => {
        let lastError: unknown
       for (let attempt = 0; attempt < 2; attempt++) {
         try {
           return await detectCourse({
             portal: page,
             href: c.href,
             key: c.key || c.name,
             courseName: c.name,
             local_id: a.local_id,
             slot: v.slot,
             index: i + j + 1,
             total: courses.length,
             mode: a.work_mode,
             answerRoundLimit: a.answer_round_limit,
           })
         } catch (error) {
           lastError = error
           if (attempt === 0) await waitMs(300)
         }
      }
      const reason = sanitizeRuntimeLogText(lastError instanceof Error ? lastError.message : '未知检测错误').slice(0, 180)
       v.courseLogs = [...v.courseLogs.slice(-499), {
         time: new Date().toISOString(), level: 'error', courseName: c.name, courseKey: c.key || c.name,
         homeworkName: '', action: '课程检测失败', result: '检测失败', reason,
       }]
      v.logs = [...v.logs.slice(-99), '课程检测失败 · ' + c.name + ' · ' + reason]
       emitProgress({ local_id: a.local_id, slot: v.slot, account: 'detecting',
         action: '课程检测失败 · ' + c.name + ' · ' + reason, courseName: c.name, courseKey: c.key || c.name,
         courseIndex: i + j + 1, courseTotal: courses.length, bankCount: v.bankCount, aiCount: v.aiCount })
       return { key: c.key || c.name, name: c.name, status: '检测失败', homeworks: [] } as DetectedCourse
     }),
    )
    for (const p of parts) {
      detected.push(p)
      const idx = v.courses.findIndex((x) => x.key === (p.key || p.name))
      if (idx >= 0) {
        v.courses[idx].status = p.status
        v.courses[idx].bankCount = 0
        v.courses[idx].aiCount = 0
        v.courses[idx].groups = groupsForDetected(p)
      }
      v.activeCourseName = p.name
      v.activeCourseKey = p.key || p.name
      v.groups = groupsForDetected(p)
      emitProgress({
        local_id: a.local_id,
        slot: v.slot,
        account: v.account,
        action: '课程状态已更新',
        courseName: p.name,
        courseKey: p.key || p.name,
        courseIndex: courses.findIndex((course) => (course.key || course.name) === (p.key || p.name)) + 1,
        courseTotal: courses.length,
        bankCount: v.bankCount,
       aiCount: v.aiCount,
     })
      if (p.status === '检测失败') emitProgress({
        local_id: a.local_id, slot: v.slot, account: 'detecting',
        action: '课程检测失败，请查看课程日志', courseName: p.name, courseKey: p.key || p.name,
        courseIndex: courses.findIndex((course) => (course.key || course.name) === (p.key || p.name)) + 1,
        courseTotal: courses.length, bankCount: v.bankCount, aiCount: v.aiCount,
      })
   }
 }
 setState(v, 'detected', '检测完成')
  let runCourses = detected
  if (a.course_scope === 'selected') {
    v.awaitingCourseSelection = true
    setState(v, 'waiting_course_selection', '课程检测完成，请选择本轮课程')
    if (Notification.isSupported()) {
      new Notification({
        title: '课程检测完成',
        body: `${a.name} 已检测 ${detected.length} 门课程，请返回程序选择本轮课程。`,
      }).show()
    }
    if (!selectionStartRequested) {
      await new Promise<void>((resolve) => courseSelectionWaiters.set(a.local_id, resolve))
    }
    courseSelectionWaiters.delete(a.local_id)
    v.awaitingCourseSelection = false
    if (stopFlag.has(a.local_id)) return
    runCourses = selectCoursesForRun(detected, 'selected', v.selectedCourseKeys)
    const selected = new Set(runCourses.map((course) => course.key || course.name))
    for (const course of v.courses) {
      if (!selected.has(course.key || course.name)) course.status = '本轮未选择'
    }
    if (!runCourses.length) {
      setState(v, 'round_ended', '本轮未选择课程', 'released')
      await release(a.local_id)
      return
    }
  }
  if (a.work_mode === 'extract') {
    setState(v, 'extracting', '提取题库（全部分数）')
    v.extractTotals = emptyExtractStats()
    v.extractTotalCourses = runCourses.length
    v.extractCompletedCourses = 0
    const extractionHomeworks = runCourses.flatMap((course) => course.homeworks
      .filter((hw) => hw.status === 'todo' || hw.status === 'extracting_done'))
    v.extractTotalHomeworks = extractionHomeworks.length
    v.extractCompletedHomeworks = extractionHomeworks.filter((hw) => hw.status === 'extracting_done').length
    v.extractHistoryPages = 0
    v.extractHistoryTotal = 0
    v.extractHistoryCompleted = 0
    v.extractCurrentHistory = ''
   const referenceTotals: ReferenceStats = { added: 0, updated: 0, merged: 0, retry: 0, contradictions: 0 }
    const jobs = extractionHomeworks
      .filter((hw) => Boolean(hw.page))
      .map((hw) => ({ course: runCourses.find((course) => course.homeworks.includes(hw))!, hw }))
    const refreshProgress = () => {
      v.extractCompletedHomeworks = extractionHomeworks.filter((hw) => hw.status === 'extracting_done').length
      v.extractCompletedCourses = runCourses.filter((course) => course.status !== '检测失败' && course.homeworks.every((hw) =>
        !extractionHomeworks.includes(hw) || hw.status === 'extracting_done')).length
    }
    const refreshTotals = () => {
      v.extractTotals = emptyExtractStats()
      for (const course of runCourses) {
        for (const hw of course.homeworks) {
          if (hw.extractStats) {
            v.extractTotals.added += hw.extractStats.added
            v.extractTotals.merged += hw.extractStats.merged
            v.extractTotals.skipped += hw.extractStats.skipped
            v.extractTotals.conflict += hw.extractStats.conflict
            v.extractTotals.failed += hw.extractStats.failed
          }
        }
      }
    }
    refreshTotals()
    refreshProgress()
    await mapWithConcurrency(jobs, 1, async ({ course: c, hw }) => {
      if (stopFlag.has(a.local_id)) return
      let pendingForHomework = 0
      hw.extractStats = emptyExtractStats()
      hw.status = 'extracting'
      refreshProgress()
      syncHomeworkView(v, c.key, hw)
      setState(v, 'extracting', '提取题库 · ' + c.name + ' · ' + hw.name)
      let graded: Awaited<ReturnType<typeof readHistory>>
      let skippedHistory = 0
      try {
        const historyRows = await stopAware(a.local_id, readHistory(hw.page!))
        if (stopFlag.has(a.local_id)) return
        graded = historyRows.filter((row) => row.status.includes('已批阅') && row.historyHref)
        skippedHistory = historyRows.length - graded.length
        v.extractHistoryTotal += graded.length
        refreshProgress()
        syncHomeworkView(v, c.key, hw)
      } catch {
        if (stopFlag.has(a.local_id)) return
        hw.extractStats.failed++
        refreshTotals()
        hw.status = 'extracting_done'
        refreshProgress()
        syncHomeworkView(v, c.key, hw)
        return
      }
      const historyStats = graded.map(() => emptyExtractStats())
      const syncHistoryStats = () => {
        hw.extractStats = { ...emptyExtractStats(), skipped: skippedHistory }
        for (const stats of historyStats) addExtractStats(hw.extractStats, stats)
        refreshTotals()
        syncHomeworkView(v, c.key, hw)
      }
      const historyQuestions: (ReviewedQuestion[] | null)[] = graded.map(() => null)
      await mapWithConcurrency(graded, 1, async (historyRow, historyIndex) => {
        if (stopFlag.has(a.local_id)) return
        try {
          historyQuestions[historyIndex] = await stopAware(a.local_id, withFreshHistoryPage(ctx, historyRow.historyHref!, readReviewedQuestions, () => stopFlag.has(a.local_id)))
       } catch {
          if (stopFlag.has(a.local_id)) return
       }
     })
      if (stopFlag.has(a.local_id)) return
      const unreadableHistories = historyQuestions.filter((questions) => !questions).length
      if (unreadableHistories) {
        for (const [historyIndex, questions] of historyQuestions.entries()) {
          if (!questions) historyStats[historyIndex].failed++
        }
        syncHistoryStats()
        setState(v, 'extracting', '历史读取失败 ' + unreadableHistories + ' 条，继续其它历史 · ' + c.name + ' · ' + hw.name)
      }
      const blockedHashes = contradictoryReferenceHashes(historyQuestions.flatMap((questions) => questions || []))
      await mapWithConcurrency(graded, 1, async (historyRow, historyIndex) => {
        if (stopFlag.has(a.local_id)) return
        v.extractHistoryPages++
        const historyLabel = (historyIndex + 1) + '/' + graded.length + ' · ' + (historyRow.submittedAt || '时间未知')
        v.extractCurrentHistory = historyLabel
        setState(v, 'extracting', '读取历史记录 · ' + c.name + ' · ' + hw.name + ' · 历史 ' + historyLabel)
        const questions = historyQuestions[historyIndex]
        if (!questions) {
          v.extractHistoryPages = Math.max(0, v.extractHistoryPages - 1)
          v.extractHistoryCompleted++
          syncHistoryStats()
          return
        }
       if (questions.some((q) => q.referenceState === 'valid')) {
          emitProgress({ local_id: a.local_id, slot: v.slot, account: v.account,
            action: '切换到有参考答案分支，根据参考答案进行题库提取', courseName: c.name, courseKey: c.key,
            homeworkName: hw.name, bankCount: v.bankCount, aiCount: v.aiCount })
        }
        if (questions.some((q) => q.referenceState === 'absent')) {
          emitProgress({ local_id: a.local_id, slot: v.slot, account: v.account,
            action: '按照原模式继续提取题库', courseName: c.name, courseKey: c.key,
            homeworkName: hw.name, bankCount: v.bankCount, aiCount: v.aiCount })
        }
        try {
          const result = await stopAware(a.local_id, withFreshHistoryPage(ctx, historyRow.historyHref!, (history) =>
            extractReviewedQuestions(history, c.name, (stats, current, total) => {
              if (stopFlag.has(a.local_id)) return
              historyStats[historyIndex] = { ...stats }
              syncHistoryStats()
              v.extractCurrentHistory = historyLabel
              setState(v, 'extracting', '提取正确题 · ' + c.name + ' · ' + hw.name + ' · 历史 ' + historyLabel + ' · 第 ' + current + '/' + total + ' 题')
            }, () => stopFlag.has(a.local_id), { questions: historyQuestions[historyIndex]!, blockedHashes }), () => stopFlag.has(a.local_id)))
          if (stopFlag.has(a.local_id)) return
          historyStats[historyIndex] = {
            added: result.added,
            merged: result.merged,
            skipped: result.skipped,
            conflict: result.conflict,
            failed: result.failed,
          }
          for (const key of Object.keys(referenceTotals) as (keyof ReferenceStats)[]) referenceTotals[key] += result.referenceStats[key]
         if (result.failedCandidates.length) {
            pendingForHomework++
           appendExtractWriteback({
              local_id: a.local_id,
              course_name: c.name,
              homework_id: hw.name,
              history_href: historyRow.historyHref!,
              candidates: result.failedCandidates,
              created_at: new Date().toISOString(),
            })
          }
        } catch (error) {
          if (stopFlag.has(a.local_id)) return
          if (error instanceof ExtractWritebackSaveError) throw error
          historyStats[historyIndex].failed++
         setState(v, 'extracting', '提取题库 · ' + c.name + ' · ' + hw.name + ' · 历史读取失败')
        } finally {
          v.extractHistoryPages = Math.max(0, v.extractHistoryPages - 1)
        }
        v.extractHistoryCompleted++
        syncHistoryStats()
      })
      if (stopFlag.has(a.local_id)) return
      hw.status = pendingForHomework ? 'pending_writeback' : 'extracting_done'
      refreshTotals()
      refreshProgress()
      syncHomeworkView(v, c.key, hw)
    })
   if (stopFlag.has(a.local_id)) return
    await flushExtractWriteback(a, v)
    for (const course of runCourses) for (const hw of course.homeworks) {
      if (hw.status !== 'pending_writeback') continue
      const retained = getExtractWriteback(a.local_id).some((item) => item.course_name === course.name && item.homework_id === hw.name)
      if (!retained) { hw.status = 'extracting_done'; syncHomeworkView(v, course.key, hw) }
    }
   refreshProgress()
   v.extractCurrentHistory = ''
   const failedCourses = runCourses.filter((course) => course.status === '检测失败').length
    const pendingItems = getExtractWriteback(a.local_id).length + referenceTotals.retry
    const completion = extractCompletionLabel(v.extractTotals, failedCourses, pendingItems)
    setState(v, 'round_ended', completion + ' · 原模式新增 ' + v.extractTotals.added + ' · 去重 ' + v.extractTotals.merged + ' · 跳过 ' + v.extractTotals.skipped + ' · 冲突 ' + v.extractTotals.conflict + ' · 写入失败 ' + v.extractTotals.failed + ' · 参考答案新增 ' + referenceTotals.added + ' · 更新 ' + referenceTotals.updated + ' · 去重 ' + referenceTotals.merged + ' · 待重试 ' + referenceTotals.retry + ' · 矛盾跳过 ' + referenceTotals.contradictions, 'released')
    await release(a.local_id)
    return
  }
  setState(v, 'auto_answering', '自动开答')
  resetAsked()
  let verified = false
  // Each student walks every course in portal order; review finishes before the next job.
  for (const c of runCourses) {
    if (c.status === '检测失败') continue
    for (const hw of c.homeworks) {
      if (stopFlag.has(a.local_id)) return
      if (!hw.needDo) continue
      if (blockedWriteback.has(c.name + '\0' + hw.name)) {
        hw.status = 'pending_writeback'
        syncHomeworkView(v, c.key || c.name, hw)
        setState(v, 'auto_answering', '本份仍待回写，跳过作答 · ' + c.name + ' · ' + hw.name)
        continue
      }
      try {
        await doHomeworkLoop(a, v, hw, c, () => verified, (x) => { verified = x })
        if (stopFlag.has(a.local_id)) return
        if (hw.status === 'submit_failed') {
          setState(v, 'auto_answering', '本份失败，继续下一份 · ' + c.name + ' · ' + hw.name)
        }
      } catch (error) {
        if (stopFlag.has(a.local_id)) return
        hw.status = 'submit_failed'
        syncHomeworkView(v, c.key || c.name, hw)
        const reason = error instanceof Error ? error.message : '未知错误'
        setState(v, 'auto_answering', '本份异常，继续下一份 · ' + c.name + ' · ' + hw.name + ' · ' + reason)
      }
    }
    const course = v.courses.find((row) => row.key === (c.key || c.name))
    if (course) course.status = courseOutcome(c.homeworks.map((hw) => hw.status))
    setState(v, 'auto_answering', '课程处理结果 · ' + c.name + ' · ' + (course?.status || ''))
  }
  if (stopFlag.has(a.local_id)) return
  const runCourseKeys = new Set(runCourses.map((course) => course.key || course.name))
  const unfinished = v.courses.filter((c) => runCourseKeys.has(c.key || c.name) && !['无作业', '本轮可做作业已完成'].includes(c.status)).length
  const pending = getWriteback().filter((item) => item.local_id === a.local_id).length
  setState(v, 'round_ended', unfinished || pending
    ? `已遍历本轮 ${runCourses.length} 门课程；仍有 ${unfinished} 门未完成、${pending} 份待回写`
    : `本轮 ${runCourses.length} 门课程可做作业已完成并回写，其余按规则跳过`, 'released')
  await release(a.local_id)
}

function appendExtractWriteback(item: ExtractWritebackItem) {
  const all = getExtractWriteback().filter((current) => !(
    current.local_id === item.local_id &&
    current.course_name === item.course_name &&
    current.homework_id === item.homework_id &&
    current.history_href === item.history_href
  ))
  all.push(item)
  saveExtractWriteback(all)
}

async function flushExtractWriteback(a: LocalAccount, v: StudentView) {
  const own = getExtractWriteback(a.local_id)
  if (!own.length) return
  const retained: ExtractWritebackItem[] = []
  for (const item of own) {
    const pending: ExtractWritebackItem['candidates'] = []
    for (const candidate of item.candidates) {
      const status = await upsertQuestion({
        qtype: candidate.qtype,
        stem: candidate.stem,
        options: candidate.options,
        answer_texts: candidate.answer_texts,
        course_name: item.course_name,
        source: 'extract',
        verified: true,
      })
      if (status === 'failed') pending.push(candidate)
    }
    if (pending.length) retained.push({ ...item, candidates: pending })
    else setState(v, 'flushing_writeback', '提取题库待写入已补偿 · ' + item.homework_id, 'occupied')
  }
  saveExtractWriteback([...getExtractWriteback().filter((item) => item.local_id !== a.local_id), ...retained])
}

async function doHomeworkLoop(
  a: LocalAccount,
  v: StudentView,
  hw: DetectedHomework,
  course: DetectedCourse,
  getVerified: () => boolean,
  setVerified: (x: boolean) => void,
) {
  const courseName = course.name
  const courseKey = course.key || course.name
  if (!hw.page) return
  const max = hw.remainingCap
  let lastScore = -1
  let emptySpin = 0
  for (let n = 0; n < max; n++) {
    if (stopFlag.has(a.local_id)) return
    hw.attempt = n + 1
    hw.score = null
    hw.status = 'clicking_do_homework'
    syncHomeworkView(v, courseKey, hw)
    setState(v, 'auto_answering', '作答 ' + hw.name)
    const before = (await readHistory(hw.page)).map((r) => r.submittedAt)
    const answer = await openDoHomework(a, v, hw.page, courseName, hw.name, setVerified, false)
    if (stopFlag.has(a.local_id)) return
    if (!answer) {
      hw.status = 'submit_failed'
      syncHomeworkView(v, courseKey, hw)
      setState(v, 'auto_answering', '点做作业后未进入作答页，本站页面或验证未放行 · ' + hw.name)
      return
    }
    let ans
    const bankBase = v.bankCount
    const aiBase = v.aiCount
    const liveCourse = v.courses.find((item) => item.key === courseKey)
    const courseBankBase = liveCourse?.bankCount || 0
    const courseAiBase = liveCourse?.aiCount || 0
    hw.status = 'answering'
    syncHomeworkView(v, courseKey, hw, [])
    try {
      ans = await answerPage({
      page: answer,
      local_id: a.local_id,
      slot: v.slot,
      account: 'auto_answering',
      courseName,
      homeworkName: hw.name,
      onQuestion: (result, total, bank, ai) => {
        v.bankCount = bankBase + bank
        v.aiCount = aiBase + ai
        if (liveCourse) {
          liveCourse.bankCount = courseBankBase + bank
          liveCourse.aiCount = courseAiBase + ai
          const group = liveCourse.groups.find((g) => g.title === (hw.section === 'onlineHomework' ? '网上记分作业' : '阶段性测验'))
          const row = group?.rows.find((r) => r.name === hw.name)
          if (row) recordQuestion(row, { no: Number(result.no), stem: result.stem, source: result.source === '题库答题' ? '题库' : result.source === 'AI 答题' ? 'AI' : '空过' }, total)
        }
      },
    })
    } catch (error) {
      if (stopFlag.has(a.local_id)) return
      if (error instanceof ListeningBankMissError) {
        hw.status = 'skip_bank_miss'
        hw.attempt = 0
        syncHomeworkView(v, courseKey, hw, [])
        setState(v, 'auto_answering', hw.name + ' · ' + error.message)
        return
      }
      hw.status = 'submit_failed'
      syncHomeworkView(v, courseKey, hw)
      const reason = error instanceof Error ? error.message : '未知错误'
      setState(v, 'auto_answering', '作答失败 · ' + hw.name + ' · ' + reason)
      return
    }
    if (stopFlag.has(a.local_id)) return
    v.bankCount = bankBase + ans.bankCount
    v.aiCount = aiBase + ans.aiCount
    const course = v.courses.find((item) => item.key === courseKey)
    if (course) {
      course.bankCount = courseBankBase + ans.bankCount
      course.aiCount = courseAiBase + ans.aiCount
    }
    hw.status = 'answering'
    syncHomeworkView(v, courseKey, hw, ans.results.map((result) => ({
      no: Number(result.no) || 0,
      stem: result.stem,
      source: result.source === '题库答题' ? '题库' : result.source === 'AI 答题' ? 'AI' : '空过',
    })))
    emitProgress({
      local_id: a.local_id,
      slot: v.slot,
      account: v.account,
      action: '作答结果已更新',
      courseName,
      homeworkName: hw.name,
      homework: 'answering',
      questionTotal: ans.results.length,
      bankCount: v.bankCount,
      aiCount: v.aiCount,
    })
    hw.status = 'submitting'
    syncHomeworkView(v, courseKey, hw)
    const sub = await submitHomework({ page: answer, local_id: a.local_id, slot: v.slot, account: 'auto_answering', homeworkName: hw.name, verifiedComposite: ans.compositeVerified })
    if (stopFlag.has(a.local_id)) return
    if (!sub.ok) {
      hw.status = 'submit_failed'
      syncHomeworkView(v, courseKey, hw)
      setState(v, 'auto_answering', (sub.incomplete ? '仍有未作答题，已取消提交' : '提交确认弹窗未完成，未确认交卷') + ' · ' + hw.name)
      return
    }
    await hw.page.bringToFront().catch(() => {})
    await hw.page.reload().catch(() => {})
    await hw.page.locator(SEL.historyTable).waitFor({ timeout: 15000 }).catch(() => {})
    let historyPage = hw.page
    let okHist = await historyHasNew(historyPage, before)
    if (!okHist) {
      try {
        const path = new URL(answer.url()).pathname
        if (path.includes('assignment-preview.aspx')) {
          await answer.locator(SEL.historyTable).waitFor({ timeout: 8000 }).catch(() => {})
          okHist = await historyHasNew(answer, before)
          if (okHist) historyPage = answer
        }
      } catch { /* 作答页已关 */ }
    }
    if (!okHist) {
      hw.status = 'submit_failed'
      syncHomeworkView(v, courseKey, hw)
      setState(v, 'auto_answering', '提交后历史未出现本次交卷记录，结果未确认，跳过本份 · ' + hw.name)
      return
    }
    hw.status = 'waiting_grade'
    syncHomeworkView(v, courseKey, hw)
    setState(v, 'auto_answering', '等待批阅 · ' + hw.name)
    emitProgress({
      local_id: a.local_id, slot: v.slot, account: v.account,
      action: '等待批阅', homeworkName: hw.name, homework: 'waiting_grade',
      courseName, bankCount: v.bankCount, aiCount: v.aiCount,
    })
    // Keep recovery evidence before waiting; normal execution must finish this writeback now.
    appendWriteback({
      local_id: a.local_id, course_name: courseName, homework_id: hw.name,
      preview_href: hw.page.url(), history_href: '',
      candidates: ans.results.filter((r) => r.source !== '空过'),
      need_insert_hashes: ans.results.filter((r) => r.source === 'AI 答题').map((r) => r.hash),
      need_delete_hashes: ans.results.filter((r) => r.source === '题库答题').map((r) => r.hash),
      created_at: new Date().toISOString(),
    })
    let graded: Awaited<ReturnType<typeof readHistory>>[number] | null = null
    const gradeDeadline = Date.now() + 120_000
    while (!stopFlag.has(a.local_id) && !graded && Date.now() < gradeDeadline) {
      const hist = await readHistory(historyPage)
      const latest = newSubmission(hist, before)
      graded = latest?.status.includes('已批阅') && latest.historyHref ? latest : null
      if (graded) break
      setState(v, 'auto_answering', '等待本次批阅后立即回写 · ' + hw.name, 'occupied')
      await waitMs(WRITEBACK_RETRY_MS)
      await historyPage.reload().catch(() => {})
      await historyPage.locator(SEL.historyTable).waitFor({ timeout: 15000 }).catch(() => {})
    }
    if (!graded) {
      if (stopFlag.has(a.local_id)) return
      hw.status = 'pending_writeback'
      syncHomeworkView(v, courseKey, hw)
      setState(v, 'auto_answering', '本次已提交，批阅超过两分钟未出；保留待回写并继续下一份 · ' + hw.name)
      return
    }
    const historyHref = graded.historyHref!
    hw.score = graded?.score ?? null
    if (hw.score != null) {
      hw.lastAttempt = hw.attempt
      hw.lastScore = hw.score
    }
    syncHomeworkView(v, courseKey, hw)
    hw.status = 'reviewing'
    syncHomeworkView(v, courseKey, hw)
    setState(v, 'auto_answering', '校对中 · ' + hw.name)
    emitProgress({
      local_id: a.local_id, slot: v.slot, account: v.account,
      action: '校对中', homeworkName: hw.name, homework: 'reviewing',
      courseName, bankCount: v.bankCount, aiCount: v.aiCount,
    })
    // Persist before cloud mutations so interruption cannot discard correction evidence.
    appendWriteback({
      local_id: a.local_id, course_name: courseName, homework_id: hw.name,
      preview_href: hw.page.url(), history_href: historyHref,
      candidates: ans.results.filter((r) => r.source !== '空过'),
      need_insert_hashes: [], need_delete_hashes: [], created_at: new Date().toISOString(),
    })
    let review = await maybeReview(hw.page, ans.results, courseName, historyHref)
    let totalInserted = review.inserted
    let totalDeleted = review.deleted
    let totalConflicts = review.conflicts
    const referenceTotals = { ...review.referenceStats }
    let protectedDeletes = review.protectedDeletes || 0
    for (const [count, action] of [[review.oldModeQuestions, '继续校对回写（原模式）'], [review.referenceQuestions, '切换到有参考答案分支，根据参考答案进行题库回写']] as const) {
      if (count) emitProgress({ local_id: a.local_id, slot: v.slot, account: v.account, action,
        courseName, courseKey, homeworkName: hw.name, bankCount: v.bankCount, aiCount: v.aiCount })
    }
    if (hw.score == null && review.score != null) {
      hw.score = review.score
      hw.lastAttempt = hw.attempt
      hw.lastScore = review.score
      syncHomeworkView(v, courseKey, hw)
    }
    emitProgress({
      local_id: a.local_id, slot: v.slot, account: v.account,
      action: `校对读取 ${review.reviewed} 题，匹配 ${review.matched} 题，对错可判定 ${review.graded} 题，错题 ${review.wrong}（题库 ${review.bankWrong}/AI ${review.aiWrong}）`,
      courseName, homeworkName: hw.name, homework: 'reviewing',
      bankCount: v.bankCount, aiCount: v.aiCount,
    })
    if (review.pendingCandidates.length && !stopFlag.has(a.local_id)) {
      hw.status = 'pending_writeback'
      syncHomeworkView(v, courseKey, hw)
      appendWriteback({
        local_id: a.local_id,
        course_name: courseName,
        homework_id: hw.name,
        preview_href: hw.page.url(),
        history_href: historyHref,
        need_insert_hashes: review.pendingInsertHashes,
        need_delete_hashes: review.pendingDeleteHashes,
        candidates: review.pendingCandidates,
        created_at: new Date().toISOString(),
      })
      setState(v, 'flushing_writeback', `回写待处理 ${review.pendingCandidates.length} 项（参考待重试 ${review.referenceStats.retry}、写入失败 ${review.pendingInsertHashes.length}、删除失败 ${review.pendingDeleteHashes.length}）· ${hw.name}`, 'occupied')
      await waitMs(WRITEBACK_RETRY_MS)
      const retry = await maybeReview(hw.page, review.pendingCandidates, courseName, historyHref)
      totalInserted += retry.inserted
      totalDeleted += retry.deleted
      totalConflicts += retry.conflicts
      referenceTotals.added += retry.referenceStats.added
      referenceTotals.updated += retry.referenceStats.updated
      referenceTotals.merged += retry.referenceStats.merged
      referenceTotals.retry = retry.referenceStats.retry
      referenceTotals.contradictions += retry.referenceStats.contradictions
      protectedDeletes += retry.protectedDeletes || 0
      review = { ...retry, inserted: totalInserted, deleted: totalDeleted, conflicts: totalConflicts, referenceStats: { ...referenceTotals }, protectedDeletes }
      if (review.pendingCandidates.length) {
        appendWriteback({
          local_id: a.local_id, course_name: courseName, homework_id: hw.name,
          preview_href: hw.page.url(), history_href: historyHref,
          need_insert_hashes: review.pendingInsertHashes, need_delete_hashes: review.pendingDeleteHashes,
          candidates: review.pendingCandidates, created_at: new Date().toISOString(),
        })
        setState(v, 'auto_answering', '本份回写仍待处理，继续下一份 · ' + hw.name)
        return
      }
      hw.status = 'reviewing'
      syncHomeworkView(v, courseKey, hw)
    }
    if (stopFlag.has(a.local_id)) return
    saveWriteback(getWriteback().filter((item) => !(item.local_id === a.local_id && item.course_name === courseName && item.homework_id === hw.name)))
    emitProgress({
      local_id: a.local_id, slot: v.slot, account: v.account,
      action: '校对完成 · 原模式 AI正确入库 ' + review.inserted + ' · 冲突标记 ' + review.conflicts + ' · 题库错删 ' + review.deleted + ' · 保护跳过 ' + protectedDeletes + ' · 参考答案新增 ' + referenceTotals.added + ' · 更新 ' + referenceTotals.updated + ' · 去重 ' + referenceTotals.merged + ' · 待重试 ' + referenceTotals.retry + ' · 矛盾跳过 ' + referenceTotals.contradictions,
      homeworkName: hw.name, homework: 'reviewing',
      courseName, bankCount: v.bankCount, aiCount: v.aiCount,
    })
    if (hw.score === 100) {
      hw.status = 'done_100'
      syncHomeworkView(v, courseKey, hw)
      return
    }
    if (hw.score === lastScore && review.inserted === 0 && review.deleted === 0 &&
        ans.results.some((r) => r.source === '空过') &&
        ans.results.every((r) => r.source === '空过' || r.source === '题库答题')) emptySpin++
    else emptySpin = 0
    lastScore = hw.score || 0
    if (emptySpin >= 1) {
      hw.status = 'spin_stopped'
      syncHomeworkView(v, courseKey, hw)
      return
    }
    hw.status = 'not_full_next_time'
    syncHomeworkView(v, courseKey, hw)
  }
}

function othersPage(page: Page, pathPart: string): Page | undefined {
  const homeworkId = new URL(page.url()).searchParams.get('homeWorkId')
  return page.context().pages().find((p) => {
    try {
      const url = new URL(p.url())
      return Boolean(homeworkId) && url.pathname.includes(pathPart) && url.searchParams.get('homeWorkId') === homeworkId
    } catch { return false }
  })
}

function studyUrl(href: string) {
  return href.startsWith('http') ? href : 'https://l.shou.org.cn' + href
}

async function withFreshHistoryPage<T>(
  context: BrowserContext,
  historyHref: string,
  read: (page: Page) => Promise<T>,
  shouldStop: () => boolean = () => false,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (shouldStop()) throw new Error('任务已停止')
    const page = await context.newPage()
    try {
      const response = await page.goto(studyUrl(historyHref), { waitUntil: 'domcontentloaded' })
      if (response && !response.ok()) throw new Error(`批阅页 HTTP ${response.status()}`)
      await page.locator('.e-q-body').first().waitFor({ timeout: 20000 })
      return await read(page)
    } catch (error) {
      lastError = error
      if (shouldStop()) throw error
    } finally {
      await page.close().catch(() => {})
    }
  }
  throw lastError instanceof Error ? lastError : new Error('批阅页读取失败')
}

function appendWriteback(item: Parameters<typeof saveWriteback>[0][number]) {
  const all = getWriteback().filter((x) => !(x.local_id === item.local_id && x.course_name === item.course_name && x.homework_id === item.homework_id))
  all.push(item)
  saveWriteback(all)
}

function pendingReview(results: QResult[]): ReviewOutcome {
  return {
    reviewed: 0,
    matched: 0,
    graded: 0,
    inserted: 0,
    conflicts: 0,
    deleted: 0,
    wrong: 0,
    bankWrong: 0,
    aiWrong: 0,
    deleteFailed: 0,
    pendingCandidates: results.filter((r) => r.source !== '空过'),
    pendingInsertHashes: results.filter((r) => r.source === 'AI 答题').map((r) => r.hash),
    pendingDeleteHashes: results.filter((r) => r.source === '题库答题').map((r) => r.hash),
    score: null,
    referenceStats: { added: 0, updated: 0, merged: 0, retry: 0, contradictions: 0 },
    oldModeQuestions: 0,
    referenceQuestions: 0,
  }
}

async function flushWriteback(a: LocalAccount, v: StudentView, ctx: BrowserContext) {
  const blocked = new Set<string>()
  const all = getWriteback()
  const retained: typeof all = []
  const own = all.filter((item) => item.local_id === a.local_id)
  for (const item of own) {
    const key = (item.course_name || '') + '\0' + item.homework_id
    blocked.add(key)
    if (!item.candidates?.length || (!item.history_href && !item.preview_href)) {
      retained.push(item)
      continue
    }
    setState(v, 'flushing_writeback', '待回写补抽 · ' + item.homework_id, 'occupied')
    emitProgress({
      local_id: a.local_id, slot: v.slot, account: v.account,
      action: '待回写补抽', homeworkName: item.homework_id, homework: 'pending_writeback',
      courseName: item.course_name, bankCount: v.bankCount, aiCount: v.aiCount,
    })
    try {
      let historyHref = item.history_href
      if (!historyHref) {
        const preview = await ctx.newPage()
        try {
          await preview.goto(studyUrl(item.preview_href || ''), { waitUntil: 'domcontentloaded' })
          const row = newestHistory(await readHistory(preview))
          if (!row?.status.includes('已批阅') || !row.historyHref) throw new Error('最新记录尚未批阅')
          historyHref = row.historyHref
        } finally {
          await preview.close().catch(() => {})
        }
      }
      const outcome = await withFreshHistoryPage(ctx, historyHref, (history) =>
        reviewResults(history, item.candidates!, item.course_name || ''))
      setState(v, 'flushing_writeback', `补偿读取 ${outcome.reviewed} 题，匹配 ${outcome.matched} 题，对错可判定 ${outcome.graded} 题`, 'occupied')
      if (outcome.pendingCandidates.length) {
        emitProgress({
          local_id: a.local_id, slot: v.slot, account: v.account,
          action: `回写仍待处理 ${outcome.pendingCandidates.length} 项（参考待重试 ${outcome.referenceStats.retry}、写入失败 ${outcome.pendingInsertHashes.length}、删除失败 ${outcome.pendingDeleteHashes.length}）`,
          homeworkName: item.homework_id, homework: 'pending_writeback',
          courseName: item.course_name, bankCount: v.bankCount, aiCount: v.aiCount,
        })
        retained.push({
          ...item,
          history_href: historyHref,
          need_insert_hashes: outcome.pendingInsertHashes,
          need_delete_hashes: outcome.pendingDeleteHashes,
          candidates: outcome.pendingCandidates,
        })
      } else {
        blocked.delete(key)
        emitProgress({
          local_id: a.local_id, slot: v.slot, account: v.account,
          action: '待回写完成 · AI正确入库 ' + outcome.inserted + ' · 题库错删 ' + outcome.deleted + ' · 删除失败 ' + outcome.deleteFailed,
          homeworkName: item.homework_id, homework: 'reviewing',
          courseName: item.course_name, bankCount: v.bankCount, aiCount: v.aiCount,
        })
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      emitProgress({
        local_id: a.local_id, slot: v.slot, account: v.account,
        action: '待回写补抽失败 · ' + reason, homeworkName: item.homework_id,
        homework: 'pending_writeback', courseName: item.course_name,
        bankCount: v.bankCount, aiCount: v.aiCount,
      })
      retained.push(item)
    }
  }
  saveWriteback(mergeAccountWriteback(getWriteback(), a.local_id, retained))
  return blocked
}

async function openDoHomework(
  a: LocalAccount,
  v: StudentView,
  preview: Page,
  courseName: string,
  homeworkName: string,
  setVerified: (x: boolean) => void,
  retried: boolean,
): Promise<Page | undefined> {
  if (!verifiedAccounts.has(a.local_id)) {
    const clicks = unverifiedClicks.get(a.local_id) || 0
    if (!canClickDoHomework(false, clicks)) {
      if (!verificationSessions.has(a.local_id)) {
        setState(v, 'needs_verify', '等待当前扫码验证', 'occupying_verify')
        return undefined
      }
      setState(v, 'needs_verify', '等待当前扫码完成', 'occupying_verify')
      await waitForVerification(a.local_id)
      setVerified(true)
    }
    unverifiedClicks.set(a.local_id, clicks + 1)
  }
  emitProgress({
    local_id: a.local_id, slot: v.slot, account: v.account, action: '点做作业',
    homeworkName, homework: 'clicking_do_homework', courseName, bankCount: v.bankCount, aiCount: v.aiCount, click: '做作业',
  })
  const popupP = preview.context().waitForEvent('page', { timeout: 8000 }).catch(() => null)
  try {
    await preview.locator(SEL.doHomework).first().click({ timeout: 8000 })
  } catch {
    return undefined
  }
  let qr = false
  for (let i = 0; i < 8; i++) {
    await preview.waitForTimeout(400)
    if (await hasQr(preview)) { qr = true; break }
    try {
      if (isAnswerPath(new URL(preview.url()).pathname)) break
    } catch { /* URL 未就绪 */ }
    if (othersPage(preview, PATH.assignmentAnswer)) break
  }
  if (qr) {
    await waitForVerify(a.local_id, preview, 'qr-gone', { courseName, homeworkName })
    setVerified(true)
    for (const p of preview.context().pages()) {
      try {
        const path = new URL(p.url()).pathname
        if (path.includes('assignment-preview.aspx') && !isAnswerPath(path)) await p.reload().catch(() => {})
      } catch {
        /* 忽略坏 URL */
      }
    }
    if (retried) return undefined
    return openDoHomework(a, v, preview, courseName, homeworkName, setVerified, true)
  }
  const popup = await popupP
  let answerPage: Page | undefined
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {})
    try {
      if (isAnswerPath(new URL(popup.url()).pathname)) answerPage = popup
    } catch {
      /* 新页 URL 未就绪 */
    }
  }
  if (!answerPage) try {
    if (isAnswerPath(new URL(preview.url()).pathname)) answerPage = preview
  } catch { /* 当前页 URL 未就绪 */ }
  for (let i = 0; i < 20 && !answerPage; i++) {
    answerPage = othersPage(preview, PATH.assignmentAnswer)
    if (answerPage) break
    await preview.waitForTimeout(400)
  }
  if (!answerPage) return undefined
  setVerified(true)
  markHomeworkVerified(a.local_id)
  return answerPage
}

async function maybeReview(preview: Page, results: QResult[], courseName: string, historyHref: string): Promise<ReviewOutcome> {
  if (!results.some((r) => r.source !== '空过')) return pendingReview([])
  if (!historyHref) return pendingReview(results)
  try {
    return await withFreshHistoryPage(preview.context(), historyHref, (history) =>
      reviewResults(history, results, courseName))
  } catch {
    return pendingReview(results)
  }
}

function scheduleStudent(a: LocalAccount) {
  if (activeRuns.has(a.local_id) || stoppingAll) return false
  stopFlag.delete(a.local_id)
  stopControllers.set(a.local_id, new AbortController())
  runAccountIds.add(a.local_id)
  const task = Promise.resolve().then(() => runOne(a)).catch(async (e) => {
    const v = viewOf(a)
    const reason = e instanceof Error ? e.message : '未知运行异常'
    setState(v, 'stopped', '本学生已停止 · ' + reason, 'released')
  }).finally(async () => {
    await release(a.local_id)
    activeRuns.delete(a.local_id)
    runAccountIds.delete(a.local_id)
    stopControllers.delete(a.local_id)
    clearVerification(a.local_id, true)
    if (!activeRuns.size) {
      runConcurrency = null
      selectionStartRequested = false
    }
  })
  activeRuns.set(a.local_id, task)
  return true
}

export function startStudent(local_id: string) {
  const account = listAccounts().find((a) => a.local_id === local_id)
  if (!account) return { ok: false, error: '学生账号不存在' }
  if (stoppingAll || isStudentLocked(local_id)) return { ok: false, error: '该学生正在运行、排队或停止中' }
  if (!isRunning()) {
    runConcurrency = concurrencySnapshot(getSettings())
    slots.setLimit(runConcurrency.account_parallel)
    selectionStartRequested = false
  }
  scheduleStudent(account)
  return { ok: true }
}

export function enqueueNewStudents(ids: string[]) {
  if (!isRunning() || stoppingAll) return 0
  const wanted = new Set(ids)
  let count = 0
  for (const account of listAccounts()) if (wanted.has(account.local_id) && scheduleStudent(account)) count++
  return count
}

export async function stopAllStudents() {
  stoppingAll = true
  try {
    await Promise.all([...activeRuns.keys()].map((id) => stopStudent(id)))
    await Promise.all([...activeRuns.values()])
  } finally {
    runConcurrency = null
    selectionStartRequested = false
    stoppingAll = false
  }
}

export async function loginAndRefresh(accountIds?: string[]) {
  if (isRunning()) return { ok: false, error: '任务运行中，请单独开始或停止学生' }
  const accounts = listAccounts().filter((a) => !accountIds || accountIds.includes(a.local_id))
  if (!accounts.length) return { ok: false, error: '请先添加学生账号' }
  runConcurrency = concurrencySnapshot(getSettings())
  slots.setLimit(runConcurrency.account_parallel)
  selectionStartRequested = false
  for (const account of accounts) scheduleStudent(account)
  await Promise.all(accounts.map((a) => activeRuns.get(a.local_id)!))
  return { ok: true }
}

export { views }
