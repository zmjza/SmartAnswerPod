export type LiveSource = '题库' | 'AI' | '空过'

export type LiveQuestion = {
  no: number
  stem: string
  source: LiveSource
}

export type ExtractStats = {
  added: number
  merged: number
  skipped: number
  conflict: number
  failed: number
}

export const emptyExtractStats = (): ExtractStats => ({ added: 0, merged: 0, skipped: 0, conflict: 0, failed: 0 })

export function extractCompletionLabel(stats: ExtractStats, failedCourses: number, pendingItems: number): string {
  return stats.failed > 0 || failedCourses > 0 || pendingItems > 0
    ? '题库提取结束 · 有待处理项'
    : '题库提取完成'
}

export function addExtractStats(total: ExtractStats, part: ExtractStats): ExtractStats {
  total.added += part.added
  total.merged += part.merged
  total.skipped += part.skipped
  total.conflict += part.conflict
  total.failed += part.failed
  return total
}

export type LiveHomework = {
  name: string
  status: string
  previewHref?: string
  questions: LiveQuestion[]
  questionTotal?: number
  attempt?: number
  score?: number | null
  lastAttempt?: number
  lastScore?: number | null
  extractStats?: ExtractStats
}

export function homeworkScoreLabel(row: Pick<LiveHomework, 'attempt' | 'score' | 'lastAttempt' | 'lastScore' | 'status'>): string {
  if (!row.attempt || row.status === 'skip_bank_miss') return '本次得分：尚未作答'
  const prefix = '第 ' + row.attempt + ' 次 · 本次得分：'
  if (row.score != null && Number.isFinite(row.score)) return prefix + row.score + ' 分'
  const current = ['waiting_grade', 'pending_writeback', 'reviewing'].includes(row.status) ? '等待批阅' : '尚未出分'
  const previous = row.lastScore != null && Number.isFinite(row.lastScore) && row.lastAttempt && row.lastAttempt < row.attempt
    ? ` · 上次 ${row.lastScore} 分`
    : ''
  return prefix + current + previous
}

export type LiveHomeworkGroup = {
  title: string
  rows: LiveHomework[]
}

export type LiveCourse = {
  key?: string
  name: string
  status: string
  bankCount?: number
  aiCount?: number
}

export function courseOutcome(statuses: string[]): string {
  if (!statuses.length) return '无作业'
  if (statuses.includes('pending_writeback')) return '待回写'
  if (statuses.includes('submit_failed') || statuses.includes('skip_bank_miss')) return '有失败待处理'
  if (statuses.some((s) => s === 'skip_attempts_exhausted' || s === 'skip_out_of_window')) return '暂不可完成'
  if (statuses.some((s) => !s.startsWith('skip_') && s !== 'done_100')) return '尚未完成'
  return '本轮可做作业已完成'
}

export function recordQuestion(row: LiveHomework, question: LiveQuestion, total: number) {
  row.questionTotal = total
  const index = row.questions.findIndex((q) => q.no === question.no)
  if (index < 0) row.questions.push(question)
  else row.questions[index] = question
}

export function homeworkGroupTitle(section: 'onlineHomework' | 'phasedTest') {
  return section === 'onlineHomework' ? '网上记分作业' : '阶段性测验'
}

export function upsertCourse(courses: LiveCourse[], name: string, status: string): LiveCourse[] {
  const next = courses.map((course) => ({ ...course }))
  const index = next.findIndex((course) => course.name === name)
  if (index >= 0) next[index] = { ...next[index], status }
  else next.push({ name, status })
  return next
}

export function upsertHomework(
  groups: LiveHomeworkGroup[],
  section: 'onlineHomework' | 'phasedTest',
  name: string,
  status: string,
  questions?: LiveQuestion[],
): LiveHomeworkGroup[] {
  const title = homeworkGroupTitle(section)
  const next = groups.map((group) => ({
    title: group.title,
    rows: group.rows.map((row) => ({ ...row, questions: [...row.questions] })),
  }))
  let group = next.find((item) => item.title === title)
  if (!group) {
    group = { title, rows: [] }
    next.push(group)
  }
  const index = group.rows.findIndex((row) => row.name === name)
  const current = index >= 0 ? group.rows[index] : { name, status, questions: [] }
  const row = { ...current, status, questions: questions ? [...questions] : current.questions }
  if (index >= 0) group.rows[index] = row
  else group.rows.push(row)
  return next
}
