import type { Page } from 'patchright'
import { NoqrBlankRecoveryGate } from './blank-recovery.ts'
import {
  openNoqrCourseWork,
  readNoqrCourseMenu,
  switchNoqrCourse,
  waitForNoqrCourseWorkReady,
} from './course.ts'
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
import type { NoqrCourse } from './types.ts'

export type NoqrInPlaceRecoveryOptions = {
  signal?: AbortSignal
  course?: NoqrCourse
  refreshBudget?: number
  blankGraceMs?: number
  blankMaxActiveWaitMs?: number
  blankMaxHeartbeatWaitMs?: number
  onWaiting?: (elapsedMs: number) => void
  network?: NoqrNetworkActivity
}

function normalizedPath(urlText: string): string {
  try {
    return new URL(urlText).pathname.replace(/\/+$/, '') || '/'
  } catch {
    return ''
  }
}

async function hasAnswerProgress(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (document.querySelector('.sub-question.has-answered')) return true
    if (document.querySelector('.option-item[aria-checked="true"], .option-item.checked, .e-a.checked')) {
      return true
    }
    return [...document.querySelectorAll('input[name="answer"]')]
      .some((node) => {
        // Visible text/search/file controls are not objective answer progress.
        // Only hidden form state can preserve an already-started objective page.
        if (!(node instanceof HTMLInputElement) || node.type !== 'hidden') return false
        return node.value.trim().length > 0
      })
  }).catch(() => true)
}

/**
 * Recover a page that is already part of an authenticated browser context.
 * This path never opens the login page and never submits credentials again.
 */
export async function recoverNoqrCourseWorkWithoutLogin(
  page: Page,
  opts: NoqrInPlaceRecoveryOptions = {},
): Promise<void> {
  const startedAt = Date.now()
  const refreshBudget = Math.max(0, Math.trunc(opts.refreshBudget ?? 3))
  const ownNetwork = opts.network ? null : new NoqrNetworkActivity(page)
  const network = opts.network || ownNetwork!
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    refreshBudget,
  })
  let refreshes = 0

  try {
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked' || surface === 'login' || surface === 'login_failed') {
        throw new NoqrSessionError('auth_blocked', '页面已回到登录或人工认证状态，禁止自动重新登录')
      }

      if (isNoqrAnswerPath(page.url())) {
        if (await hasAnswerProgress(page)) {
          throw new NoqrSessionError(
            'answer_interrupted',
            '答题页已有作答进度，禁止刷新、返回重进或重建会话',
          )
        }
        const back = page.locator(NOQR_SEL.navBack).first()
        if (!(await back.count().catch(() => 0))) {
          throw new NoqrSessionError('page_error', '空白答题页缺少返回按钮，无法原位恢复')
        }
        await back.click()
        await waitForNoqrCourseWorkReady(page, {
          signal: opts.signal,
          refreshBudget,
          blankGraceMs: opts.blankGraceMs,
          blankMaxActiveWaitMs: opts.blankMaxActiveWaitMs,
          blankMaxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
          onWaiting: opts.onWaiting,
          network,
        })
        break
      }
      if (surface === 'error') {
        throw new NoqrSessionError('page_error', '页面显示明确错误')
      }

      const path = normalizedPath(page.url())
      if (path === NOQR_PATH.courseWork) {
        await waitForNoqrCourseWorkReady(page, {
          signal: opts.signal,
          refreshBudget,
          blankGraceMs: opts.blankGraceMs,
          blankMaxActiveWaitMs: opts.blankMaxActiveWaitMs,
          blankMaxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
          onWaiting: opts.onWaiting,
          network,
        })
        break
      }

      if (path === NOQR_PATH.home || surface === 'home' || surface === 'home_blank') {
        await ensureNoqrHomeReady(page, {
          signal: opts.signal,
          refreshBudget,
          blankGraceMs: opts.blankGraceMs,
          blankMaxActiveWaitMs: opts.blankMaxActiveWaitMs,
          blankMaxHeartbeatWaitMs: opts.blankMaxHeartbeatWaitMs,
          onWaiting: opts.onWaiting,
          network,
        })
        await openNoqrCourseWork(page, {
          signal: opts.signal,
          refreshBudget,
          blankGraceMs: opts.blankGraceMs,
          onWaiting: opts.onWaiting,
          network,
        })
        break
      }

      const decision = recovery.observe({
        now: Date.now(),
        activityVersion: network.businessActivityVersion,
        empty: true,
        active: network.isBusinessActive(),
        stopRequested: opts.signal?.aborted,
      })
      if (decision.action === 'refresh') {
        if (refreshes >= refreshBudget) {
          throw new NoqrSessionError('blank_page', '非答题页刷新后仍未恢复到作业区')
        }
        refreshes++
        await reloadNoqrPage(page, { signal: opts.signal })
        continue
      }
      if (decision.action === 'stop') {
        throw new NoqrSessionError('blank_page', '非答题页持续无响应，已安全停止当前课程')
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(page, 150, opts.signal)
    }
  } finally {
    ownNetwork?.dispose()
  }

  if (!opts.course) return
  const courses = await readNoqrCourseMenu(page, {
    signal: opts.signal,
    refreshBudget,
    blankGraceMs: opts.blankGraceMs,
  })
  const target = courses.find((item) => item.key === opts.course!.key)
  if (!target) {
    throw new NoqrSessionError('course_contract', '课程菜单中找不到本轮目标课程')
  }
  await switchNoqrCourse(page, target, {
    signal: opts.signal,
    refreshBudget,
    blankGraceMs: opts.blankGraceMs,
    onWaiting: opts.onWaiting,
  })
}
