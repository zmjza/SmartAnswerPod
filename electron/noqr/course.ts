import { createHash } from 'node:crypto'
import type { Page } from 'patchright'
import type { NoqrCourse } from './types.ts'
import { NOQR_PATH, NOQR_SEL } from './selectors.ts'
import {
  classifyNoqrPage,
  ensureNoqrHomeReady,
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
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

const COURSE_MENU_UTILITY_NAMES = new Set(['中文', 'english', '切换课程'])

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

export async function waitForNoqrCourseWorkReady(page: Page, opts: NoqrCourseWorkOptions = {}): Promise<void> {
  const startedAt = Date.now()
  let refreshAttempts = 0
  const network = new NoqrNetworkActivity(page)
  try {
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked') throw new NoqrSessionError('auth_blocked', '形考作业页进入企业微信或人工认证')
      if (surface === 'error') throw new NoqrSessionError('page_error', '形考作业页显示明确错误')
      if (normalizedPath(page.url()) !== NOQR_PATH.courseWork) {
        throw new NoqrSessionError('page_error', '形考作业入口没有进入课程作业页')
      }
      const state = await page.evaluate((selectors) => {
        const items = document.querySelectorAll(selectors.courseWorkItem).length
        const skeleton = Boolean(document.querySelector('.skeleton-area.van-skeleton'))
        const empty = Boolean(document.querySelector('.van-empty')) ||
          /暂无作业|没有作业|暂无数据/.test(document.body?.innerText || '')
        const title = (document.querySelector(selectors.navTitle)?.textContent || '').trim()
        return { items, skeleton, empty, title }
      }, NOQR_SEL)
      if (state.items > 0 || state.empty) return
      if (network.isActive()) {
        opts.onWaiting?.(Date.now() - startedAt)
        await sleepNoqr(page, 150, opts.signal)
        continue
      }
      if (refreshAttempts < (opts.refreshBudget ?? 3)) {
        refreshAttempts++
        await reloadNoqrPage(page, { signal: opts.signal })
        continue
      }
      throw new NoqrSessionError('blank_page', '形考作业页连续刷新后仍无作业卡或明确空态')
    }
  } finally {
    network.dispose()
  }
}

export async function openNoqrCourseWork(page: Page, opts: NoqrCourseWorkOptions = {}): Promise<void> {
  const initial = await classifyNoqrPage(page)
  if (initial === 'course_work') return waitForNoqrCourseWorkReady(page, opts)
  await ensureNoqrHomeReady(page, opts)
  const entry = page.locator(NOQR_SEL.homeMenuItems)
    .getByText('形考作业', { exact: true })
    .first()
  if (!(await entry.count())) throw new NoqrSessionError('page_error', '首页缺少“形考作业”入口')
  throwIfNoqrStopped(opts.signal)
  await entry.click()
  const startedAt = Date.now()
  for (;;) {
    throwIfNoqrStopped(opts.signal)
    if (normalizedPath(page.url()) === NOQR_PATH.courseWork) return waitForNoqrCourseWorkReady(page, opts)
    const surface = await classifyNoqrPage(page)
    if (surface === 'auth_blocked') throw new NoqrSessionError('auth_blocked', '形考作业入口进入企业微信或人工认证')
    if (surface === 'error') throw new NoqrSessionError('page_error', '形考作业入口显示明确错误')
    opts.onWaiting?.(Date.now() - startedAt)
    await sleepNoqr(page, 150, opts.signal)
  }
}

async function menuVisible(page: Page): Promise<boolean> {
  const items = page.locator(NOQR_SEL.courseMenuItem)
  if (!(await items.count())) return false
  return items.first().isVisible().catch(() => false)
}

async function openCourseMenu(page: Page, signal?: AbortSignal): Promise<void> {
  if (await menuVisible(page)) return
  const trigger = page.locator(NOQR_SEL.courseMenuTrigger).first()
  if (!(await trigger.count())) throw new NoqrSessionError('page_error', '课程作业页缺少右上角课程菜单')
  throwIfNoqrStopped(signal)
  await trigger.click()
  for (;;) {
    throwIfNoqrStopped(signal)
    if (await menuVisible(page)) return
    await sleepNoqr(page, 100, signal)
  }
}

export async function readNoqrCourseMenu(
  page: Page,
  opts: { signal?: AbortSignal } = {},
): Promise<NoqrCourse[]> {
  throwIfNoqrStopped(opts.signal)
  await openCourseMenu(page, opts.signal)
  const rows = await page.locator(NOQR_SEL.courseMenuItem).evaluateAll((nodes) =>
    nodes.map((node, index) => ({
      order: index + 1,
      name: (node.textContent || '').replace(/\s+/g, ' ').trim(),
      current: node.classList.contains('top-pop-active'),
      stableToken: [
        node.getAttribute('data-course-id'),
        node.getAttribute('data-id'),
        node.getAttribute('data-key'),
      ].filter(Boolean).join('|'),
    })),
  )
  const courses: NoqrCourse[] = []
  const namesByOrder = new Set<string>()
  for (const row of rows) {
    // The shared top menu also contains language and switch-course actions.
    // Keep their original DOM order for clicks, but never expose them as courses.
    if (!isNoqrCourseMenuItem(row.name)) continue
    if (!row.name || namesByOrder.has(String(row.order))) {
      throw new NoqrSessionError('page_error', '课程菜单存在空名称或重复顺序，禁止猜课程身份')
    }
    namesByOrder.add(String(row.order))
    courses.push({
      key: noqrCourseKey(row.name, row.order, row.stableToken),
      name: row.name,
      order: row.order,
      current: row.current,
    })
  }
  if (!courses.length) throw new NoqrSessionError('page_error', '课程菜单没有可读取课程')
  return courses
}

