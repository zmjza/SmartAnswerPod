import type { LocalAccount } from '../store.ts'
import type { SlotState } from '../core/states.ts'
import {
  emptyExtractStats,
  type ExtractStats,
  type LiveCourse,
  type LiveHomeworkGroup,
} from '../core/live-view.ts'
import { maskAccount } from '../core/excel.ts'
import { sanitizeRuntimeLogText, type RuntimeLogLevel } from '../core/runtime-log.ts'
import type { NoqrPhase } from './types.ts'

export type NoqrSavedQuestionKind =
  | 'single'
  | 'multiple'
  | 'judge'
  | 'english_grammar'
  | 'english_listening'
  | 'picker'
  | 'english_cloze'
  | 'english_reading'

export type NoqrQuestionKindCounts = Partial<Record<NoqrSavedQuestionKind, number>>

const SAVED_QUESTION_KINDS = new Set<NoqrSavedQuestionKind>([
  'single',
  'multiple',
  'judge',
  'english_grammar',
  'english_listening',
  'picker',
  'english_cloze',
  'english_reading',
])

export function emptyNoqrQuestionKindCounts(): NoqrQuestionKindCounts {
  return {}
}

export function recordNoqrSavedQuestionKind(
  counts: NoqrQuestionKindCounts,
  kind: string,
): void {
  if (!SAVED_QUESTION_KINDS.has(kind as NoqrSavedQuestionKind)) return
  const key = kind as NoqrSavedQuestionKind
  counts[key] = (counts[key] || 0) + 1
}

export function recordNoqrSavedQuestionKindSlots(
  counts: NoqrQuestionKindCounts,
  kind: string,
  unitCount: number,
): void {
  if (!SAVED_QUESTION_KINDS.has(kind as NoqrSavedQuestionKind)) return
  const savedSlots = Number(unitCount)
  if (!Number.isFinite(savedSlots) || savedSlots <= 0) return
  const key = kind as NoqrSavedQuestionKind
  counts[key] = (counts[key] || 0) + Math.trunc(savedSlots)
}

export function sanitizeNoqrLogText(message: unknown): string {
  return sanitizeRuntimeLogText(String(message || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

export type NoqrCourseLog = {
  time: string
  level: RuntimeLogLevel
  courseName: string
  courseKey?: string
  homeworkName: string
  action: string
  result: string
  reason: string
}

export type NoqrStudentView = {
  local_id: string
  name: string
  studentNo: string
  major: string
  campus: string
  displayMode: 'headless' | 'visual'
  browserWindowVisible: boolean | null
  workMode: 'noqr'
  courseScope: 'all' | 'selected'
  selectedCourseNames: string[]
  selectedCourseKeys: string[]
  awaitingCourseSelection: boolean
  answerRoundLimit: number
  slot: SlotState
  account: string
  action: string
  headline: string
  phase: NoqrPhase
  bankCount: number
  aiCount: number
  saveClickAttempts: number
  saveRequestRetries: number
  questionKindCounts: NoqrQuestionKindCounts
  questionKindSlotCounts: NoqrQuestionKindCounts
  extractTotals: ExtractStats
  extractTotalCourses: number
  extractCompletedCourses: number
  extractTotalHomeworks: number
  extractCompletedHomeworks: number
  extractHistoryPages: number
  extractHistoryTotal: number
  extractHistoryCompleted: number
  extractCurrentHistory: string
  needsVerify: false
  verified: false
  configLocked: boolean
  queued: boolean
  logs: string[]
  courseLogs: NoqrCourseLog[]
  courses: (LiveCourse & { key: string; order: number; groups: LiveHomeworkGroup[] })[]
  groups: LiveHomeworkGroup[]
  activeCourseName: string
  activeCourseKey: string
}

export function createNoqrStudentView(account: LocalAccount): NoqrStudentView {
  return {
    local_id: account.local_id,
    name: account.name,
    studentNo: maskAccount(account.username),
    major: account.major || '',
    campus: account.campus || '',
    displayMode: account.display_mode,
    browserWindowVisible: null,
    workMode: 'noqr',
    courseScope: account.course_scope,
    selectedCourseNames: [],
    selectedCourseKeys: [],
    awaitingCourseSelection: false,
    answerRoundLimit: account.answer_round_limit,
    slot: 'queued',
    account: 'idle',
    action: '空闲',
    headline: '空闲',
    phase: 'idle',
    bankCount: 0,
    aiCount: 0,
    saveClickAttempts: 0,
    saveRequestRetries: 0,
    questionKindCounts: emptyNoqrQuestionKindCounts(),
    questionKindSlotCounts: emptyNoqrQuestionKindCounts(),
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
    configLocked: false,
    queued: false,
    logs: [],
    courseLogs: [],
    courses: [],
    groups: [],
    activeCourseName: '',
    activeCourseKey: '',
  }
}

export function resetNoqrStudentRunView(view: NoqrStudentView): void {
  view.selectedCourseNames = []
  view.selectedCourseKeys = []
  view.awaitingCourseSelection = false
  view.bankCount = 0
  view.aiCount = 0
  view.saveClickAttempts = 0
  view.saveRequestRetries = 0
  view.questionKindCounts = emptyNoqrQuestionKindCounts()
  view.questionKindSlotCounts = emptyNoqrQuestionKindCounts()
  view.extractTotals = emptyExtractStats()
  view.extractTotalCourses = 0
  view.extractCompletedCourses = 0
  view.extractTotalHomeworks = 0
  view.extractCompletedHomeworks = 0
  view.extractHistoryPages = 0
  view.extractHistoryTotal = 0
  view.extractHistoryCompleted = 0
  view.extractCurrentHistory = ''
  view.needsVerify = false
  view.verified = false
  view.logs = []
  view.courseLogs = []
  view.courses = []
  view.groups = []
  view.activeCourseName = ''
  view.activeCourseKey = ''
}

export function noqrRunOutcome(statuses: string[]): {
  phase: 'completed' | 'not_full'
  message: string
} {
  const hasFailure = statuses.some((status) => status === '检测失败' || status === '有失败待处理')
  if (hasFailure) return { phase: 'not_full', message: '本轮结束，存在已隔离失败项' }
  const hasIncomplete = statuses.some((status) => status !== '本轮可做作业已完成' && status !== '无作业')
  return hasIncomplete
    ? { phase: 'not_full', message: '本轮结束，存在未完成或暂不可完成作业' }
    : { phase: 'completed', message: '本轮无码答题完成' }
}
