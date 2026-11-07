import type { Page } from 'patchright'
import { upsertHomework } from '../core/live-view.ts'
import { NOQR_PATH } from './selectors.ts'
import {
  classifyNoqrPage,
  isNoqrAnswerPath,
  NoqrSessionError,
  type NoqrPageSurface,
} from './session.ts'
import type { NoqrCourse, NoqrHomework, NoqrPageKind, NoqrPhase } from './types.ts'
import { sanitizeNoqrLogText, type NoqrStudentView } from './view.ts'

export type NoqrRecoveryInput = {
  page: NoqrPageKind
  ready: boolean
  activeRequest: boolean
  loading: boolean
  error: boolean
  hasAnswerProgress: boolean
  refreshAttempts: number
  refreshBudget: number
  stopRequested?: boolean
}

export type NoqrRecoveryDecision = 'ready' | 'wait' | 'refresh' | 'reenter' | 'stop'

export type NoqrFailurePolicy = {
  status: 'answer_page_interrupted' | 'page_interrupted' | 'submitted_uncertain' | 'submit_failed'
  phase: Extract<NoqrPhase, 'needs_user' | 'unsupported'>
  preservePage: boolean
}

const REFRESHABLE_PAGES = new Set<NoqrPageKind>([
  'login',
  'home',
  'course_work',
  'record',
  'submit_success',
])

const ACCOUNT_TERMINAL_CODES = new Set([
  'login_failed',
  'auth_blocked',
  'credentials_missing',
  'answer_interrupted',
  'submitted_uncertain',
])

function noqrErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
}

export function terminalNoqrPhase(
  error: unknown,
): Extract<NoqrPhase, 'login_failed' | 'needs_user' | 'unsupported' | 'not_full'> {
  const code = noqrErrorCode(error)
  if (code === 'login_failed') return 'login_failed'
  if (['auth_blocked', 'credentials_missing', 'answer_interrupted', 'submitted_uncertain'].includes(code)) return 'needs_user'
  if (['blank_page', 'page_error'].includes(code)) return 'not_full'
  return 'unsupported'
}

export function isNoqrAccountTerminalError(error: unknown): boolean {
  if (ACCOUNT_TERMINAL_CODES.has(noqrErrorCode(error))) return true
  const message = error instanceof Error ? error.message : ''
  return /人工认证|登录失败|账号或密码错误|凭据/.test(message)
}

export function noqrFailurePolicy(error: unknown): NoqrFailurePolicy {
  const code = noqrErrorCode(error)
  if (code === 'answer_interrupted') {
    return { status: 'answer_page_interrupted', phase: 'needs_user', preservePage: true }
  }
  if (code === 'blank_page' || code === 'page_error') {
    // Contract/blank failures are isolated to the current course or homework.
    // Only an answer page with saved progress is promoted to answer_interrupted
    // and preserved for manual handling.
    return { status: 'page_interrupted', phase: 'needs_user', preservePage: false }
  }
  if (code === 'submitted_uncertain') {
    return { status: 'submitted_uncertain', phase: 'needs_user', preservePage: true }
  }
  return { status: 'submit_failed', phase: 'unsupported', preservePage: false }
}

export async function detectNoqrAnswerPageInterruption(
  page: Page,
  opts: { settleMs?: number } = {},
): Promise<NoqrSessionError | null> {
  if (!isNoqrAnswerPath(page.url())) return null
  const abnormal = (surface: NoqrPageSurface) =>
    ['answer_boot', 'blank', 'unknown', 'error'].includes(surface)
  const first = await classifyNoqrPage(page)
  if (!abnormal(first)) return null
  // A save/navigation transition can briefly expose an unclassified document.
  // Only preserve the page after the same abnormal surface survives a short
  // settle window, so ordinary answer/AI errors remain isolated homework
  // failures and can release the account slot.
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Math.trunc(Number(opts.settleMs ?? 500)))))
  if (!isNoqrAnswerPath(page.url())) return null
  const second = await classifyNoqrPage(page)
  if (!abnormal(second)) return null
  return new NoqrSessionError('answer_interrupted', '已作答答题页异常中断，保留当前页面并等待人工处理')
}

export function noqrAnswerProgressInterruption(input: {
  url: string
  hasAnswerProgress: boolean
  submitConfirmed: boolean
  pageInterrupted: boolean
}): NoqrSessionError | null {
  if (
    !input.pageInterrupted ||
    !input.hasAnswerProgress ||
    input.submitConfirmed ||
    !isNoqrAnswerPath(input.url)
  ) return null
  return new NoqrSessionError('answer_interrupted', '已作答答题页出现异常，保留当前页面并等待人工处理')
}

export function assertNoqrRecordPageCanReturn(url: string, surface: NoqrPageKind | string): void {
  if (isNoqrAnswerPath(url)) {
    throw new NoqrSessionError(
      'answer_interrupted',
      '作答记录流程误入答题页，已保留页面且禁止点击返回',
    )
  }
  if (surface === 'auth_blocked' || surface === 'login') {
    throw new NoqrSessionError('auth_blocked', '作答记录读取后进入登录或人工认证页面')
  }
}

export function shouldRestoreNoqrRecordPage(currentPath: string, stopRequested: boolean): boolean {
  if (stopRequested) return false
  return currentPath.replace(/\/+$/, '') !== NOQR_PATH.courseWork
}

export function shouldStopNoqrCourseAfterHomeworkFailure(url: string): boolean {
  // A normal homework error must not send an answer page with saved progress
  // into the non-answer recovery path. Stop this course lane; other course
  // lanes and queued accounts continue independently.
  return isNoqrAnswerPath(url)
}

export function applyNoqrFailureToView(
  view: NoqrStudentView,
  course: NoqrCourse,
  homework: NoqrHomework,
  error: unknown,
): NoqrFailurePolicy {
  const failure = noqrFailurePolicy(error)
  if (!failure.preservePage) return failure
  let courseRow = view.courses.find((item) => item.key === course.key)
  if (!courseRow) {
    courseRow = { key: course.key, name: course.name, order: course.order, status: '有失败待处理', groups: [] }
    view.courses.push(courseRow)
  }
  courseRow.status = '有失败待处理'
  courseRow.groups = upsertHomework(courseRow.groups, 'onlineHomework', homework.name, failure.status)
  view.groups = courseRow.groups
  view.activeCourseName = course.name
  view.activeCourseKey = course.key
  view.phase = failure.phase
  view.headline = failure.phase === 'needs_user' ? '需人工处理' : '当前作业不支持'
  view.action = sanitizeNoqrLogText(error instanceof Error ? error.message : '无码作业需要人工处理')
  view.account = failure.phase === 'needs_user' ? 'needs_verify' : view.account
  return failure
}

/**
 * Decide recovery using observed page/network state, never elapsed time.
 * Answer pages are never refreshed; an initial blank answer page is returned
 * to the homework list and opened again.
 */
export function decideNoqrRecovery(input: NoqrRecoveryInput): NoqrRecoveryDecision {
  if (input.stopRequested) return 'stop'
  if (input.ready) return 'ready'
  if (input.activeRequest || input.loading) return 'wait'
  if (input.error) return 'stop'

  if (input.page === 'answer_boot') return input.hasAnswerProgress ? 'stop' : 'reenter'
  if (input.page === 'answer') return 'stop'
  if (!REFRESHABLE_PAGES.has(input.page)) return 'stop'

  const attempts = Math.max(0, Math.floor(Number(input.refreshAttempts) || 0))
  const budget = Math.max(0, Math.floor(Number(input.refreshBudget) || 0))
  return attempts < budget ? 'refresh' : 'stop'
}
