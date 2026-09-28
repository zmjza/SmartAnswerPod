import { onMounted, onUnmounted, ref } from 'vue'
import type { ExtractStats, LiveHomeworkGroup } from '../electron/core/live-view'

export const selectedStudentId = ref('')

export function selectStudentId(localId: string) {
  selectedStudentId.value = localId
}

export function resolveSelectedStudentId(currentId: string, students: { local_id: string }[]): string {
  return currentId || students[0]?.local_id || ''
}

export type LiveStudent = {
  local_id: string
  name: string
  studentNo: string
  major: string
  campus: string
  displayMode: 'headless' | 'visual'
  browserWindowVisible: boolean | null
  workMode: 'answer' | 'extract'
  courseScope: 'all' | 'selected'
  selectedCourseNames: string[]
  selectedCourseKeys?: string[]
  awaitingCourseSelection: boolean
  answerRoundLimit: number
  slot: 'queued' | 'launching' | 'occupied' | 'occupying_verify' | 'released'
  account: string
  action: string
  headline: string
  bankCount: number
  aiCount: number
  extractTotals: ExtractStats
  extractTotalCourses: number
  extractCompletedCourses: number
  extractTotalHomeworks: number
  extractCompletedHomeworks: number
  extractHistoryPages: number
  extractHistoryTotal: number
  extractHistoryCompleted: number
  extractCurrentHistory: string
  needsVerify: boolean
  verified: boolean
  configLocked: boolean
  queued: boolean
  logs: string[]
  courseLogs: { time: string; level: 'info' | 'running' | 'success' | 'warning' | 'error'; courseName: string; courseKey?: string; homeworkName: string; action: string; result: string; reason: string }[]
  courses: { name: string; key?: string; status: string; bankCount?: number; aiCount?: number; groups?: LiveHomeworkGroup[] }[]
  groups: LiveHomeworkGroup[]
  activeCourseName?: string
  activeCourseKey?: string
}

export type LiveSnap = {
  machine: { cpu: string; memory: string; app: string; browsers: number; pressure: string; recommendedAccount: number; recommendedCourse: number; browserAverage: string; recommendationSampled: boolean }
  settings: {
    account_parallel: number
    course_parallel: number
    browser_visible_default: boolean
    log_enabled: boolean
    hasSilicon: boolean
    hasUrl: boolean
    hasAnon: boolean
  }
  students: LiveStudent[]
  running: boolean
}

export function useKaida() {
  const snap = ref<LiveSnap | null>(null)
  let off: (() => void) | undefined
  onMounted(async () => {
    if (!window.kaida) return
    off = window.kaida.onSnapshot((s) => { snap.value = s as LiveSnap })
    snap.value = (await window.kaida.snapshot()) as LiveSnap
  })
  onUnmounted(() => off?.())
  return { snap }
}
