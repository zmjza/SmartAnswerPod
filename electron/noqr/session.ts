import type { BrowserContext, Page, Request, Response } from 'patchright'
import { createHash } from 'node:crypto'
import { NoqrBlankRecoveryGate } from './blank-recovery.ts'
import { NOQR_LOGIN_URL, NOQR_ORIGIN, NOQR_PATH, NOQR_SEL } from './selectors.ts'

export type NoqrPageSurface =
  | 'login'
  | 'home'
  | 'course_work'
  | 'answer_boot'
  | 'answer'
  | 'record'
  | 'submit_success'
  | 'home_blank'
  | 'auth_blocked'
  | 'login_failed'
  | 'blank'
  | 'error'
  | 'unknown'

export type NoqrSessionPhase = 'login_page' | 'logging_in' | 'home'

export type NoqrLoginOptions = {
  username: string
  password: string
  signal?: AbortSignal
  onPhase?: (phase: NoqrSessionPhase) => void
  onWaiting?: (elapsedMs: number) => void
  loginIdleBudgetMs?: number
  blankGraceMs?: number
  blankMaxActiveWaitMs?: number
  blankMaxHeartbeatWaitMs?: number
}

export type NoqrLoginResult = {
  reused: boolean
  finalUrl: string
  elapsedMs: number
}

export type NoqrSessionErrorCode =
  | 'login_failed'
  | 'auth_blocked'
  | 'course_contract'
  | 'homework_contract'
  | 'blank_page'
  | 'credentials_missing'
  | 'stopped'
  | 'page_error'
  | 'answer_interrupted'
  | 'submitted_uncertain'

export class NoqrSessionError extends Error {
  readonly code: NoqrSessionErrorCode

  constructor(code: NoqrSessionErrorCode, message: string) {
    super(message)
    this.name = 'NoqrSessionError'
    this.code = code
  }
}

const AUTH_BLOCK_PATTERN = /企业微信|微信客户端打开|扫码登录|验证码|人脸识别|身份验证|授权失败/
const LOGIN_ERROR_PATTERN = /登录失败|账号或密码错误|用户名或密码错误|用户不存在|密码错误/
const PAGE_ERROR_PATTERN = /加载失败|读取失败|请求失败|发生错误|系统异常|服务异常/
const LOGIN_REQUEST_PATTERN = /(?:login|log-in|signin|sign-in|auth|session|token)/i
const VOLATILE_QUERY_PARAM = /^(?:_?t|ts|timestamp|time|cache|cachebust|_dc|rnd|random|nonce)$/i
const NOQR_LONG_REQUEST_BUSINESS_MS = 1_500

type NoqrSessionStorageSnapshot = {
  origin: string
  accountKey: string
  entries: Array<[string, string]>
}

// sessionStorage is tab-scoped in Chromium. Keep the authenticated tab's
// snapshot in memory so new tabs can start from the same school session
// without submitting the account credentials again.
const sessionStorageSnapshots = new WeakMap<BrowserContext, NoqrSessionStorageSnapshot>()
const primedSessionStoragePages = new WeakSet<Page>()
const loginSubmissions = new WeakMap<
  BrowserContext,
  Map<string, { page: Page; submitted: boolean; authenticated: boolean }>
>()

function loginAccountKey(username: string): string {
  return createHash('sha256').update(String(username)).digest('hex').slice(0, 32)
}

function loginSubmissionFor(page: Page, accountKey: string) {
  const context = page.context()
  let entries = loginSubmissions.get(context)
  if (!entries) {
    entries = new Map()
    loginSubmissions.set(context, entries)
  }
  return {
    entry: entries.get(accountKey),
    set(entry: { page: Page; submitted: boolean; authenticated: boolean }) {
      entries!.set(accountKey, entry)
    },
  }
}

function markNoqrAuthenticated(page: Page, accountKey: string): void {
  const state = loginSubmissionFor(page, accountKey)
  state.set({ page, submitted: true, authenticated: true })
}

async function captureNoqrSessionStorage(page: Page, accountKey: string): Promise<void> {
  try {
    const snapshot = await page.evaluate(({ origin, accountKey }) => {
      if (location.origin !== origin) return null
      const entries: Array<[string, string]> = []
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index)
        if (key != null) entries.push([key, sessionStorage.getItem(key) ?? ''])
      }
      return entries.length ? { origin, accountKey, entries } : null
    }, { origin: NOQR_ORIGIN, accountKey })
    if (snapshot) sessionStorageSnapshots.set(page.context(), snapshot)
  } catch {
    // A navigation can replace the document between classification and capture.
    // Retry after the next confirmed home page instead of blocking the session.
  }
}

