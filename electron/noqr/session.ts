import type { Page, Request, Response } from 'patchright'
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
}

export type NoqrLoginResult = {
  reused: boolean
  finalUrl: string
  elapsedMs: number
}

export type NoqrSessionErrorCode =
  | 'login_failed'
  | 'auth_blocked'
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
  page.setDefaultNavigationTimeout(0)
  await awaitNoqrNavigation(
    page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }),
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
  private readonly page: Page
  private readonly origin: string
  private readonly onRequest = (request: Request) => {
    if (this.tracked(request)) this.active.add(request)
  }
  private readonly onFinished = (request: Request) => {
    this.active.delete(request)
  }
  private readonly onFailed = (request: Request) => {
    this.active.delete(request)
  }

  constructor(page: Page, origin = NOQR_ORIGIN) {
    this.page = page
    this.origin = origin
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

  get size(): number {
    return this.active.size
  }

  isActive(): boolean {
    return this.active.size > 0
  }

  dispose(): void {
    this.page.off('request', this.onRequest)
    this.page.off('requestfinished', this.onFinished)
    this.page.off('requestfailed', this.onFailed)
    this.active.clear()
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
      return {
        url: location.href,
        loginVisible: visible(username) && visible(password),
        homeReady: Boolean(document.querySelector(selectors.homeMenuItems) || document.querySelector(selectors.homeCourseCard)),
        courseWorkReady: Boolean(document.querySelector(selectors.navTitle) &&
          (document.querySelector(selectors.courseWorkItem) || document.querySelector('.van-empty') || document.querySelector(selectors.courseMenuTrigger))),
        answerReady: Boolean(document.querySelector(selectors.questionInfo)),
        answerBoot: Boolean(document.querySelector(selectors.navTitle) && document.querySelector(selectors.answerSkeleton)),
        recordReady: Boolean(document.querySelector(selectors.recordItem) ||
          (document.querySelector(selectors.navTitle)?.textContent || '').includes('作答记录')),
        submitSuccess: Boolean(document.querySelector(selectors.successToast)),
        bodyText,
        bodyTextLength: (document.body?.innerText || '').replace(/\s+/g, '').length,
        skeleton: Boolean(document.querySelector(selectors.answerSkeleton) || document.querySelector('.skeleton-area.van-skeleton')),
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
  } = {},
): Promise<NoqrPageSurface> {
  const startedAt = Date.now()
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
    opts.onWaiting?.(Date.now() - startedAt)
    await sleepNoqr(page, 200, opts.signal)
  }
}

async function reloadUntilLoginSurface(page: Page, signal?: AbortSignal, budget = 3): Promise<NoqrPageSurface> {
  let attempts = 0
  for (;;) {
    throwIfNoqrStopped(signal)
    const surface = await classifyNoqrPage(page)
    if (surface === 'login' || surface === 'home' || surface === 'auth_blocked' ||
        surface === 'login_failed' || surface === 'error') return surface
    const loginBlank = surface === 'unknown' && isNoqrLoginPath(page.url())
    if ((surface === 'blank' || surface === 'home_blank' || loginBlank) && attempts < budget) {
      attempts++
      await reloadNoqrPage(page, { signal })
      continue
    }
    if (surface === 'home_blank') {
      throw new NoqrSessionError('page_error', '登录会话已进入首页，但首页连续刷新后仍未加载业务内容')
    }
    if (surface === 'blank' || loginBlank) {
      throw new NoqrSessionError('blank_page', '登录页连续刷新后仍为无活动空白，已安全停止当前学生')
    }
    return surface
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
  await awaitNoqrNavigation(
    page.goto(NOQR_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 0 }),
    opts.signal,
  )
  let surface = await reloadUntilLoginSurface(page, opts.signal)
  if (surface === 'home') {
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
    })
  }
  if (surface === 'home') {
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
          opts.onPhase?.('home')
          return { reused: false, finalUrl: page.url(), elapsedMs: Date.now() - startedAt }
        }
        const currentUrl = page.url()
        if (surface === 'home_blank' && currentUrl && isNoqrHomePath(currentUrl)) {
          await ensureNoqrHomeReady(page, {
            signal: opts.signal,
            refreshBudget: 3,
            onWaiting: opts.onWaiting,
          })
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
          if (loading || network.isActive()) {
            loginSettledAt = 0
          } else {
            loginSettledAt ||= Date.now()
            if (Date.now() - loginSettledAt >= Math.max(50, opts.loginIdleBudgetMs ?? 2_000)) {
              throw new NoqrSessionError('login_failed', '登录表单已停止加载且无活动请求，已安全停止当前学生')
            }
          }
        }
        if (surface === 'error') {
          throw new NoqrSessionError('page_error', '登录中页面显示明确错误')
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
  opts: { signal?: AbortSignal; refreshBudget?: number; onWaiting?: (elapsed: number) => void } = {},
): Promise<void> {
  page.setDefaultNavigationTimeout(0)
  const network = new NoqrNetworkActivity(page)
  let refreshAttempts = 0
  try {
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      const surface = await classifyNoqrPage(page)
      if (surface === 'home') return
      if (surface === 'auth_blocked') {
        throw new NoqrSessionError('auth_blocked', '首页进入企业微信或人工认证页面')
      }
      if (surface === 'login_failed') throw new NoqrSessionError('login_failed', '首页显示登录失败')
      if (surface === 'error') throw new NoqrSessionError('page_error', '首页显示明确错误')
      if (network.isActive()) {
        opts.onWaiting?.(network.size)
        await sleepNoqr(page, 150, opts.signal)
        continue
      }
      if ((surface === 'blank' || surface === 'home_blank') && refreshAttempts < (opts.refreshBudget ?? 3)) {
        refreshAttempts++
        await reloadNoqrPage(page, { signal: opts.signal })
        continue
      }
      if (surface === 'blank' || surface === 'home_blank') {
        throw new NoqrSessionError('blank_page', '首页连续刷新后仍无业务标记')
      }
      await sleepNoqr(page, 150, opts.signal)
    }
  } finally {
    network.dispose()
  }
}
