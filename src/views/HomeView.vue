<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { CourseScope, DisplayMode, PageId, WorkMode } from '../types/shell'
import { selectedStudentId, selectStudentId, resolveSelectedStudentId, useKaida } from '../useKaida'
import { overflowStudentIndexes, visibleStudentIndexes } from '../student-switcher'
import { homeworkScoreLabel } from '../../electron/core/live-view'
import { pageForCourse, pageGroups, pageSlice, pageCountForCourses } from '../../electron/core/course-pager'

const emit = defineEmits<{ go: [PageId] }>()
function go(id: PageId) {
  emit('go', id)
}

const { snap } = useKaida()
const displayMode = ref<DisplayMode>('headless')
const workMode = ref<WorkMode>('answer')
const courseScope = ref<CourseScope>('all')
const answerRoundLimit = ref(10)
const needsVerify = ref(false)
const popoverOn = ref(false)
const selectedCourseKey = ref('')
const studentMoreOn = ref(false)
const coursePage = ref(1)
const homeworkPage = ref(1)
const coursePageSize = 7
const homeworkPageSize = 4
const toastMsg = ref('操作已就绪')
const toastShow = ref(false)
type HistoryItem = { attempt: number; submittedAt: string; status: string; score: number | null; completed: boolean; viewable: boolean; displayState: 'viewable' | 'ungraded' | 'unfinished' | 'continue_only' | 'no_view' }
const historyOpen = ref(false)
const historyLoading = ref(false)
const historyError = ref('')
const historyHomework = ref('')
const historyCourseKey = ref('')
const historyRows = ref<HistoryItem[]>([])
const historyPaperImage = ref('')
const logOpen = ref(false)
type QrSnapshotPayload = { localId: string; courseName: string; homeworkName: string; version: number; image: string; capturedAt: string; appVersion: string; status: '等待扫码' }
const qrOpen = ref(false)
const qrLoading = ref(false)
const qrError = ref('')
const qrSnapshot = ref<QrSnapshotPayload | null>(null)
let qrRequest = 0
let historyRequest = 0
let toastTimer: ReturnType<typeof setTimeout> | undefined

const studentMeta = computed(() => {
  const live = snap.value?.students || []
  if (live.length) {
    return live.map((s) => ({
      local_id: s.local_id,
      name: s.name,
      id: s.studentNo,
      major: s.major,
      campus: s.campus,
      account: s.account,
      action: s.action,
      headline: s.headline,
      bankCount: s.bankCount,
      aiCount: s.aiCount,
      extractTotals: s.extractTotals,
      extractTotalCourses: s.extractTotalCourses,
      extractCompletedCourses: s.extractCompletedCourses,
      extractTotalHomeworks: s.extractTotalHomeworks,
      extractCompletedHomeworks: s.extractCompletedHomeworks,
      extractHistoryPages: s.extractHistoryPages,
      extractHistoryTotal: s.extractHistoryTotal,
      extractHistoryCompleted: s.extractHistoryCompleted,
      extractCurrentHistory: s.extractCurrentHistory,
      needsVerify: s.needsVerify,
      verified: s.verified,
      configLocked: s.configLocked,
      displayMode: s.displayMode,
      workMode: s.workMode,
      courseScope: s.courseScope,
      selectedCourseNames: s.selectedCourseNames,
      selectedCourseKeys: s.selectedCourseKeys,
      awaitingCourseSelection: s.awaitingCourseSelection,
      answerRoundLimit: s.answerRoundLimit,
      courses: s.courses || [],
      groups: s.groups || [],
      activeCourseName: s.activeCourseName || '',
      activeCourseKey: s.activeCourseKey || '',
      logs: s.logs || [],
      courseLogs: s.courseLogs || [],
    }))
  }
  return []
})
const emptyStudent = { local_id: '', name: '未选择学生', id: '', major: '', campus: '', headline: '等待添加学生账号', action: '等待添加学生账号', account: 'idle', bankCount: 0, aiCount: 0, extractTotals: { added: 0, merged: 0, skipped: 0, conflict: 0, failed: 0 }, extractTotalCourses: 0, extractCompletedCourses: 0, extractTotalHomeworks: 0, extractCompletedHomeworks: 0, extractHistoryPages: 0, extractHistoryTotal: 0, extractHistoryCompleted: 0, extractCurrentHistory: '', needsVerify: false, verified: false, configLocked: false, displayMode: 'headless' as const, workMode: 'answer' as const, courseScope: 'all' as const, selectedCourseNames: [], selectedCourseKeys: [], awaitingCourseSelection: false, answerRoundLimit: 10, courses: [], groups: [], activeCourseName: '', activeCourseKey: '', logs: [], courseLogs: [] }
const activeStudent = computed(() => studentMeta.value.findIndex((student) => student.local_id === selectedStudentId.value))
const currentStudent = computed(() => studentMeta.value.find((student) => student.local_id === selectedStudentId.value) ?? emptyStudent)
const hasLiveStudents = computed(() => Boolean(snap.value?.students?.length))
const allCourseRows = computed(() => hasLiveStudents.value ? currentStudent.value.courses : [])
const coursePageCount = computed(() => pageCountForCourses(allCourseRows.value, coursePageSize))
const courseRows = computed(() => pageSlice(allCourseRows.value, coursePageSize, coursePage.value))
const currentCourse = computed(() =>
  allCourseRows.value.find((course) => (course.key || course.name) === selectedCourseKey.value)
  || allCourseRows.value.find((course) => (course.key || course.name) === currentStudent.value.activeCourseKey)
  || allCourseRows.value.find((course) => course.name === currentStudent.value.activeCourseName)
  || allCourseRows.value[0],)
const currentCourseName = computed(() => currentCourse.value?.name || '')
const currentCourseKey = computed(() => currentCourse.value?.key || currentCourseName.value)
const currentGroups = computed(() => {
  if (!hasLiveStudents.value) return []
  const liveGroups = currentStudent.value.groups
  const course = currentCourse.value
  if (course?.groups?.length) return course.groups
  if (liveGroups.length && (currentStudent.value.activeCourseKey ? currentStudent.value.activeCourseKey === currentCourseKey.value : currentStudent.value.activeCourseName === currentCourseName.value)) return liveGroups
  return []
})
const currentHomeworkTotal = computed(() => currentGroups.value.reduce((sum, group) => sum + group.rows.length, 0))
const homeworkPageCount = computed(() => Math.max(1, Math.ceil(currentHomeworkTotal.value / homeworkPageSize)))
const visibleHomeworkGroups = computed(() => pageGroups(currentGroups.value, homeworkPageSize, homeworkPage.value))
const currentAnsweredTotal = computed(() => currentGroups.value.reduce((sum, group) => sum + group.rows.reduce((n, row) => n + row.questions.length, 0), 0))
const currentQuestionTotal = computed(() => currentGroups.value.reduce((sum, group) => sum + group.rows.reduce((n, row) => n + (row.questionTotal || row.questions.length), 0), 0))
const completedCourses = computed(() => allCourseRows.value.filter((c) => ['本轮可做作业已完成', '无作业'].includes(c.status)).length)
const machine = computed(() => snap.value?.machine || { cpu: '--', memory: '--', app: '--', browsers: 0, pressure: '等待主进程' })
const bankCount = computed(() => currentStudent.value.bankCount ?? 0)
const aiCount = computed(() => currentStudent.value.aiCount ?? 0)
const selectedCourseSet = computed(() => new Set(currentStudent.value.selectedCourseKeys || currentStudent.value.selectedCourseNames || []))
const selectedCourseTotal = computed(() => studentMeta.value.reduce((sum, student) => sum + (student.selectedCourseKeys || student.selectedCourseNames || []).length, 0))
const selectedStudentTotal = computed(() => studentMeta.value.filter((student) => (student.selectedCourseKeys || student.selectedCourseNames || []).length > 0).length)
const unselectedStudentNames = computed(() => studentMeta.value
  .filter((student) => student.awaitingCourseSelection && !(student.selectedCourseKeys || student.selectedCourseNames || []).length)
  .map((student) => student.name))
