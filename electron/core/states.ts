export const SLOT = ['queued', 'launching', 'occupied', 'occupying_verify', 'released'] as const
export type SlotState = (typeof SLOT)[number]

export const ACCOUNT = [
  'idle',
  'queued',
  'launching_browser',
  'logging_in',
  'needs_verify',
  'login_failed',
  'logged_in',
  'scanning_courses',
  'courses_listed',
  'detecting',
  'detected',
  'waiting_course_selection',
  'auto_answering',
  'extracting',
  'flushing_writeback',
  'round_ended',
  'stopped',
] as const
export type AccountState = (typeof ACCOUNT)[number]

export const HOMEWORK = [
  'skip_weight0',
  'skip_non_objective',
  'skip_out_of_window',
  'skip_attempts_exhausted',
  'skip_full_score',
  'skip_no_history',
  'skip_bank_miss',
  'todo',
  'previewing',
  'gate_queued',
  'clicking_do_homework',
  'occupying_qr',
  'answering',
  'submitting',
  'submit_failed',
  'waiting_grade',
  'reviewing',
  'extracting',
  'extracting_done',
  'pending_writeback',
  'done_100',
  'not_full_next_time',
  'spin_stopped',
] as const
export type HomeworkState = (typeof HOMEWORK)[number]

export const QUESTION = [
  'reading',
  'bank_hit',
  'ai_answering',
  'unknown_skip',
  'ai_failed_skip',
  'selected',
] as const
export type QuestionState = (typeof QUESTION)[number]

export const QUESTION_SOURCE_UI = ['题库答题', 'AI 答题', '空过'] as const

export const ACCOUNT_ZH: Record<AccountState, string> = {
  idle: '空闲',
  queued: '排队中',
  launching_browser: '启动浏览器',
  logging_in: '登录中',
  needs_verify: '需验证',
  login_failed: '登录失败',
  logged_in: '已登录',
  scanning_courses: '扫课中',
  courses_listed: '已列出课程',
  detecting: '检测中',
  detected: '已检测',
  waiting_course_selection: '等待选择课程',
  auto_answering: '自动开答',
  extracting: '提取题库',
  flushing_writeback: '待回写补抽',
  round_ended: '本轮结束',
  stopped: '已停止',
}

export function isKnownSlot(v: string): v is SlotState {
  return (SLOT as readonly string[]).includes(v)
}
export function isKnownAccount(v: string): v is AccountState {
  return (ACCOUNT as readonly string[]).includes(v)
}
export function isKnownHomework(v: string): v is HomeworkState {
  return (HOMEWORK as readonly string[]).includes(v)
}
export function isKnownQuestion(v: string): v is QuestionState {
  return (QUESTION as readonly string[]).includes(v)
}

export function slotCountsInToolbar(s: SlotState): boolean {
  return s === 'launching' || s === 'occupied' || s === 'occupying_verify'
}
