import {
  applyStudentSettingsToAll as applyLegacyStudentSettingsToAll,
  deleteStudentRuntime as deleteLegacyStudentRuntime,
  getHistoryPaperImage as getLegacyHistoryPaperImage,
  getHomeworkHistory as getLegacyHomeworkHistory,
  getQrSnapshot as getLegacyQrSnapshot,
  isRunning as isLegacyRunning,
  isStudentLocked as isLegacyStudentLocked,
  loginAndRefresh as loginAndRefreshLegacy,
  openVisual as openLegacyVisual,
  refreshQrSnapshot as refreshLegacyQrSnapshot,
  setAnswerRoundLimit as setLegacyAnswerRoundLimit,
  setCourseScope as setLegacyCourseScope,
  setSelectedCourses as setLegacySelectedCourses,
  setWorkMode as setLegacyWorkMode,
  signalVerified as signalLegacyVerified,
  snapshot as legacySnapshot,
  startSelectedCourseExecution as startLegacySelectedCourseExecution,
  startStudent as startLegacyStudent,
  stopAllStudents as stopLegacyStudents,
  stopStudent as stopLegacyStudent,
  toggleDisplay as toggleLegacyDisplay,
} from './runner.ts'
import {
  applyNoqrSettingsToAll,
  deleteNoqrRuntime,
  getNoqrHistoryPaperImage,
  getNoqrHomeworkHistory,
  isRunning as isNoqrRunning,
  isStudentLocked as isNoqrStudentLocked,
  loginAndRefreshNoqr,
  onNoqrChange,
  setNoqrAnswerRoundLimit,
  setNoqrCourseScope,
  setNoqrSelectedCourses,
  snapshot as noqrSnapshot,
  startNoqrSelectedCourseExecution,
  startNoqrStudent,
  stopAllNoqr,
  stopNoqrStudent,
  toggleNoqrDisplay,
} from './noqr/run.ts'
import { getAccountWorkMode, listAccounts, patchAccountWorkMode } from './store.ts'
import { normalizeWorkMode, type WorkMode } from './core/work-mode.ts'

function routeMode(localId: string): WorkMode {
  return getAccountWorkMode(localId)
}

export function snapshot() {
  const base = legacySnapshot()
  const noqr = noqrSnapshot()
  const noqrById = new Map(noqr.students.map((student) => [student.local_id, student]))
  const legacyById = new Map(base.students.map((student) => [student.local_id, student]))
  const students = listAccounts().map((account) => {
    const mode = routeMode(account.local_id)
    if (mode === 'noqr') {
      const current = noqrById.get(account.local_id)
      if (current) {
        return {
          ...current,
          local_id: account.local_id,
          name: account.name,
          studentNo: account.username,
          major: account.major || '',
          campus: account.campus || '',
          configLocked: isStudentLocked(account.local_id),
          browserWindowVisible: current.browserWindowVisible,
        }
      }
      return null
    }
    return legacyById.get(account.local_id)
  }).filter(Boolean)
  return {
    ...base,
    students,
    running: isRunning(),
  }
}

export function isRunning() {
  return isLegacyRunning() || isNoqrRunning()
}

export function isStudentLocked(localId: string) {
  return isLegacyStudentLocked(localId) || isNoqrStudentLocked(localId)
}

export function startStudent(localId: string) {
  return routeMode(localId) === 'noqr' ? startNoqrStudent(localId) : startLegacyStudent(localId)
}

export async function loginAndRefresh(accountIds?: string[]) {
  if (isRunning()) return { ok: false, error: '任务运行中，请单独开始或停止学生' }
  const ids = listAccounts()
    .filter((account) => !accountIds || accountIds.includes(account.local_id))
    .map((account) => account.local_id)
  const legacyIds = ids.filter((id) => routeMode(id) !== 'noqr')
  const noqrIds = ids.filter((id) => routeMode(id) === 'noqr')
  if (!legacyIds.length && !noqrIds.length) return { ok: false, error: '请先添加学生账号' }
  const tasks: Promise<{ ok: boolean; error?: string }>[] = []
  if (legacyIds.length) tasks.push(loginAndRefreshLegacy(legacyIds))
  if (noqrIds.length) tasks.push(loginAndRefreshNoqr(noqrIds))
  const results = await Promise.all(tasks)
  return results.find((result) => !result.ok) || { ok: true }
}