const waitingForCourseSelection = computed(() => studentMeta.value.some((student) => student.awaitingCourseSelection))
const canOpenCourseLog = computed(() => Boolean(currentCourseName.value) && !(currentStudent.value.awaitingCourseSelection && currentStudent.value.courseScope === 'selected' && !selectedCourseKey.value))
const controlsLocked = computed(() => Boolean(snap.value?.running))
const studentConfigLocked = computed(() => Boolean(currentStudent.value.configLocked))
const currentCourseLogs = computed(() => (currentStudent.value.courseLogs || []).filter((log) =>
  log.courseKey ? log.courseKey === currentCourseKey.value : log.courseName === currentCourseName.value && allCourseRows.value.filter((course) => course.name === log.courseName).length === 1,
).slice().reverse())
watch(currentStudent, (s) => {
  displayMode.value = s.displayMode
  workMode.value = s.workMode
  courseScope.value = s.courseScope
  answerRoundLimit.value = s.answerRoundLimit
  needsVerify.value = s.needsVerify
}, { immediate: true })

watch([selectedStudentId, studentMeta], async ([id, students]) => {
  const selected = resolveSelectedStudentId(id, students)
  if (!id) {
    if (selected) selectStudentId(selected)
    return
  }
  if (students.some((student) => student.local_id === id)) return
  const accounts = await window.kaida?.listAccounts().catch(() => null)
  if (accounts && selectedStudentId.value === id && !accounts.some((account) => account.local_id === id)) {
    selectStudentId(students[0]?.local_id || '')
  }
}, { immediate: true })

watch(needsVerify, (v) => {
  if (v) showToast('请扫微信码，然后点绿色「验证完毕」')
})

watch(() => [selectedStudentId.value, currentStudent.value.activeCourseKey || currentStudent.value.activeCourseName], ([studentId, activeCourse], [previousStudentId, previousCourse]) => {
  if (activeCourse && (studentId === previousStudentId && activeCourse !== previousCourse || !previousStudentId)) {
    coursePage.value = pageForCourse(allCourseRows.value, coursePageSize, activeCourse)
  }
})
watch(coursePageCount, (count) => { coursePage.value = Math.min(coursePage.value, count) })
watch(homeworkPageCount, (count) => { homeworkPage.value = Math.min(homeworkPage.value, count) })
watch(currentCourseKey, () => {
  homeworkPage.value = 1
  historyRequest++
  historyOpen.value = false
  historyPaperImage.value = ''
  logOpen.value = false
})
watch(selectedStudentId, () => {
  selectedCourseKey.value = ''
  coursePage.value = 1
  homeworkPage.value = 1
  qrRequest++
  historyRequest++
  qrOpen.value = false
  qrSnapshot.value = null
  historyOpen.value = false
  historyPaperImage.value = ''
  logOpen.value = false
}, { flush: 'sync' })
onMounted(() => {
  document.addEventListener('click', onDocClick)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
})

const pillOn =
  'student-pill flex min-w-0 flex-1 items-center gap-2 py-1.5 px-3 rounded-lg bg-white text-[#4F46E5] shadow-sm cursor-pointer transition-all duration-200 select-none tactile-btn overflow-hidden'
const segOn =
  'px-2.5 py-1 rounded-full bg-[#4F46E5] text-white text-[11px] font-semibold shadow-sm transition-all duration-200 tactile-btn'
const segOff =
  'px-2.5 py-1 rounded-full text-slate-600 hover:text-[#4F46E5] text-[11px] font-medium transition-all duration-200 tactile-btn'
const workOn =
  'px-3 py-1 rounded-full bg-[#4F46E5] text-white text-[11px] font-semibold shadow-sm transition-all duration-200 tactile-btn'
const workOff =
  'px-3 py-1 rounded-full text-slate-600 hover:text-[#4F46E5] text-[11px] font-medium transition-all duration-200 tactile-btn'

const toastClass = computed(() =>
  toastShow.value ? '!translate-y-0 !opacity-100 pointer-events-auto' : '',
)
const popoverClass = computed(() => (popoverOn.value ? 'show-popover' : 'hidden-popover'))
const studentMoreClass = computed(() => (studentMoreOn.value ? 'show-popover' : 'hidden-popover'))
const visiblePills = computed(() => visibleStudentIndexes(studentMeta.value.length, activeStudent.value, snap.value?.settings.account_parallel || 1))
const overflowPills = computed(() => overflowStudentIndexes(studentMeta.value.length, visiblePills.value))

function showToast(message: string) {
  toastMsg.value = message
  toastShow.value = true
  const el = document.getElementById('toast-msg')
  if (el) el.textContent = message
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastShow.value = false
  }, 2200)
}

