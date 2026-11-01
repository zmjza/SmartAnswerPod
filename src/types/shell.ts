export type PageId = 'home' | 'settings' | 'bank' | 'accounts'

export type DisplayMode = 'headless' | 'visual'

export type WorkMode = 'answer' | 'extract' | 'noqr'
export type CourseScope = 'all' | 'selected'

export interface ExtractStats {
  added: number
  merged: number
  skipped: number
  conflict: number
  failed: number
}

export type Pressure = '正常' | '偏高' | '过高'

export interface MachineStatus {
  cpu: string
  memory: string
  app: string
  browsers: number
  pressure: Pressure
}

export interface CourseRow {
  name: string
  status: string
  bankCount?: number
  aiCount?: number
}

export interface HomeworkRow {
  name: string
  status: string
  questions: { no: number; stem: string; source: '题库' | 'AI' | '空过' }[]
  extractStats?: ExtractStats
}

export interface HomeworkGroup {
  title: string
  rows: HomeworkRow[]
}

export interface StudentCard {
  name: string
  studentNo: string
  major: string
  campus: string
  mode: WorkMode
  accountParallel: number
  courseParallel: number
  displayMode: DisplayMode
  headline: string
  bankCount: number
  aiCount: number
  extractTotals: ExtractStats
  needsVerify: boolean
  queued: boolean
  logs: string[]
}
