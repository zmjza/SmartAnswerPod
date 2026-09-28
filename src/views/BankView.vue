<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import type { PageId } from '../types/shell'
import { useKaida } from '../useKaida'
import BankImportView from './BankImportView.vue'

type BankRow = { id: string; qtype: string; stem: string; options: string[]; answer_texts: string[]; course_names: string[]; updated_at: string }
const emit = defineEmits<{ go: [PageId] }>()
const { snap } = useKaida()
const machine = computed(() => snap.value?.machine || { cpu: '--', memory: '--', app: '--', browsers: 0, pressure: '等待主进程' })
const screen = ref<'home' | 'import' | 'view'>('home')
const unlocked = ref(false)
const passwordOpen = ref(false)
const password = ref('')
const accessError = ref('')
const lockedUntil = ref(0)
const remainingAttempts = ref(5)
const now = ref(Date.now())
const rows = ref<BankRow[]>([])
const courses = ref<string[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const courseName = ref('')
const searchMode = ref<'fuzzy' | 'exact'>('fuzzy')
const searchText = ref('')
const loading = ref(false)
const listError = ref('')
const selected = ref(new Set<string>())
const expanded = ref(new Set<string>())
const deleteIds = ref<string[]>([])
const deleteTargets = ref<{ id: string; stem: string }[]>([])
const deleteFailures = ref<{ id: string; reason: string }[]>([])
const deleteOpen = ref(false)
const deleteBusy = ref(false)
const deleteMessage = ref('')
let bankRequest = 0
const lockSeconds = computed(() => Math.max(0, Math.ceil((lockedUntil.value - now.value) / 1000)))
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const allCurrentSelected = computed(() => rows.value.length > 0 && rows.value.every((row) => selected.value.has(row.id)))
const timer = setInterval(() => { now.value = Date.now() }, 500)
onUnmounted(() => clearInterval(timer))

function go(id: PageId) {
  if (id === 'bank') screen.value = 'home'
  else emit('go', id)
}
async function openViewer() {
  screen.value = 'view'
  if (unlocked.value) return loadBank()
  const status = await window.kaida?.bankAccessStatus()
  lockedUntil.value = status?.lockedUntil || 0
  remainingAttempts.value = status?.remainingAttempts ?? 5
  passwordOpen.value = true
}
async function unlock() {
  if (lockSeconds.value > 0 || !password.value) return
  const result = await window.kaida?.unlockBank(password.value)
  password.value = ''
  lockedUntil.value = result?.lockedUntil || 0
  remainingAttempts.value = result?.remainingAttempts ?? 0
  if (!result?.ok) {
    accessError.value = lockedUntil.value ? `密码错误次数已达上限，请 ${lockSeconds.value || 60} 秒后重试` : `密码错误，还可尝试 ${remainingAttempts.value} 次`
    return
  }
  accessError.value = ''
  unlocked.value = true
  passwordOpen.value = false
  loading.value = true
  await Promise.allSettled([loadCourses(), loadBank()])
}
async function loadCourses() {
  const result = await window.kaida?.listBankCourses()
  if (result?.ok) courses.value = result.courses
}
async function loadBank() {
  if (!unlocked.value) return
  const request = ++bankRequest
  loading.value = true
  listError.value = ''
  try {
    const result = await window.kaida?.listBankQuestions({ page: page.value, pageSize: pageSize.value, courseName: courseName.value, searchMode: searchMode.value, searchText: searchText.value })
    if (request !== bankRequest) return
    if (!result?.ok) { listError.value = result?.error || '题库查询失败'; return }
    total.value = result.total
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize.value))
    if (page.value > lastPage) { page.value = lastPage; return await loadBank() }
    rows.value = result.rows
    selected.value = new Set([...selected.value].filter((id) => rows.value.some((row) => row.id === id)))
  } catch (error) {
    if (request !== bankRequest) return
    listError.value = error instanceof Error ? error.message : '题库查询失败'
  } finally {
    if (request === bankRequest) loading.value = false
  }
}
function search() { page.value = 1; void loadBank() }
function clearSearch() { courseName.value = ''; searchText.value = ''; searchMode.value = 'fuzzy'; page.value = 1; void loadBank() }
function changePage(next: number) { page.value = Math.min(pageCount.value, Math.max(1, next)); void loadBank() }
function toggleSelected(id: string) {
  const next = new Set(selected.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selected.value = next
}
function toggleAll() {
  selected.value = allCurrentSelected.value ? new Set() : new Set(rows.value.map((row) => row.id))
}
function toggleExpanded(id: string) {
  const next = new Set(expanded.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expanded.value = next
}
function askDelete(ids: string[]) {
  deleteIds.value = [...new Set(ids)]
  deleteTargets.value = deleteIds.value.map((id) => ({ id, stem: rows.value.find((row) => row.id === id)?.stem || id }))
  deleteMessage.value = ''
  deleteFailures.value = []
  deleteOpen.value = true
}
function deleteTarget(id: string) {
  const target = deleteTargets.value.find((item) => item.id === id)
  return target?.stem || id
}
async function confirmDelete() {
  deleteBusy.value = true
  try {
    const result = await window.kaida?.deleteBankQuestions([...deleteIds.value])
    if (!result || result.error) { deleteMessage.value = result?.error || '删除失败'; return }
    deleteFailures.value = result.failed
    deleteMessage.value = result.failed.length ? `已删除 ${result.deletedIds.length} 条，失败 ${result.failed.length} 条` : `已删除并回读确认 ${result.deletedIds.length} 条`
    selected.value = new Set()
    await loadBank()
    if (!result.failed.length) setTimeout(() => { deleteOpen.value = false }, 800)
  } catch (error) {
    deleteMessage.value = error instanceof Error ? error.message : '删除失败'
  } finally {
    deleteBusy.value = false
  }
}
function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
</script>

<template>
<BankImportView v-if="screen === 'import'" @go="go" />
<div v-else class="min-h-screen bg-[#F5F3FF] text-slate-900">
<header class="sticky top-0 z-40 border-b border-indigo-100 bg-white/95 backdrop-blur"><div class="mx-auto flex h-16 max-w-[1500px] items-center justify-between px-8"><div class="flex items-center gap-6"><div class="flex items-center gap-3 font-bold"><span class="flex h-9 w-9 items-center justify-center rounded-xl bg-[#4F46E5] text-white"><span class="material-symbols-outlined">menu_book</span></span>开大自动答题桌面端</div><div class="hidden items-center gap-2 rounded-full border border-slate-200 px-4 py-1.5 font-mono text-xs text-slate-500 xl:flex"><span>CPU {{ machine.cpu }}</span><span>·</span><span>内存 {{ machine.memory }}</span><span>·</span><span>本软件 {{ machine.app }}</span><span>·</span><span>浏览器 {{ machine.browsers }}</span><span>·</span><b class="text-emerald-600">{{ machine.pressure }}</b></div></div><nav class="flex items-center gap-1 rounded-full bg-slate-100 p-1 text-xs font-semibold"><button class="rounded-full px-5 py-1.5 text-slate-600" @click="go('home')">工作台</button><button class="rounded-full bg-[#4F46E5] px-5 py-1.5 text-white" @click="screen = 'home'">题库</button><button class="rounded-full px-5 py-1.5 text-slate-600" @click="go('accounts')">学生账号</button><button class="rounded-full px-5 py-1.5 text-slate-600" @click="go('settings')">设置</button></nav></div></header>

<main v-if="screen === 'home'" class="mx-auto flex max-w-5xl flex-col gap-8 px-8 py-14"><div><p class="text-sm font-semibold text-indigo-600">云端统一题库</p><h1 class="mt-2 text-3xl font-bold">选择题库操作</h1><p class="mt-2 text-sm text-slate-500">导入本地 JSON，或通过密码门禁查看、搜索和删除云端题目。</p></div><div class="grid gap-6 md:grid-cols-2"><button class="group rounded-3xl border border-indigo-100 bg-white p-8 text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl" @click="screen = 'import'"><span class="material-symbols-outlined rounded-2xl bg-indigo-50 p-4 text-3xl text-indigo-600">upload_file</span><h2 class="mt-6 text-xl font-bold">导入题库</h2><p class="mt-2 text-sm leading-6 text-slate-500">导入 JSON，按题干和选项集合去重，显示新增、合并、冲突和跳过统计。</p></button><button class="group rounded-3xl border border-indigo-100 bg-white p-8 text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl" @click="openViewer"><span class="material-symbols-outlined rounded-2xl bg-emerald-50 p-4 text-3xl text-emerald-600">table_view</span><h2 class="mt-6 text-xl font-bold">查看题库</h2><p class="mt-2 text-sm leading-6 text-slate-500">服务端分页查询全部题目，支持课程筛选、搜索、单条与批量删除。</p></button></div></main>

<main v-else class="mx-auto max-w-[1600px] px-8 py-8"><div class="mb-5 flex flex-wrap items-center justify-between gap-3"><div><button class="text-sm font-semibold text-indigo-600" @click="screen = 'home'">← 返回题库首页</button><h1 class="mt-2 text-2xl font-bold">查看题库</h1><p v-if="loading" class="mt-1 text-sm text-indigo-600">正在读取云端题库…</p><p v-else class="mt-1 text-sm text-slate-500">共 {{ total }} 题 · 第 {{ page }}/{{ pageCount }} 页</p></div><button class="rounded-full bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600 disabled:opacity-40" :disabled="selected.size === 0" @click="askDelete([...selected])">批量删除（{{ selected.size }}）</button></div><section class="overflow-hidden rounded-3xl border border-indigo-100 bg-white shadow-sm"><div class="grid gap-3 border-b border-slate-100 bg-slate-50 p-4 md:grid-cols-[180px_1fr_120px_auto_auto]"><select v-model="courseName" class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" @change="search"><option value="">全部课程</option><option v-for="course in courses" :key="course">{{ course }}</option></select><input v-model="searchText" class="rounded-xl border border-slate-200 px-3 py-2 text-sm" placeholder="搜索课程、题干、选项或答案" @keyup.enter="search"><select v-model="searchMode" class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"><option value="fuzzy">模糊搜索</option><option value="exact">精确搜索</option></select><button class="rounded-xl bg-[#4F46E5] px-4 py-2 text-sm font-semibold text-white" @click="search">搜索</button><button class="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600" @click="clearSearch">清除</button></div><div v-if="listError" class="m-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-600">{{ listError }}</div><div class="overflow-x-auto"><table class="min-w-[1200px] w-full table-fixed text-left text-xs"><thead class="bg-white text-slate-500"><tr><th class="w-16 p-3"><input type="checkbox" :checked="allCurrentSelected" @change="toggleAll"></th><th class="w-16 p-3">序号</th><th class="w-48 p-3">所属课程</th><th class="w-80 p-3">题目</th><th class="w-72 p-3">题目选项</th><th class="w-56 p-3">正确答案</th><th class="w-44 p-3">时间</th><th class="w-24 p-3">操作</th></tr></thead><tbody><tr v-if="loading"><td colspan="8" class="p-10 text-center text-indigo-600">正在读取云端题库…</td></tr><tr v-else-if="!rows.length"><td colspan="8" class="p-10 text-center text-slate-400">没有符合条件的题目</td></tr><tr v-for="(row, index) in rows" v-else :key="row.id" class="border-t border-slate-100 align-top hover:bg-indigo-50/30"><td class="p-3"><input type="checkbox" :checked="selected.has(row.id)" @change="toggleSelected(row.id)"></td><td class="p-3 font-mono">{{ (page - 1) * pageSize + index + 1 }}</td><td class="p-3"><span class="line-clamp-3" :title="row.course_names.join('、')">{{ row.course_names.join('、') || '未分类' }}</span></td><td class="p-3"><button class="w-full text-left" :class="expanded.has(row.id) ? '' : 'line-clamp-3'" :title="row.stem" @click="toggleExpanded(row.id)">{{ row.stem }}</button></td><td class="p-3"><div :class="expanded.has(row.id) ? '' : 'line-clamp-3'" :title="row.options.join('；')">{{ row.options.join('；') }}</div></td><td class="p-3"><div :class="expanded.has(row.id) ? '' : 'line-clamp-3'" :title="row.answer_texts.join('；')">{{ row.answer_texts.join('；') }}</div></td><td class="p-3 font-mono text-slate-500">{{ formatTime(row.updated_at) }}</td><td class="p-3"><button class="rounded-full bg-rose-50 px-3 py-1.5 font-semibold text-rose-600" @click="askDelete([row.id])">删除</button></td></tr></tbody></table></div><div class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 p-4"><select v-model.number="pageSize" class="rounded-full border border-slate-200 px-3 py-1.5 text-xs" @change="page = 1; loadBank()"><option :value="20">每页 20 条</option><option :value="50">每页 50 条</option><option :value="100">每页 100 条</option></select><div class="flex items-center gap-2"><button class="rounded-full border border-slate-200 px-4 py-1.5 disabled:opacity-40" :disabled="page <= 1" @click="changePage(page - 1)">上一页</button><span class="font-mono text-xs">{{ page }} / {{ pageCount }}</span><button class="rounded-full border border-slate-200 px-4 py-1.5 disabled:opacity-40" :disabled="page >= pageCount" @click="changePage(page + 1)">下一页</button></div></div></section></main>

<div v-if="passwordOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-6 backdrop-blur-sm" @click.self="passwordOpen = false; screen = 'home'"><section class="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"><h2 class="text-xl font-bold">输入查看题库密码</h2><p class="mt-2 text-sm text-slate-500">连续输入错误 5 次将冻结 60 秒，关闭或重启程序不能绕过。</p><input v-model="password" type="password" class="mt-5 w-full rounded-xl border border-slate-200 px-4 py-3" :disabled="lockSeconds > 0" placeholder="请输入密码" @keyup.enter="unlock"><p v-if="accessError || lockSeconds" class="mt-3 text-sm text-rose-600">{{ lockSeconds ? `已冻结，请 ${lockSeconds} 秒后重试` : accessError }}</p><div class="mt-5 flex justify-end gap-2"><button class="rounded-full border border-slate-200 px-4 py-2 text-sm" @click="passwordOpen = false; screen = 'home'">取消</button><button class="rounded-full bg-[#4F46E5] px-5 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="lockSeconds > 0 || !password" @click="unlock">进入题库</button></div></section></div>
<div v-if="deleteOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-6 backdrop-blur-sm" @click.self="!deleteBusy && (deleteOpen = false)"><section class="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"><h2 class="text-xl font-bold">确认删除 {{ deleteIds.length }} 道题？</h2><p class="mt-2 text-sm text-slate-500">删除后会立即回读确认。部分失败时会逐条保留并显示原因。</p><ul class="mt-4 max-h-32 space-y-2 overflow-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-600"><li v-for="target in deleteTargets.slice(0, 10)" :key="target.id" class="line-clamp-2" :title="target.stem">{{ target.stem }}</li><li v-if="deleteTargets.length > 10">其余 {{ deleteTargets.length - 10 }} 道题</li></ul><p v-if="deleteMessage" class="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{{ deleteMessage }}</p><ul v-if="deleteFailures.length" class="mt-2 max-h-32 space-y-2 overflow-auto text-xs text-rose-600"><li v-for="failure in deleteFailures" :key="failure.id">{{ deleteTarget(failure.id) }}：{{ failure.reason }}</li></ul><div class="mt-5 flex justify-end gap-2"><button class="rounded-full border border-slate-200 px-4 py-2 text-sm" :disabled="deleteBusy" @click="deleteOpen = false">取消</button><button class="rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="deleteBusy" @click="confirmDelete">{{ deleteBusy ? '正在删除并回读…' : '确认删除' }}</button></div></section></div>
</div>
</template>
