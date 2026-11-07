import type { BrowserContext, Page } from 'patchright'
import { acquire, browserWindowVisible, getContext, isHeld, onPoolRelease, release, slots } from '../pool.ts'
import { getSettings, listAccounts, patchAccount, type LocalAccount } from '../store.ts'
import { mapWithConcurrency } from '../core/concurrency.ts'
import { courseOutcome, recordQuestion, upsertHomework } from '../core/live-view.ts'
import { getAccountWorkMode } from '../store.ts'
import { NoqrAiClient } from './ai-client.ts'
import { createReadOnlyBankClient } from './bank-readonly.ts'
import {
  answerNoqrGroup,
  saveNoqrAnswerAndAdvance,
  waitForNoqrAnswerReady,
} from './answer.ts'
import {
  buildNoqrQuestionGroupSessionKey,
  readNoqrQuestionGroup,
  type NoqrQuestionKind,
} from './question.ts'
import { openNoqrCourseWork, readNoqrCourseMenu, switchNoqrCourse, waitForNoqrCourseWorkReady } from './course.ts'
import {
  evaluateNoqrHomeworkRule,
  noqrHomeworkRuleStatus,
  openNoqrHomework,
  readNoqrHomeworks,
  resolveNoqrHomeworkCard,
  shouldResetNoqrCoursePage,
} from './homework.ts'
import {
  newestFreshNoqrHistoryRecord,
  readNoqrHistoryAfterOpen,
  type NoqrFreshRecordEvidence,
  type NoqrHistoryRecord,
} from './history.ts'
import { NoqrMutationObserver } from './network.ts'
import {
  NOQR_ANSWER_CARD_HARD_WAIT_MS,
  NOQR_ANSWER_BOOT_HARD_WAIT_MS,
  NOQR_SCORE_PENDING_WAIT_MS,
  withNoqrHardDeadline,
} from './limits.ts'
import { recoverNoqrCourseWorkWithoutLogin } from './recovery.ts'
import { NOQR_PATH, NOQR_SEL } from './selectors.ts'
import {
  isNoqrFatalWorkflowError,
  NoqrScoreUnavailableError,
  NoqrUnsupportedNonObjectiveError,
  noqrHomeworkFailureStatus,
  shouldDegradeNoqrBaselineFailure,
} from './workflow-errors.ts'
import {
  applyNoqrFailureToView,
  assertNoqrRecordPageCanReturn,
  detectNoqrAnswerPageInterruption,
  isNoqrAccountTerminalError,
  shouldRestoreNoqrRecordPage,
  shouldStopNoqrCourseAfterHomeworkFailure,
  terminalNoqrPhase,
} from './page-policy.ts'
import { newNoqrHistoryCache } from './score-cache.ts'
import {
  createNoqrTimingAccumulator,
  noqrPacingDelayMs,
  noqrPacingElapsedMs,
  recordNoqrGroupTiming,
  snapshotNoqrTiming,
  type NoqrHomeworkTiming,
} from './timing.ts'
import {
  auditNoqrAnswerCard,
  goToNoqrAnswerCardQuestion,
  noqrAnswerCardGroupKeys,
  noqrAnswerCardExpectedGroups,
  noqrAnswerCardKey,
  preflightNoqrObjectiveOnlyAnswerCard,
  readNoqrAnswerCardDiagnostic,
  returnToNoqrCourseWork,
  submitNoqrHomework,
  type NoqrExpectedAnswerCardGroup,
} from './submit.ts'
import { waitForNoqrAnswerSurfaceBeforeSubmit } from './submit-surface.ts'
import {
  classifyNoqrPage,
  ensureNoqrHomeReady,
  ensureNoqrSession,
  NoqrNetworkActivity,
  NoqrSessionError,
  sleepNoqr,
} from './session.ts'
import { withNoqrStartupLock } from './startup-queue.ts'
import {
  createNoqrStudentView,
  emptyNoqrQuestionKindCounts,
  noqrRunOutcome,
  recordNoqrSavedQuestionKind,
  recordNoqrSavedQuestionKindSlots,
  resetNoqrStudentRunView,
  sanitizeNoqrLogText,
  type NoqrCourseLog,
  type NoqrQuestionKindCounts,
  type NoqrStudentView,
} from './view.ts'
import type { NoqrCourse, NoqrHomework, NoqrPhase } from './types.ts'
import type { LiveHomework, LiveHomeworkGroup } from '../core/live-view.ts'

type NoqrHomeworkSlotRow = LiveHomework & {
  questionKindSlotCounts?: NoqrQuestionKindCounts
}

type NoqrRunOptions = {
  localId: string
  account: LocalAccount
  context: BrowserContext
  signal: AbortSignal
  view: NoqrStudentView
  settings: ReturnType<typeof getSettings>
}

const views = new Map<string, NoqrStudentView>()
const activeRuns = new Map<string, Promise<void>>()
const stopFlags = new Set<string>()
const stopControllers = new Map<string, AbortController>()
const queuedWaiters = new Map<string, () => void>()
const selectionWaiters = new Map<string, () => void>()
const historyCache = newNoqrHistoryCache()
const changeListeners = new Set<() => void>()
let stoppingAll = false
const selectionStartTokens = new Set<string>()
let detailLogsEnabled = true
onPoolRelease((event) => {
  if (event.reason === 'context_closed') {
    stopControllers.get(event.localId)?.abort()
  }
  const view = views.get(event.localId)
  if (view) {
    view.slot = slots.get(event.localId)
    view.configLocked = activeRuns.has(event.localId) ||
      isHeld(event.localId) ||
      noqrSlotHoldsCapacity(view.slot)
    view.queued = view.slot === 'queued'
    notify()
  }
  for (const wake of [...queuedWaiters.values()]) wake()
})

const PHASE_ZH: Record<NoqrPhase, string> = {
  idle: '空闲',
  queued: '排队中',
  launching_browser: '启动浏览器',
  login_page: '无码登录页',
  logging_in: '无码登录中',
  home: '已进入首页',
  scanning_courses: '扫描课程',
  waiting_course_selection: '等待选择课程',
  detecting: '检测作业',
  opening_homework: '打开作业',
  answer_boot: '答题页加载中',
  answering: '无码作答中',
  waiting_save: '等待答案保存',
  awaiting_advance: '已保存，等待页面推进',
  submitting: '交卷中',
  waiting_score: '等待出分',
  retry_wait: '等待重答',
  completed: '本轮完成',
  not_full: '未满分，已按次数收口',
  login_failed: '登录失败',
  needs_user: '需人工处理',
  unsupported: '当前作业不支持',
  stopped: '已停止',
}

function notify() {
  for (const listener of changeListeners) listener()
}

export function onNoqrChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function nowIso() {
  return new Date().toISOString()
}

function addLog(
  view: NoqrStudentView,
  phase: NoqrPhase,
  message: string,
  courseName?: string,
  homeworkName?: string,
  courseKey?: string,
) {
  const text = sanitizeNoqrLogText(message)
  const previousPhase = view.phase
  const previousAction = view.action
  view.phase = phase
  view.headline = PHASE_ZH[phase]
  view.action = text || view.headline
  const lineChanged = view.logs.at(-1) !== text
  if (lineChanged) view.logs = [...view.logs.slice(-99), text]
  const resolvedCourseKey = courseKey || (() => {
    const matches = view.courses.filter((course) => course.name === courseName)
    return matches.find((course) => course.key === view.activeCourseKey)?.key ||
      (matches.length === 1 ? matches[0].key : undefined)
  })()
  const lastCourseLog = view.courseLogs.at(-1)
  const courseLogChanged = Boolean(courseName) && detailLogsEnabled && (
    !lastCourseLog ||
    lastCourseLog.reason !== text ||
    lastCourseLog.courseKey !== resolvedCourseKey ||
    lastCourseLog.homeworkName !== (homeworkName || '') ||
    lastCourseLog.action !== view.headline
  )
  if (courseName && detailLogsEnabled && courseLogChanged) {
    const entry: NoqrCourseLog = {
      time: nowIso(),
      level: phase === 'stopped' || phase === 'unsupported' || phase === 'login_failed' ? 'error' : 'running',
      courseName,
      courseKey: resolvedCourseKey,
      homeworkName: homeworkName || '',
      action: view.headline,
      result: phase === 'completed' ? '完成' : '运行中',
      reason: text,
    }
    view.courseLogs = [...view.courseLogs.slice(-499), entry]
  }
  view.account = phase === 'completed' || phase === 'not_full' ? 'round_ended'
    : phase === 'stopped' ? 'stopped'
      : phase === 'login_failed' ? 'login_failed'
        : phase === 'queued' ? 'queued'
          : phase === 'launching_browser' ? 'launching_browser'
            : phase === 'logging_in' ? 'logging_in'
              : phase === 'home' ? 'logged_in'
                : phase === 'detecting' || phase === 'scanning_courses' ? 'detecting'
                  : phase === 'waiting_course_selection' ? 'waiting_course_selection'
                    : phase === 'answering' || phase === 'waiting_save' || phase === 'awaiting_advance' || phase === 'opening_homework' || phase === 'answer_boot'
                      ? 'auto_answering'
                      : phase === 'submitting' || phase === 'waiting_score' || phase === 'retry_wait'
                        ? 'auto_answering'
                        : phase === 'needs_user' ? 'needs_verify'
                        : 'logging_in'
  view.queued = view.slot === 'queued'
  if (previousPhase !== phase || previousAction !== view.action || lineChanged || courseLogChanged) notify()
}

