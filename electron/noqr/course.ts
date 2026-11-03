import { createHash } from 'node:crypto'
import type { Page } from 'patchright'
import { NoqrBlankRecoveryGate } from './blank-recovery.ts'
import type { NoqrCourse } from './types.ts'
import { NOQR_PATH, NOQR_SEL } from './selectors.ts'
import {
  classifyNoqrPage,
  ensureNoqrHomeReady,
  isNoqrAnswerPath,
  NoqrNetworkActivity,
  NoqrSessionError,
  reloadNoqrPage,
  sleepNoqr,
  throwIfNoqrStopped,
} from './session.ts'

export type NoqrCourseWorkOptions = {
  signal?: AbortSignal
  refreshBudget?: number
  onWaiting?: (waiting: number) => void
  blankGraceMs?: number
  blankMaxActiveWaitMs?: number
  blankMaxHeartbeatWaitMs?: number
  network?: NoqrNetworkActivity
}

export type NoqrCourseWorkReady = 'ready' | 'empty'

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

const COURSE_MENU_UTILITY_NAMES = new Set(['中文', 'english', '切换课程'])
const COURSE_SWITCH_SAME_CARD_CONFIRM_MS = 2_500

export function isNoqrCourseMenuItem(name: string): boolean {
  const normalized = normalizedText(name).toLocaleLowerCase('en-US')
  return Boolean(normalized) && !COURSE_MENU_UTILITY_NAMES.has(normalized)
}

function normalizedPath(urlText: string): string {
  try { return new URL(urlText).pathname.replace(/\/+$/, '') || '/' } catch { return '' }
}

export function noqrCourseKey(name: string, order: number, stableToken = ''): string {
  return 'course:' + createHash('sha256')
    .update(`${order}\n${normalizedText(name)}\n${stableToken.trim()}`)
    .digest('hex')
    .slice(0, 20)
}

export async function waitForNoqrCourseWorkReady(
  page: Page,
  opts: NoqrCourseWorkOptions = {},
): Promise<NoqrCourseWorkReady> {
  const startedAt = Date.now()
  const ownNetwork = opts.network ? null : new NoqrNetworkActivity(page)
  const network = opts.network || ownNetwork!
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    maxActiveWaitMs: opts.blankMaxActiveWaitMs,
    maxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
    refreshBudget: opts.refreshBudget ?? 3,
  })
  let progressVersion = 0
  let lastProgress = ''
  try {
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked') throw new NoqrSessionError('auth_blocked', '形考作业页进入企业微信或人工认证')
      if (surface === 'error') throw new NoqrSessionError('page_error', '形考作业页显示明确错误')
      if (isNoqrAnswerPath(page.url())) {
        throw new NoqrSessionError('answer_interrupted', '非答题恢复流程误入答题页，已保留页面且不刷新')
      }
      if (normalizedPath(page.url()) !== NOQR_PATH.courseWork) {
        throw new NoqrSessionError('course_contract', '形考作业入口没有进入课程作业页')
      }
      const state = await page.evaluate((selectors) => {
        const visible = (node: Element) => {
          if (!(node instanceof HTMLElement)) return false
          const style = getComputedStyle(node)
          return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
        }
        const items = [...document.querySelectorAll(selectors.courseWorkItem)].filter(visible).length
        const skeleton = [...document.querySelectorAll('.skeleton-area.van-skeleton')].some(visible)
        const empty = [...document.querySelectorAll('.van-empty')].some(visible) ||
          /暂无作业|没有作业|暂无数据/.test(document.body?.innerText || '')
        const title = (document.querySelector(selectors.navTitle)?.textContent || '').trim()
        return { items, skeleton, empty, title }
      }, NOQR_SEL)
      if ((state.items > 0 || state.empty) && !state.skeleton) return 'ready'
      const progress = JSON.stringify(state)
      if (progress !== lastProgress) {
        lastProgress = progress
        progressVersion++
      }
      const decision = recovery.observe({
        now: Date.now(),
        activityVersion: network.businessActivityVersion * 1_000_003 + progressVersion,
        empty: true,
        active: network.isBusinessActive(),
        stopRequested: opts.signal?.aborted,
      })
      if (decision.action === 'refresh') {
        await reloadNoqrPage(page, { signal: opts.signal })
        lastProgress = ''
        progressVersion++
        continue
      }
      if (decision.action === 'stop') {
        if (network.isBusinessActive() || state.skeleton) {
          throw new NoqrSessionError(
            'blank_page',
            '形考作业页持续处于活动请求或骨架加载，未确认无作业，已安全停止当前学生',
          )
        }
        // The school can legitimately leave a course work page without cards
        // after repeated refreshes. Treat that isolated course as having no
        // visible homework instead of failing the whole account.
        return 'empty'
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(page, 150, opts.signal)
    }
  } finally {
    ownNetwork?.dispose()
  }
}