async function primeNoqrSessionStorage(page: Page, accountKey: string): Promise<boolean> {
  const snapshot = sessionStorageSnapshots.get(page.context())
  if (!snapshot) return false
  if (snapshot.accountKey !== accountKey) {
    sessionStorageSnapshots.delete(page.context())
    return false
  }
  if (primedSessionStoragePages.has(page)) return true
  await page.addInitScript((input) => {
    if (location.origin !== input.origin) return
    for (const [key, value] of input.entries) {
      // A live tab may already have rotated its token; never overwrite it.
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value)
    }
  }, snapshot)
  primedSessionStoragePages.add(page)
  return true
}

function abortError() {
  return new NoqrSessionError('stopped', '任务已停止')
}

export function throwIfNoqrStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

export async function sleepNoqr(page: Page, ms: number, signal?: AbortSignal): Promise<void> {
  throwIfNoqrStopped(signal)
  if (!signal) {
    await page.waitForTimeout(ms)
    return
  }
  let abort: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    await Promise.race([page.waitForTimeout(ms), stopped])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
  throwIfNoqrStopped(signal)
}

export async function awaitNoqrNavigation<T>(
  task: Promise<T>,
  signal?: AbortSignal,
  stopRequested?: () => boolean,
): Promise<T> {
  throwIfNoqrStopped(signal)
  if (stopRequested?.()) throw abortError()
  if (!signal && !stopRequested) return task
  let abort: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(abortError())
    signal?.addEventListener('abort', abort, { once: true })
  })
  const stopPoll = stopRequested
    ? setInterval(() => {
        if (stopRequested()) abort?.()
      }, 50)
    : undefined
  try {
    return await Promise.race([task, stopped])
  } finally {
    if (abort && signal) signal.removeEventListener('abort', abort)
    if (stopPoll) clearInterval(stopPoll)
  }
}

export async function reloadNoqrPage(
  page: Page,
  opts: { signal?: AbortSignal; stopRequested?: () => boolean } = {},
): Promise<void> {
  if (isNoqrAnswerPath(page.url())) {
    throw new NoqrSessionError(
      'answer_interrupted',
      '答题页禁止刷新，已保留当前页面',
    )
  }
  page.setDefaultNavigationTimeout(0)
  await awaitNoqrNavigation(
    page.reload({ waitUntil: 'commit', timeout: 0 }),
    opts.signal,
    opts.stopRequested,
  )
}

async function restartNoqrNavigation(
  page: Page,
  url: string,
  opts: { signal?: AbortSignal; stopRequested?: () => boolean } = {},
): Promise<void> {
  // A pending page.goto() can make page.reload() abort and leave Chromium on
  // about:blank. Cancel that navigation first, then issue a fresh navigation
  // to the same supported non-answer entry.
  try {
    await awaitNoqrNavigation(
      page.goto('about:blank', { waitUntil: 'commit', timeout: 0 }),
      opts.signal,
      opts.stopRequested,
    )
  } catch (error) {
    throwIfNoqrStopped(opts.signal)
    if (opts.stopRequested?.()) throw error
  }
  await awaitNoqrNavigation(
    page.goto(url, { waitUntil: 'commit', timeout: 0 }),
    opts.signal,
    opts.stopRequested,
  )
}

export function isLikelyNoqrLoginRequest(request: Request): boolean {
  if (request.method().toUpperCase() !== 'POST') return false
  try {
    return LOGIN_REQUEST_PATTERN.test(new URL(request.url()).pathname)
  } catch {
    return false
  }
}