function syncConfig(view: NoqrStudentView, account: LocalAccount) {
  view.displayMode = account.display_mode
  view.courseScope = account.course_scope
  view.answerRoundLimit = account.answer_round_limit
  view.selectedCourseNames = [...view.selectedCourseNames]
  view.selectedCourseKeys = [...view.selectedCourseKeys]
}

function viewOf(account: LocalAccount): NoqrStudentView {
  let view = views.get(account.local_id)
  if (!view) {
    view = createNoqrStudentView(account)
    views.set(account.local_id, view)
  }
  syncConfig(view, account)
  view.slot = slots.get(account.local_id)
  view.browserWindowVisible = browserWindowVisible(account.local_id)
  view.configLocked = activeRuns.has(account.local_id) ||
    isHeld(account.local_id) ||
    noqrSlotHoldsCapacity(view.slot)
  return view
}

export function snapshot() {
  const accounts = listAccounts().filter((account) => getAccountWorkMode(account.local_id) === 'noqr')
  return {
    students: accounts.map((account) => ({ ...viewOf(account) })),
    running: isRunning(),
  }
}

export function isRunning() {
  return stoppingAll ||
    activeRuns.size > 0 ||
    [...views.keys()].some((localId) =>
      isHeld(localId) || noqrSlotHoldsCapacity(slots.get(localId)))
}

export function isStudentLocked(local_id: string) {
  return activeRuns.has(local_id) ||
    isHeld(local_id) ||
    noqrSlotHoldsCapacity(slots.get(local_id))
}

function noqrSlotHoldsCapacity(slot: string): boolean {
  return slot === 'launching' ||
    slot === 'occupied' ||
    slot === 'occupying_verify' ||
    slot === 'closing'
}

function assertNotStopped(signal: AbortSignal) {
  if (signal.aborted) throw new NoqrSessionError('stopped', '任务已停止')
}

function createNoqrAccountSignal(parent: AbortSignal) {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', abortFromParent, { once: true })
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => parent.removeEventListener('abort', abortFromParent),
  }
}

function courseView(view: NoqrStudentView, course: NoqrCourse) {
  let current = view.courses.find((item) => item.key === course.key)
  if (!current) {
    current = { key: course.key, name: course.name, order: course.order, status: '待检测', groups: [] }
    view.courses.push(current)
  }
  return current
}

function markCourse(view: NoqrStudentView, course: NoqrCourse, status: string) {
  const current = courseView(view, course)
  current.status = status
  view.activeCourseName = course.name
  view.activeCourseKey = course.key
  notify()
}

function markHomework(
  view: NoqrStudentView,
  course: NoqrCourse,
  homework: NoqrHomework,
  status: string,
  score?: number | null,
  attempt?: number,
) {
  const current = courseView(view, course)
  current.groups = upsertHomework(current.groups, 'onlineHomework', homework.name, status)
  const row = current.groups[0]?.rows.find((item) => item.name === homework.name)
  if (row && score !== undefined) {
    row.score = score
    row.lastScore = score
  }
  if (row && attempt !== undefined) {
    row.attempt = attempt
    row.lastAttempt = attempt
  }
  view.activeCourseName = course.name
  view.activeCourseKey = course.key
  view.groups = current.groups
  notify()
}

function markHomeworkTiming(
  view: NoqrStudentView,
  course: NoqrCourse,
  homework: NoqrHomework,
  timing: NoqrHomeworkTiming,
) {
  const current = courseView(view, course)
  const row = current.groups[0]?.rows.find((item) => item.name === homework.name)
  if (!row) return
  Object.assign(row, timing)
  view.groups = current.groups
  notify()
}

function closeNoqrPageBounded(page: Page, timeoutMs = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    page.close().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function createNoqrPageBounded(
  context: BrowserContext,
  signal: AbortSignal,
  timeoutMs = NOQR_ANSWER_BOOT_HARD_WAIT_MS,
): Promise<Page> {
  const task = context.newPage()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<Page>((resolve, reject) => {
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (page: Page) => {
      if (settled) {
        void closeNoqrPageBounded(page)
        return
      }
      settled = true
      cleanup()
      resolve(page)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => fail(new NoqrSessionError('stopped', '任务已停止'))
    timer = setTimeout(() => {
      fail(new NoqrSessionError(
        'blank_page',
        '浏览器页面创建超过安全上限，已释放当前学生名额',
      ))
    }, Math.max(50, timeoutMs))
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(finish, fail)
  })
}

function selectedCourses(view: NoqrStudentView, courses: NoqrCourse[]): NoqrCourse[] {
  if (view.courseScope !== 'selected') return courses
  const selected = new Set(view.selectedCourseKeys)
  return courses.filter((course) => selected.has(course.key))
}

async function waitForCourseSelection(view: NoqrStudentView, signal: AbortSignal): Promise<void> {
  if (view.courseScope !== 'selected') return
  selectionStartTokens.delete(view.local_id)
  view.awaitingCourseSelection = true
  view.selectedCourseNames = []
  view.selectedCourseKeys = []
  view.slot = 'occupied'
  addLog(view, 'waiting_course_selection', '课程检测完成，请选择本轮课程')
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new NoqrSessionError('stopped', '任务已停止'))
      const finish = () => {
        cleanup()
        resolve()
      }
      const abort = () => {
        cleanup()
        reject(new NoqrSessionError('stopped', '任务已停止'))
      }
      const cleanup = () => {
        signal.removeEventListener('abort', abort)
        selectionWaiters.delete(view.local_id)
      }
      selectionWaiters.set(view.local_id, finish)
      signal.addEventListener('abort', abort, { once: true })
    })
  } finally {
    view.awaitingCourseSelection = false
  }
}

export function setNoqrSelectedCourses(local_id: string, keys: string[]) {
  const view = views.get(local_id)
  if (!view || !view.awaitingCourseSelection) return { ok: false, error: '当前不在课程选择阶段' }
  const selected = new Set(keys)
  view.selectedCourseKeys = view.courses
    .filter((course) => selected.has(course.key) || (selected.has(course.name) && view.courses.filter((item) => item.name === course.name).length === 1))
    .map((course) => course.key)
  view.selectedCourseNames = view.courses.filter((course) => view.selectedCourseKeys.includes(course.key)).map((course) => course.name)
  notify()
  return { ok: true, selected: view.selectedCourseKeys.length, selectedNames: view.selectedCourseNames, selectedKeys: view.selectedCourseKeys }
}

export function startNoqrSelectedCourseExecution() {
  const waiting = [...views.values()].filter((view) => view.awaitingCourseSelection)
  if (!waiting.length) {
    return { ok: false, error: '当前没有等待开始的无码课程选择' }
  }
  const notStarted = waiting.filter((view) => !selectionStartTokens.has(view.local_id))
  if (!notStarted.length) {
    return { ok: false, error: '本轮课程选择已开始，请等待当前学生执行' }
  }
  const pendingSelected = [...views.values()].filter((view) =>
    activeRuns.has(view.local_id) &&
    view.slot !== 'queued' &&
    view.slot !== 'released' &&
    !selectionStartTokens.has(view.local_id) &&
    view.courseScope === 'selected' &&
    !view.awaitingCourseSelection).length
  if (pendingSelected > 0) {
    return { ok: false, error: `仍有 ${pendingSelected} 名无码学生正在扫描课程` }
  }
  const empty = waiting.find((view) => !view.selectedCourseKeys.length)
  if (empty) return { ok: false, error: `${empty.name} 尚未选择课程` }
  for (const view of notStarted) {
    selectionStartTokens.add(view.local_id)
    selectionWaiters.get(view.local_id)?.()
  }
  return { ok: true }
}

