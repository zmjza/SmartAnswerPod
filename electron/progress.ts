import type { AccountState, HomeworkState, SlotState } from './core/states'

export type ProgressEvent = {
  time: string
  local_id: string
  slot: SlotState
  account: AccountState
  action: string
  courseIndex?: number
  courseTotal?: number
  courseName?: string
  courseKey?: string
  homeworkName?: string
  homework?: HomeworkState
  questionNo?: number
  questionTotal?: number
  source?: '题库答题' | 'AI 答题' | '空过'
  aiModel?: string
  bankCount: number
  aiCount: number
  click?: string
}

type Listener = (e: ProgressEvent) => void
const listeners = new Set<Listener>()

export function onProgress(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitProgress(e: Omit<ProgressEvent, 'time'> & { time?: string }) {
  const ev: ProgressEvent = { ...e, time: e.time || new Date().toISOString() }
  const dump = JSON.stringify(ev)
  if (/xhtoken|sb_secret|password|siliconflow/i.test(dump) && /sk-|sb_secret|xhtoken=/i.test(dump)) {
    return
  }
  for (const fn of listeners) fn(ev)
}