export class NoqrNetworkActivity {
  private readonly active = new Set<Request>()
  private readonly businessActive = new Set<Request>()
  private readonly nonBusinessStartedAt = new Map<Request, number>()
  private readonly requestSeries = new Map<string, { count: number; lastStartedAt: number }>()
  private activityVersionValue = 0
  private businessActivityVersionValue = 0
  private readonly page: Page
  private readonly origin: string
  private readonly longRequestPromotionMs: number
  private readonly onRequest = (request: Request) => {
    if (this.tracked(request)) {
      this.activityVersionValue++
      this.active.add(request)
      if (this.isBusinessActivity(request)) {
        this.businessActivityVersionValue++
        this.businessActive.add(request)
      } else {
        this.nonBusinessStartedAt.set(request, Date.now())
      }
    }
  }
  private readonly onFinished = (request: Request) => {
    if (this.active.delete(request)) this.activityVersionValue++
    if (this.businessActive.delete(request)) this.businessActivityVersionValue++
    this.nonBusinessStartedAt.delete(request)
  }
  private readonly onFailed = (request: Request) => {
    if (this.active.delete(request)) this.activityVersionValue++
    if (this.businessActive.delete(request)) this.businessActivityVersionValue++
    this.nonBusinessStartedAt.delete(request)
  }

  constructor(
    page: Page,
    origin = NOQR_ORIGIN,
    longRequestPromotionMs = NOQR_LONG_REQUEST_BUSINESS_MS,
  ) {
    this.page = page
    this.origin = origin
    this.longRequestPromotionMs = Math.max(0, Number(longRequestPromotionMs) || 0)
    page.on('request', this.onRequest)
    page.on('requestfinished', this.onFinished)
    page.on('requestfailed', this.onFailed)
  }

  private tracked(request: Request): boolean {
    try {
      const url = new URL(request.url())
      if (url.origin !== this.origin) return false
      const type = request.resourceType()
      return type === 'document' || type === 'xhr' || type === 'fetch'
    } catch {
      return false
    }
  }

  private isBusinessActivity(request: Request): boolean {
    if (request.resourceType() === 'document') return true
    let seriesKey: string
    try {
      const url = new URL(request.url())
      // Strip only known cache-buster parameters. Stable business parameters
      // such as courseId/page/workId remain part of the series identity.
      const stableQuery = [...url.searchParams.entries()]
        .filter(([key]) => !VOLATILE_QUERY_PARAM.test(key))
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&')
      seriesKey = `${request.method().toUpperCase()} ${url.pathname}?${stableQuery} ${request.resourceType()}`
    } catch {
      return true
    }
    const now = Date.now()
    const previous = this.requestSeries.get(seriesKey)
    this.requestSeries.set(seriesKey, {
      count: (previous?.count || 0) + 1,
      lastStartedAt: now,
    })
    // A repeated same-endpoint XHR/fetch is normally a heartbeat or status
    // poll. Keep it in the full activity view, but never let it postpone
    // blank-page recovery forever.
    return !previous || previous.count < 2 || now - previous.lastStartedAt > 120_000
  }

  get size(): number {
    return this.active.size
  }

  get activityVersion(): number {
    return this.activityVersionValue
  }

  get businessActivityVersion(): number {
    this.promoteLongRunningRequests()
    return this.businessActivityVersionValue
  }

  isActive(): boolean {
    return this.active.size > 0
  }

  isBusinessActive(): boolean {
    this.promoteLongRunningRequests()
    return this.businessActive.size > 0
  }

  dispose(): void {
    this.page.off('request', this.onRequest)
    this.page.off('requestfinished', this.onFinished)
    this.page.off('requestfailed', this.onFailed)
    this.active.clear()
    this.businessActive.clear()
    this.nonBusinessStartedAt.clear()
    this.requestSeries.clear()
  }

  private promoteLongRunningRequests(now = Date.now()) {
    for (const [request, startedAt] of this.nonBusinessStartedAt) {
      if (now - startedAt < this.longRequestPromotionMs) continue
      this.nonBusinessStartedAt.delete(request)
      if (!this.active.has(request) || this.businessActive.has(request)) continue
      this.businessActive.add(request)
      this.businessActivityVersionValue++
    }
  }
}

function normalizedPath(urlText: string): string {
  try {
    const url = new URL(urlText)
    return url.pathname.replace(/\/+$/, '') || '/'
  } catch {
    return ''
  }
}

export function isNoqrLoginPath(urlText: string): boolean {
  return normalizedPath(urlText) === NOQR_PATH.login
}

export function isNoqrHomePath(urlText: string): boolean {
  return normalizedPath(urlText) === NOQR_PATH.home
}

export function isNoqrAnswerPath(urlText: string): boolean {
  return normalizedPath(urlText) === NOQR_PATH.answer
}