export async function openNoqrCourseWork(page: Page, opts: NoqrCourseWorkOptions = {}): Promise<void> {
  const initial = await classifyNoqrPage(page)
  if (initial === 'course_work') {
    await waitForNoqrCourseWorkReady(page, opts)
    return
  }
  await ensureNoqrHomeReady(page, opts)
  const entry = page.locator(NOQR_SEL.homeMenuItems)
    .getByText('形考作业', { exact: true })
    .first()
  if (!(await entry.count())) throw new NoqrSessionError('course_contract', '首页缺少“形考作业”入口')
  throwIfNoqrStopped(opts.signal)
  const startedAt = Date.now()
  const network = new NoqrNetworkActivity(page)
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    refreshBudget: opts.refreshBudget ?? 3,
  })
  try {
    // Attach before the click so a slow request started by the click cannot
    // be mistaken for a quiet blank page.
    await entry.click()
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      if (normalizedPath(page.url()) === NOQR_PATH.courseWork) {
        await waitForNoqrCourseWorkReady(page, { ...opts, network })
        return
      }
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked' || surface === 'login') {
        throw new NoqrSessionError('auth_blocked', '形考作业入口进入登录或人工认证页面')
      }
      if (surface === 'error') throw new NoqrSessionError('page_error', '形考作业入口显示明确错误')
      if (isNoqrAnswerPath(page.url())) {
        throw new NoqrSessionError('answer_interrupted', '形考作业入口误入答题页，已保留页面且不刷新')
      }
      const decision = recovery.observe({
        now: Date.now(),
        activityVersion: network.businessActivityVersion,
        empty: true,
        active: network.isBusinessActive(),
        stopRequested: opts.signal?.aborted,
      })
      if (decision.action === 'refresh') {
        await reloadNoqrPage(page, { signal: opts.signal })
        await ensureNoqrHomeReady(page, { ...opts, network })
        await entry.click()
        continue
      }
      if (decision.action === 'stop') {
        throw new NoqrSessionError('blank_page', '形考作业入口持续无响应，已安全停止当前学生')
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(page, 150, opts.signal)
    }
  } finally {
    network.dispose()
  }
}

async function menuVisible(page: Page): Promise<boolean> {
  const names = await page.locator(NOQR_SEL.courseMenuItem).evaluateAll((nodes) => nodes
    .filter((node) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
    })
    .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()))
  return names.some(isNoqrCourseMenuItem)
}

