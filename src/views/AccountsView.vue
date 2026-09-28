<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PageId } from '../types/shell'
import { selectedStudentId, selectStudentId, useKaida } from '../useKaida'

const emit = defineEmits<{ go: [PageId] }>()
function go(id: PageId) {
  // TODO(ui-shell) 仅壳内切页
  emit('go', id)
}

const excelInput = ref<HTMLInputElement | null>(null)
const query = ref('')
const newName = ref('')
const newAccount = ref('')
const newPassword = ref('')
const editId = ref('')
const editName = ref('')
const editPassword = ref('')
const formatError = ref('')
const pasteText = ref('')
const pasteOpen = ref(false)
const pasteConfirmOpen = ref(false)
const pasteRows = ref<{ name: string; username: string; password: string }[]>([])
const pasteErrors = ref<{ line: number; text: string; reason: string }[]>([])
const pasteBusy = ref(false)
const deleteAllIds = ref<string[]>([])
const deletingAll = ref(false)
const accounts = ref<{ name: string; account: string; local_id: string }[]>([])
const filter = ref<'all' | 'running' | 'queued'>('all')
const { snap } = useKaida()
const machine = computed(() => snap.value?.machine)
const liveById = computed(() => new Map((snap.value?.students || []).map((s) => [s.local_id, s])))
const filteredAccounts = computed(() => accounts.value.filter((a) => {
  const live = liveById.value.get(a.local_id)
  const text = [a.name, a.account, live?.major, live?.campus].join(' ').toLowerCase()
  if (query.value && !text.includes(query.value.trim().toLowerCase())) return false
  if (filter.value === 'running') return Boolean(live && live.slot !== 'queued' && live.slot !== 'released')
  if (filter.value === 'queued') return Boolean(live?.queued)
  return true
}))
const runningCount = computed(() => accounts.value.filter((a) => {
  const slot = liveById.value.get(a.local_id)?.slot
  return slot === 'launching' || slot === 'occupied' || slot === 'occupying_verify'
}).length)
const queuedCount = computed(() => accounts.value.filter((a) => liveById.value.get(a.local_id)?.queued).length)