export async function classifyNoqrPage(page: Page): Promise<NoqrPageSurface> {
  let value: {
    url: string
    loginVisible: boolean
    homeReady: boolean
    courseWorkReady: boolean
    answerReady: boolean
    answerBoot: boolean
    recordReady: boolean
    submitSuccess: boolean
    bodyText: string
    bodyTextLength: number
    skeleton: boolean
  }
  try {
    value = await page.evaluate((selectors) => {
      const visible = (node: Element | null) => {
        if (!node || !(node instanceof HTMLElement)) return false
        const style = getComputedStyle(node)
        return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
      }
      const username = document.querySelector(selectors.loginUsername)
      const password = document.querySelector(selectors.loginPassword)
      const bodyText = document.body?.innerText || ''
      const homeMenuReady = [...document.querySelectorAll(selectors.homeMenuItems)]
        .some((node) => visible(node) && (node as HTMLElement).innerText.includes('形考作业'))
      return {
        url: location.href,
        loginVisible: visible(username) && visible(password),
        homeReady: homeMenuReady ||
          [...document.querySelectorAll(selectors.homeCourseCard)].some(visible),
        courseWorkReady: [...document.querySelectorAll(selectors.navTitle)].some(visible) &&
          [selectors.courseWorkItem, '.van-empty', selectors.courseMenuTrigger]
            .some((selector) => [...document.querySelectorAll(selector)].some(visible)),
        answerReady: [...document.querySelectorAll(selectors.questionInfo)].some(visible),
        answerBoot: [...document.querySelectorAll(selectors.navTitle)].some(visible) &&
          [...document.querySelectorAll(selectors.answerSkeleton)].some(visible),
        recordReady: [...document.querySelectorAll(selectors.recordItem)].some(visible) ||
          [...document.querySelectorAll(selectors.navTitle)]
            .some((node) => visible(node) && (node.textContent || '').includes('作答记录')),
        submitSuccess: [...document.querySelectorAll(selectors.successToast)].some(visible),
        bodyText,
        bodyTextLength: (document.body?.innerText || '').replace(/\s+/g, '').length,
        skeleton: [selectors.answerSkeleton, '.skeleton-area.van-skeleton']
          .some((selector) => [...document.querySelectorAll(selector)].some(visible)),
      }
    }, NOQR_SEL)
  } catch {
    return 'unknown'
  }

  const host = (() => {
    try { return new URL(value.url).hostname } catch { return '' }
  })()
  if (host === 'open.weixin.qq.com' || AUTH_BLOCK_PATTERN.test(value.bodyText)) return 'auth_blocked'
  if (LOGIN_ERROR_PATTERN.test(value.bodyText) && !value.homeReady) return 'login_failed'
  if (PAGE_ERROR_PATTERN.test(value.bodyText)) return 'error'
  if (isNoqrHomePath(value.url) && !value.loginVisible) return value.homeReady ? 'home' : 'home_blank'
  if (isNoqrLoginPath(value.url) && value.loginVisible) return 'login'
  if (normalizedPath(value.url) === NOQR_PATH.courseWork && value.courseWorkReady) return 'course_work'
  if (normalizedPath(value.url) === NOQR_PATH.record && value.recordReady) return 'record'
  if (normalizedPath(value.url) === NOQR_PATH.answer && value.submitSuccess) return 'submit_success'
  if (normalizedPath(value.url) === NOQR_PATH.answer && value.answerReady) return 'answer'
  if (normalizedPath(value.url) === NOQR_PATH.answer && (value.answerBoot || value.skeleton)) return 'answer_boot'
  if (!value.bodyTextLength && !value.loginVisible && !value.homeReady) return 'blank'
  return 'unknown'
}