async function openCourseMenu(
  page: Page,
  signal?: AbortSignal,
  blankGraceMs?: number,
  refreshBudget = 3,
): Promise<void> {
  if (isNoqrAnswerPath(page.url())) {
    throw new NoqrSessionError('answer_interrupted', '课程菜单恢复不允许在答题页刷新或重建')
  }
  if (await menuVisible(page)) return
  const trigger = page.locator(NOQR_SEL.courseMenuTrigger).first()
  const network = new NoqrNetworkActivity(page)
  const recovery = new NoqrBlankRecoveryGate({ graceMs: blankGraceMs, refreshBudget })
  try {
    for (;;) {
      throwIfNoqrStopped(signal)
      if (await trigger.isVisible().catch(() => false)) break
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked' || surface === 'login') {
        throw new NoqrSessionError('auth_blocked', '课程菜单打开前进入登录或人工认证页面')
      }
      if (surface === 'error') {
        throw new NoqrSessionError('page_error', '课程菜单打开前页面显示明确错误')
      }
      if (isNoqrAnswerPath(page.url())) {
        throw new NoqrSessionError('answer_interrupted', '课程菜单恢复误入答题页，已保留页面且不刷新')
      }
      const decision = recovery.observe({
        now: Date.now(),
        activityVersion: network.businessActivityVersion,
        empty: true,
        active: network.isBusinessActive(),
        stopRequested: signal?.aborted,
      })
      if (decision.action === 'refresh') {
        await reloadNoqrPage(page, { signal })
        await waitForNoqrCourseWorkReady(page, {
          signal,
          blankGraceMs,
          refreshBudget,
          network,
        })
        continue
      }
      if (decision.action === 'stop') {
        throw new NoqrSessionError('course_contract', '课程作业页持续缺少课程菜单入口')
      }
      await sleepNoqr(page, 100, signal)
    }
    throwIfNoqrStopped(signal)
    await trigger.click()
    for (;;) {
      throwIfNoqrStopped(signal)
      if (await menuVisible(page)) return
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked' || surface === 'login') {
        throw new NoqrSessionError('auth_blocked', '课程菜单打开后进入登录或人工认证页面')
      }
      if (surface === 'error') {
        throw new NoqrSessionError('page_error', '课程菜单打开后页面显示明确错误')
      }
      if (isNoqrAnswerPath(page.url())) {
        throw new NoqrSessionError('answer_interrupted', '课程菜单恢复误入答题页，已保留页面且不刷新')
      }
      const decision = recovery.observe({
        now: Date.now(),
        activityVersion: network.businessActivityVersion,
        empty: true,
        active: network.isBusinessActive(),
        stopRequested: signal?.aborted,
      })
      if (decision.action === 'refresh') {
        await reloadNoqrPage(page, { signal })
        await waitForNoqrCourseWorkReady(page, {
          signal,
          blankGraceMs,
          refreshBudget,
          network,
        })
        await trigger.click()
        continue
      }
      if (decision.action === 'stop') {
        throw new NoqrSessionError('blank_page', '课程菜单持续无响应，已安全停止当前学生')
      }
      await sleepNoqr(page, 100, signal)
    }
  } finally {
    network.dispose()
  }
}

export async function readNoqrCourseMenu(
  page: Page,
  opts: { signal?: AbortSignal; blankGraceMs?: number; refreshBudget?: number } = {},
): Promise<NoqrCourse[]> {
  throwIfNoqrStopped(opts.signal)
  await openCourseMenu(page, opts.signal, opts.blankGraceMs, opts.refreshBudget)
  const rows = await page.locator(NOQR_SEL.courseMenuItem).evaluateAll((nodes) =>
    nodes.map((node, index) => ({
      order: index + 1,
      name: (node.textContent || '').replace(/\s+/g, ' ').trim(),
      current: node.classList.contains('top-pop-active'),
      visible: node instanceof HTMLElement &&
        getComputedStyle(node).display !== 'none' &&
        getComputedStyle(node).visibility !== 'hidden' &&
        node.getClientRects().length > 0,
      stableToken: [
        node.getAttribute('data-course-id'),
        node.getAttribute('data-id'),
        node.getAttribute('data-key'),
        node.getAttribute('data-course-order'),
      ].filter(Boolean).join('|'),
    })),
  )
  const courses: NoqrCourse[] = []
  const namesByOrder = new Set<string>()
  for (const row of rows) {
    // The shared top menu also contains language and switch-course actions.
    // Keep their original DOM order for clicks, but never expose them as courses.
    if (!row.visible || !isNoqrCourseMenuItem(row.name)) continue
    if (!row.name || namesByOrder.has(String(row.order))) {
      throw new NoqrSessionError('course_contract', '课程菜单存在空名称或重复顺序，禁止猜课程身份')
    }
    namesByOrder.add(String(row.order))
    courses.push({
      key: noqrCourseKey(row.name, row.order, row.stableToken),
      name: row.name,
      order: row.order,
      current: row.current,
      stableToken: row.stableToken || undefined,
    })
  }
  if (!courses.length) throw new NoqrSessionError('course_contract', '课程菜单没有可读取课程')
  return courses
}

export async function readNoqrCourseTitle(page: Page): Promise<string> {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector)
    return String(node?.textContent || '').replace(/\s+/g, ' ').trim()
  }, NOQR_SEL.navTitle).catch(() => '')
}