async function importExcel() {
  const r = await window.kaida?.importExcel()
  formatError.value = r?.ok ? `已导入 ${r.count || 0} 名学生` : (r?.error || '格式错误')
  await reload()
}
function onExcel() {
  void importExcel()
}
async function reload() {
  const list = await window.kaida?.listAccounts()
  if (list) accounts.value = list.map((a) => ({ name: a.name, account: a.account, local_id: a.local_id }))
}
onMounted(() => { void reload() })
function focusAdd() {
  document.querySelector('#manual-name')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
async function addAccount() {
  if (!newName.value || !newAccount.value || !newPassword.value) {
    formatError.value = '姓名、账号、密码都要填'
    return
  }
  const r = await window.kaida?.addAccount({ name: newName.value, username: newAccount.value, password: newPassword.value })
  if (r && !r.ok) {
    formatError.value = r.error || '添加失败'
    return
  }
  formatError.value = ''
  newName.value = ''
  newAccount.value = ''
  newPassword.value = ''
  await reload()
}
async function parsePaste() {
  pasteBusy.value = true
  const result = await window.kaida?.parsePastedAccounts(pasteText.value)
  pasteBusy.value = false
  pasteRows.value = result?.rows || []
  pasteErrors.value = result?.errors || []
  if (!pasteRows.value.length) formatError.value = pasteErrors.value[0]?.reason || '没有可导入的学生'
}
function openPaste() {
  pasteText.value = ''
  pasteRows.value = []
  pasteErrors.value = []
  pasteConfirmOpen.value = false
  pasteOpen.value = true
}
function openPasteConfirm() {
  if (pasteRows.value.length) pasteConfirmOpen.value = true
}
async function confirmPaste() {
  if (!pasteRows.value.length) return
  pasteBusy.value = true
  let result: { ok: boolean; imported: number; error?: string } | undefined
  try {
    result = await window.kaida?.confirmPastedAccounts(pasteRows.value.map((row) => ({ ...row })))
  } catch (error) {
    pasteBusy.value = false
    formatError.value = error instanceof Error ? error.message : '批量导入失败'
    return
  }
  pasteBusy.value = false
  if (!result?.ok && !result?.imported) { formatError.value = result?.error || '批量导入失败'; return }
  pasteOpen.value = false
  pasteConfirmOpen.value = false
  pasteText.value = ''
  pasteRows.value = []
  pasteErrors.value = []
  formatError.value = result?.ok ? `已批量导入 ${result.imported} 名学员` : `已导入 ${result?.imported || 0} 名学员；${result?.error || '其余失败'}`
  await reload()
}
async function remove(i: number) {
  const id = filteredAccounts.value[i]?.local_id
  if (id) await window.kaida?.removeAccount(id)
  await reload()
}
function openDeleteAll() {
  deleteAllIds.value = accounts.value.map((a) => a.local_id)
}
async function confirmDeleteAll() {
  if (deletingAll.value || !deleteAllIds.value.length) return
  deletingAll.value = true
  try {
    const result = await window.kaida?.removeAllAccounts([...deleteAllIds.value])
    await reload()
    formatError.value = result?.ok ? `已删除 ${result.removed} 名学生` : (result?.error || '删除失败')
    deleteAllIds.value = []
  } catch (error) {
    formatError.value = error instanceof Error ? error.message : '删除失败'
  } finally {
    deletingAll.value = false
  }
}

function beginEdit(account: { local_id: string; name: string }) {
  editId.value = account.local_id
  editName.value = account.name
  editPassword.value = ''
}
function cancelEdit() {
  editId.value = ''
  editName.value = ''
  editPassword.value = ''
}
async function saveEdit() {
  if (!editId.value) return
  const r = await window.kaida?.updateAccount(editId.value, { name: editName.value, password: editPassword.value || undefined })
  if (r && !r.ok) formatError.value = r.error || '保存失败'
  else { formatError.value = ''; cancelEdit(); await reload() }
}

function selectFilter(next: typeof filter.value) {
  filter.value = next
}

function clearQuery() {
  query.value = ''
}

function selectCurrent(localId: string) {
  selectStudentId(localId)
  emit('go', 'home')
}

function initials(name: string) {
  return name.trim().slice(0, 1) || '学'
}

function liveLabel(localId: string) {
  const live = liveById.value.get(localId)
  if (!live) return '待运行'
  if (live.needsVerify) return '需验证'
  if (live.queued) return '排队中'
  return live.headline || '空闲'
}

function courseProgress(localId: string) {
  const live = liveById.value.get(localId)
  const total = live?.courses.length || 0
  const done = live?.courses.filter((c) => /满分|完成|无作业|跳过/.test(c.status)).length || 0
  return { done, total, percent: total ? Math.round(done / total * 100) : 0 }
}
</script>

<template>
  <div class="bg-[#F8FAFC] text-[#0F172A] font-sans antialiased selection:bg-[#4F46E5] selection:text-white min-h-screen flex flex-col justify-between">
<!-- 1. 全局顶部 Header (fadeInDown 动效) -->
<header class="fixed top-0 left-0 right-0 z-50 h-12 bg-white border-b border-slate-200/80 px-6 flex items-center justify-between shadow-[0_1px_3px_rgba(0,0,0,0.02)] anim-fade-down">
<!-- 左侧品牌与指标卡 -->
<div class="flex items-center gap-6">
<div class="flex items-center gap-2.5 group cursor-pointer">
<span class="w-2.5 h-2.5 rounded-full bg-[#4F46E5] transition-transform duration-200 group-hover:scale-125"></span>
<span class="text-sm font-semibold tracking-tight text-slate-900 select-none group-hover:text-[#4F46E5] transition-colors duration-150">开大自动答题桌面端</span>
</div>
<!-- 系统指标胶囊 -->
<div class="hidden xl:flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 border border-slate-200 text-[11px] font-mono text-slate-600 select-none hover:border-slate-300 transition-colors">
<span class="hover:text-slate-900 transition-colors">CPU {{ machine?.cpu || '--' }}</span>
<span class="text-slate-300">·</span>
<span class="hover:text-slate-900 transition-colors">内存 {{ machine?.memory || '--' }}</span>
<span class="text-slate-300">·</span>
<span class="hover:text-slate-900 transition-colors">本软件 {{ machine?.app || '--' }}</span>
<span class="text-slate-300">·</span>
<span class="hover:text-slate-900 transition-colors">浏览器 {{ machine?.browsers ?? 0 }}</span>
<span class="text-slate-300">·</span>
<span class="flex items-center gap-1.5 text-slate-800 font-medium font-sans">
<span class="w-1.5 h-1.5 rounded-full bg-[#10B981] pulse-indicator"></span>
          压力{{ machine?.pressure || '等待主进程' }}
        </span>
</div>
</div>
<!-- 右侧全局导航胶囊栏 -->
<div class="flex items-center gap-4">
<nav class="flex items-center gap-1 p-1 rounded-full bg-slate-100 border border-slate-200/80">
<a href="#" @click.prevent="go('home')" class="px-3.5 py-1 rounded-full text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-white active:scale-95 transition-all duration-150">工作台</a>
<a href="#" @click.prevent="go('bank')" class="px-3.5 py-1 rounded-full text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-white active:scale-95 transition-all duration-150">题库</a>
<!-- 当前激活：学生账号 -->
<a @click.prevent="go('accounts')" aria-current="page" class="px-3.5 py-1 rounded-full text-xs font-semibold bg-[#4F46E5] text-white shadow-sm active:scale-95 transition-all duration-150" href="#">学生账号</a>
<a href="#" @click.prevent="go('settings')" class="px-3.5 py-1 rounded-full text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-white active:scale-95 transition-all duration-150">设置</a>
</nav>
</div>
</header>
<!-- 页面主体容器 (无任何渐变纯色系统 #F8FAFC) -->
<main class="w-full pt-16 flex-1 flex flex-col justify-between bg-[#F8FAFC]">
<div class="w-full max-w-[1440px] mx-auto px-8 py-7 flex flex-col gap-6">
<!-- 顶部标题与操作区 (anim-fade-up) -->
<div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pt-1 anim-fade-up">
<div class="flex items-center gap-3">
<div class="flex items-center gap-2.5">
<span class="w-2.5 h-2.5 rounded-full bg-[#4F46E5] ring-4 ring-[#EEF2FF] animate-pulse"></span>
<h1 class="text-xl font-bold tracking-tight text-slate-900">学生账号管理</h1>
</div>
<div class="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white border border-slate-200 text-xs font-mono text-slate-600 shadow-sm hover:border-indigo-200 transition-colors">
<span class="w-1.5 h-1.5 rounded-full bg-[#4F46E5]"></span>
<span class="">已注册 {{ accounts.length }} 名学员</span>
</div>
</div>
<!-- 搜索输入框交互强化 -->
<div class="flex flex-1 max-w-md mx-0 lg:mx-4 relative items-center group">
<span class="material-symbols-outlined absolute left-3.5 text-[18px] text-slate-400 group-hover:text-slate-600 group-focus-within:text-[#4F46E5] transition-colors duration-200">search</span>
<input v-model="query" class="w-full pl-10 pr-9 py-1.5 rounded-full bg-white text-slate-900 placeholder:text-slate-400 text-xs border border-slate-200 shadow-sm focus:outline-none focus:border-[#4F46E5] focus:ring-2 focus:ring-[#EEF2FF] transition-all duration-200" placeholder="搜索姓名、学号、账号..." type="text"/>
<button class="absolute right-3 text-slate-300 hover:text-slate-600 hover:rotate-90 active:scale-90 transition-all duration-200 flex items-center justify-center" title="清空搜索" type="button" @click="clearQuery">
<span class="material-symbols-outlined text-[15px]">close</span>
</button>
</div>
<!-- 头部快捷操作按钮 -->
<div class="flex items-center gap-2.5 shrink-0">
<button class="rounded-full border border-red-200 px-3 py-2 text-xs font-medium text-red-600 disabled:opacity-40" type="button" :disabled="!accounts.length" @click="openDeleteAll">全部删除</button>
<button class="group flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-slate-200 hover:border-indigo-300 text-slate-700 shadow-sm hover:bg-slate-50 hover:-translate-y-0.5 active:scale-95 transition-all duration-200 text-xs font-medium" type="button" @click="importExcel">
<span class="material-symbols-outlined text-[17px] text-[#4F46E5] transition-transform duration-200 group-hover:-translate-y-0.5">upload_file</span>
<span class="">导入 Excel 批量名单</span>
</button>
<button class="group flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-50 text-[#4F46E5] border border-indigo-100 hover:bg-indigo-100 text-xs font-medium" type="button" @click="openPaste"><span class="material-symbols-outlined text-[17px]">content_paste</span><span>粘贴批量导入</span></button>
<button class="group flex items-center gap-2 px-4 py-2 rounded-full bg-[#4F46E5] text-white hover:bg-[#4338CA] shadow-sm hover:shadow-md hover:-translate-y-0.5 active:scale-95 transition-all duration-200 text-xs font-medium" type="button" @click="focusAdd"><span class="material-symbols-outlined text-[17px] text-white transition-transform duration-300 group-hover:rotate-90">add</span><span>+ 新增学员</span></button>
</div>
</div>
<!-- 搜索栏与筛选胶囊群 (anim-fade-up anim-delay-1) -->
<div v-if="formatError" class="px-3 py-2 rounded-xl bg-red-50 border border-red-100 text-xs text-red-600">{{ formatError }}</div><div class="w-full flex items-center justify-between gap-3 p-1.5 bg-white rounded-xl border border-slate-200/80 shadow-[0_1px_3px_rgba(0,0,0,0.02)] anim-fade-up anim-delay-1">
<div class="flex items-center gap-1.5 overflow-x-auto">
<button :class="filter === 'all' ? 'bg-[#4F46E5] text-white' : 'bg-slate-100 text-slate-600'" class="px-3.5 py-1.5 rounded-lg text-xs font-medium shadow-sm whitespace-nowrap active:scale-95 transition-all duration-150" type="button" @click="selectFilter('all')">全部学员 ({{ accounts.length }})</button>
<button :class="filter === 'running' ? 'bg-[#4F46E5] text-white' : 'bg-slate-100 text-slate-600'" class="px-3.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap active:scale-95 transition-all duration-150" type="button" @click="selectFilter('running')">当前绑定执行中 ({{ runningCount }})</button>
<button :class="filter === 'queued' ? 'bg-[#4F46E5] text-white' : 'bg-slate-100 text-slate-600'" class="px-3.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap active:scale-95 transition-all duration-150" type="button" @click="selectFilter('queued')">排队就绪待命 ({{ queuedCount }})</button>
</div>
<span class="text-[11px] text-slate-400 pr-2 hidden sm:inline-flex items-center gap-1.5 font-mono select-none">
<span class="w-1.5 h-1.5 rounded-full bg-[#10B981] pulse-indicator"></span> 自动任务队列运转正常
</span>
</div>
<!-- 学生账号桌面端三列显示 -->
<div id="accounts-grid" class="grid grid-cols-1 gap-5 md:grid-cols-3">
<div v-for="(account, index) in filteredAccounts" :key="account.local_id" class="group relative flex flex-col justify-between p-6 rounded-2xl bg-white border border-slate-200 shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:shadow-lg hover:border-indigo-200 hover:-translate-y-1 transition-all duration-200 anim-fade-up">
<div class="flex flex-col gap-4">
<div class="flex items-start justify-between gap-3">
<div class="flex items-center gap-3 min-w-0">
<div class="w-11 h-11 rounded-full bg-[#4F46E5] text-white flex items-center justify-center text-base font-semibold shadow-sm shrink-0">{{ initials(account.name) }}</div>
<div class="flex flex-col min-w-0">
<div class="flex items-center gap-2 min-w-0">
<span class="text-sm font-bold text-slate-900 truncate">{{ account.name }}</span>
<span v-if="liveById.get(account.local_id)?.verified" class="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700" aria-label="已授权">已授权</span>
<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-mono text-[10px] tracking-wide truncate">{{ liveLabel(account.local_id) }}</span>
</div>
<span class="font-mono text-xs text-slate-400 tracking-wider">{{ account.account }}</span>
</div>
</div>
<div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 border border-slate-200 text-slate-600 text-xs font-medium shrink-0">{{ liveById.get(account.local_id)?.account || 'idle' }}</div>
</div>
<div class="p-3.5 rounded-xl bg-slate-50 border border-slate-100 flex flex-col gap-2 text-xs">
<div class="flex items-center justify-between text-slate-500"><span>绑定题库</span><span class="text-slate-900 font-medium">{{ liveById.get(account.local_id)?.courses.length || 0 }} 门</span></div>
<div class="flex items-center justify-between text-slate-500"><span>当前动作</span><span class="text-slate-900 font-mono truncate ml-3">{{ liveById.get(account.local_id)?.action || '等待运行' }}</span></div>
</div>
<div class="flex flex-col gap-1.5"><div class="flex justify-between font-mono text-xs text-slate-500"><span>{{ courseProgress(account.local_id).done }}/{{ courseProgress(account.local_id).total }} 门完结</span><span class="text-[#4F46E5] font-semibold">{{ courseProgress(account.local_id).percent }}%</span></div><div class="w-full h-1.5 rounded-full bg-slate-100 overflow-hidden"><div class="h-full bg-[#4F46E5] rounded-full progress-bar-fill" :style="{ width: courseProgress(account.local_id).percent + '%' }"></div></div></div>
</div>
<div v-if="editId === account.local_id" class="mt-3 p-3 rounded-xl bg-indigo-50/50 border border-indigo-100 flex flex-col gap-2"><div class="grid grid-cols-2 gap-2"><input v-model="editName" class="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#EEF2FF] focus:border-[#4F46E5]" placeholder="姓名" type="text"/><input v-model="editPassword" class="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#EEF2FF] focus:border-[#4F46E5]" placeholder="新密码（留空保持）" type="password"/></div><div class="flex justify-end gap-2"><button class="px-3 py-1 rounded-lg bg-white border border-slate-200 text-xs text-slate-600" type="button" @click="cancelEdit">取消</button><button class="px-3 py-1 rounded-lg bg-[#4F46E5] text-white text-xs" type="button" @click="saveEdit">保存</button></div></div>
<div class="pt-4 mt-3 border-t border-slate-100 flex items-center justify-between"><button class="flex items-center gap-1 text-slate-600 hover:text-[#4F46E5] text-xs font-medium active:scale-95" type="button" @click="selectCurrent(account.local_id)"><span class="material-symbols-outlined text-[16px]">open_in_new</span><span>查看工作台</span></button><button class="flex items-center gap-1 text-slate-600 hover:text-[#4F46E5] text-xs font-medium active:scale-95" type="button" @click="beginEdit(account)"><span class="material-symbols-outlined text-[16px]">edit</span><span>编辑</span></button><div class="flex items-center gap-2"><button v-if="selectedStudentId !== account.local_id" class="px-3.5 py-1 rounded-full bg-[#4F46E5] text-white text-xs font-medium shadow-sm" type="button" @click="selectCurrent(account.local_id)">切换当前</button><button class="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 active:scale-90" @click="remove(index)" title="删除账号" type="button"><span class="material-symbols-outlined text-[16px]">delete</span></button></div></div>
</div>
<div v-if="!filteredAccounts.length" class="p-10 rounded-2xl bg-white border border-dashed border-slate-300 text-left text-sm text-slate-400">{{ accounts.length ? '没有符合当前筛选条件的学生账号' : '尚未添加学生账号' }}</div>
<!-- 卡片 3：手工添加模块 & Excel 导入区 (anim-fade-up anim-delay-4) -->
<div class="relative flex flex-col justify-between p-5 rounded-2xl bg-white border border-slate-200 shadow-[0_2px_8px_rgba(0,0,0,0.03)] hover:shadow-lg hover:border-slate-300 transition-all duration-200 anim-fade-up anim-delay-4">
<div class="flex flex-col gap-2.5">
<div class="flex items-center justify-between pb-1.5 border-b border-slate-100">
<div class="flex items-center gap-2">
<span class="material-symbols-outlined text-[17px] text-[#4F46E5]">person_add</span>
<span class="text-xs font-bold text-slate-900">手工录入学员</span>
</div>
<span class="text-[10px] text-slate-400 font-mono">MANUAL INPUT</span>
</div>
<div class="grid grid-cols-3 gap-2">
<div class="flex flex-col gap-1">
<label class="text-[11px] font-medium text-slate-600">姓名</label>
<input v-model="newName" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#EEF2FF] focus:border-[#4F46E5] focus:bg-white transition-all duration-200" placeholder="如 张明" type="text"/>
</div>
<div class="flex flex-col gap-1">
<label class="text-[11px] font-medium text-slate-600">学号 / 账号</label>
<input v-model="newAccount" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-900 font-mono focus:outline-none focus:ring-2 focus:ring-[#EEF2FF] focus:border-[#4F46E5] focus:bg-white transition-all duration-200" placeholder="如 20240101" type="text"/>
</div>
<div class="flex flex-col gap-1">
<label class="text-[11px] font-medium text-slate-600">登录密码</label>
<input v-model="newPassword" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#EEF2FF] focus:border-[#4F46E5] focus:bg-white transition-all duration-200" placeholder="••••••••" type="password"/>
</div>
</div>
<div class="flex items-center justify-between pt-0.5">
<div class="flex items-center gap-1.5 text-[11px] text-emerald-600">
<span class="material-symbols-outlined text-[14px]">check_circle</span>
<span class="">信息校验合格，可直接保存</span>
</div>
<button class="px-3.5 py-1 rounded-lg bg-[#4F46E5] text-white hover:bg-[#4338CA] hover:shadow hover:-translate-y-0.5 active:scale-95 text-xs font-medium transition-all duration-150 shadow-sm" type="button" @click="addAccount">保存并添加</button>
</div>
</div>
<div class="mt-3 pt-3 border-t border-slate-100 flex flex-col gap-2">
<!-- Excel 拖拽区交互提升 -->
<div class="border-2 border-dashed border-indigo-200 hover:border-[#4F46E5] hover:bg-[#EEF2FF]/40 rounded-xl p-3 flex flex-col items-center justify-center text-center bg-slate-50/50 transition-all duration-200 cursor-pointer group active:scale-[0.99]" @click="onExcel">
<div class="flex items-center gap-2 mb-1">
<span class="material-symbols-outlined text-[20px] text-[#4F46E5] group-hover:scale-110 group-hover:-translate-y-0.5 transition-transform duration-200">cloud_upload</span>
<span class="text-xs font-semibold text-slate-800 group-hover:text-[#4F46E5] transition-colors">批量导入 Excel / CSV</span>
</div>
<p class="text-[11px] text-slate-500 leading-snug">拖拽包含【姓名、学号、密码】三列标准 .xlsx / .csv 文件至此</p>
</div>
<div class="flex items-start gap-1.5 p-2 rounded-lg bg-slate-50 border border-slate-200 text-[10px] text-slate-500 leading-normal">
<span class="material-symbols-outlined text-[13px] text-amber-500 shrink-0 mt-0.5">warning</span>
<span class="">导入规范：跳过表头，缺列或空文件提示格式错误。</span>
</div>
</div>
</div>
</div>
<!-- 底部三张纯色系统特性说明卡片 (纯紫、纯蓝、纯青) (anim-fade-up anim-delay-5) -->
<div class="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1 anim-fade-up anim-delay-5">
<div class="p-4 rounded-xl bg-white border border-slate-200/80 shadow-[0_1px_3px_rgba(0,0,0,0.02)] flex items-start gap-3 hover:-translate-y-1 hover:border-indigo-200 hover:shadow-md transition-all duration-200 cursor-default">
<div class="w-8 h-8 rounded-lg bg-[#EEF2FF] border border-indigo-100 flex items-center justify-center shrink-0 text-[#4F46E5] transition-transform duration-200 group-hover:scale-105">
<span class="material-symbols-outlined text-[18px]">lock</span>
</div>
<div class="flex flex-col">
<span class="text-xs font-semibold text-slate-900">本地沙箱隔离</span>
<p class="text-[11px] text-slate-500 mt-0.5 leading-relaxed">密码仅存本地沙箱环境并采用对称加密存储，绝不上报云端。</p>
</div>
</div>
<div class="p-4 rounded-xl bg-white border border-slate-200/80 shadow-[0_1px_3px_rgba(0,0,0,0.02)] flex items-start gap-3 hover:-translate-y-1 hover:border-blue-200 hover:shadow-md transition-all duration-200 cursor-default">
<div class="w-8 h-8 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0 text-[#2563EB] transition-transform duration-200 group-hover:scale-105">
<span class="material-symbols-outlined text-[18px]">sync_saved_locally</span>
</div>
<div class="flex flex-col">
<span class="text-xs font-semibold text-slate-900">实时状态同步</span>
<p class="text-[11px] text-slate-500 mt-0.5 leading-relaxed">账号、浏览器名额和任务状态由主进程快照实时推送到界面。</p>
</div>
</div>
<div class="p-4 rounded-xl bg-white border border-slate-200/80 shadow-[0_1px_3px_rgba(0,0,0,0.02)] flex items-start gap-3 hover:-translate-y-1 hover:border-emerald-200 hover:shadow-md transition-all duration-200 cursor-default">
<div class="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center shrink-0 text-[#10B981] transition-transform duration-200 group-hover:scale-105">
<span class="material-symbols-outlined text-[18px]">swap_calls</span>
</div>
<div class="flex flex-col">
<span class="text-xs font-semibold text-slate-900">浏览器名额调度</span>
<p class="text-[11px] text-slate-500 mt-0.5 leading-relaxed">每个学生独立占用浏览器上下文，排队和验证状态不会抢占名额。</p>
</div>
</div>
</div>
</div>
<!-- 底部状态行规范 -->
<footer class="w-full border-t border-slate-200/80 bg-white py-3 mt-4">
<div class="w-full max-w-[1440px] mx-auto px-8 flex flex-col sm:flex-row items-center justify-between text-[11px] font-mono text-slate-500 gap-2">
<div class="flex items-center gap-2">
<span class="hover:text-slate-700 transition-colors">DESKTOP RUNTIME</span>
<span class="text-slate-300">/</span>
<span class="hover:text-slate-700 transition-colors">STUDENT PROFILE STORAGE: ENCRYPTED</span>
</div>
<div class="flex items-center gap-4">
<span class="flex items-center gap-1.5">
<span class="w-1.5 h-1.5 rounded-full bg-[#10B981] pulse-indicator"></span>
<span class="hover:text-slate-700 transition-colors">MULTI-INSTANCE READY</span>
</span>
<span class="text-slate-300">/</span>
<span class="hover:text-slate-700 transition-colors">实时快照已接入</span>
</div>
</div>
</footer>
</main>
<input ref="excelInput" type="file" accept=".xlsx,.xls,.csv" class="hidden" @change="onExcel" />
  </div>
<div v-if="deleteAllIds.length" class="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/55 p-6">
<section class="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-label="确认全部删除学生账号">
<h2 class="text-lg font-bold">确认全部删除 {{ deleteAllIds.length }} 名学生？</h2>
<p class="mt-2 text-sm text-slate-600">将先停止正在运行和排队的学生，再删除全部学生账号；题库不受影响。</p>
<div class="mt-5 flex justify-end gap-2"><button type="button" class="rounded-full border px-4 py-2 text-sm" :disabled="deletingAll" @click="deleteAllIds = []">取消</button><button type="button" class="rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="deletingAll" @click="confirmDeleteAll">确认全部删除</button></div>
</section>
</div>
<div v-if="pasteOpen" class="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/45 p-6" @click.self="pasteOpen = false">
<section class="w-full max-w-4xl rounded-2xl bg-white p-6 shadow-2xl">
<div class="flex items-center justify-between"><h2 class="text-lg font-bold">复制粘贴批量导入</h2><button type="button" aria-label="关闭批量导入" @click="pasteOpen = false">×</button></div>
<textarea v-model="pasteText" class="mt-4 h-32 w-full rounded-xl border border-slate-200 p-3 text-sm" placeholder="每行：姓名 账号 密码；支持 Tab、逗号、中文逗号或空格"></textarea>
<div class="mt-3 flex justify-end gap-2"><button type="button" class="rounded-full border px-4 py-2 text-sm" :disabled="pasteBusy" @click="parsePaste">解析预览</button></div>
<div v-if="pasteRows.length" class="mt-4 max-h-56 overflow-auto rounded-xl border border-slate-200"><table class="w-full text-left text-sm"><thead><tr class="bg-slate-50"><th class="p-2">姓名</th><th class="p-2">账号</th><th class="p-2">密码</th></tr></thead><tbody><tr v-for="row in pasteRows" :key="row.username" class="border-t"><td class="p-2">{{ row.name }}</td><td class="p-2">{{ row.username }}</td><td class="p-2">{{ row.password }}</td></tr></tbody></table></div>
<div v-if="pasteRows.length" class="mt-3 text-xs font-semibold text-indigo-600">预计导入 {{ pasteRows.length }} 名学生</div>
<div v-if="pasteErrors.length" class="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-700">{{ pasteErrors.map((item) => `${item.line ? `第 ${item.line} 行：` : ''}${item.reason}`).join('；') }}</div>
<div class="mt-5 flex justify-end gap-2"><button type="button" class="rounded-full border px-4 py-2 text-sm" @click="pasteOpen = false">取消</button><button type="button" class="rounded-full bg-[#4F46E5] px-5 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="!pasteRows.length || pasteBusy" @click="openPasteConfirm">进入二级确认（{{ pasteRows.length }} 名）</button></div>
</section>
</div>
<div v-if="pasteConfirmOpen" class="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-6">
<section class="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl">
<h2 class="text-lg font-bold">确认写入学生账号</h2>
<p class="mt-1 text-sm text-slate-500">以下姓名、账号和密码将明文写入现有加密账号存储。</p>
<div class="mt-4 max-h-56 overflow-auto rounded-xl border border-slate-200"><table class="w-full text-left text-sm"><thead><tr class="bg-slate-50"><th class="p-2">姓名</th><th class="p-2">账号</th><th class="p-2">密码</th></tr></thead><tbody><tr v-for="row in pasteRows" :key="`confirm-${row.username}`" class="border-t"><td class="p-2">{{ row.name }}</td><td class="p-2">{{ row.username }}</td><td class="p-2">{{ row.password }}</td></tr></tbody></table></div>
<div class="mt-5 flex justify-end gap-2"><button type="button" class="rounded-full border px-4 py-2 text-sm" @click="pasteConfirmOpen = false">取消导入</button><button type="button" class="rounded-full bg-[#4F46E5] px-5 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="pasteBusy" @click="confirmPaste">确认写入 {{ pasteRows.length }} 名</button></div>
</section>
</div>
</template>