async function waitForSurface(
  page: Page,
  accept: (surface: NoqrPageSurface) => boolean,
  opts: {
    signal?: AbortSignal
    onWaiting?: (elapsedMs: number) => void
    blankGraceMs?: number
    blankMaxActiveWaitMs?: number
    blankMaxHeartbeatWaitMs?: number
  } = {},
): Promise<NoqrPageSurface> {
  const startedAt = Date.now()
  const network = new NoqrNetworkActivity(page)
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    maxActiveWaitMs: opts.blankMaxActiveWaitMs,
    maxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
    refreshBudget: 3,
  })
  try {
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      const surface = await classifyNoqrPage(page)
      if (accept(surface)) return surface
      if (surface === 'auth_blocked') {
        throw new NoqrSessionError('auth_blocked', '页面要求企业微信、验证码、扫码或其它人工认证，已暂停且未进入旧扫码流程')
      }
      if (surface === 'login_failed') {
        throw new NoqrSessionError('login_failed', '页面明确显示登录失败')
      }
      if (surface === 'error') {
        throw new NoqrSessionError('page_error', '页面显示明确错误')
      }
      if (['course_work', 'record', 'answer', 'answer_boot', 'submit_success'].includes(surface)) {
        throw new NoqrSessionError('page_error', '登录入口意外进入非登录业务页面，已安全停止当前学生')
      }
      if (surface === 'blank' || surface === 'home_blank' || surface === 'unknown') {
        const decision = recovery.observe({
          now: Date.now(),
          activityVersion: network.businessActivityVersion,
          empty: true,
          active: network.isBusinessActive(),
          stopRequested: opts.signal?.aborted,
        })
        if (decision.action === 'refresh') {
          await reloadNoqrPage(page, { signal: opts.signal })
          continue
        }
        if (decision.action === 'stop') {
          throw new NoqrSessionError('blank_page', '登录入口持续无响应，已安全停止当前学生')
        }
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(page, 200, opts.signal)
    }
  } finally {
    network.dispose()
  }
}

async function reloadUntilLoginSurface(
  page: Page,
  signal?: AbortSignal,
  budget = 3,
  blankGraceMs?: number,
  blankMaxActiveWaitMs?: number,
  blankMaxHeartbeatWaitMs?: number,
): Promise<NoqrPageSurface> {
  const network = new NoqrNetworkActivity(page)
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: blankGraceMs,
    maxActiveWaitMs: blankMaxActiveWaitMs,
    maxHeartbeatWaitMs: blankMaxHeartbeatWaitMs,
    refreshBudget: budget,
  })
  try {
    for (;;) {
      throwIfNoqrStopped(signal)
      const surface = await classifyNoqrPage(page)
      if (surface === 'login' || surface === 'home' || surface === 'auth_blocked' ||
          surface === 'login_failed' || surface === 'error') return surface
      const blank = surface === 'blank' || surface === 'home_blank' || surface === 'unknown'
      if (!blank) return surface
      const decision = recovery.observe({
        now: Date.now(),
        activityVersion: network.businessActivityVersion,
        empty: true,
        active: network.isBusinessActive(),
        stopRequested: signal?.aborted,
      })
      if (decision.action === 'refresh') {
        await reloadNoqrPage(page, { signal })
        continue
      }
      if (decision.action === 'stop') {
        if (surface === 'home_blank') {
          throw new NoqrSessionError('page_error', '登录会话已进入首页，但首页持久无响应，已安全停止当前学生')
        }
        throw new NoqrSessionError('blank_page', '登录页持续无响应，已安全停止当前学生')
      }
      await sleepNoqr(page, 150, signal)
    }
  } finally {
    network.dispose()
  }
}

/**
 * Start the login/home navigation without blindly waiting forever for a
 * document response. The page is still allowed to finish a genuinely slow
 * response; only a quiet blank document is eligible for the existing bounded
 * recovery path.
 */