async function readRecordsForHomework(
  page: Page,
  course: NoqrCourse,
  homework: NoqrHomework,
  view: NoqrStudentView,
  signal: AbortSignal,
  waitForValid = false,
  baseline: NoqrHistoryRecord[] = [],
  freshEvidence?: NoqrFreshRecordEvidence,
): Promise<NoqrHistoryRecord[]> {
  if (!homework.recordEnabled) {
    if (homework.recordCount > 0) throw new Error('作业存在历史次数但作答记录按钮不可用，禁止猜测分数')
    return []
  }
  const pendingWaitStartedAt = waitForValid ? Date.now() : 0
  const pendingWaitBudgetMs = Math.max(
    50,
    Number(process.env.KAIDA_T005_SCORE_PENDING_BUDGET_MS) || NOQR_SCORE_PENDING_WAIT_MS,
  )
  for (;;) {
    let historyReadTimedOut = false
    let result: Awaited<ReturnType<typeof readNoqrHistoryAfterOpen>>
    let restoreFailure: unknown = null
    const remainingWaitMs = Math.max(
      50,
      pendingWaitBudgetMs - (Date.now() - pendingWaitStartedAt),
    )
    try {
      const historyRead = readNoqrHistoryAfterOpen({
        page,
        open: async () => openNoqrHomework(page, homework, 'record', {
          signal,
          onWaiting: (elapsed) => addLog(view, 'waiting_score', `等待作答记录加载 ${Math.floor(elapsed / 1000)} 秒`, course.name, homework.name, course.key),
        }),
        stopRequested: () => historyReadTimedOut || signal.aborted,
        requireFreshRecord: waitForValid,
        baseline,
        freshEvidence,
        onWaiting: (elapsed) => addLog(view, 'waiting_score', `等待作答记录接口 ${Math.floor(elapsed / 1000)} 秒`, course.name, homework.name, course.key),
      })
      result = waitForValid
        ? await withNoqrHardDeadline(historyRead, remainingWaitMs, () => {
            historyReadTimedOut = true
            return {
              ok: false,
              records: [],
              latest: null,
              apiCount: 0,
              domCount: 0,
              error: '作答记录读取超过分数待确认预算',
            }
          })
        : await historyRead
    } finally {
      const currentPath = (() => {
        try { return new URL(page.url()).pathname.replace(/\/+$/, '') || '/' } catch { return '' }
      })()
      if (shouldRestoreNoqrRecordPage(currentPath, signal.aborted)) {
        const surface = await classifyNoqrPage(page).catch(() => 'unknown' as const)
        try {
          assertNoqrRecordPageCanReturn(page.url(), surface)
          const back = page.locator('.van-nav-bar__left').first()
          if (!(await back.count().catch(() => 0))) {
            throw new NoqrSessionError('page_error', '作答记录读取后缺少返回作业区按钮')
          }
          await back.click()
          await waitForNoqrCourseWorkReady(page, {
            signal,
            refreshBudget: 3,
            onWaiting: () => undefined,
          })
        } catch (error) {
          restoreFailure = error
        }
      }
    }
    assertNotStopped(signal)
    if (restoreFailure) {
      if (isNoqrFatalWorkflowError(restoreFailure)) throw restoreFailure
      throw new NoqrSessionError(
        'page_error',
        '作答记录读取后未能恢复作业区，已停止当前学生',
      )
    }
    if (result.ok) {
      historyCache.set(`${view.local_id}|${course.key}|${homework.name}`, result.records)
      return result.records
    }
    if (!waitForValid) {
      throw new Error(result.error || '作答记录读取失败')
    }
    if (/HTTP|格式错误|身份不一致|交叉核对/.test(result.error || '')) {
      throw new Error(result.error || '作答记录读取失败')
    }
    addLog(view, 'waiting_score', `最新分数尚未批阅，继续等待 · ${homework.name}`, course.name, homework.name, course.key)
    if (Date.now() - pendingWaitStartedAt >= pendingWaitBudgetMs) {
      throw new NoqrScoreUnavailableError(
        `交卷后分数等待超过 ${Math.ceil(pendingWaitBudgetMs / 1000)} 秒，标记分数待确认并继续`,
      )
    }
    await sleepNoqr(page, 3_000, signal)
  }
}

async function prepareCourseWorkPage(
  page: Page,
  account: LocalAccount,
  view: NoqrStudentView,
  signal: AbortSignal,
  course?: NoqrCourse,
): Promise<void> {
  await ensureNoqrSession(page, {
    username: account.username,
    password: account.password,
    signal,
    onPhase: (phase) => addLog(view, phase === 'logging_in' ? 'logging_in' : phase === 'home' ? 'home' : 'login_page', phase === 'home' ? '会话已复用，进入首页' : phase === 'logging_in' ? '登录中，等待真实响应' : '打开无码登录入口'),
    onWaiting: (elapsed) => addLog(view, 'logging_in', `等待登录响应 ${Math.floor(elapsed / 1000)} 秒`),
  })
  await ensureNoqrHomeReady(page, { signal, refreshBudget: 3 })
  await openNoqrCourseWork(page, {
    signal,
    refreshBudget: 3,
    onWaiting: (elapsed) => addLog(view, 'detecting', `等待形考作业页 ${Math.floor(elapsed / 1000)} 秒`, course?.name, undefined, course?.key),
  })
}

async function createReadyCourseWorkPage(
  ctx: BrowserContext,
  account: LocalAccount,
  view: NoqrStudentView,
  signal: AbortSignal,
): Promise<Page> {
  return withNoqrStartupLock(account.local_id, async () => {
    const page = await createNoqrPageBounded(ctx, signal)
    try {
      await prepareCourseWorkPage(page, account, view, signal)
      return page
    } catch (error) {
      await closeNoqrPageBounded(page)
      throw error
    }
  }, signal)
}

async function createCoursePage(ctx: BrowserContext, account: LocalAccount, course: NoqrCourse, view: NoqrStudentView, signal: AbortSignal): Promise<Page> {
  return withNoqrStartupLock(account.local_id, async () => {
    const page = await createNoqrPageBounded(ctx, signal)
    try {
      await prepareCourseWorkPage(page, account, view, signal, course)
      const courses = await readNoqrCourseMenu(page, { signal })
      const target = courses.find((item) => item.key === course.key)
      if (!target) throw new Error('课程菜单中找不到本轮目标课程')
      await switchNoqrCourse(page, target, {
        signal,
        refreshBudget: 3,
        onWaiting: (elapsed) => addLog(view, 'detecting', `等待课程切换 ${Math.floor(elapsed / 1000)} 秒`, course.name, undefined, course.key),
      })
      return page
    } catch (error) {
      await closeNoqrPageBounded(page)
      throw error
    }
  }, signal)
}