function currentId() {
  return currentStudent.value.local_id
}
async function toggleMode(mode: DisplayMode) {
  if (!currentId() || studentConfigLocked.value) return showToast('该学生运行中，浏览器模式已锁定')
  const result = await window.kaida?.setDisplay(currentId(), mode)
  if (!result?.ok) return showToast(result?.error || '浏览器模式切换失败')
  displayMode.value = mode
  showToast(mode === 'headless' ? '已设置无头模式，下次启动生效' : '已设置可视化模式，下次启动生效')
}
async function setWorkMode(mode: WorkMode) {
  if (!currentId() || studentConfigLocked.value) return showToast('该学生运行中，工作模式已锁定')
  const result = await window.kaida?.setWorkMode(currentId(), mode)
  if (!result?.ok) return showToast(result?.error || '工作模式修改失败')
  workMode.value = mode
  showToast(mode === 'answer' ? '模式已设为：智能答题' : '模式已设为：提取题库')
}
async function setCourseScope(scope: CourseScope) {
  if (!currentId() || studentConfigLocked.value) return showToast('该学生运行中，课程范围已锁定')
  const result = await window.kaida?.setCourseScope(currentId(), scope)
  if (!result?.ok) return showToast(result?.error || '课程范围修改失败')
  courseScope.value = scope
  showToast(scope === 'all' ? '本学生将执行全部课程' : '扫描后由你选择本轮课程')
}
async function setAnswerRoundLimit() {
  if (!currentId() || studentConfigLocked.value) return showToast('该学生运行中，重新答题次数已锁定')
  const result = await window.kaida?.setAnswerRoundLimit(currentId(), answerRoundLimit.value)
  showToast(result?.ok ? `每份作业本次最多答 ${answerRoundLimit.value} 轮` : (result?.error || '保存失败'))
}
async function applyAllSettings() {
  if (!currentId() || controlsLocked.value) return
  const result = await window.kaida?.applyStudentSettingsToAll(currentId())
  showToast(result?.ok ? `已将配置设置到全部 ${result.updated} 名学生` : `${result?.error || '同步失败'}；成功 ${result?.updated || 0} 名`)
}
async function startCurrentStudent() {
  if (!currentId()) return
  const result = await window.kaida?.startStudent(currentId())
  showToast(result?.ok ? '该学生已重新开始或进入队列' : (result?.error || '开始失败'))
}
async function loginRefresh() {
  if (controlsLocked.value) return
  showToast('正在登录并刷新课程')
  const result = await window.kaida?.loginRefresh()
  showToast(result?.ok ? '本轮课程刷新已结束' : (result?.error || '登录并刷新课程失败'))
}
async function openQr() {
  const id = currentId()
  if (!id) return
  const request = ++qrRequest
  qrOpen.value = true
  qrLoading.value = true
  qrError.value = ''
  qrSnapshot.value = null
  const result = await window.kaida?.getQrSnapshot(id)
  if (request !== qrRequest || currentId() !== id) return
  qrLoading.value = false
  if (!result?.ok || !result.snapshot) qrError.value = result?.error || '二维码读取失败'
  else qrSnapshot.value = result.snapshot
}
async function refreshQr() {
  const id = currentId()
  if (!id) return
  const request = ++qrRequest
  qrLoading.value = true
  qrError.value = ''
  const result = await window.kaida?.refreshQrSnapshot(id)
  if (request !== qrRequest || currentId() !== id) return
  qrLoading.value = false
  if (!result?.ok || !result.snapshot) qrError.value = result?.error || '二维码刷新失败'
  else qrSnapshot.value = result.snapshot
}
async function copyQr() {
  if (!qrSnapshot.value) return
  const result = await window.kaida?.copyQrSnapshot(currentId(), qrSnapshot.value.version)
  showToast(result?.ok ? '二维码图片已复制' : (result?.error || '二维码复制失败'))
}
async function verifyDone() {
  const id = currentId()
  if (!id) return
  const result = await window.kaida?.verifyDone(id)
  if (currentId() !== id) return
  if (!result?.ok) {
    qrError.value = result?.error || '验证状态复核失败'
    showToast(qrError.value)
    return
  }
  needsVerify.value = false
  qrOpen.value = false
  qrSnapshot.value = null
  showToast('验证状态已确认，自动化继续')
}
function selectStudent(i: number) {
  const id = studentMeta.value[i]?.local_id
  if (!id) return
  selectStudentId(id)
  studentMoreOn.value = false
  showToast('已切换至学员：' + (studentMeta.value[i]?.name || ''))
}
function stopTask() {
  needsVerify.value = false
  if (currentId()) void window.kaida?.stop(currentId())
  showToast('已安全暂停当前答题任务')
}
async function stopAll() {
  await window.kaida?.stopAllStudents()
  showToast('已停止全部学生任务')
}
function deleteStudent() {
  if (currentId()) void window.kaida?.removeAccount(currentId())
  showToast('已清除当前排队任务')
}
function toggleLog() {
  if (!canOpenCourseLog.value) return showToast('请先选择课程')
  logOpen.value = true
}
function togglePopover() {
  popoverOn.value = !popoverOn.value
}
function toggleStudentMore() {
  studentMoreOn.value = !studentMoreOn.value
}
function onDocClick(ev: MouseEvent) {
  const el = document.getElementById('student-more')
  if (el && !el.contains(ev.target as Node)) studentMoreOn.value = false
}
function pillDotClass(i: number) {
  if (i === activeStudent.value) return 'w-1.5 h-1.5 rounded-full bg-[#10B981] status-pulse-green'
  const s = studentMeta.value[i]
  if (s?.needsVerify || /排队/.test(s?.headline || '')) return 'w-1.5 h-1.5 rounded-full bg-[#F59E0B]'
  return 'w-1.5 h-1.5 rounded-full bg-slate-300'
}
async function selectCourse(key: string) {
  selectedCourseKey.value = key
  const name = allCourseRows.value.find((course) => (course.key || course.name) === key)?.name || key
  if (courseScope.value !== 'selected' || !currentStudent.value.awaitingCourseSelection) {
    showToast('已切换课程：' + name)
    return
  }
  const keys = new Set(currentStudent.value.selectedCourseKeys || currentStudent.value.selectedCourseNames || [])
  if (keys.has(key)) keys.delete(key)
  else keys.add(key)
  const result = await window.kaida?.setSelectedCourses(currentId(), [...keys])
  if (result?.ok) {
    const selected = result.selectedKeys || result.selectedNames || []
    selectedCourseKey.value = selected.includes(key) ? key : (selected[0] || '')
  }
  showToast(result?.ok ? `本学生已选择 ${result.selected || 0} 门课程` : (result?.error || '课程选择失败'))
}
async function primaryAction() {
  if (waitingForCourseSelection.value) {
    const result = await window.kaida?.startSelectedCourses()
    showToast(result?.ok ? `开始执行已选 ${selectedCourseTotal.value} 门课程` : (result?.error || '暂不能开始'))
    return
  }
  if (controlsLocked.value) return
  loginRefresh()
}
async function openHistoryScores(homeworkName: string) {
  const id = currentId()
  const request = ++historyRequest
  const courseKey = currentCourseKey.value
  historyOpen.value = true
  historyLoading.value = true
  historyError.value = ''
  historyHomework.value = homeworkName
  historyCourseKey.value = courseKey
  historyRows.value = []
  historyPaperImage.value = ''
  const result = await window.kaida?.getHomeworkHistory(id, courseKey, homeworkName)
  if (request !== historyRequest || currentId() !== id) return
  historyLoading.value = false
  if (!result?.ok) historyError.value = result?.error || '历史成绩读取失败'
  else historyRows.value = result.items
}
async function openHistoryPaper(row: HistoryItem) {
  const id = currentId()
  const request = ++historyRequest
  const courseKey = historyCourseKey.value
  historyLoading.value = true
  historyError.value = ''
  const result = await window.kaida?.getHistoryPaperImage(id, courseKey, historyHomework.value, row.submittedAt)
  if (request !== historyRequest || currentId() !== id) return
  historyLoading.value = false
  if (!result?.ok || !result.image) historyError.value = result?.error || '历史答卷读取失败'
  else historyPaperImage.value = result.image
}
function closeHistory() {
  historyOpen.value = false
  historyPaperImage.value = ''
}
function historyStateLabel(state: HistoryItem['displayState']) {
  return { viewable: '已批阅，可查看', ungraded: '尚未批阅', unfinished: '未完成提交', continue_only: '只有续做，无查看', no_view: '无可靠查看入口' }[state]
}
function logLevelClass(level: 'info' | 'running' | 'success' | 'warning' | 'error') {
  return {
    info: 'border-slate-200 bg-slate-50 text-slate-700',
    running: 'border-blue-200 bg-blue-50 text-blue-700',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-700',
    error: 'border-rose-200 bg-rose-50 text-rose-700',
  }[level]
}
function formatLogTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('zh-CN', { hour12: false })
}
function statusLabel(status: string) {
  const labels: Record<string, string> = {
    previewing: '预览中', clicking_do_homework: '点做作业', answering: '作答中', submitting: '提交中',
    waiting_grade: '等待批阅', reviewing: '校对中', extracting: '提取中', extracting_done: '提取完成', pending_writeback: '待回写', done_100: '已满分',
    skip_weight0: '权重 0% 跳过', skip_non_objective: '非客观题跳过', skip_out_of_window: '不在时间窗',
    skip_attempts_exhausted: '次数用尽', skip_full_score: '已满分跳过', skip_no_history: '无历史链接跳过', submit_failed: '提交失败',
    skip_bank_miss: '听力题库缺项',
    not_full_next_time: '下次继续', spin_stopped: '已停止空转', todo: '待作答', '检测中': '检测中',
  }
  return labels[status] || status
}
function homeworkSourceCount(rows: { source: '题库' | 'AI' | '空过' }[], source: '题库' | 'AI' | '空过') {
  return rows.filter((row) => row.source === source).length
}
</script>

<template>
  <div class="bg-[#F5F3FF] font-sans text-slate-900 antialiased selection:bg-[#4F46E5] selection:text-white min-h-screen w-full flex flex-col justify-between relative overflow-x-hidden">
