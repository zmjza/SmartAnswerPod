import type { Page } from 'patchright'
import { upsertHomework } from '../core/live-view.ts'
import { classifyNoqrPage, isNoqrAnswerPath, NoqrSessionError } from './session.ts'
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
  status: 'answer_page_interrupted' | 'submitted_uncertain' | 'submit_failed'
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

export function terminalNoqrPhase(error: unknown): Extract<NoqrPhase, 'login_failed' | 'needs_user' | 'unsupported'> {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  if (code === 'login_failed') return 'login_failed'
  if (['auth_blocked', 'credentials_missing', 'blank_page', 'page_error', 'answer_interrupted', 'submitted_uncertain'].includes(code)) return 'needs_user'
  return 'unsupported'
}

export function noqrFailurePolicy(error: unknown): NoqrFailurePolicy {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  if (code === 'answer_interrupted') {
    return { status: 'answer_page_interrupted', phase: 'needs_user', preservePage: true }
  }
  if (code === 'submitted_uncertain') {
    return { status: 'submitted_uncertain', phase: 'needs_user', preservePage: true }
  }
  return { status: 'submit_failed', phase: 'unsupported', preservePage: false }
}

export async function detectNoqrAnswerPageInterruption(page: Page): Promise<NoqrSessionError | null> {
  if (!isNoqrAnswerPath(page.url())) return null
  const surface = await classifyNoqrPage(page)
  if (!['answer_boot', 'blank', 'unknown', 'error'].includes(surface)) return null
  return new NoqrSessionError('answer_interrupted', '已作答答题页异常中断，保留当前页面并等待人工处理')
}

export function noqrAnswerProgressInterruption(input: {
  url: string
  hasAnswerProgress: boolean
  submitConfirmed: boolean
}): NoqrSessionError | null {
  if (!input.hasAnswerProgress || input.submitConfirmed || !isNoqrAnswerPath(input.url)) return null
  return new NoqrSessionError('answer_interrupted', '已作答答题页出现异常，保留当前页面并等待人工处理')
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