export async function navigateNoqrPage(
  page: Page,
  url: string,
  opts: {
    origin?: string
    signal?: AbortSignal
    blankGraceMs?: number
    blankMaxActiveWaitMs?: number
    blankMaxHeartbeatWaitMs?: number
    onWaiting?: (elapsedMs: number) => void
  } = {},
): Promise<void> {
  page.setDefaultNavigationTimeout(0)
  const network = new NoqrNetworkActivity(page, opts.origin)
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    maxActiveWaitMs: opts.blankMaxActiveWaitMs,
    maxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
    refreshBudget: 3,
  })
  const startedAt = Date.now()
  let settled = false
  let navigationError: unknown
  let recoverAfterNavigationError = false
  const navigation = page.goto(url, {
    waitUntil: 'commit',
    timeout: 0,
  }).then(() => {
    settled = true
  }).catch((error: unknown) => {
    settled = true
    navigationError = error
  })
  try {
    const classifyNavigationPage = async (): Promise<NoqrPageSurface> => {
      // Playwright can keep page.evaluate() pending while the first document
      // is still waiting for commit. Treat the initial about:blank document as
      // a blank observation so the recovery gate can still run.
      if (!settled && page.url() === 'about:blank') return 'blank'
      return classifyNoqrPage(page)
    }
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      if (settled && !recoverAfterNavigationError) {
        if (navigationError) {
          const surface = await classifyNavigationPage()
          if (!['blank', 'home_blank', 'unknown'].includes(surface)) throw navigationError
          recoverAfterNavigationError = true
        }
      }
      const surface = await classifyNavigationPage()
      if (['login', 'home', 'auth_blocked', 'login_failed', 'error', 'course_work', 'record', 'answer', 'answer_boot', 'submit_success'].includes(surface)) {
        return
      }
      const blank = surface === 'blank' || surface === 'home_blank' || surface === 'unknown'
      if (blank) {
        const decision = recovery.observe({
          now: Date.now(),
          activityVersion: network.businessActivityVersion,
          empty: true,
          active: network.isBusinessActive(),
          stopRequested: opts.signal?.aborted,
        })
        if (decision.action === 'refresh') {
          await restartNoqrNavigation(page, url, {
            signal: opts.signal,
            stopRequested: () => opts.signal?.aborted === true,
          })
          // The original commit wait may reject after this controlled restart.
          // It belongs to the navigation we intentionally cancelled.
          recoverAfterNavigationError = true
          navigationError = undefined
          settled = true
          continue
        }
        if (decision.action === 'stop') {
          throw new NoqrSessionError('blank_page', '登录入口持续无响应，已安全停止当前学生')
        }
      } else {
        recovery.observe({
          now: Date.now(),
          activityVersion: network.businessActivityVersion,
          empty: false,
          active: network.isBusinessActive(),
        })
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(page, 150, opts.signal)
    }
  } finally {
    network.dispose()
    // The page may be reloaded while the original commit wait is pending.
    // Consume that late rejection so it cannot become an unhandled rejection.
    void navigation
  }
}