<!-- Toast Notification Container -->
<div class="fixed top-6 right-8 z-[100] transform transition-all duration-300 -translate-y-6 opacity-0 pointer-events-none flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-slate-900 text-white shadow-floating text-[13px] font-medium" :class="toastClass" id="toast">
<span class="material-symbols-outlined text-[18px] text-[#10B981]" id="toast-icon">check_circle</span>
<span id="toast-msg">{{ toastMsg }}</span>
</div>
<div v-if="qrOpen" class="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/50 p-6 backdrop-blur-sm" @click.self="qrOpen = false">
<section class="w-full max-w-xl overflow-hidden rounded-3xl border border-indigo-100 bg-white shadow-2xl">
<header class="flex items-start justify-between border-b border-slate-100 px-6 py-4">
<div>
<h2 class="text-lg font-bold text-slate-900">作业二维码</h2>
<p class="mt-1 text-xs text-slate-500">扫码后仍需点击“验证完毕”，程序复核通过才会继续。</p>
</div>
<button class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="关闭二维码弹窗" @click="qrOpen = false"><span class="material-symbols-outlined">close</span></button>
</header>
<div class="grid gap-5 p-6 md:grid-cols-[1fr_180px]">
<div class="flex min-h-72 items-center justify-center rounded-2xl border border-indigo-100 bg-[#F8FAFC] p-4">
<span v-if="qrLoading" class="text-sm font-medium text-indigo-600">正在读取真实二维码…</span>
<img v-else-if="qrSnapshot" :src="qrSnapshot.image" class="max-h-[360px] w-full rounded-xl object-contain" alt="当前作业扫码二维码">
<div v-else class="text-center text-sm text-rose-600">{{ qrError || '暂无可用二维码' }}</div>
</div>
<div class="flex flex-col gap-3 text-xs">
<div class="rounded-xl border border-slate-200 bg-slate-50 p-3"><span class="text-slate-400">学生</span><p class="mt-1 font-semibold text-slate-800">{{ currentStudent.name }} · {{ currentStudent.id }} <span v-if="currentStudent.verified" class="text-emerald-700" aria-label="已授权">已授权</span></p></div>
<div class="rounded-xl border border-slate-200 bg-slate-50 p-3"><span class="text-slate-400">课程 / 作业</span><p class="mt-1 font-semibold text-slate-800">{{ qrSnapshot?.courseName || currentCourseName || '等待识别' }}</p><p class="mt-1 text-slate-600">{{ qrSnapshot?.homeworkName || '等待识别' }}</p></div>
<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-700"><p class="font-semibold">{{ qrSnapshot?.status || '等待二维码' }}</p><p v-if="qrSnapshot" class="mt-1 font-mono text-[10px]">二维码 v{{ qrSnapshot.version }} · 程序 {{ qrSnapshot.appVersion }}</p></div>
<p v-if="qrError && qrSnapshot" class="rounded-xl bg-rose-50 p-3 text-rose-600">{{ qrError }}</p>
</div>
</div>
<footer class="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-6 py-4">
<button class="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40" :disabled="!qrSnapshot || qrLoading" @click="copyQr">复制二维码</button>
<button class="rounded-full border border-indigo-200 px-4 py-2 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-40" :disabled="qrLoading" @click="refreshQr">刷新二维码</button>
<button class="rounded-full bg-[#10B981] px-5 py-2 text-xs font-semibold text-white hover:bg-[#059669]" @click="verifyDone">验证完毕</button>
</footer>
</section>
</div>
<div v-if="historyOpen" class="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/45 p-6 backdrop-blur-sm" @click.self="closeHistory">
<section class="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-indigo-100 bg-white shadow-2xl">
<header class="flex items-center justify-between border-b border-slate-100 px-6 py-4">
<div><h2 class="text-lg font-bold text-slate-900">{{ historyPaperImage ? '只读历史答卷' : '历史成绩' }}</h2><p class="mt-1 text-xs text-slate-500">{{ currentCourseName }} · {{ historyHomework }}</p></div>
<div class="flex items-center gap-2">
<button v-if="historyPaperImage" type="button" class="rounded-full border border-indigo-100 px-3 py-1.5 text-xs font-semibold text-[#4F46E5] hover:bg-indigo-50" @click="historyPaperImage = ''">返回成绩</button>
<button type="button" class="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="关闭历史成绩" @click="closeHistory"><span class="material-symbols-outlined text-[20px]">close</span></button>
</div>
</header>
<div class="overflow-auto p-6">
<div v-if="historyLoading" class="flex items-center justify-center gap-2 py-16 text-sm text-indigo-600"><span class="material-symbols-outlined animate-spin">progress_activity</span>正在读取真实历史记录</div>
<div v-else-if="historyError" class="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{{ historyError }}</div>
<img v-else-if="historyPaperImage" :src="historyPaperImage" class="mx-auto h-auto max-w-full rounded-xl border border-slate-200" alt="只读历史答卷截图" />
<div v-else-if="!historyRows.length" class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">暂无历史记录</div>
<div v-else class="flex flex-col gap-3">
<article v-for="row in historyRows" :key="`${row.attempt}-${row.submittedAt}`" class="grid grid-cols-[72px_minmax(0,1fr)_110px_130px] items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3">
<span class="font-mono text-sm font-bold text-slate-800">第 {{ row.attempt }} 次</span>
<div class="min-w-0"><p class="truncate text-sm font-semibold text-slate-800">{{ row.submittedAt || '提交时间未知' }}</p><p class="mt-1 text-xs text-slate-500">{{ row.status || historyStateLabel(row.displayState) }} · {{ row.completed ? '已完成提交' : '未完成提交' }}</p></div>
<span class="text-right font-mono text-sm font-bold" :class="row.score === 100 ? 'text-emerald-600' : 'text-indigo-600'">{{ row.score == null ? '尚未出分' : `${row.score} 分` }}</span>
<button type="button" class="rounded-full border px-3 py-1.5 text-xs font-semibold transition" :class="row.viewable ? 'border-indigo-200 bg-white text-[#4F46E5] hover:bg-indigo-50' : 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'" :disabled="!row.viewable" @click="openHistoryPaper(row)">{{ row.viewable ? '查看只读答卷' : historyStateLabel(row.displayState) }}</button>
</article>
</div>
</div>
</section>
</div>
<div v-if="logOpen" class="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/45 p-6 backdrop-blur-sm" @click.self="logOpen = false">
<section class="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-indigo-100 bg-white shadow-2xl">
<header class="flex items-center justify-between border-b border-slate-100 px-6 py-4">
<div><h2 class="text-lg font-bold text-slate-900">课程运行日志</h2><p class="mt-1 text-xs text-slate-500">{{ currentStudent.name }} · {{ currentCourseName }}</p></div>
<button type="button" class="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="关闭课程日志" @click="logOpen = false"><span class="material-symbols-outlined text-[20px]">close</span></button>
</header>
<div class="overflow-auto p-5">
<div v-if="!currentCourseLogs.length" class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">当前课程暂无运行日志</div>
<div v-else class="flex flex-col gap-2">
<article v-for="(entry, index) in currentCourseLogs" :key="`${entry.time}-${index}`" class="grid grid-cols-[76px_82px_minmax(0,1fr)] gap-3 rounded-2xl border px-4 py-3 text-xs" :class="logLevelClass(entry.level)">
<time class="font-mono opacity-70">{{ formatLogTime(entry.time) }}</time>
<span class="font-semibold">{{ entry.result }}</span>
<div class="min-w-0"><p class="font-semibold">{{ entry.action }}</p><p v-if="entry.homeworkName || entry.reason" class="mt-1 truncate opacity-70">{{ entry.homeworkName }}<span v-if="entry.homeworkName && entry.reason"> · </span>{{ entry.reason }}</p></div>
</article>
</div>
</div>
</section>
</div>
<!-- TOP APP BAR: 纯净通透顶栏 -->
<header class="sticky top-0 z-50 px-10 py-4 bg-white/95 backdrop-blur-md border-b border-[#EDE9FE] shadow-[0_1px_3px_rgba(79,70,229,0.04)] transition-all">
<div class="max-w-[1600px] mx-auto flex items-center justify-between">
<div class="flex items-center gap-8">
<div class="flex items-center gap-3 cursor-pointer group">
<div class="w-9 h-9 rounded-xl bg-[#4F46E5] flex items-center justify-center text-white shadow-sm transition-transform duration-200 group-hover:scale-105">
<span class="material-symbols-outlined text-[19px]">auto_stories</span>
</div>
<span class="text-[17px] font-bold text-slate-900 tracking-tight select-none">开大自动答题桌面端</span>
</div>
<div class="hidden xl:flex items-center gap-3 px-4 py-1.5 rounded-full bg-[#FFFFFF] text-slate-500 text-[12px] font-mono border border-[#EDE9FE] shadow-sm select-none transition-all hover:border-[#C7D2FE]"><span class="text-slate-600 font-medium">CPU <span class="text-slate-900 font-semibold">{{ machine.cpu }}</span></span><span class="w-1 h-1 rounded-full bg-[#EDE9FE]"></span><span class="text-slate-600 font-medium">内存 <span class="text-slate-900 font-semibold">{{ machine.memory }}</span></span><span class="w-1 h-1 rounded-full bg-[#EDE9FE]"></span><span class="">本软件 {{ machine.app }}</span><span class="w-1 h-1 rounded-full bg-[#EDE9FE]"></span><span class="" title="启动中+占用中+需验证，不含排队">浏览器 {{ machine.browsers }}</span><span class="w-1 h-1 rounded-full bg-[#EDE9FE]"></span><span class="flex items-center gap-1.5 text-[#10B981] font-sans font-semibold"><span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10B981] opacity-60"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-[#10B981] status-pulse-green"></span></span>压力{{ machine.pressure }}</span></div>
</div>
<div class="flex items-center gap-4">
<nav class="flex items-center p-1 rounded-full bg-[#EDE9FE]/50 border border-[#EDE9FE]" id="header-nav">
<a href="#" @click.prevent="go('home')" class="nav-tab px-4 py-1.5 rounded-full bg-[#4F46E5] text-white font-semibold text-[13px] shadow-sm transition-all tactile-btn">工作台</a>
<a href="#" @click.prevent="go('bank')" class="nav-tab px-4 py-1.5 rounded-full text-slate-600 hover:text-[#4F46E5] hover:bg-white text-[13px] font-medium transition-all tactile-btn">题库</a>
<a href="#" @click.prevent="go('accounts')" class="nav-tab px-4 py-1.5 rounded-full text-slate-600 hover:text-[#4F46E5] hover:bg-white text-[13px] font-medium transition-all tactile-btn">学生账号</a>
<a href="#" @click.prevent="go('settings')" class="nav-tab px-4 py-1.5 rounded-full text-slate-600 hover:text-[#4F46E5] hover:bg-white text-[13px] font-medium transition-all tactile-btn">设置</a>
</nav>
</div>
</div>
</header>
<!-- MAIN WORKSPACE: 三列纯色卡片布局 -->
<main class="flex-1 w-full max-w-[1600px] mx-auto px-10 pt-[92px] pb-8 flex flex-col">
<div class="grid grid-cols-[280px_minmax(0,1fr)_340px] gap-8 items-start"><!-- LEFT COLUMN: 课程目录导航 -->
<aside class="flex flex-col bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden animate-enter-1 transition-all hover:shadow-card">
<div class="flex flex-col gap-2.5 px-4 py-3.5 border-b border-slate-100 bg-[#F8FAFC]">
<div class="flex items-center gap-2">
<span class="material-symbols-outlined text-[17px] text-[#4F46E5]">menu_book</span>
<span class="text-[13px] font-bold text-slate-900 tracking-tight">我的课程 ({{ allCourseRows.length }})</span>
</div>
<div class="grid grid-cols-2 gap-1 rounded-xl border border-[#EDE9FE] bg-[#F5F3FF] p-1">
<button type="button" class="rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-all" :class="courseScope === 'all' ? 'bg-[#4F46E5] text-white shadow-sm' : 'text-slate-500 hover:bg-white'" :disabled="studentConfigLocked" @click="setCourseScope('all')">全部自动执行</button>
<button type="button" class="rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-all" :class="courseScope === 'selected' ? 'bg-[#4F46E5] text-white shadow-sm' : 'text-slate-500 hover:bg-white'" :disabled="studentConfigLocked" @click="setCourseScope('selected')">可选课程执行</button>
</div>
</div>
<div class="h-[360px] overflow-y-auto p-2 flex flex-col gap-1" id="course-list">
<div v-for="course in courseRows" :key="course.key || course.name" class="course-item group relative flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all duration-200 hover:translate-x-0.5" :class="selectedCourseSet.has(course.key || course.name) ? 'bg-[#EEF2FF] border border-[#818CF8] shadow-sm' : (course.key || course.name) === currentCourseKey ? 'bg-[#F8FAFC] border border-[#C7D2FE]' : 'border border-transparent hover:bg-[#F8FAFC] hover:border-slate-100'" @click="selectCourse(course.key || course.name)">
<div class="flex items-center gap-2.5 min-w-0 pr-2">
<span v-if="courseScope === 'selected' && currentStudent.awaitingCourseSelection" class="material-symbols-outlined text-[17px]" :class="selectedCourseSet.has(course.key || course.name) ? 'text-[#4F46E5]' : 'text-slate-300'">{{ selectedCourseSet.has(course.key || course.name) ? 'check_box' : 'check_box_outline_blank' }}</span>
<span v-else class="w-1.5 h-4 rounded-full" :class="(course.key || course.name) === currentCourseKey ? 'bg-[#4F46E5]' : 'bg-slate-300 group-hover:bg-[#4F46E5]'" />
<span class="text-[13px] truncate" :class="selectedCourseSet.has(course.key || course.name) || (course.key || course.name) === currentCourseKey ? 'font-bold text-slate-900' : 'font-medium text-slate-700 group-hover:text-slate-900'">{{ course.name }}</span>
</div>
<div class="flex items-center gap-1.5 shrink-0">
<span class="font-mono text-[10px] text-slate-400 whitespace-nowrap">库{{ course.bankCount || 0 }} · AI{{ course.aiCount || 0 }}</span>
<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap" :class="(course.key || course.name) === currentCourseKey ? 'bg-[#4F46E5] text-white' : 'bg-slate-100 text-slate-500'">{{ statusLabel(course.status) }}</span>
</div>
</div>
</div>
<div v-if="coursePageCount > 1" class="flex items-center justify-center gap-2 border-t border-slate-100 bg-white p-2">
<button type="button" aria-label="上一页课程" :disabled="coursePage <= 1" @click="coursePage--"><span class="material-symbols-outlined text-[16px]">chevron_left</span></button>
<span class="font-mono text-[10px]">{{ coursePage }}/{{ coursePageCount }}</span>
<button type="button" aria-label="下一页课程" :disabled="coursePage >= coursePageCount" @click="coursePage++"><span class="material-symbols-outlined text-[16px]">chevron_right</span></button>
</div>
<div class="p-3 border-t border-slate-100 bg-[#F8FAFC] flex items-center justify-between text-[11.5px] text-slate-500">
<span class="font-medium">已处理 {{ completedCourses }}/{{ allCourseRows.length }} 门课程</span>
<span class="text-[#4F46E5] font-medium">{{ courseScope === 'selected' ? `已选 ${(currentStudent.selectedCourseKeys || currentStudent.selectedCourseNames || []).length} 门` : '按顺序执行' }}</span>
</div>
</aside>
<!-- CENTER COLUMN: 中央主工作区 (核心主角) -->
<section class="flex flex-col bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden min-h-[560px] animate-enter-2 transition-all hover:shadow-card">
<!-- Header Banner -->
<div class="p-6 border-b border-slate-100 bg-white flex flex-col gap-4">
<div class="flex flex-wrap items-center justify-between gap-3">
<div class="flex items-center gap-3">
<span class="w-1.5 h-6 rounded-full bg-[#4F46E5]"></span>
<h1 class="text-[20px] font-bold text-slate-900 tracking-tight">{{ currentCourseName || '等待课程' }} · 客观题结果</h1>
</div>
<div class="flex items-center gap-2">
<div class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#4F46E5] text-white font-mono text-[12px] font-semibold shadow-sm transition-transform duration-150 hover:scale-105 select-none">
<span class="material-symbols-outlined text-[15px]">database</span>
<span>题库答题 {{ bankCount }}</span>
</div>
<div class="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#EEF2FF] border border-[#C7D2FE] text-[#4F46E5] font-mono text-[12px] font-semibold transition-transform duration-150 hover:scale-105 select-none">
<span class="material-symbols-outlined text-[15px] text-[#4F46E5]">smart_toy</span>
<span>AI 答题 {{ aiCount }}</span>
</div>
</div>
</div>
<!-- Realtime Engine Status Capsule -->
<div class="flex items-center justify-between px-3.5 py-2 rounded-xl bg-[#F8FAFC] border border-[#EDE9FE] transition-colors duration-200 hover:border-[#C7D2FE]">
<div class="flex min-w-0 items-center gap-2 text-[12px]">
<span class="relative flex h-2 w-2">
<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#4F46E5] opacity-60"></span>
<span class="relative inline-flex rounded-full h-2 w-2 bg-[#4F46E5] status-pulse-indigo"></span>
</span>
<span id="current-action" class="line-clamp-2 min-w-0 flex-1 break-words font-semibold text-[#4F46E5]" :title="currentStudent.action">{{ currentStudent.action }}</span>
<span class="shrink-0 text-slate-400">（课程与作业状态实时同步）</span>
</div>
</div>
<div v-if="workMode === 'extract'" id="extract-progress" class="grid grid-cols-2 gap-2 rounded-xl border border-indigo-100 bg-indigo-50/50 px-3 py-2 text-[10px] font-mono tabular-nums text-indigo-700" aria-live="polite">
<span>课程 {{ currentStudent.extractCompletedCourses }}/{{ currentStudent.extractTotalCourses }}</span>
<span>作业 {{ currentStudent.extractCompletedHomeworks }}/{{ currentStudent.extractTotalHomeworks }}</span>
<span>历史 {{ currentStudent.extractHistoryCompleted }}/{{ currentStudent.extractHistoryTotal }}</span>
<span>活动历史页 {{ currentStudent.extractHistoryPages }}</span>
<span v-if="currentStudent.extractCurrentHistory" class="col-span-2 truncate">当前历史：第 {{ currentStudent.extractCurrentHistory }} 条</span>
</div>
<!-- Overall Progress bar -->
<div class="flex flex-col gap-1.5">
<div class="flex items-center justify-between text-[12px]">
<span class="text-slate-500 font-medium">当前课程作答进度（提交与回写另计）</span>
<span class="font-mono font-bold text-slate-900">{{ currentAnsweredTotal }} <span class="text-slate-400 font-normal">题 · {{ currentHomeworkTotal }} 份作业</span></span>
</div>
<div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden p-0.5">
<div class="h-full bg-[#4F46E5] rounded-full progress-shimmer-bar transition-all duration-500" :style="{ width: (currentQuestionTotal ? Math.min(100, currentAnsweredTotal / currentQuestionTotal * 100) : 0) + '%' }"></div>
</div>
</div>
</div>
<!-- Body Sections -->
<div class="p-6 flex flex-col gap-6 flex-1 justify-between">
<div class="flex flex-col gap-5">
<div v-for="group in visibleHomeworkGroups" :key="group.title" class="flex flex-col gap-2.5">
<div class="flex items-center justify-between px-1">
<span class="text-[11.5px] font-bold text-slate-400 uppercase tracking-wider">{{ group.title }}</span>
<span class="text-[11px] text-slate-400 font-mono">{{ group.rows.length }} 项</span>
</div>
<div v-for="row in group.rows" :key="row.name" class="p-4 rounded-xl bg-[#F8FAFC] border border-slate-200 transition-all duration-200 hover:bg-white hover:shadow-card hover:border-[#C7D2FE]">
<div class="flex items-center justify-between gap-3">
<div class="flex items-center gap-3 min-w-0">
<span class="w-2.5 h-2.5 rounded-full" :class="row.status === 'done_100' ? 'bg-[#10B981] ring-4 ring-[#D1FAE5]' : 'bg-[#F59E0B]'" />
<span class="text-[14.5px] font-bold text-slate-900 tracking-tight truncate">{{ row.name }}</span>
</div>
<div class="flex items-center gap-3">
<span class="px-3 py-0.5 rounded-full bg-[#EEF2FF] text-[#4F46E5] text-[11.5px] font-semibold border border-[#C7D2FE] whitespace-nowrap">{{ statusLabel(row.status) }}</span>
<button type="button" class="rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] font-medium text-slate-600 shadow-sm transition-all hover:border-indigo-200 hover:text-[#4F46E5]" @click="openHistoryScores(row.name)">历史成绩</button>
<div v-if="row.questions.length" class="relative">
<button @click="togglePopover" class="source-popover-trigger px-3 py-1 rounded-full text-slate-600 hover:text-[#4F46E5] hover:bg-white text-[12px] font-medium transition-all duration-150 flex items-center gap-1 shadow-sm border border-slate-200 bg-white tactile-btn"><span>查看来源</span><span class="material-symbols-outlined text-[15px]">expand_more</span></button>
<div :class="popoverClass" class="source-popover hidden-popover absolute right-0 top-full mt-2 w-64 p-4 rounded-2xl bg-white shadow-floating border border-[#EDE9FE] z-30 flex flex-col gap-2.5">
<span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">来源明细 (题库 / AI / 空过)</span>
<div class="flex items-center justify-between py-1 border-b border-[#F1F5F9]"><span class="text-[12px] text-slate-700">题库答题</span><span class="font-mono text-[12px] font-bold text-slate-900">{{ homeworkSourceCount(row.questions, '题库') }} 题</span></div>
<div class="flex items-center justify-between py-1 border-b border-[#F1F5F9]"><span class="text-[12px] text-slate-700">AI 答题</span><span class="font-mono text-[12px] font-bold text-[#4F46E5]">{{ homeworkSourceCount(row.questions, 'AI') }} 题</span></div>
<div class="flex items-center justify-between py-0.5"><span class="text-[12px] text-slate-500">空过</span><span class="font-mono text-[12px] font-medium text-slate-400">{{ homeworkSourceCount(row.questions, '空过') }} 题</span></div>
</div>
</div>
</div>
</div>
<div v-if="row.questions.length" class="text-[11px] text-slate-400 pt-2">已读取 {{ row.questions.length }} 题，题库 {{ homeworkSourceCount(row.questions, '题库') }} / AI {{ homeworkSourceCount(row.questions, 'AI') }} / 空过 {{ homeworkSourceCount(row.questions, '空过') }}</div>
<div v-if="workMode === 'extract' && row.extractStats" class="grid grid-cols-5 gap-1.5 pt-2 text-[10px] font-mono tabular-nums" aria-live="polite">
<span class="rounded-md bg-indigo-50 px-1.5 py-1 text-center text-indigo-700">新增 {{ row.extractStats.added }}</span>
<span class="rounded-md bg-sky-50 px-1.5 py-1 text-center text-sky-700">去重 {{ row.extractStats.merged }}</span>
<span class="rounded-md bg-slate-100 px-1.5 py-1 text-center text-slate-600">跳过 {{ row.extractStats.skipped }}</span>
<span class="rounded-md bg-amber-50 px-1.5 py-1 text-center text-amber-700">冲突 {{ row.extractStats.conflict }}</span>
<span class="rounded-md bg-rose-50 px-1.5 py-1 text-center text-rose-700">失败 {{ row.extractStats.failed }}</span>
</div>
<div class="pt-2 text-[12px] font-semibold tabular-nums" :class="row.score === 100 ? 'text-emerald-600' : 'text-indigo-600'" aria-live="polite">{{ homeworkScoreLabel(row) }}</div>
</div>
</div>
<div v-if="!currentGroups.length" class="p-4 rounded-xl bg-[#F8FAFC] border border-slate-200 text-[13px] text-slate-400">等待课程检测结果</div>
</div>
<div v-if="homeworkPageCount > 1" class="flex items-center justify-center gap-2 border-t border-slate-100 pt-3">
<button type="button" aria-label="上一页作业" :disabled="homeworkPage <= 1" @click="homeworkPage--"><span class="material-symbols-outlined text-[16px]">chevron_left</span></button>
<span class="font-mono text-[10px]">{{ homeworkPage }}/{{ homeworkPageCount }}</span>
<button type="button" aria-label="下一页作业" :disabled="homeworkPage >= homeworkPageCount" @click="homeworkPage++"><span class="material-symbols-outlined text-[16px]">chevron_right</span></button>
</div>
<!-- Center footer notes -->
<div class="pt-4 border-t border-slate-100 flex items-center justify-between text-slate-500 text-[12px]">
<span class="font-mono">本单元自测共 {{ currentHomeworkTotal }} 份试卷</span>
<div class="flex items-center gap-1.5 text-[#10B981] bg-[#ECFDF5] px-3 py-1 rounded-full border border-[#A7F3D0] transition-transform duration-150 hover:scale-[1.02] cursor-default">
<span class="material-symbols-outlined text-[15px]">verified</span>
<span class="text-[11.5px] font-semibold">自动化引擎就绪</span>
</div>
</div>
</div>
</section>
<!-- RIGHT COLUMN: 学生卡与控制中心 -->
<aside class="flex flex-col bg-white rounded-2xl border border-slate-200 shadow-sm p-5 gap-4 animate-enter-3 transition-all hover:shadow-card">
<!-- Student Tabs -->
<div class="flex flex-col gap-1 p-1 bg-[#F5F3FF] rounded-xl border border-[#EDE9FE]" id="student-switcher">
<div v-for="i in visiblePills" :key="'pill-' + (studentMeta[i]?.local_id || i)" class="flex min-w-0 items-center gap-1">
<div :class="[pillOn, i === activeStudent ? 'ring-2 ring-[#C7D2FE]' : '']" :data-student="i" :title="(studentMeta[i]?.name || '') + ' ' + (studentMeta[i]?.id || '')" @click="selectStudent(i)">
<span :class="pillDotClass(i)" class="shrink-0"></span>
<span class="text-[12px] font-bold shrink-0 whitespace-nowrap">{{ studentMeta[i]?.name }}</span>
<span class="font-mono text-[10px] text-slate-500 whitespace-nowrap truncate">{{ studentMeta[i]?.id }}</span>
</div>
<div v-if="overflowPills.length && i === visiblePills[visiblePills.length - 1]" class="relative shrink-0" id="student-more">
<button type="button" class="min-w-[36px] h-8 px-1.5 flex items-center justify-center gap-0.5 rounded-lg bg-white text-[#4F46E5] border border-[#EDE9FE] hover:bg-[#EEF2FF] tactile-btn" @click.stop="toggleStudentMore" aria-label="更多学生">
<span class="text-[16px] font-bold leading-none tracking-tight">⋯</span>
<span class="text-[10px] font-semibold">{{ overflowPills.length }}</span>
</button>
<div :class="studentMoreClass" class="source-popover absolute right-0 top-full mt-2 w-72 max-h-72 overflow-y-auto p-2 rounded-2xl bg-white shadow-floating border border-[#EDE9FE] z-30 flex flex-col gap-1">
<span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-2 pt-1">其余学生 {{ overflowPills.length }}</span>
<button v-for="i in overflowPills" :key="'more-' + (studentMeta[i]?.local_id || i)" type="button" class="flex flex-col gap-0.5 px-3 py-2 rounded-xl text-left hover:bg-[#F5F3FF] tactile-btn" @click.stop="selectStudent(i)">
<span class="text-[12px] font-bold text-slate-800">{{ studentMeta[i]?.name }}</span>
<span class="font-mono text-[10px] text-slate-500">{{ studentMeta[i]?.id }}</span>
<span class="text-[10px] text-slate-400">{{ studentMeta[i]?.headline }}</span>
</button>
</div>
 </div>
