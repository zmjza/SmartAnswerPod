import type { Page } from 'patchright'
import { NOQR_ANSWER_BOOT_HARD_WAIT_MS } from './limits.ts'
import { NOQR_SEL } from './selectors.ts'
import {
  classifyNoqrPage,
  NoqrNetworkActivity,
  NoqrSessionError,
  sleepNoqr,
} from './session.ts'
import { hasVisibleNoqrAnswerCardButton } from './submit.ts'

export async function waitForNoqrAnswerSurfaceBeforeSubmit(
  page: Page,
  opts: {
    signal: AbortSignal
    onWaiting?: (elapsedMs: number) => void
    hardDeadlineMs?: number
    stabilityWindowMs?: number
  },
): Promise<void> {
  const startedAt = Date.now()
  const hardDeadlineMs = Math.max(
    50,
    Number(opts.hardDeadlineMs) || NOQR_ANSWER_BOOT_HARD_WAIT_MS,
  )
  const stabilityWindowMs = Math.max(
    50,
    Number(opts.stabilityWindowMs) || 750,
  )
  const network = new NoqrNetworkActivity(page)
  let quietSince = 0
  let stableSince = 0
  let lastLogAt = 0
  try {
    for (;;) {
      if (opts.signal.aborted) throw new NoqrSessionError('stopped', '任务已停止')
      const surface = await classifyNoqrPage(page)
      const answerCardButtonVisible = await hasVisibleNoqrAnswerCardButton(page)
      if (surface === 'auth_blocked' || surface === 'login' || surface === 'login_failed') {
        throw new NoqrSessionError('auth_blocked', '答题页恢复时进入登录或人工认证页面')
      }
      if (surface === 'error') {
        throw new NoqrSessionError('page_error', '答题页恢复时显示明确错误')
      }
      if (surface === 'course_work' || surface === 'home' || surface === 'record' || surface === 'submit_success') {
        throw new NoqrSessionError('answer_interrupted', '答题页在交卷前意外离开，已保留当前页面')
      }
      if (Date.now() - startedAt >= hardDeadlineMs) {
        throw new NoqrSessionError(
          'answer_interrupted',
          '答题页等待就绪超过安全上限，已保留当前页面并停止当前作业',
        )
      }
      const loading = await page.locator(NOQR_SEL.loadingToast).first()
        .isVisible()
        .catch(() => false)
      const stableAnswerSurface =
        surface === 'answer' &&
        answerCardButtonVisible &&
        !loading &&
        !network.isBusinessActive()
      if (stableAnswerSurface) {
        stableSince ||= Date.now()
        if (Date.now() - stableSince >= stabilityWindowMs) return
      } else {
        stableSince = 0
      }
      if (network.isBusinessActive() || loading) {
        quietSince = 0
      } else {
        quietSince ||= Date.now()
        if (Date.now() - quietSince >= 180_000) {
          throw new NoqrSessionError('answer_interrupted', '答题页长时间无响应，已保留当前页面并等待人工处理')
        }
      }
      if (Date.now() - lastLogAt >= 5_000) {
        lastLogAt = Date.now()
        opts.onWaiting?.(Date.now() - startedAt)
      }
      await sleepNoqr(page, 150, opts.signal)
    }
  } finally {
    network.dispose()
  }
}