async function activeCourseIdentity(page: Page): Promise<{ order: number; stableToken: string }> {
  return page.locator(NOQR_SEL.courseMenuItem).evaluateAll((nodes) => {
    const index = nodes.findIndex((node) =>
      node.classList.contains('top-pop-active') &&
      node instanceof HTMLElement &&
      getComputedStyle(node).display !== 'none' &&
      getComputedStyle(node).visibility !== 'hidden' &&
      node.getClientRects().length > 0)
    const node = index >= 0 ? nodes[index] : null
    return {
      order: index >= 0 ? index + 1 : 0,
      stableToken: node
        ? [
            node.getAttribute('data-course-id'),
            node.getAttribute('data-id'),
            node.getAttribute('data-key'),
            node.getAttribute('data-course-order'),
          ].filter(Boolean).join('|')
        : '',
    }
  })
}

async function readActiveCourseFromMenu(
  page: Page,
  opts: { signal?: AbortSignal; blankGraceMs?: number; refreshBudget?: number } = {},
): Promise<{ order: number; stableToken: string }> {
  const wasOpen = await menuVisible(page)
  if (!wasOpen) await openCourseMenu(page, opts.signal, opts.blankGraceMs, opts.refreshBudget)
  const identity = await activeCourseIdentity(page)
  if (!wasOpen) {
    throwIfNoqrStopped(opts.signal)
    await page.locator(NOQR_SEL.courseMenuTrigger).first().click().catch(() => {})
  }
  return identity
}

async function readCourseOrderFromMenu(
  page: Page,
  opts: { signal?: AbortSignal; blankGraceMs?: number; refreshBudget?: number } = {},
): Promise<number> {
  return (await readActiveCourseFromMenu(page, opts)).order
}

async function workSignature(page: Page): Promise<string> {
  return page.evaluate((selectors) => {
    const normalized = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim()
    const visible = (node: Element) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
    }
    const stableAttributes = (node: Element) => [...node.attributes]
      .filter((attribute) => attribute.name === 'id' || attribute.name.startsWith('data-'))
      .map((attribute) => [attribute.name, attribute.value])
      .sort(([left], [right]) => left.localeCompare(right))
    return JSON.stringify([...document.querySelectorAll(selectors.courseWorkItem)].filter(visible).map((node) => ({
      text: normalized(node.textContent),
      attributes: stableAttributes(node),
      buttons: [...node.querySelectorAll(selectors.courseWorkButtons)].map((button) => ({
        text: normalized(button.textContent),
        attributes: stableAttributes(button),
      })),
    })))
  }, NOQR_SEL)
}