</div>
</div>
<!-- Segmented Switchers -->
<div class="flex flex-col gap-2.5 pb-2 border-b border-slate-100">
<div class="flex items-center justify-between gap-2">
<span class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">执行环境</span>
<div class="p-0.5 rounded-full bg-[#F5F3FF] flex items-center border border-[#EDE9FE]">
<button @click="toggleMode('headless')" class="mode-headless-btn disabled:cursor-not-allowed disabled:opacity-60" :class="displayMode === 'headless' ? segOn : segOff" :disabled="studentConfigLocked">无头浏览器</button>
<button @click="toggleMode('visual')" class="mode-visual-btn disabled:cursor-not-allowed disabled:opacity-60" :class="displayMode === 'visual' ? segOn : segOff" :disabled="studentConfigLocked">可视化浏览器</button>
</div>
</div>
<div class="flex items-center justify-between gap-2">
<span class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">工作模式</span>
<div class="p-0.5 rounded-full bg-[#F5F3FF] flex items-center border border-[#EDE9FE]" id="work-mode-switcher">
<button @click="setWorkMode('answer')" class="workmode-btn-ans disabled:cursor-not-allowed disabled:opacity-60" :class="workMode === 'answer' ? workOn : workOff" :disabled="studentConfigLocked">答题</button>
<button @click="setWorkMode('extract')" class="workmode-btn-ext disabled:cursor-not-allowed disabled:opacity-60" :class="workMode === 'extract' ? workOn : workOff" :disabled="studentConfigLocked">提取题库</button>
</div>
</div>
<div v-if="workMode === 'answer'" class="flex items-center justify-between gap-2">
<span class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">作业重新答题次数</span>
<select v-model.number="answerRoundLimit" class="h-7 min-w-[72px] rounded-full border border-[#EDE9FE] bg-[#F5F3FF] px-3 text-[11px] font-semibold text-[#4F46E5] outline-none focus:border-[#A5B4FC]" aria-label="作业重新答题次数" :disabled="studentConfigLocked" @change="setAnswerRoundLimit">
<option v-for="n in 10" :key="n" :value="n">{{ n }} 轮</option>
</select>
</div>
</div>
<!-- Dynamic Core Status -->
<div class="flex flex-col gap-2.5 p-3.5 rounded-xl bg-[#F8FAFC] border border-slate-200 transition-all duration-200 hover:border-[#C7D2FE]">
<div class="flex items-center gap-2">
<span class="relative flex h-2.5 w-2.5">
<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#4F46E5] opacity-60"></span>
<span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#4F46E5] status-pulse-indigo"></span>
</span>
<span class="line-clamp-2 min-w-0 break-words text-[13.5px] font-bold text-slate-900 tracking-tight" id="status-title" :title="currentStudent.headline">{{ currentStudent.headline }}</span>
</div>
<div class="grid grid-cols-2 gap-2">
<div class="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white border border-[#EDE9FE] shadow-sm transition-transform hover:scale-[1.02]">
<span class="text-[11px] text-slate-500">题库答题 {{ bankCount }}</span>
<span class="font-mono text-[12px] font-bold text-slate-900" id="stat-repo">{{ bankCount }}</span>
</div>
<div v-if="workMode === 'extract'" id="extract-stats" class="mt-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-2.5 py-2 text-[10px] font-mono tabular-nums text-indigo-700" aria-live="polite">
提取总计：新增 {{ currentStudent.extractTotals.added }} · 去重 {{ currentStudent.extractTotals.merged }} · 跳过 {{ currentStudent.extractTotals.skipped }} · 冲突 {{ currentStudent.extractTotals.conflict }} · 失败 {{ currentStudent.extractTotals.failed }}
</div>
<div class="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white border border-[#EDE9FE] shadow-sm transition-transform hover:scale-[1.02]">
<span class="text-[11px] text-[#4F46E5]">AI 答题 {{ aiCount }}</span>
<span class="font-mono text-[12px] font-bold text-[#4F46E5]" id="stat-ai">{{ aiCount }}</span>
</div>
</div>
</div>
<!-- Student details & Parallel badges -->
<div class="flex flex-col gap-2 px-1 text-[12px]" id="student-meta">
<div class="flex items-center justify-between"><span class="text-slate-400">学员姓名</span><span class="flex items-center gap-1.5 font-semibold text-slate-900" id="student-name">{{ currentStudent.name }}<span v-if="currentStudent.verified" class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700" aria-label="已授权">已授权</span></span></div>
<div class="flex items-center justify-between"><span class="text-slate-400">学员学号</span><span class="font-mono text-slate-700 font-medium" id="student-id">{{ currentStudent.id }}</span></div>
<div class="flex items-center justify-between"><span class="text-slate-400">登录账号</span><span class="font-mono text-slate-700 font-medium" id="student-account">{{ currentStudent.id }}</span></div>
</div>
<div class="flex items-center justify-center gap-2">
<span class="px-2.5 py-1 rounded-full bg-[#F5F3FF] text-[#4F46E5] font-mono text-[11px] font-medium border border-[#EDE9FE] transition-transform hover:scale-105">账号并行 {{ snap?.settings.account_parallel || 1 }}</span>
<span class="px-2.5 py-1 rounded-full bg-[#F5F3FF] text-[#4F46E5] font-mono text-[11px] font-medium border border-[#EDE9FE] transition-transform hover:scale-105">课程并行 {{ snap?.settings.course_parallel || 1 }}</span>
<button type="button" class="px-2 py-1 rounded-full border border-indigo-200 text-indigo-600 text-[10px] font-semibold disabled:opacity-40" :disabled="controlsLocked || !currentId()" @click="applyAllSettings">将配置设置到全部</button>
</div>
<!-- Verification Warning Card -->
<div v-if="needsVerify" class="p-3 rounded-xl bg-[#FEF3C7]/60 border border-[#FDE68A] flex flex-col gap-2">
<div class="flex items-center gap-1.5 text-[11px] font-medium text-[#F59E0B]">
<span class="material-symbols-outlined text-[15px]">info</span>
<span>微信扫码出现后：扫完再点「验证完毕」才会继续作答</span>
</div>
<div class="flex items-center gap-2">
<button class="flex-1 py-1 rounded-lg bg-white text-slate-700 text-[11px] font-medium hover:text-[#4F46E5] border border-slate-200 shadow-sm transition-all tactile-btn" id="btn-open-qr" @click="openQr">查看作业二维码</button>
<button class="flex-1 py-2 rounded-lg bg-[#10B981] hover:bg-[#059669] text-white text-[12px] font-semibold shadow-sm transition-all tactile-btn" id="btn-verify-done" @click="verifyDone">验证完毕</button>
</div>
</div>
<!-- Quick Toolbar -->
<div class="grid grid-cols-4 gap-1 pt-2 border-t border-slate-100">
<button class="py-1.5 rounded-lg text-slate-600 hover:text-[#F59E0B] hover:bg-[#FEF3C7]/40 text-[11px] font-medium transition-all flex flex-col items-center gap-0.5 tactile-btn" id="tool-stop" @click="stopTask">
<span class="material-symbols-outlined text-[16px]">stop_circle</span>
<span>停止</span>
</button>
<button class="py-1.5 rounded-lg text-indigo-600 hover:bg-indigo-50 text-[11px] font-medium transition-all flex flex-col items-center gap-0.5 tactile-btn disabled:opacity-40" id="tool-start" :disabled="!currentId() || studentConfigLocked" @click="startCurrentStudent">
<span class="material-symbols-outlined text-[16px]">play_circle</span>
<span>开始</span>
</button>
<button class="py-1.5 rounded-lg text-slate-600 hover:text-[#4F46E5] hover:bg-[#F5F3FF] text-[11px] font-medium transition-all flex flex-col items-center gap-0.5 tactile-btn disabled:cursor-not-allowed disabled:opacity-40" id="tool-log" :disabled="!canOpenCourseLog" @click="toggleLog">
<span class="material-symbols-outlined text-[16px]">receipt_long</span>
<span>日志</span>
</button>
<button class="py-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 text-[11px] font-medium transition-all flex flex-col items-center gap-0.5 tactile-btn" id="tool-delete" @click="deleteStudent">
<span class="material-symbols-outlined text-[16px]">delete</span>
<span>删除</span>
</button>
</div></aside></div>
</main>
<!-- BOTTOM BAR: 纯色悬浮控制胶囊栏 -->
<footer class="fixed bottom-0 left-0 right-0 z-40 px-10 pointer-events-none pb-4 animate-enter-bottom">
<div class="max-w-[1600px] mx-auto flex justify-end"><div class="w-full pointer-events-auto flex items-center justify-between px-6 py-3 rounded-full bg-white/95 backdrop-blur-md shadow-floating border border-[#EDE9FE] transition-all hover:border-[#C7D2FE]">
<div class="flex items-center gap-4">
<div class="flex items-center gap-2 text-slate-600 select-none">
<span class="material-symbols-outlined text-[19px] text-[#10B981]">verified_user</span>
<span v-if="waitingForCourseSelection" class="max-w-[760px] truncate text-[13px] font-semibold text-slate-800" :title="unselectedStudentNames.length ? `未选择：${unselectedStudentNames.join('、')}` : ''">已选 {{ selectedStudentTotal }} 个学生 · {{ selectedCourseTotal }} 门课程<span v-if="unselectedStudentNames.length"> · 未选择：{{ unselectedStudentNames.join('、') }}</span></span>
<span v-else class="text-[13px] font-semibold text-slate-800">全部课程 {{ allCourseRows.length }} 门 · 已处理 {{ completedCourses }} 门 · 当前课程 {{ currentHomeworkTotal }} 项作业</span>
</div>
<span class="w-1 h-1 rounded-full bg-slate-300"></span>
<div class="flex items-center gap-1.5 text-[#10B981] font-mono text-[12px] font-medium">
<span class="w-1.5 h-1.5 rounded-full bg-[#10B981] status-pulse-green"></span>
<span>{{ snap?.running ? '自动化引擎运行中' : '自动化引擎待命' }}</span>
</div>
</div>
<div class="flex items-center gap-2">
<button class="h-11 px-5 rounded-full bg-slate-100 hover:bg-red-50 text-slate-700 hover:text-red-600 font-semibold text-[13px] flex items-center gap-2 shadow-sm transition-all duration-200 tactile-btn disabled:cursor-not-allowed disabled:opacity-50" id="btn-stop-all" @click="stopAll" :disabled="!snap?.running">
<span class="material-symbols-outlined text-[18px]">stop_circle</span><span>全部停止</span>
</button>
<button class="h-11 px-7 rounded-full bg-[#4F46E5] hover:bg-[#4338CA] text-white font-semibold text-[14px] flex items-center gap-2 shadow-card transition-all duration-200 tactile-btn disabled:cursor-not-allowed disabled:opacity-50" id="btn-primary-action" @click="primaryAction" :disabled="waitingForCourseSelection ? selectedCourseTotal === 0 : controlsLocked" title="快捷键 ⌘R / Ctrl+R">
<span class="material-symbols-outlined text-[18px]" id="play-icon">play_arrow</span>
<span id="play-text">{{ waitingForCourseSelection ? `开始执行（已选 ${selectedCourseTotal} 门）` : courseScope === 'selected' ? '登录并检测课程' : '登录并刷新课程' }}</span>
<span class="text-[11px] font-mono text-[#C7D2FE] font-normal ml-0.5">⌘R</span>
</button>
</div>
</div></div>
</footer>
  </div>
</template>
