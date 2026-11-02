import type { WorkMode } from '../core/work-mode.ts'

export const NOQR_PHASES = [
  'idle',
  'queued',
  'launching_browser',
  'login_page',
  'logging_in',
  'home',
  'scanning_courses',
  'waiting_course_selection',
  'detecting',
  'opening_homework',
  'answer_boot',
  'answering',
  'waiting_save',
  'awaiting_advance',
  'submitting',
  'waiting_score',
  'retry_wait',
  'completed',
  'not_full',
  'login_failed',
  'needs_user',
  'unsupported',
  'stopped',
] as const

export type NoqrPhase = (typeof NOQR_PHASES)[number]

export const NOQR_PAGE_KINDS = [
  'login',
  'home',
  'course_work',
  'answer_boot',
  'answer',
  'record',
  'submit_success',
  'unknown',
] as const

export type NoqrPageKind = (typeof NOQR_PAGE_KINDS)[number]

export type NoqrViewSnapshot = {
  mode: Extract<WorkMode, 'noqr'>
  localId: string
  running: boolean
  phase: NoqrPhase
  courseName: string
  homeworkName: string
  questionNo: number | null
  questionTotal: number | null
  bankCount: number
  aiCount: number
  attempt: number
}

export type NoqrCourse = {
  key: string
  name: string
  order: number
  current: boolean
  stableToken?: string
}

export type NoqrHomework = {
  key: string
  name: string
  workId?: string
  courseId?: string
  workType: string
  section: 'onlineHomework'
  weightPercent: number
  startAt: string
  endAt: string
  reviewDeadline: string
  attemptsText: string
  recordCount: number
  startEnabled: boolean
  recordEnabled: boolean
}

export type NoqrOption = {
  index: number
  text: string
  role: 'radio' | 'checkbox'
  checked: boolean
}

export type NoqrQuestionKind =
  | 'single'
  | 'multiple'
  | 'judge'
  | 'grammar'
  | 'listening'
  | 'picker'
  | 'cloze'
  | 'reading_judge'
  | 'unknown'

export type NoqrSubQuestion = {
  ordinal: number
  stem: string
  options: NoqrOption[]
}

export type NoqrQuestionGroup = {
  kind: NoqrQuestionKind
  title: string
  position: number
  total: number
  sharedStem: string
  stem: string
  options: NoqrOption[]
  subQuestions: NoqrSubQuestion[]
  pickerValues: string[]
  lastQuestion: boolean
}

export type NoqrAnswerSource = 'bank' | 'ai'

export type NoqrQuestionAnswer = {
  source: NoqrAnswerSource
  selectedTexts: string[]
}

export type NoqrCompositeAnswer = {
  source: NoqrAnswerSource
  selectedByOrdinal: Array<{ ordinal: number; text: string }>
}

export type NoqrScoreRecord = {
  finishedTime: string
  score: number
  isMarked: boolean
  status: string
  useTime?: string | number
  paperId?: string
  remark?: string
}