async function processHomework(opts: {
  page: Page
  account: LocalAccount
  course: NoqrCourse
  homework: NoqrHomework
  view: NoqrStudentView
  settings: ReturnType<typeof getSettings>
  signal: AbortSignal
}): Promise<void> {
  const { page, course, homework, view, settings, signal, account } = opts
  markCourse(view, course, '检测中')
  const forceRetry = process.env.KAIDA_T005_FORCE_RETRY === '1'
  const rule = evaluateNoqrHomeworkRule(homework, Date.now(), view.answerRoundLimit)
  if (!rule.needDo) {
    markHomework(view, course, homework, noqrHomeworkRuleStatus(rule))
    addLog(view, 'completed', `本次跳过 · ${homework.name} · ${rule.reason}`, course.name, homework.name, course.key)
    return
  }

  let baseline: NoqrHistoryRecord[] = []
  let baselineReliable = false
  if (!forceRetry) {
    addLog(view, 'detecting', `读取作业记录 · ${homework.name}`, course.name, homework.name, course.key)
    try {
      baseline = await readRecordsForHomework(page, course, homework, view, signal)
      baselineReliable = true
    } catch (error) {
      if (signal.aborted) throw error
      if (!shouldDegradeNoqrBaselineFailure(error)) throw error
      addLog(
        view,
        'waiting_score',
        `历史分数不可确认，按规则继续作答 · ${homework.name}`,
        course.name,
        homework.name,
        course.key,
      )
    }
  }
  const latest = baseline.length ? (await import('./score.ts')).newestNoqrScoreRecord(baseline) : null
  if (!forceRetry && latest?.score === 100) {
    markHomework(view, course, homework, 'skip_full_score', 100)
    addLog(view, 'completed', `已满分跳过 · ${homework.name}`, course.name, homework.name, course.key)
    return
  }

  const timing = createNoqrTimingAccumulator()
  const homeworkStartedAt = Date.now()
  let previousRecords = baseline
  let rounds = 0
  while (rounds < rule.maxRounds) {
    if (signal.aborted) throw new NoqrSessionError('stopped', '任务已停止')
    rounds++
    view.slot = 'occupied'
    markHomework(view, course, homework, 'clicking_do_homework')
    addLog(view, 'opening_homework', `开始作业 ${rounds}/${rule.maxRounds} · ${homework.name}`, course.name, homework.name, course.key)
    const openStart = () => openNoqrHomework(page, homework, 'start', {
      signal,
      onWaiting: (elapsed) => addLog(view, 'opening_homework', `等待答题页 ${Math.floor(elapsed / 1000)} 秒`, course.name, homework.name, course.key),
    })
    const startNetwork = new NoqrNetworkActivity(page)
    let attempts = 0
    try {
      await openStart()
      while (true) {
        await waitForNoqrAnswerReady({
          page,
          stopRequested: () => signal.aborted,
          network: startNetwork,
          reenter: async () => {
            attempts++
            addLog(view, 'answer_boot', `答题启动空白，返回重进 ${attempts}/3`, course.name, homework.name, course.key)
            assertNotStopped(signal)
            await page.locator('.van-nav-bar__left').first().click()
            await waitForNoqrCourseWorkReady(page, { signal, refreshBudget: 3 })
            await openStart()
          },
          maxReentries: 3,
        })
        break
      }
    } finally {
      startNetwork.dispose()
    }

    const observer = new NoqrMutationObserver(page)
    const bank = createReadOnlyBankClient()
    const ai = new NoqrAiClient()
    const answerPageReady = true
    let persistedAnswerEvidence = false
    const savedKeys = new Set<string>()
    const expectedCardGroups: NoqrExpectedAnswerCardGroup[] = []
    const kindGroupOccurrences = new Map<NoqrQuestionKind, number>()
    const savedLogicalKeys = new Set<string>()
    const answeredKinds = new Set<NoqrQuestionKind>()
    const logicalGroupOccurrences = new Map<string, number>()
    const logicalBaseKeyByOrdinal = new Map<number, string>()
    const logicalKeyByOrdinal = new Map<number, string>()
    let expectedCardSlotOffset = 0
    let lastQuestion = false
    let latestHomeWorkUniqueFlag = ''
    let submittedHomeWorkUniqueFlag = ''
    let submittedPaperStructUniqueFlag = ''
    let submittedAt = 0
    let submitConfirmed = false
    try {
      const objectivePreflight = await preflightNoqrObjectiveOnlyAnswerCard(
        page,
        () => signal.aborted,
        {
          onWaiting: (elapsed) => addLog(
            view,
            'answer_boot',
            `检查整卷客观题边界 ${Math.floor(elapsed / 1000)} 秒`,
            course.name,
            homework.name,
            course.key,
          ),
        },
      )
      if (!objectivePreflight.ok) {
        if (objectivePreflight.code === 'unsupported_non_objective') {
          throw new NoqrUnsupportedNonObjectiveError(objectivePreflight.reason)
        }
        if (objectivePreflight.code === 'answer_interrupted') {
          persistedAnswerEvidence = true
        }
        throw new NoqrSessionError(objectivePreflight.code, objectivePreflight.reason)
      }
      const solveCurrentAndSave = async (opts: {
        recordCardStructure?: boolean
        repairKey?: string
      } = {}) => {
        const recordCardStructure = opts.recordCardStructure !== false
        const questionStartedAt = Date.now()
        let repairTargetKey = ''
        if (!recordCardStructure) {
          // Answer-card repair must never fill or save a logical group that was
          // not recorded during the original read-through. Check before
          // answerNoqrGroup() because that function may already write field or
          // option values to the page before the save request is sent.
          const read = await readNoqrQuestionGroup(page)
          if (!read.ok) {
            throw new NoqrSessionError('answer_interrupted', read.reason)
          }
          const repairBaseKey = buildNoqrQuestionGroupSessionKey(read.group)
          const requestedOccurrence = Number(
            opts.repairKey?.match(/@(\d+)#[^#]+$/)?.[1] || 1,
          )
          const candidates = expectedCardGroups.filter((group) =>
            group.kind === read.group.kind &&
            (requestedOccurrence <= 1 || group.kindOccurrence === requestedOccurrence) &&
            logicalBaseKeyByOrdinal.get(group.groupOrdinal) === repairBaseKey,
          )
          if (candidates.length !== 1) {
            throw new NoqrSessionError(
              'answer_interrupted',
              '答题卡补答无法唯一绑定已记录题组，已保留页面并停止当前作业',
            )
          }
          repairTargetKey = logicalKeyByOrdinal.get(candidates[0].groupOrdinal) || ''
          if (!repairTargetKey || !savedLogicalKeys.has(repairTargetKey)) {
            throw new NoqrSessionError(
              'answer_interrupted',
              '答题卡补答目标题组未在答题过程中保存，已保留页面并停止当前作业',
            )
          }
        }
        const answered = await answerNoqrGroup({
          page,
          bank,
          ai,
          stopRequested: () => signal.aborted,
          onProgress: (progress) => {
            addLog(view, progress.phase === 'waiting' ? 'waiting_save' : 'answering', progress.message, course.name, homework.name, course.key)
          },
          onAiAttempt: (message) => addLog(view, 'answering', message, course.name, homework.name, course.key),
        })
        savedKeys.add(`${answered.group.kind}-${answered.group.position || 0}`)
        addLog(view, 'waiting_save', `等待保存响应 · 第 ${answered.group.position || '?'}/${answered.group.total || '?'} 题`, course.name, homework.name, course.key)
        const saved = await saveNoqrAnswerAndAdvance({
          page,
          observer,
          workId: (() => { try { return new URL(page.url()).searchParams.get('workId') || '' } catch { return '' } })(),
          group: answered.group,
          answers: answered.answers,
          stopRequested: () => signal.aborted,
          onWaiting: (state, elapsed) => addLog(
            view,
            state === '等待页面推进' ? 'awaiting_advance' : 'waiting_save',
            `${state} ${Math.floor(elapsed / 1000)} 秒`,
            course.name,
            homework.name,
            course.key,
          ),
          onMismatch: (reason) => addLog(
            view,
            'waiting_save',
            `保存请求待确认 · ${reason}`,
            course.name,
            homework.name,
            course.key,
          ),
          onClickAttempt: (attempt) => {
            view.saveClickAttempts++
            if (attempt > 1) view.saveRequestRetries++
            addLog(
              view,
              'waiting_save',
              `保存点击 ${attempt}/3`,
              course.name,
              homework.name,
              course.key,
            )
          },
        })
        answeredKinds.add(answered.group.kind)
        if (!saved.saved) {
          if (saved.state === 'submitted_uncertain' || saved.uncertain) {
            throw new NoqrSessionError('submitted_uncertain', '保存请求结果不确定，已停止当前作业')
          }
          throw new Error('保存失败，未推进')
        }
        if (saved.uncertain) throw new NoqrSessionError('submitted_uncertain', '保存结果不确定，已停止当前作业')
        persistedAnswerEvidence = true
        if (!saved.advanced && !saved.lastQuestion) {
          if (signal.aborted) throw new NoqrSessionError('stopped', '任务已停止')
          throw new NoqrSessionError(
            'answer_interrupted',
            '答案已保存但页面未推进，已保留当前答题页并停止当前作业',
          )
        }
        if (saved.homeWorkUniqueFlag) latestHomeWorkUniqueFlag = saved.homeWorkUniqueFlag
        const answeredBaseKey = buildNoqrQuestionGroupSessionKey(answered.group)
        let cardGroupKey = repairTargetKey || answeredBaseKey
        let isNewLogicalGroup = false
        if (recordCardStructure) {
          const occurrence = (logicalGroupOccurrences.get(answeredBaseKey) || 0) + 1
          logicalGroupOccurrences.set(answeredBaseKey, occurrence)
          cardGroupKey = buildNoqrQuestionGroupSessionKey(answered.group, occurrence)
          isNewLogicalGroup = true
        } else if (!savedLogicalKeys.has(cardGroupKey)) {
          throw new NoqrSessionError(
            'answer_interrupted',
            '答题卡补答进入了未记录的新题组，已保留页面并停止当前作业',
          )
        }
        savedLogicalKeys.add(cardGroupKey)
        const savedGroupOrdinal = savedLogicalKeys.size
        logicalBaseKeyByOrdinal.set(savedGroupOrdinal, answeredBaseKey)
        logicalKeyByOrdinal.set(savedGroupOrdinal, cardGroupKey)
        const previousKindOccurrence = kindGroupOccurrences.get(answered.group.kind) || 0
        const kindOccurrence = isNewLogicalGroup
          ? previousKindOccurrence + 1
          : previousKindOccurrence
        if (recordCardStructure && isNewLogicalGroup) {
          kindGroupOccurrences.set(answered.group.kind, kindOccurrence)
          expectedCardGroups.push(noqrAnswerCardExpectedGroups(answered.group, {
            groupOrdinal: savedGroupOrdinal,
            kindOccurrence,
            slotOffset: expectedCardSlotOffset,
          }))
          expectedCardSlotOffset += answered.group.units.length
        }
        for (const key of noqrAnswerCardGroupKeys(answered.group)) savedKeys.add(key)
        const savedQuestionNumbers = answered.group.units.length > 1
          ? answered.answers.map((answer) => answer.ordinal)
          : [answered.group.position || answered.answers[0]?.ordinal || 1]
        const cardOccurrences = [...new Set([
          Math.max(1, kindOccurrence),
          Math.max(1, answered.group.position || 1),
        ])]
        for (const number of savedQuestionNumbers) {
          for (const cardOccurrence of cardOccurrences) {
            const savedKey = noqrAnswerCardKey(answered.group.kind, number, cardOccurrence)
            if (savedKey) {
              savedKeys.add(savedKey)
              if (cardOccurrence > 1 && answered.group.units.length > 1) {
                const mergedNumber = (cardOccurrence - 1) * answered.group.units.length + Number(number)
                const mergedKey = noqrAnswerCardKey(answered.group.kind, mergedNumber, 1)
                if (mergedKey) savedKeys.add(mergedKey)
              }
            }
          }
          savedKeys.add(String(number))
          const legacyKey = noqrAnswerCardKey(answered.group.kind, number)
          if (legacyKey) savedKeys.add(legacyKey)
        }
        view.bankCount += answered.bankCount
        view.aiCount += answered.aiCount
        recordNoqrSavedQuestionKind(view.questionKindCounts, answered.group.kind)
        recordNoqrSavedQuestionKindSlots(
          view.questionKindSlotCounts,
          answered.group.kind,
          answered.group.units.length,
        )
        const courseRow = courseView(view, course)
        const homeworkRow = courseRow.groups[0]?.rows.find((item) => item.name === homework.name) as
          NoqrHomeworkSlotRow | undefined
        if (homeworkRow) {
          const homeworkSlotCounts = homeworkRow.questionKindSlotCounts || emptyNoqrQuestionKindCounts()
          homeworkRow.questionKindSlotCounts = homeworkSlotCounts
          recordNoqrSavedQuestionKindSlots(
            homeworkSlotCounts,
            answered.group.kind,
            answered.group.units.length,
          )
          for (const [index, answer] of answered.answers.entries()) {
            recordQuestion(homeworkRow, {
              no: (answered.group.position || 1) * 1000 + answer.ordinal + index,
              stem: '',
              source: answer.source === 'bank' ? '题库' : 'AI',
            }, Math.max(answered.group.total || 0, answered.answers.length))
          }
        }
        const answeredQuestionCount = Math.max(1, answered.answers.length)
        const pacingDelay = noqrPacingDelayMs(
          noqrPacingElapsedMs(questionStartedAt, saved.requestStartedAt, Date.now()),
          answeredQuestionCount,
        )
        try {
          if (pacingDelay > 0) {
            addLog(
              view,
              'answering',
              `保持答题节奏 · ${answeredQuestionCount} 个题位 · 等待 ${Math.ceil(pacingDelay / 1000)} 秒`,
              course.name,
              homework.name,
              course.key,
            )
            await sleepNoqr(page, pacingDelay, signal)
          }
        } finally {
          if (isNewLogicalGroup) {
            recordNoqrGroupTiming(
              timing,
              Date.now() - questionStartedAt,
              answeredQuestionCount,
            )
          }
          markHomework(
            view,
            course,
            homework,
            signal.aborted ? 'stopped' : 'answering',
          )
          markHomeworkTiming(
            view,
            course,
            homework,
            snapshotNoqrTiming(timing, Date.now() - homeworkStartedAt),
          )
        }
        return saved
      }
      addLog(view, 'answering', `作答中 · ${homework.name}`, course.name, homework.name, course.key)
      for (let questionGuard = 0; questionGuard < 500 && !lastQuestion; questionGuard++) {
        const saved = await solveCurrentAndSave()
        if (saved.lastQuestion) lastQuestion = true
      }
      if (signal.aborted) throw new NoqrSessionError('stopped', '任务已停止')
      await waitForNoqrAnswerSurfaceBeforeSubmit(page, {
        signal,
        onWaiting: (elapsed) => addLog(
          view,
          'submitting',
          `等待答题页恢复 ${Math.floor(elapsed / 1000)} 秒`,
          course.name,
          homework.name,
          course.key,
        ),
      })
      markHomework(view, course, homework, 'submitting')
      addLog(view, 'submitting', `核对答题卡 · ${homework.name}`, course.name, homework.name, course.key)
      let awaitingMissingAfterIncompleteDialog = false
      const configuredAnswerCardWaitMs = Number(process.env.KAIDA_T005_ANSWER_CARD_WAIT_MS)
      const answerCardAuditDeadlineMs =
        Number.isFinite(configuredAnswerCardWaitMs) && configuredAnswerCardWaitMs > 0
          ? Math.min(NOQR_ANSWER_CARD_HARD_WAIT_MS, Math.max(10_000, configuredAnswerCardWaitMs))
          : undefined
      for (let repairRound = 0; ; repairRound++) {
        const audit = await auditNoqrAnswerCard(page, {
          stopRequested: () => signal.aborted,
          savedKeys,
          expectedKeys: savedKeys,
          expectedGroups: expectedCardGroups,
          savedGroupOrdinals: new Set(expectedCardGroups.map((group) => group.groupOrdinal)),
          expectedCount: savedLogicalKeys.size,
          auditDeadlineMs: answerCardAuditDeadlineMs,
          onWaiting: (elapsed) => addLog(
            view,
            'submitting',
            `等待答题卡完整加载 ${Math.floor(elapsed / 1000)} 秒`,
            course.name,
            homework.name,
            course.key,
          ),
          onRecovery: (message, attempt) => addLog(
            view,
            'submitting',
            `${message} ${attempt}/3`,
            course.name,
            homework.name,
            course.key,
          ),
          onDiagnostic: (message) => addLog(
            view,
            'submitting',
            message,
            course.name,
            homework.name,
            course.key,
          ),
        })
        if (!audit.ok) {
          if (repairRound >= 30) {
            throw new Error(`答题卡补答 30 轮后仍有 ${audit.unanswered} 道未答题，禁止交卷`)
          }
          const missingKey = audit.missingKeys[0]
          if (!missingKey) throw new Error('答题卡报告漏题但没有可定位题号，禁止交卷')
          assertNotStopped(signal)
          addLog(view, 'answering', `答题卡漏题，回跳补答 · ${missingKey}`, course.name, homework.name, course.key)
          await goToNoqrAnswerCardQuestion(page, missingKey, () => signal.aborted, {
            verifyBudgetMs: NOQR_ANSWER_CARD_HARD_WAIT_MS,
            deadlineAt: Date.now() + NOQR_ANSWER_CARD_HARD_WAIT_MS,
          })
          await solveCurrentAndSave({
            recordCardStructure: false,
            repairKey: missingKey,
          })
          awaitingMissingAfterIncompleteDialog = false
          markHomework(view, course, homework, 'submitting')
          continue
        }
        if (awaitingMissingAfterIncompleteDialog) {
          throw new Error('页面提示仍有未完成题目，但答题卡未给出可定位题号，禁止交卷')
        }
        addLog(view, 'submitting', `交卷中 · ${homework.name}`, course.name, homework.name, course.key)
        const submitted = await submitNoqrHomework({
          page,
          workId: (() => { try { return new URL(page.url()).searchParams.get('workId') || '' } catch { return '' } })(),
          observer,
          stopRequested: () => signal.aborted,
          expectedHomeWorkUniqueFlag: latestHomeWorkUniqueFlag,
          onWaiting: (state, elapsed) => addLog(view, 'submitting', `${state} ${Math.floor(elapsed / 1000)} 秒`, course.name, homework.name, course.key),
        })
        if (submitted.incomplete) {
          if (repairRound >= 30) {
            throw new Error('交卷前连续 30 轮提示漏题，禁止交卷')
          }
          awaitingMissingAfterIncompleteDialog = true
          addLog(view, 'answering', '页面提示漏题，返回答题卡补答', course.name, homework.name, course.key)
          continue
        }
        if (!submitted.ok) {
          const message = submitted.reason || '交卷未完成'
          if (submitted.state === 'submitted_uncertain' || submitted.uncertain) {
            throw new NoqrSessionError('submitted_uncertain', message)
          }
          throw new Error(message)
        }
        submitConfirmed = true
        submittedHomeWorkUniqueFlag = submitted.homeWorkUniqueFlag
        submittedPaperStructUniqueFlag = submitted.paperStructUniqueFlag
        submittedAt = Date.now()
        markHomeworkTiming(
          view,
          course,
          homework,
          snapshotNoqrTiming(timing, Date.now() - homeworkStartedAt),
        )
        break
      }
      addLog(view, 'waiting_score', `等待作答记录 · ${homework.name}`, course.name, homework.name, course.key)
      let after: NoqrHistoryRecord[]
      let fresh: NoqrHistoryRecord | null
      try {
        await returnToNoqrCourseWork(page, () => signal.aborted, {
          submitConfirmedEvidence: true,
        })
        const refreshedCards = await readNoqrHomeworks(page, {
          signal,
          refreshBudget: 3,
          onWaiting: (elapsed) => addLog(view, 'waiting_score', `等待作业区恢复 ${Math.floor(elapsed / 1000)} 秒`, course.name, homework.name, course.key),
        })
        const refreshed = resolveNoqrHomeworkCard(refreshedCards, homework)
        const freshEvidence: NoqrFreshRecordEvidence = {
          baselineReliable,
          submittedAt,
          homeWorkUniqueFlag: submittedHomeWorkUniqueFlag,
          paperStructUniqueFlag: submittedPaperStructUniqueFlag,
        }
        after = await readRecordsForHomework(
          page,
          course,
          refreshed,
          view,
          signal,
          true,
          previousRecords,
          freshEvidence,
        )
        fresh = newestFreshNoqrHistoryRecord(after, previousRecords, freshEvidence)
        if (!fresh) throw new Error('交卷后未出现新的有效作答记录，分数不确定')
      } catch (error) {
        if (signal.aborted) throw error
        if (isNoqrFatalWorkflowError(error)) throw error
        throw new NoqrScoreUnavailableError('已交卷但作答记录或分数不可确认', error)
      }
      previousRecords = after
      markHomework(view, course, homework, fresh.score === 100 ? 'done_100' : 'not_full_next_time', fresh.score, rounds)
      markHomeworkTiming(
        view,
        course,
        homework,
        snapshotNoqrTiming(timing, Date.now() - homeworkStartedAt),
      )
      addLog(view, fresh.score === 100 ? 'completed' : 'retry_wait', `第 ${rounds} 次完成 · ${fresh.score} 分`, course.name, homework.name, course.key)
      // The test-only force flag bypasses a full-score baseline once, but a
      // freshly scored 100 must always end this homework instead of looping.
      if (fresh.score === 100) return
    } catch (error) {
      let terminalError = error
      if (
        process.env.KAIDA_T005_DEBUG_DIAGNOSTICS === '1' &&
        answerPageReady &&
        !submitConfirmed
      ) {
        const shape = await readNoqrAnswerCardDiagnostic(page).catch(() => null)
        if (shape) {
          addLog(
            view,
            'submitting',
            `答题卡实际结构：cards=${shape.cards}; rows=${shape.rows}; answered=${shape.answered};` +
              ` current=${shape.current}; sections=${shape.sections.join('|') || '-'};` +
              ` ordinals=${shape.cardOrdinals.map((value) => value ?? '?').join('|')};` +
              ` numbers=${shape.numbers.join('|')}`,
            course.name,
            homework.name,
            course.key,
          )
        }
        addLog(
          view,
          'submitting',
          `答题卡期望结构：${expectedCardGroups.map((group) =>
            `${group.section}#${group.position}@${group.kindOccurrence}:${group.unitCount}`,
          ).join('|') || '-'}`,
          course.name,
          homework.name,
          course.key,
        )
      }
      if (
        !signal.aborted &&
        answerPageReady &&
        !submitConfirmed &&
        (savedLogicalKeys.size > 0 || persistedAnswerEvidence)
      ) {
        const uncertain = error instanceof NoqrSessionError && error.code === 'submitted_uncertain'
        if (!uncertain) {
          const interruption = await detectNoqrAnswerPageInterruption(page).catch(() => null)
          if (interruption) {
            const message = error instanceof Error ? error.message : String(error || '未知错误')
            terminalError = new NoqrSessionError(
              interruption.code,
              `${interruption.message}；原始错误：${message}`,
            )
          }
        }
      }
      if (
        terminalError instanceof NoqrSessionError &&
        isNoqrAccountTerminalError(terminalError) &&
        (savedLogicalKeys.size > 0 || persistedAnswerEvidence)
      ) {
        throw new NoqrSessionError(
          terminalError.code,
          `${terminalError.message}（已保存 ${savedLogicalKeys.size} 个题组）`,
        )
      }
      if (
        terminalError instanceof NoqrSessionError &&
        terminalError.code === 'answer_interrupted' &&
        savedLogicalKeys.size === 0 &&
        !persistedAnswerEvidence
      ) {
        throw new NoqrSessionError('page_error', terminalError.message)
      }
      throw terminalError
    } finally {
      observer.dispose()
    }
  }
  markHomework(view, course, homework, 'not_full_next_time', previousRecords.length ? (await import('./score.ts')).newestNoqrScoreRecord(previousRecords)?.score ?? null : null, rounds)
  markHomeworkTiming(
    view,
    course,
    homework,
    snapshotNoqrTiming(timing, Date.now() - homeworkStartedAt),
  )
  addLog(view, 'not_full', `重答次数用尽，保留真实分数 · ${homework.name}`, course.name, homework.name, course.key)
}

async function processCourse(opts: {
  account: LocalAccount
  course: NoqrCourse
  view: NoqrStudentView
  settings: ReturnType<typeof getSettings>
  signal: AbortSignal
}): Promise<void> {
  const { account, course, view, settings, signal } = opts
  let ctx: BrowserContext | undefined
  let page: Page | undefined
  let resetPage = false
  try {
    ctx = (await getContext(account.local_id))!
    page = await createCoursePage(ctx, account, course, view, signal)
    markCourse(view, course, '检测中')
    const list = await readNoqrHomeworks(page, {
      signal,
      refreshBudget: 3,
      onWaiting: (elapsed) => addLog(view, 'detecting', `等待作业卡 ${Math.floor(elapsed / 1000)} 秒`, course.name, undefined, course.key),
    })
    const row = courseView(view, course)
    row.groups = []
    view.activeCourseName = course.name
    view.activeCourseKey = course.key
    const processedHomeworkKeys = new Set<string>()
    for (const plannedHomework of list) {
      const plannedKey = plannedHomework.workId ||
        `${plannedHomework.courseId}|${plannedHomework.name}|${plannedHomework.startAt}|${plannedHomework.endAt}`
      if (processedHomeworkKeys.has(plannedKey)) continue
      processedHomeworkKeys.add(plannedKey)
      let homework = plannedHomework
      markHomework(view, course, plannedHomework, 'todo')
      if (resetPage || shouldResetNoqrCoursePage(page.url(), false)) {
        await recoverNoqrCourseWorkWithoutLogin(page, {
          signal,
          course,
          refreshBudget: 3,
          onWaiting: (elapsed) => addLog(view, 'detecting', `等待页面恢复 ${Math.floor(elapsed / 1000)} 秒`, course.name, undefined, course.key),
        })
        resetPage = false
      }
      try {
        const currentCards = await readNoqrHomeworks(page, {
          signal,
          refreshBudget: 3,
          onWaiting: (elapsed) => addLog(view, 'detecting', `等待当前作业卡 ${Math.floor(elapsed / 1000)} 秒`, course.name, plannedHomework.name, course.key),
        })
        homework = resolveNoqrHomeworkCard(currentCards, plannedHomework)
        markHomework(view, course, homework, 'todo')
        await processHomework({ page, account, course, homework, view, settings, signal })
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof NoqrSessionError && error.code === 'answer_interrupted') {
          const message = error.message || '已作答答题页异常中断'
          markHomework(view, course, homework, 'answer_page_interrupted')
          addLog(
            view,
            'unsupported',
            `${homework.name} 已隔离 · ${message}`,
            course.name,
            homework.name,
            course.key,
          )
          throw error
        }
        if (isNoqrAccountTerminalError(error)) {
          applyNoqrFailureToView(view, course, homework, error)
          const message = error instanceof Error ? error.message : '未知作业错误'
          addLog(
            view,
            terminalNoqrPhase(error),
            `${homework.name} 已终止账号 · ${message}`,
            course.name,
            homework.name,
            course.key,
          )
          throw error
        }
        const message = error instanceof Error ? error.message : '未知作业错误'
        const failureStatus = noqrHomeworkFailureStatus(error)
        if (failureStatus) {
          markHomework(view, course, homework, failureStatus)
          if (failureStatus === 'skip_non_objective') {
            addLog(
              view,
              'unsupported',
              `${homework.name} 已隔离 · ${message}`,
              course.name,
              homework.name,
              course.key,
            )
            resetPage = true
            continue
          }
          addLog(
            view,
            'waiting_score',
            `${homework.name} 已交卷，分数待确认 · ${message}`,
            course.name,
            homework.name,
            course.key,
          )
          resetPage = false
          continue
        }
        markHomework(view, course, homework, 'submit_failed')
        addLog(view, 'unsupported', `${homework.name} 已隔离 · ${message}`, course.name, homework.name, course.key)
        if (shouldStopNoqrCourseAfterHomeworkFailure(page.url())) {
          try {
            await recoverNoqrCourseWorkWithoutLogin(page, {
              signal,
              course,
              refreshBudget: 3,
              onWaiting: (elapsed) => addLog(view, 'detecting', `等待课程页恢复 ${Math.floor(elapsed / 1000)} 秒`, course.name, homework.name, course.key),
            })
          } catch (recoveryError) {
            if (signal.aborted) throw recoveryError
            if (isNoqrAccountTerminalError(recoveryError)) throw recoveryError
            addLog(view, 'detecting', `${homework.name} 页面恢复失败，重建课程页后继续`, course.name, homework.name, course.key)
            await closeNoqrPageBounded(page)
            page = await createCoursePage(ctx, account, course, view, signal)
          }
          resetPage = false
          continue
        }
        resetPage = true
      }
      resetPage ||= shouldResetNoqrCoursePage(page.url(), false)
    }
    row.status = courseOutcome(row.groups.flatMap((group) => group.rows.map((homework) => homework.status)))
    markCourse(view, course, row.status)
  } catch (error) {
    if (signal.aborted) throw error
    if (isNoqrAccountTerminalError(error)) throw error
    const message = error instanceof Error ? error.message : '未知课程错误'
    markCourse(view, course, '检测失败')
    addLog(view, 'unsupported', `课程已隔离 · ${message}`, course.name, undefined, course.key)
  } finally {
    if (page) await closeNoqrPageBounded(page)
  }
}

async function detectCourseOnPage(opts: {
  page: Page
  course: NoqrCourse
  view: NoqrStudentView
  signal: AbortSignal
}): Promise<void> {
  const { page, course, view, signal } = opts
  try {
    markCourse(view, course, '检测中')
    await recoverNoqrCourseWorkWithoutLogin(page, {
      signal,
      refreshBudget: 3,
      onWaiting: (elapsed) => addLog(view, 'detecting', `等待页面恢复 ${Math.floor(elapsed / 1000)} 秒`, course.name, undefined, course.key),
    })
    await switchNoqrCourse(page, course, {
      signal,
      refreshBudget: 3,
      onWaiting: (elapsed) => addLog(view, 'detecting', `等待课程切换 ${Math.floor(elapsed / 1000)} 秒`, course.name, undefined, course.key),
    })
    const list = await readNoqrHomeworks(page, {
      signal,
      refreshBudget: 3,
      onWaiting: (elapsed) => addLog(view, 'detecting', `等待作业卡 ${Math.floor(elapsed / 1000)} 秒`, course.name, undefined, course.key),
    })
    const row = courseView(view, course)
    row.groups = []
    for (const homework of list) {
      const rule = evaluateNoqrHomeworkRule(homework, Date.now(), view.answerRoundLimit)
      markHomework(view, course, homework, noqrHomeworkRuleStatus(rule))
    }
    row.status = courseOutcome(row.groups.flatMap((group) => group.rows.map((homework) => homework.status)))
    markCourse(view, course, row.status)
  } catch (error) {
    if (signal.aborted) throw error
    if (isNoqrAccountTerminalError(error)) throw error
    markCourse(view, course, '检测失败')
    addLog(view, 'unsupported', `课程检测已隔离 · ${error instanceof Error ? error.message : '未知错误'}`, course.name, undefined, course.key)
  }
}

async function runOne(opts: NoqrRunOptions): Promise<void> {
  const { account, context, signal: parentSignal, view, settings } = opts
  const accountRun = createNoqrAccountSignal(parentSignal)
  const signal = accountRun.signal
  try {
    resetNoqrStudentRunView(view)
    detailLogsEnabled = settings.log_enabled
    view.slot = 'occupied'
    addLog(view, 'launching_browser', '浏览器已启动，开始登录')
    const page = context.pages()[0] || await createNoqrPageBounded(context, signal)
    await ensureNoqrSession(page, {
      username: account.username,
      password: account.password,
      signal,
      onPhase: (phase) => addLog(view, phase === 'logging_in' ? 'logging_in' : phase === 'home' ? 'home' : 'login_page', phase === 'home' ? '登录成功，进入首页' : phase === 'logging_in' ? '登录中，等待真实响应' : '打开无码登录入口'),
      onWaiting: (elapsed) => addLog(view, 'logging_in', `等待登录响应 ${Math.floor(elapsed / 1000)} 秒`),
    })
    await ensureNoqrHomeReady(page, { signal, refreshBudget: 3 })
    addLog(view, 'scanning_courses', '点击形考作业并读取课程')
    await openNoqrCourseWork(page, {
      signal,
      refreshBudget: 3,
      onWaiting: (elapsed) => addLog(view, 'scanning_courses', `等待形考作业页 ${Math.floor(elapsed / 1000)} 秒`),
    })
    const courses = await readNoqrCourseMenu(page, { signal })
    view.courses = courses.map((course) => ({ key: course.key, name: course.name, order: course.order, status: '待检测', groups: [] }))
    view.activeCourseName = courses.find((course) => course.current)?.name || courses[0]?.name || ''
    view.activeCourseKey = courses.find((course) => course.current)?.key || courses[0]?.key || ''
    addLog(view, 'detecting', `已读取 ${courses.length} 门课程`)
    const detectionParallel = Math.min(
      courses.length,
      Math.max(1, settings.course_parallel),
    )
    const lanePages: Page[] = [page]
    let detectFatal: unknown
    try {
      const ctx = (await getContext(account.local_id))!
      for (let lane = 1; lane < detectionParallel; lane++) {
        lanePages.push(await createReadyCourseWorkPage(ctx, account, view, signal))
      }
      let nextCourse = 0
      await mapWithConcurrency(lanePages, lanePages.length, async (lanePage) => {
        while (!detectFatal) {
          const index = nextCourse++
          if (index >= courses.length) return
          try {
            await detectCourseOnPage({ page: lanePage, course: courses[index], view, signal })
          } catch (error) {
            if (!detectFatal) {
              detectFatal = error
              if (isNoqrAccountTerminalError(error)) accountRun.abort()
            }
          }
        }
      })
    } finally {
      await Promise.all(lanePages.slice(1).map((lanePage) => closeNoqrPageBounded(lanePage)))
    }
    if (detectFatal) throw detectFatal
    await waitForCourseSelection(view, signal)
    const runCourses = selectedCourses(view, courses)
    if (!runCourses.length) {
      view.phase = 'stopped'
      view.account = 'stopped'
      addLog(view, 'stopped', '本轮没有选择课程')
      return
    }
    const parallel = Math.max(1, settings.course_parallel)
    let fatalError: unknown
    await mapWithConcurrency(runCourses, parallel, async (course) => {
      if (fatalError) return
      try {
        await processCourse({ account, course, view, settings, signal })
      } catch (error) {
        if (!fatalError) {
          fatalError = error
          if (isNoqrAccountTerminalError(error)) accountRun.abort()
        }
      }
    })
    if (fatalError) throw fatalError
    if (!signal.aborted) {
      const outcome = noqrRunOutcome(runCourses.map((course) => courseView(view, course).status))
      addLog(view, outcome.phase, outcome.message)
    }
  } finally {
    accountRun.dispose()
  }
}

async function scheduleStudent(account: LocalAccount): Promise<void> {
  if (activeRuns.has(account.local_id) || stoppingAll) return
  const controller = new AbortController()
  stopControllers.set(account.local_id, controller)
  stopFlags.delete(account.local_id)
  const view = viewOf(account)
  view.slot = 'queued'
  addLog(view, 'queued', '等待浏览器名额')
  const waitForQueueSignal = async () => {
    if (controller.signal.aborted) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        if (queuedWaiters.get(account.local_id) === finish) queuedWaiters.delete(account.local_id)
        resolve()
      }
      const abort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        if (queuedWaiters.get(account.local_id) === finish) queuedWaiters.delete(account.local_id)
        reject(new NoqrSessionError('stopped', '任务已停止'))
      }
      const timer = setTimeout(finish, 400)
      queuedWaiters.set(account.local_id, finish)
      controller.signal.addEventListener('abort', abort, { once: true })
    })
  }
  const task = (async () => {
    selectionStartTokens.delete(account.local_id)
    if (controller.signal.aborted) return
    let acquired = await acquire(
      account.local_id,
      account.display_mode === 'visual',
      controller.signal,
    )
    while (!acquired.ok && !controller.signal.aborted) {
      if (acquired.error) throw new Error(acquired.error)
      view.slot = 'queued'
      addLog(view, 'queued', '等待浏览器名额')
      await waitForQueueSignal()
      if (controller.signal.aborted) return
      acquired = await acquire(
        account.local_id,
        account.display_mode === 'visual',
        controller.signal,
      )
    }
    if (!acquired.ok || !acquired.context) return
    if (controller.signal.aborted) {
      await release(account.local_id)
      return
    }
    view.slot = 'occupied'
    await runOne({
      localId: account.local_id,
      account,
      context: acquired.context,
      signal: controller.signal,
      view,
      settings: getSettings(),
    })
  })().catch((error) => {
    if (controller.signal.aborted) addLog(view, 'stopped', '已停止')
    else {
      const phase = terminalNoqrPhase(error)
      const message = error instanceof Error ? error.message : '未知错误'
      addLog(view, phase, phase === 'unsupported' ? `运行结束 · ${message}` : message)
    }
  }).finally(async () => {
    view.slot = 'closing'
    const released = await release(account.local_id)
    view.awaitingCourseSelection = false
    view.queued = false
    if (controller.signal.aborted && view.phase !== 'completed') {
      addLog(view, 'stopped', '已停止')
    }
    activeRuns.delete(account.local_id)
    stopControllers.delete(account.local_id)
    stopFlags.delete(account.local_id)
    selectionStartTokens.delete(account.local_id)
    view.slot = slots.get(account.local_id)
    view.configLocked = noqrSlotHoldsCapacity(view.slot)
    view.queued = false
    if (!released && view.slot === 'closing') {
      addLog(view, 'stopped', '浏览器进程未确认退出，保留关闭占位')
    }
    notify()
  })
  activeRuns.set(account.local_id, task)
  notify()
}

export function startNoqrStudent(local_id: string) {
  const account = listAccounts().find((item) => item.local_id === local_id)
  if (!account || getAccountWorkMode(local_id) !== 'noqr') return { ok: false, error: '该学生不是无码答题模式' }
  if (stoppingAll || isStudentLocked(local_id)) return { ok: false, error: '该学生正在运行、排队或停止中' }
  const settings = getSettings()
  detailLogsEnabled = settings.log_enabled
  slots.setLimit(settings.account_parallel)
  void scheduleStudent(account)
  return { ok: true }
}

export async function loginAndRefreshNoqr(accountIds?: string[]) {
  if (isRunning()) return { ok: false, error: '任务运行中，请单独开始或停止学生' }
  const accounts = listAccounts().filter((account) =>
    getAccountWorkMode(account.local_id) === 'noqr' &&
    (!accountIds || accountIds.includes(account.local_id)))
  if (!accounts.length) return { ok: false, error: '没有无码答题学生' }
  const settings = getSettings()
  detailLogsEnabled = settings.log_enabled
  slots.setLimit(settings.account_parallel)
  for (const account of accounts) void scheduleStudent(account)
  await Promise.all(accounts.map((account) => activeRuns.get(account.local_id) || Promise.resolve()))
  return { ok: true }
}

export function enqueueNoqrStudents(ids: string[]) {
  if (!isRunning()) return 0
  const allowed = new Set(ids)
  let count = 0
  for (const account of listAccounts()) {
    if (allowed.has(account.local_id) &&
      getAccountWorkMode(account.local_id) === 'noqr' &&
      !isStudentLocked(account.local_id)) {
      void scheduleStudent(account)
      count++
    }
  }
  return count
}

export async function stopNoqrStudent(local_id: string) {
  stopFlags.add(local_id)
  stopControllers.get(local_id)?.abort()
  const task = activeRuns.get(local_id)
  const slot = slots.get(local_id)
  const releaseTask = slot === 'queued' || slot === 'launching' || slot === 'closing'
    ? release(local_id)
    : Promise.resolve(true)
  await Promise.all([task || Promise.resolve(), releaseTask])
}

export async function stopAllNoqr() {
  stoppingAll = true
  try {
    const closingOnly = [...views.entries()]
      .filter(([id, view]) => !activeRuns.has(id) && view.slot === 'closing')
      .map(([id]) => id)
    await Promise.all([
      ...[...activeRuns.keys()].map((id) => stopNoqrStudent(id)),
      ...closingOnly.map((id) => release(id)),
    ])
  } finally {
    stoppingAll = false
  }
}

export async function deleteNoqrRuntime(local_id: string) {
  await stopNoqrStudent(local_id)
  if (slots.get(local_id) === 'closing' || isStudentLocked(local_id)) {
    throw new Error('浏览器关闭尚未确认，暂不能删除该学生运行状态')
  }
  views.delete(local_id)
  historyCache.delete(local_id)
  notify()
}

export function setNoqrCourseScope(local_id: string, scope: 'all' | 'selected') {
  const view = views.get(local_id)
  if (isStudentLocked(local_id)) return { ok: false, error: '该学生运行中，课程范围已锁定' }
  const account = listAccounts().find((item) => item.local_id === local_id)
  if (!account) return { ok: false, error: '学生不存在' }
  patchAccount(local_id, { course_scope: scope })
  if (view) {
    view.courseScope = scope
    view.selectedCourseNames = []
    view.selectedCourseKeys = []
    notify()
  }
  return { ok: true }
}

export function setNoqrAnswerRoundLimit(local_id: string, limit: number) {
  if (isStudentLocked(local_id)) return { ok: false, error: '该学生运行中，重新答题次数已锁定' }
  const account = listAccounts().find((item) => item.local_id === local_id)
  if (!account) return { ok: false, error: '学生不存在' }
  const value = Math.min(10, Math.max(1, Number(limit) || 10))
  patchAccount(local_id, { answer_round_limit: value })
  const view = views.get(local_id)
  if (view) view.answerRoundLimit = value
  notify()
  return { ok: true }
}

export async function toggleNoqrDisplay(local_id: string, mode: 'headless' | 'visual') {
  if (isStudentLocked(local_id)) return { ok: false, visible: browserWindowVisible(local_id), error: '该学生运行中，浏览器模式已锁定' }
  patchAccount(local_id, { display_mode: mode })
  const view = views.get(local_id)
  if (view) view.displayMode = mode
  notify()
  return { ok: true, visible: browserWindowVisible(local_id) }
}

export function getNoqrHomeworkHistory(local_id: string, courseKey: string, homeworkName: string) {
  const records = historyCache.get(`${local_id}|${courseKey}|${homeworkName}`) || []
  if (!records.length) {
    return { ok: true, items: [] }
  }
  return {
    ok: true,
    items: records
      .slice()
      .sort((left, right) => Date.parse(right.finishedTime) - Date.parse(left.finishedTime))
      .slice(0, 50)
      .map((record, index) => ({
        attempt: records.length - index,
        submittedAt: record.finishedTime,
        status: '已批阅',
        score: record.score,
        completed: true,
        viewable: false,
        displayState: 'no_view' as const,
      })),
  }
}

export function getNoqrHistoryPaperImage(): { ok: boolean; error: string } {
  return { ok: false, error: '无码模式只读取分数，不提供历史答卷图片' }
}

export function applyNoqrSettingsToAll(sourceId: string) {
  if (isRunning()) return { ok: false, updated: 0, failed: [] as string[], error: '仍有学生运行或排队，请全部停止后再同步' }
  const accounts = listAccounts()
  const source = accounts.find((account) => account.local_id === sourceId)
  if (!source) return { ok: false, updated: 0, failed: [] as string[], error: '请先选择学生' }
  const failed: string[] = []
  let updated = 0
  for (const account of accounts) {
    try {
      patchAccount(account.local_id, {
        display_mode: source.display_mode,
        work_mode: 'noqr',
        course_scope: source.course_scope,
        answer_round_limit: source.answer_round_limit,
      })
      const view = views.get(account.local_id)
      if (view) {
        view.displayMode = source.display_mode
        view.courseScope = source.course_scope
        view.answerRoundLimit = source.answer_round_limit
        view.selectedCourseNames = []
        view.selectedCourseKeys = []
      }
      updated++
    } catch {
      failed.push(account.name)
    }
  }
  notify()
  return {
    ok: failed.length === 0,
    updated,
    failed,
    error: failed.length ? `有 ${failed.length} 名学生保存失败` : undefined,
  }
}