export function enqueueNewStudents(ids: string[]) {
  if (!isRunning()) return 0
  let count = 0
  for (const id of ids) {
    if (isStudentLocked(id)) continue
    const mode = routeMode(id)
    const result = mode === 'noqr' ? startNoqrStudent(id) : startLegacyStudent(id)
    if (result.ok) count++
  }
  return count
}

export async function stopStudent(localId: string) {
  if (routeMode(localId) === 'noqr') {
    await stopNoqrStudent(localId)
    return
  }
  await stopLegacyStudent(localId)
}

export async function stopAllStudents() {
  await Promise.all([stopLegacyStudents(), stopAllNoqr()])
}

export async function deleteStudentRuntime(localId: string) {
  if (routeMode(localId) === 'noqr') {
    await deleteNoqrRuntime(localId)
    return
  }
  await deleteLegacyStudentRuntime(localId)
}

export async function setWorkMode(localId: string, mode: WorkMode) {
  const workMode = normalizeWorkMode(mode)
  if (isStudentLocked(localId)) return { ok: false, error: '该学生运行中，工作模式已锁定' }
  if (workMode === 'noqr') {
    patchAccountWorkMode(localId, 'noqr')
    return { ok: true }
  }
  return setLegacyWorkMode(localId, workMode)
}

export function applyStudentSettingsToAll(localId: string) {
  if (isRunning()) return { ok: false, updated: 0, failed: [] as string[], error: '仍有学生运行或排队，请全部停止后再同步' }
  return routeMode(localId) === 'noqr'
    ? applyNoqrSettingsToAll(localId)
    : applyLegacyStudentSettingsToAll(localId)
}

export async function toggleDisplay(localId: string, mode: 'headless' | 'visual') {
  return routeMode(localId) === 'noqr' ? toggleNoqrDisplay(localId, mode) : toggleLegacyDisplay(localId, mode)
}

export function setCourseScope(localId: string, scope: 'all' | 'selected') {
  return routeMode(localId) === 'noqr'
    ? setNoqrCourseScope(localId, scope)
    : setLegacyCourseScope(localId, scope)
}

export function setSelectedCourses(localId: string, keys: string[]) {
  return routeMode(localId) === 'noqr'
    ? setNoqrSelectedCourses(localId, keys)
    : setLegacySelectedCourses(localId, keys)
}

export function startSelectedCourseExecution() {
  const legacy = startLegacySelectedCourseExecution()
  const noqr = startNoqrSelectedCourseExecution()
  return legacy.ok || noqr.ok
    ? { ok: true }
    : { ok: false, error: noqr.error || legacy.error || '当前没有待开始的课程选择' }
}

export function setAnswerRoundLimit(localId: string, limit: number) {
  return routeMode(localId) === 'noqr'
    ? setNoqrAnswerRoundLimit(localId, limit)
    : setLegacyAnswerRoundLimit(localId, limit)
}

export function getHomeworkHistory(localId: string, courseName: string, homeworkName: string) {
  return routeMode(localId) === 'noqr'
    ? Promise.resolve(getNoqrHomeworkHistory(localId, courseName, homeworkName))
    : getLegacyHomeworkHistory(localId, courseName, homeworkName)
}

export function getHistoryPaperImage(localId: string, courseName: string, homeworkName: string, submittedAt: string) {
  return routeMode(localId) === 'noqr'
    ? Promise.resolve(getNoqrHistoryPaperImage())
    : getLegacyHistoryPaperImage(localId, courseName, homeworkName, submittedAt)
}

export function getQrSnapshot(localId: string) {
  return routeMode(localId) === 'noqr'
    ? { ok: false as const, error: '无码答题模式不使用二维码' }
    : getLegacyQrSnapshot(localId)
}

export function refreshQrSnapshot(localId: string) {
  return routeMode(localId) === 'noqr'
    ? Promise.resolve({ ok: false as const, error: '无码答题模式不使用二维码' })
    : refreshLegacyQrSnapshot(localId)
}

export async function signalVerified(localId: string) {
  if (routeMode(localId) === 'noqr') return { ok: false, error: '无码答题模式不使用旧扫码验证' }
  return signalLegacyVerified(localId)
}

export async function openVisual(localId: string) {
  if (routeMode(localId) === 'noqr') return { ok: false, error: '无码答题模式不使用旧可视化页面入口' }
  return openLegacyVisual(localId)
}

export { onNoqrChange }