export async function ensureNoqrSession(page: Page, opts: NoqrLoginOptions): Promise<NoqrLoginResult> {
  if (!opts.username || !opts.password) {
    throw new NoqrSessionError('credentials_missing', '账号或密码为空，未提交登录')
  }
  const startedAt = Date.now()
  throwIfNoqrStopped(opts.signal)
  // School pages may legitimately need minutes to respond. Keep the state
  // machine in control instead of inheriting Playwright's 30 second timeout.
  page.setDefaultNavigationTimeout(0)
  const accountKey = loginAccountKey(opts.username)
  await captureNoqrSessionStorage(page, accountKey)
  const hasSessionSnapshot = await primeNoqrSessionStorage(page, accountKey)
  const loginState = loginSubmissionFor(page, accountKey)
  const canReuseAuthenticatedSession = hasSessionSnapshot || loginState.entry?.authenticated === true
  // Every internal page enters through the one supported login URL. A primed
  // session may let that page redirect immediately, but direct home navigation
  // is forbidden by the real-site contract.
  await navigateNoqrPage(page, NOQR_LOGIN_URL, {
    signal: opts.signal,
    blankGraceMs: opts.blankGraceMs,
    blankMaxActiveWaitMs: opts.blankMaxActiveWaitMs,
    blankMaxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
    onWaiting: opts.onWaiting,
  })
  let surface = await reloadUntilLoginSurface(
    page,
    opts.signal,
    3,
    opts.blankGraceMs,
    opts.blankMaxActiveWaitMs,
    opts.blankMaxHeartbeatWaitMs,
  )
  if (surface === 'login' && canReuseAuthenticatedSession) {
    // A new tab still enters through the only supported login URL. The real
    // school does not always redirect an already-authenticated tab from that
    // surface, so continue exactly once from the login document. Credentials
    // are never filled or submitted again.
    await navigateNoqrPage(page, NOQR_ORIGIN + NOQR_PATH.home, {
      signal: opts.signal,
      blankGraceMs: opts.blankGraceMs,
      blankMaxActiveWaitMs: opts.blankMaxActiveWaitMs,
      blankMaxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
      onWaiting: opts.onWaiting,
    })
    surface = await reloadUntilLoginSurface(
      page,
      opts.signal,
      3,
      opts.blankGraceMs,
      opts.blankMaxActiveWaitMs,
      opts.blankMaxHeartbeatWaitMs,
    )
    if (surface === 'login') {
      throw new NoqrSessionError(
        'login_failed',
        '已认证上下文未能从登录入口续接首页，已暂停且不会再次提交凭据',
      )
    }
  }
  if (surface === 'home') {
    await captureNoqrSessionStorage(page, accountKey)
    markNoqrAuthenticated(page, accountKey)
    opts.onPhase?.('home')
    return { reused: true, finalUrl: page.url(), elapsedMs: Date.now() - startedAt }
  }
  if (surface === 'auth_blocked') {
    throw new NoqrSessionError('auth_blocked', '登录入口要求企业微信、验证码、扫码或其它人工认证')
  }
  if (surface === 'error') {
    throw new NoqrSessionError('page_error', '登录页显示明确错误，未提交登录')
  }
  if (surface === 'login_failed') {
    throw new NoqrSessionError('login_failed', '登录页明确显示账号或密码错误')
  }
  if (surface !== 'login') {
    surface = await waitForSurface(page, (kind) => kind === 'login' || kind === 'home' || kind === 'auth_blocked', {
      signal: opts.signal,
      onWaiting: opts.onWaiting,
      blankGraceMs: opts.blankGraceMs,
      blankMaxActiveWaitMs: opts.blankMaxActiveWaitMs,
      blankMaxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
    })
  }
  if (surface === 'home') {
    await captureNoqrSessionStorage(page, accountKey)
    markNoqrAuthenticated(page, accountKey)
    opts.onPhase?.('home')
    return { reused: true, finalUrl: page.url(), elapsedMs: Date.now() - startedAt }
  }

  let lastFailedStatus = 0
  let loginSettledAt = 0
  const responseListener = (response: Response) => {
    if (!isLikelyNoqrLoginRequest(response.request())) return
    if (response.status() >= 400) lastFailedStatus = response.status()
  }
  const network = new NoqrNetworkActivity(page)
  const loginRecovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    maxActiveWaitMs: opts.blankMaxActiveWaitMs,
    maxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
    refreshBudget: 3,
  })
  page.on('response', responseListener)
  try {
    opts.onPhase?.('login_page')
    const username = page.locator(NOQR_SEL.loginUsername).first()
    const password = page.locator(NOQR_SEL.loginPassword).first()
    await username.fill(opts.username)
    await password.fill(opts.password)
    const submit = page.locator('button, input[type="button"], input[type="submit"]')
      .filter({ hasText: /^提交$/ })
      .first()
    const canSubmit = Boolean(await submit.count())
    throwIfNoqrStopped(opts.signal)
    if (loginState.entry?.submitted) {
      throw new NoqrSessionError(
        'login_failed',
        '当前账号已完成一次登录提交，未能复用会话，已暂停且不会再次提交凭据',
      )
    }
    loginState.set({ page, submitted: true, authenticated: false })
    if (canSubmit) await submit.click()
    else {
      throwIfNoqrStopped(opts.signal)
      await password.press('Enter')
    }
    opts.onPhase?.('logging_in')

    for (;;) {
        throwIfNoqrStopped(opts.signal)
        surface = await classifyNoqrPage(page)
        if (surface === 'home') {
          await captureNoqrSessionStorage(page, accountKey)
          markNoqrAuthenticated(page, accountKey)
          opts.onPhase?.('home')
          return { reused: false, finalUrl: page.url(), elapsedMs: Date.now() - startedAt }
        }
        const currentUrl = page.url()
        if (surface === 'home_blank' && currentUrl && isNoqrHomePath(currentUrl)) {
          await ensureNoqrHomeReady(page, {
            signal: opts.signal,
            refreshBudget: 3,
            onWaiting: opts.onWaiting,
            blankGraceMs: opts.blankGraceMs,
            blankMaxActiveWaitMs: opts.blankMaxActiveWaitMs,
            blankMaxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
            network,
          })
          await captureNoqrSessionStorage(page, accountKey)
          markNoqrAuthenticated(page, accountKey)
          opts.onPhase?.('home')
          return { reused: false, finalUrl: page.url(), elapsedMs: Date.now() - startedAt }
        }
        if (surface === 'auth_blocked') {
          throw new NoqrSessionError('auth_blocked', '登录后要求企业微信、验证码、扫码或其它人工认证')
        }
        if (surface === 'login_failed') {
          throw new NoqrSessionError('login_failed', '登录后页面明确显示账号或密码错误')
        }
        if (surface === 'login') {
          const bodyText = await page.locator('body').innerText().catch(() => '')
          if (LOGIN_ERROR_PATTERN.test(bodyText) || lastFailedStatus >= 400) {
            throw new NoqrSessionError('login_failed', `登录失败，页面或请求返回明确失败${lastFailedStatus ? `（HTTP ${lastFailedStatus}）` : ''}`)
          }
          const loading = /加载中/.test(bodyText)
          if (loading || network.isBusinessActive()) {
            loginSettledAt = 0
          } else {
            loginSettledAt ||= Date.now()
            if (Date.now() - loginSettledAt >= Math.max(50, opts.loginIdleBudgetMs ?? 120_000)) {
              throw new NoqrSessionError('login_failed', '登录表单已停止加载且无活动请求，已安全停止当前学生')
            }
          }
        }
        if (surface === 'error') {
          throw new NoqrSessionError('page_error', '登录中页面显示明确错误')
        }
        if (['course_work', 'record', 'answer', 'answer_boot', 'submit_success'].includes(surface)) {
          throw new NoqrSessionError('page_error', '登录提交后意外进入非首页业务页面，已停止且不刷新答题页')
        }
        if (surface === 'blank' || surface === 'home_blank' || surface === 'unknown') {
          const decision = loginRecovery.observe({
            now: Date.now(),
            activityVersion: network.businessActivityVersion,
            empty: true,
            active: network.isBusinessActive(),
            stopRequested: opts.signal?.aborted,
          })
          if (decision.action === 'refresh') {
            await reloadNoqrPage(page, { signal: opts.signal })
            continue
          }
          if (decision.action === 'stop') {
            throw new NoqrSessionError('blank_page', '登录提交后页面持续空白或未识别，已安全停止当前学生')
          }
        }
        opts.onWaiting?.(Date.now() - startedAt)
        await sleepNoqr(page, 200, opts.signal)
    }
  } finally {
    page.off('response', responseListener)
    network.dispose()
  }
}