export async function readNoqrCourseTitle(page: Page): Promise<string> {
  return normalizedText(await page.locator(NOQR_SEL.navTitle).first().innerText().catch(() => ''))
}

async function activeCourseOrder(page: Page): Promise<number> {
  return page.locator(NOQR_SEL.courseMenuItem).evaluateAll((nodes) => {
    const index = nodes.findIndex((node) => node.classList.contains('top-pop-active'))
    return index >= 0 ? index + 1 : 0
  })
}

async function readCourseOrderFromMenu(page: Page, signal?: AbortSignal): Promise<number> {
  const wasOpen = await menuVisible(page)
  if (!wasOpen) await openCourseMenu(page, signal)
  const order = await activeCourseOrder(page)
  if (!wasOpen) {
    throwIfNoqrStopped(signal)
    await page.locator(NOQR_SEL.courseMenuTrigger).first().click().catch(() => {})
  }
  return order
}

async function workSignature(page: Page): Promise<string> {
  return page.evaluate((selectors) =>
    [...document.querySelectorAll(selectors.courseWorkItem)]
      .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
      .join('\n'),
  NOQR_SEL)
}

export async function switchNoqrCourse(
  page: Page,
  course: NoqrCourse,
  opts: NoqrCourseWorkOptions = {},
): Promise<void> {
  throwIfNoqrStopped(opts.signal)
  if (normalizedPath(page.url()) !== NOQR_PATH.courseWork) {
    throw new NoqrSessionError('page_error', '当前不在形考作业页，不能切换课程')
  }
  const beforeOrder = await readCourseOrderFromMenu(page, opts.signal)
  if (beforeOrder === course.order) {
    await waitForNoqrCourseWorkReady(page, opts)
    return
  }
  let beforeTitle = await readNoqrCourseTitle(page)
  let beforeWork = await workSignature(page)
  let beforeCourseId = (() => { try { return new URL(page.url()).searchParams.get('courseId') || '' } catch { return '' } })()
  const clickTargetCourse = async () => {
    await openCourseMenu(page, opts.signal)
    const target = page.locator(NOQR_SEL.courseMenuItem).nth(course.order - 1)
    if ((await target.count()) !== 1) throw new NoqrSessionError('page_error', '目标课程菜单项不存在')
    throwIfNoqrStopped(opts.signal)
    await target.click()
  }
  const rebaseAndRetryAfterReload = async (): Promise<boolean> => {
    await waitForNoqrCourseWorkReady(page, {
      signal: opts.signal,
      refreshBudget: opts.refreshBudget,
      onWaiting: opts.onWaiting,
    })
    const order = await readCourseOrderFromMenu(page, opts.signal)
    if (order === course.order) return true
    beforeTitle = await readNoqrCourseTitle(page)
    beforeWork = await workSignature(page)
    beforeCourseId = (() => { try { return new URL(page.url()).searchParams.get('courseId') || '' } catch { return '' } })()
    await clickTargetCourse()
    return false
  }
  await clickTargetCourse()

  const startedAt = Date.now()
  let sawLoading = false
  let refreshAttempts = 0
  let unchangedObservations = 0
  const network = new NoqrNetworkActivity(page)
  try {
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked') throw new NoqrSessionError('auth_blocked', '切换课程后进入人工认证')
      if (surface === 'error') throw new NoqrSessionError('page_error', '切换课程后页面显示明确错误')
      const title = await readNoqrCourseTitle(page)
      const loading = await page.locator('.skeleton-area.van-skeleton').count() > 0
      if (loading) sawLoading = true
      const currentWork = await workSignature(page)
      const currentCourseId = (() => { try { return new URL(page.url()).searchParams.get('courseId') || '' } catch { return '' } })()
      const identityChanged = Boolean(beforeCourseId && currentCourseId && beforeCourseId !== currentCourseId)
      const contentChanged = currentWork !== beforeWork || sawLoading || title !== beforeTitle
      if (title === course.name && !loading && (identityChanged || contentChanged)) {
        return await waitForNoqrCourseWorkReady(page, opts)
      }
      if (loading && !network.isActive()) {
        if (refreshAttempts >= (opts.refreshBudget ?? 3)) {
          throw new NoqrSessionError('blank_page', '切换课程后连续刷新仍停留在骨架页')
        }
        refreshAttempts++
        await reloadNoqrPage(page, { signal: opts.signal })
        if (await rebaseAndRetryAfterReload()) return await waitForNoqrCourseWorkReady(page, opts)
        continue
      }
      if (title === beforeTitle && currentWork === beforeWork && !identityChanged) {
        unchangedObservations++
        if (unchangedObservations >= 20) {
          const order = await readCourseOrderFromMenu(page, opts.signal)
          if (title === course.name && order === course.order) return await waitForNoqrCourseWorkReady(page, opts)
          if (refreshAttempts >= (opts.refreshBudget ?? 3)) {
            throw new NoqrSessionError('page_error', '课程切换连续刷新后身份仍未变化')
          }
          refreshAttempts++
          unchangedObservations = 0
          await reloadNoqrPage(page, { signal: opts.signal })
          if (await rebaseAndRetryAfterReload()) return await waitForNoqrCourseWorkReady(page, opts)
          continue
        }
      } else {
        unchangedObservations = 0
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