export async function switchNoqrCourse(
  page: Page,
  course: NoqrCourse,
  opts: NoqrCourseWorkOptions = {},
): Promise<void> {
  throwIfNoqrStopped(opts.signal)
  if (normalizedPath(page.url()) !== NOQR_PATH.courseWork) {
    throw new NoqrSessionError('course_contract', '当前不在形考作业页，不能切换课程')
  }
  const beforeOrder = await readCourseOrderFromMenu(page, opts)
  if (beforeOrder === course.order) {
    await waitForNoqrCourseWorkReady(page, opts)
    const title = await readNoqrCourseTitle(page)
    const active = await readActiveCourseFromMenu(page, opts)
    const stableReady = !course.stableToken || active.stableToken === course.stableToken
    if (title === course.name && stableReady) return
  }
  let beforeTitle = await readNoqrCourseTitle(page)
  let beforeWork = await workSignature(page)
  let beforeCourseId = (() => { try { return new URL(page.url()).searchParams.get('courseId') || '' } catch { return '' } })()
  const clickTargetCourse = async () => {
    await openCourseMenu(page, opts.signal, opts.blankGraceMs, opts.refreshBudget)
    const target = page.locator(NOQR_SEL.courseMenuItem).nth(course.order - 1)
    if ((await target.count()) !== 1) throw new NoqrSessionError('course_contract', '目标课程菜单项不存在')
    throwIfNoqrStopped(opts.signal)
    await target.click()
  }
  const rebaseAndRetryAfterReload = async (): Promise<boolean> => {
    await waitForNoqrCourseWorkReady(page, {
      signal: opts.signal,
      refreshBudget: opts.refreshBudget,
      onWaiting: opts.onWaiting,
      blankGraceMs: opts.blankGraceMs,
      network,
    })
    const order = await readCourseOrderFromMenu(page, opts)
    if (order === course.order) return true
    beforeTitle = await readNoqrCourseTitle(page)
    beforeWork = await workSignature(page)
    beforeCourseId = (() => { try { return new URL(page.url()).searchParams.get('courseId') || '' } catch { return '' } })()
    await clickTargetCourse()
    return false
  }
  const startedAt = Date.now()
  const network = new NoqrNetworkActivity(page)
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    refreshBudget: opts.refreshBudget ?? 3,
  })
  let progressVersion = 0
  let lastProgress = ''
  let sameCardTargetSince = 0
  try {
    // The target-course click can synchronously start the slow work-card
    // request; keep the listener alive before that click.
    await clickTargetCourse()
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked') throw new NoqrSessionError('auth_blocked', '切换课程后进入人工认证')
      if (surface === 'error') throw new NoqrSessionError('page_error', '切换课程后页面显示明确错误')
      if (isNoqrAnswerPath(page.url())) {
        throw new NoqrSessionError('answer_interrupted', '课程切换恢复误入答题页，已保留页面且不刷新')
      }
      const title = await readNoqrCourseTitle(page)
      const loading = await page.locator('.skeleton-area.van-skeleton').count() > 0
      const currentWork = await workSignature(page)
      const currentCourseId = (() => { try { return new URL(page.url()).searchParams.get('courseId') || '' } catch { return '' } })()
      const identityChanged = Boolean(beforeCourseId && currentCourseId && beforeCourseId !== currentCourseId)
      const identityReady = !beforeCourseId || !currentCourseId || identityChanged
      const workChanged = currentWork !== beforeWork
      if (title === course.name && !loading && workChanged) {
        await waitForNoqrCourseWorkReady(page, { ...opts, network })
        return
      }
      const sameCardTarget = title === course.name &&
        !loading &&
        !identityChanged &&
        !workChanged &&
        await (async () => {
          const active = await readActiveCourseFromMenu(page, opts)
          const stableReady = !course.stableToken ||
            !active.stableToken ||
            active.stableToken === course.stableToken
          return active.order === course.order && stableReady
        })()
      if (sameCardTarget && !network.isBusinessActive()) {
        sameCardTargetSince ||= Date.now()
        const sameCardConfirmedFor = Date.now() - sameCardTargetSince
        if (sameCardConfirmedFor >= COURSE_SWITCH_SAME_CARD_CONFIRM_MS) {
          await waitForNoqrCourseWorkReady(page, { ...opts, network })
          return
        }
        opts.onWaiting?.(sameCardConfirmedFor)
        await sleepNoqr(page, 100, opts.signal)
        continue
      } else {
        sameCardTargetSince = 0
      }
      const progress = JSON.stringify({
        title,
        currentWork,
        currentCourseId,
        loading,
      })
      if (progress !== lastProgress) {
        lastProgress = progress
        progressVersion++
      }
      const decision = recovery.observe({
        now: Date.now(),
        activityVersion: network.businessActivityVersion * 1_000_003 + progressVersion,
        empty: true,
        active: network.isBusinessActive(),
        stopRequested: opts.signal?.aborted,
      })
      if (decision.action === 'refresh') {
        await reloadNoqrPage(page, { signal: opts.signal })
        lastProgress = ''
        progressVersion++
        if (await rebaseAndRetryAfterReload()) {
          await waitForNoqrCourseWorkReady(page, { ...opts, network })
          return
        }
        continue
      }
      if (decision.action === 'stop') {
        const order = await readCourseOrderFromMenu(page, opts)
        if (title === course.name && order === course.order && workChanged) {
          await waitForNoqrCourseWorkReady(page, { ...opts, network })
          return
        }
        throw new NoqrSessionError(
          'blank_page',
          loading ? '切换课程后骨架持续无响应，已安全停止当前学生' : '课程切换持续无响应，已安全停止当前学生',
        )
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(page, 150, opts.signal)
    }
  } finally {
    network.dispose()
  }
}

export const openCourseWork = openNoqrCourseWork
export const listNoqrCourses = readNoqrCourseMenu