export async function ensureNoqrHomeReady(
  page: Page,
  opts: {
    signal?: AbortSignal
    refreshBudget?: number
    onWaiting?: (elapsed: number) => void
    blankGraceMs?: number
    blankMaxActiveWaitMs?: number
    blankMaxHeartbeatWaitMs?: number
    network?: NoqrNetworkActivity
  } = {},
): Promise<void> {
  page.setDefaultNavigationTimeout(0)
  const ownNetwork = opts.network ? null : new NoqrNetworkActivity(page)
  const network = opts.network || ownNetwork!
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    maxActiveWaitMs: opts.blankMaxActiveWaitMs,
    maxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
    refreshBudget: opts.refreshBudget ?? 3,
  })
  try {
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      const surface = await classifyNoqrPage(page)
      if (surface === 'home') return
      if (isNoqrAnswerPath(page.url())) {
        throw new NoqrSessionError('answer_interrupted', '首页恢复流程误入答题页，已保留页面且不刷新')
      }
      if (surface === 'auth_blocked' || surface === 'login') {
        throw new NoqrSessionError('auth_blocked', '首页进入企业微信或人工认证页面')
      }
      if (surface === 'login_failed') throw new NoqrSessionError('login_failed', '首页显示登录失败')
      if (surface === 'error') throw new NoqrSessionError('page_error', '首页显示明确错误')
      if (surface === 'course_work' || surface === 'record') {
        throw new NoqrSessionError('page_error', '首页恢复流程停在非首页业务页面，已保留当前页面')
      }
      let quietForMs = 0
      if (surface === 'blank' || surface === 'home_blank' || surface === 'unknown') {
        const decision = recovery.observe({
          now: Date.now(),
          activityVersion: network.businessActivityVersion,
          empty: true,
          active: network.isBusinessActive(),
          stopRequested: opts.signal?.aborted,
        })
        quietForMs = decision.quietForMs
        if (decision.action === 'refresh') {
          opts.onWaiting?.(decision.quietForMs)
          await reloadNoqrPage(page, { signal: opts.signal })
          continue
        }
        if (decision.action === 'stop') {
          throw new NoqrSessionError('blank_page', '首页持续无响应，已安全停止当前学生')
        }
      } else {
        recovery.observe({
          now: Date.now(),
          activityVersion: network.businessActivityVersion,
          empty: false,
          active: network.isBusinessActive(),
        })
      }
      if (surface === 'blank' || surface === 'home_blank' || surface === 'unknown') opts.onWaiting?.(quietForMs)
      await sleepNoqr(page, 150, opts.signal)
    }
  } finally {
    ownNetwork?.dispose()
  }
}
