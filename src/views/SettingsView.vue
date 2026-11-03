<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { PageId } from '../types/shell'
import { useKaida } from '../useKaida'
import { connectivitySummary as summarizeConnectivity } from '../../electron/core/connectivity'
import { version as appVersion } from '../../package.json'

const emit = defineEmits<{ go: [PageId] }>()
function go(id: PageId) {
  // TODO(ui-shell) 仅壳内切页
  emit('go', id)
}

const siliconKey = ref('')
const supabaseUrl = ref('')
const anonKey = ref('')
const accountN = ref(2)
const courseN = ref(2)
const browserOn = ref(false)
const logOn = ref(true)
const saved = ref(true)
const encryptFail = ref('')
const validateFail = ref('')
const testing = ref(false)
const connectivityOpen = ref(false)
const connectivitySummary = ref('等待检测')
const connectivityTestedAt = ref('')
type ConnectivityRow = { model: string; ok: boolean; status: string; elapsedMs: number; reason?: string; httpStatus?: number }
const connectivityResults = ref<ConnectivityRow[]>([])
const retestingModel = ref('')
const statusText = ref('已加载本机配置')
const updateText = ref('')
const siliconVisible = ref(false)
const anonVisible = ref(false)
const { snap } = useKaida()
const machine = computed(() => snap.value?.machine || { cpu: '--', memory: '--', app: '--', browsers: 0, pressure: '等待主进程', recommendedAccount: 1, recommendedCourse: 1, browserAverage: '--', recommendationSampled: false })
const running = computed(() => Boolean(snap.value?.running))
const aboveRecommendation = computed(() => accountN.value > machine.value.recommendedAccount || courseN.value > machine.value.recommendedCourse)

function clamp(n: number) {
  return Math.min(8, Math.max(1, n))
}
function decAccount() {
  accountN.value = clamp(accountN.value - 1)
}
function incAccount() {
  accountN.value = clamp(accountN.value + 1)
}
function decCourse() {
  courseN.value = clamp(courseN.value - 1)
}
function incCourse() {
  courseN.value = clamp(courseN.value + 1)
}
async function save() {
  if (accountN.value < 1 || courseN.value < 1) {
    saved.value = false
    encryptFail.value = ''
    validateFail.value = '并行至少为 1'
    return
  }
  validateFail.value = ''
  statusText.value = '正在保存'
  const r = await window.kaida?.saveSettings({
    siliconflow_key: siliconKey.value,
    account_parallel: accountN.value,
    course_parallel: courseN.value,
    browser_visible_default: browserOn.value,
    log_enabled: logOn.value,
  })
  if (r && !r.ok) {
    saved.value = false
    encryptFail.value = r.error || '加密不可用，拒绝写明文'
    statusText.value = '保存失败'
    return
  }
  encryptFail.value = ''
  saved.value = true
  statusText.value = '已保存最新配置'
}
function restore() {
  accountN.value = 2
  courseN.value = 2
  browserOn.value = false
  logOn.value = true
  siliconKey.value = ''
  saved.value = true
  statusText.value = '已恢复默认值，等待保存'
}
async function testConn() {
  testing.value = true
  connectivityOpen.value = true
  statusText.value = '正在逐个检测 AI 模型'
  const r = await window.kaida?.testConnectivity()
  testing.value = false
  connectivityResults.value = r?.results || []
  connectivitySummary.value = r?.summary || '检测失败'
  connectivityTestedAt.value = r?.testedAt || ''
  validateFail.value = r?.results?.length ? '' : '未取得模型检测结果'
  statusText.value = connectivitySummary.value
}
async function checkUpdates() {
  updateText.value = '正在检查更新…'
  const result = await window.kaida?.checkForUpdates()
  updateText.value = result?.phase === 'available' ? `发现新版本 ${result.version}` : (result?.message || (result?.phase === 'error' ? '更新检查失败' : '当前已是最新版本'))
}

async function retestModel(model: string) {
  if (retestingModel.value) return
  retestingModel.value = model
  const r = await window.kaida?.testConnectivityModel(model)
  const next = r?.results?.[0]
  if (next) {
    connectivityResults.value = connectivityResults.value.map((item) => item.model === model ? next : item)
    connectivitySummary.value = summarizeConnectivity(connectivityResults.value)
    connectivityTestedAt.value = r?.testedAt || connectivityTestedAt.value
  }
  retestingModel.value = ''
}

function applyConnectivityProgress(payload: unknown) {
  const data = payload as { results?: ConnectivityRow[]; targetModel?: string }
  if (!Array.isArray(data.results)) return
  if (!data.targetModel) {
    connectivityResults.value = data.results
    return
  }
  const next = data.results[0]
  if (next) connectivityResults.value = connectivityResults.value.map((item) => item.model === data.targetModel ? next : item)
}

function applySettings(payload: unknown) {
  const s = payload as Record<string, unknown>
  accountN.value = Number(s.account_parallel || accountN.value)
  courseN.value = Number(s.course_parallel || courseN.value)
  browserOn.value = Boolean(s.browser_visible_default)
  logOn.value = s.log_enabled !== false
}

async function copyValue(value: string) {
  if (value && value !== '********') await navigator.clipboard?.writeText(value)
}

let offConnectivity: (() => void) | undefined
let offSettings: (() => void) | undefined
onMounted(async () => {
  offConnectivity = window.kaida?.onConnectivityProgress(applyConnectivityProgress)
  offSettings = window.kaida?.onSettingsChanged(applySettings)
  const s = await window.kaida?.getSettings()
  if (!s) return
  applySettings(s)
  statusText.value = '已加载本机配置'
})
onUnmounted(() => {
  offConnectivity?.()
  offSettings?.()
})
</script>

<template>
  <div class="bg-[#F8FAFC] font-body text-slate-800 antialiased selection:bg-[#4F46E5] selection:text-white min-h-screen relative overflow-x-hidden">
<!-- Header Chrome -->
<header class="fixed top-0 left-0 right-0 z-50 bg-white border-b border-slate-200/90 shadow-sm anim-fade-down"><div class="h-16 w-full max-w-[1440px] mx-auto px-8 flex items-center justify-between"><div class="flex items-center gap-6"><div class="flex items-center gap-3"><span class="w-2.5 h-2.5 rounded-full bg-[#4F46E5] ring-4 ring-indigo-100"></span><span class="text-base text-slate-900 tracking-tight font-bold select-none">开大自动答题桌面端</span></div><div class="hidden xl:flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-slate-50 text-slate-600 font-mono text-xs border border-slate-200 select-none"><span class="">CPU {{ machine.cpu }}</span><span class="text-slate-300">·</span><span class="">内存 {{ machine.memory }}</span><span class="text-slate-300">·</span><span class="">本软件 {{ machine.app }}</span><span class="text-slate-300">·</span><span class="">浏览器 {{ machine.browsers }}</span><span class="text-slate-300">·</span><span class="flex items-center gap-1.5 text-slate-900 font-semibold"><span class="w-1.5 h-1.5 rounded-full bg-[#4F46E5]"></span>{{ machine.pressure }}</span></div></div><nav class="flex items-center gap-1 p-1 bg-slate-100 rounded-full border border-slate-200"><a href="#" @click.prevent="go('home')" class="px-5 py-1.5 rounded-full text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200/50 transition-all duration-200" data-path="workbench">工作台</a><a href="#" @click.prevent="go('bank')" class="px-5 py-1.5 rounded-full text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200/50 transition-all duration-200" data-path="question-bank">题库</a><a href="#" @click.prevent="go('accounts')" class="px-5 py-1.5 rounded-full text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200/50 transition-all duration-200" data-path="students">学生账号</a><a @click.prevent="go('settings')" aria-current="page" class="px-5 py-1.5 rounded-full transition-all duration-200 bg-[#4F46E5] text-white text-xs shadow-sm font-bold shadow-indigo-500/20" data-path="settings" href="#">设置</a></nav></div></header>
<main class="relative z-10 w-full pt-16 min-h-screen"><div class="flex flex-col w-full">
<!-- Main Content Area (Retaining only Connection Configuration & Runtime Defaults) -->
<div class="w-full max-w-[1140px] mx-auto px-8 py-7 flex flex-col gap-6"><div class="bg-white px-7 py-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 anim-fade-up hover:shadow-md transition-all duration-300"><div class="flex items-center gap-4"><div class="w-11 h-11 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[#4F46E5] shadow-sm"><span class="material-symbols-outlined text-[24px]">tune</span></div><div><div class="flex items-center gap-2.5"><h1 class="text-[18px] font-bold text-slate-900 tracking-tight leading-none">系统偏好设置</h1><span data-settings-version class="px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-indigo-50 text-[#4F46E5] border border-indigo-100" :aria-label="`当前版本 ${appVersion}`">v{{ appVersion }}</span></div><p class="text-xs text-slate-500 mt-1 font-mono">System Configuration &amp; Orchestration Console</p></div></div><div class="flex items-center gap-3"><div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200"><span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 ring-4 ring-emerald-100"></span></span><span class="font-mono font-semibold">服务状态：{{ statusText }}</span></div><button @click="testConn" class="group-test-btn inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-slate-50 hover:bg-slate-100/80 hover:border-slate-300 text-slate-700 text-xs font-semibold border border-slate-200 shadow-sm transition-all duration-200 active:scale-95" type="button"><span class="icon-jiggle material-symbols-outlined text-[16px] text-slate-500 transition-transform">electrical_services</span><span>连通性测试</span></button></div></div><div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"><div class="lg:col-span-7 flex flex-col gap-6"><div class="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col overflow-hidden anim-fade-up-delay-1 hover:shadow-md transition-all duration-300"><div class="px-6 py-4 border-b border-slate-100 bg-slate-50/70 flex items-center justify-between"><div class="flex items-center gap-2.5"><div class="w-7 h-7 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[#4F46E5]"><span class="material-symbols-outlined text-[18px]">hub</span></div><div><span class="text-xs font-bold text-slate-900 tracking-wide block">云端与接口连接</span><span class="text-[10px] text-slate-400 font-mono">CREDENTIALS &amp; ENDPOINTS</span></div></div><span class="font-mono text-[11px] text-emerald-600 font-semibold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">AES-256 加密</span></div><div class="p-6 flex flex-col gap-5"><div class="flex flex-col gap-1.5"><div class="flex items-center justify-between"><label class="text-xs font-bold text-slate-700 flex items-center gap-1.5" for="siliconflow-key"><span class="material-symbols-outlined text-[16px] text-[#4F46E5]">psychology</span><span>硅基流动 API Key</span></label><span class="text-[11px] font-mono text-slate-400">DeepSeek / 满血模型调用凭据</span></div><div class="relative flex items-center rounded-xl transition-all duration-200 focus-within:ring-2 focus-within:ring-indigo-100 focus-within:border-indigo-500"><input class="w-full h-10 pl-3.5 pr-20 rounded-xl bg-slate-50/80 border border-slate-200 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-indigo-500 transition-all duration-200" v-model="siliconKey" autocomplete="off" id="siliconflow-key" placeholder="留空表示保持已保存 Key" :type="siliconVisible ? 'text' : 'password'"/><div class="absolute right-1.5 flex items-center gap-0.5"><button class="text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 p-1.5 rounded-md transition-all active:scale-90" title="复制" @click="copyValue(siliconKey)" type="button"><span class="material-symbols-outlined text-[16px]">content_copy</span></button><button class="text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 p-1.5 rounded-md transition-all active:scale-90" title="显隐" @click="siliconVisible = !siliconVisible" type="button"><span class="material-symbols-outlined text-[17px]">{{ siliconVisible ? 'visibility_off' : 'visibility' }}</span></button></div></div></div><div class="flex flex-col gap-1.5"><div class="flex items-center justify-between"><label class="text-xs font-bold text-slate-700 flex items-center gap-1.5" for="supabase-url"><span class="material-symbols-outlined text-[16px] text-[#4F46E5]">cloud_done</span><span>Supabase Project URL</span></label><span class="text-[11px] font-mono text-slate-400">题库与同步数据终端</span></div><div class="relative flex items-center rounded-xl transition-all duration-200 focus-within:ring-2 focus-within:ring-indigo-100 focus-within:border-indigo-500"><input class="w-full h-10 pl-3.5 pr-12 rounded-xl bg-slate-50/80 border border-slate-200 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-indigo-500 transition-all duration-200" v-model="supabaseUrl" autocomplete="off" id="supabase-url" placeholder="https://xxxx.supabase.co" type="text"/><div class="absolute right-2 text-emerald-600 flex items-center"><span class="material-symbols-outlined text-[18px]">check_circle</span></div></div></div><div class="flex flex-col gap-1.5"><div class="flex items-center justify-between"><label class="text-xs font-bold text-slate-700 flex items-center gap-1.5" for="supabase-anon"><span class="material-symbols-outlined text-[16px] text-[#4F46E5]">key</span><span>Supabase Anon Public Key</span></label><span class="text-[11px] font-mono text-slate-400">客户端安全交互鉴权</span></div><div class="relative flex items-center rounded-xl transition-all duration-200 focus-within:ring-2 focus-within:ring-indigo-100 focus-within:border-indigo-500"><input class="w-full h-10 pl-3.5 pr-20 rounded-xl bg-slate-50/80 border border-slate-200 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-indigo-500 transition-all duration-200" v-model="anonKey" autocomplete="off" id="supabase-anon" placeholder="留空表示保持已保存 Key" :type="anonVisible ? 'text' : 'password'"/><div class="absolute right-1.5 flex items-center gap-0.5"><button class="text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 p-1.5 rounded-md transition-all active:scale-90" title="复制" @click="copyValue(anonKey)" type="button"><span class="material-symbols-outlined text-[16px]">content_copy</span></button><button class="text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 p-1.5 rounded-md transition-all active:scale-90" title="显隐" @click="anonVisible = !anonVisible" type="button"><span class="material-symbols-outlined text-[17px]">{{ anonVisible ? 'visibility_off' : 'visibility' }}</span></button></div></div></div></div><div class="px-6 py-3 bg-slate-50/70 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500"><div class="flex items-center gap-2"><span class="material-symbols-outlined text-[16px] text-slate-400">lock</span><span>所有安全令牌均注入系统安全密钥区</span></div><span class="font-mono text-[11px] text-slate-400">TLS 1.3 / mTLS</span></div></div><div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col anim-fade-up-delay-3 hover:shadow-md transition-all duration-300"><div class="px-6 py-4 border-b border-slate-100 bg-slate-50/70 flex items-center justify-between"><div class="flex items-center gap-2.5"><div class="w-7 h-7 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[#4F46E5]"><span class="material-symbols-outlined text-[18px]">terminal</span></div><div><span class="text-xs font-bold text-slate-900 tracking-wide block">运行环境与调试</span><span class="text-[10px] text-slate-400 font-mono">RUNTIME &amp; ENVIRONMENT</span></div></div><span class="font-mono text-[11px] text-slate-400 font-medium">DEBUG</span></div><div class="p-5 flex flex-col gap-3"><div class="flex items-center justify-between p-3 rounded-xl bg-slate-50/60 border border-slate-200 hover:bg-slate-50 transition-colors"><div class="flex items-center gap-3"><div class="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-600"><span class="material-symbols-outlined text-[18px]">visibility</span></div><div class="flex flex-col"><span class="text-xs font-bold text-slate-800">显示浏览器窗口</span><span class="text-[11px] text-slate-400 mt-0.5">关闭则默认静默后台 Headless 运行</span></div></div><label class="relative inline-flex items-center cursor-pointer select-none shrink-0 group"><input class="sr-only peer" v-model="browserOn" id="browser-toggle" type="checkbox"/><div class="w-11 h-6 bg-slate-200 group-hover:bg-slate-300/80 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-5 peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all after:duration-300 after:shadow-sm peer-checked:bg-[#4F46E5] transition-colors duration-200"></div></label></div><div class="flex items-center justify-between p-3 rounded-xl bg-slate-50/60 border border-slate-200 hover:bg-slate-50 transition-colors"><div class="flex items-center gap-3"><div class="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-[#4F46E5]"><span class="material-symbols-outlined text-[18px]">assignment</span></div><div class="flex flex-col"><span class="text-xs font-bold text-slate-800">详细运行日志</span><span class="text-[11px] text-slate-400 mt-0.5">实时记录模型研判与答题交互过程</span></div></div><label class="relative inline-flex items-center cursor-pointer select-none shrink-0 group"><input class="sr-only peer" v-model="logOn" id="log-toggle" type="checkbox"/><div class="w-11 h-6 bg-slate-200 group-hover:bg-slate-300/80 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-5 peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all after:duration-300 after:shadow-sm peer-checked:bg-[#4F46E5] transition-colors duration-200"></div></label></div></div></div></div><div class="lg:col-span-5 flex flex-col gap-6"><div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col anim-fade-up-delay-2 hover:shadow-md transition-all duration-300"><div class="px-6 py-4 border-b border-slate-100 bg-slate-50/70 flex items-center justify-between"><div class="flex items-center gap-2.5"><div class="w-7 h-7 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[#4F46E5]"><span class="material-symbols-outlined text-[18px]">speed</span></div><div><span class="text-xs font-bold text-slate-900 tracking-wide block">任务执行与并发控制</span><span class="text-[10px] text-slate-400 font-mono">EXECUTION &amp; WORKERS</span></div></div><span class="font-mono text-[11px] text-slate-400 font-medium">DYNAMIC</span></div><div class="p-6 flex flex-col gap-4"><p v-if="running" class="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">任务运行中，本轮并发配置已锁定</p><div class="grid grid-cols-2 gap-3.5"><div class="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 flex flex-col justify-between gap-3"><div class="flex items-center justify-between"><span class="text-xs font-bold text-slate-700">账号并发</span><span class="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-slate-200/70 text-slate-600">Max 8</span></div><div class="flex items-center justify-between bg-white rounded-xl p-1.5 border border-slate-200 shadow-sm"><button class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 hover:scale-105 text-slate-700 flex items-center justify-center font-bold text-sm transition-transform duration-150 active:scale-95 cursor-pointer select-none" type="button" :disabled="running" @click="decAccount()">-</button><div class="flex flex-col items-center leading-none"><input class="w-10 text-center font-mono text-base bg-transparent focus:outline-none text-[#4F46E5] font-bold pointer-events-none" :value="accountN" id="account-concurrency" readonly type="number"/><span class="text-[10px] text-slate-400 font-mono mt-0.5">线程</span></div><button class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 hover:scale-105 text-slate-700 flex items-center justify-center font-bold text-sm transition-transform duration-150 active:scale-95 cursor-pointer select-none" type="button" :disabled="running" @click="incAccount()">+</button></div><div class="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden"><div class="bg-[#4F46E5] h-1.5 rounded-full transition-all duration-300" :style="{ width: (accountN / 8) * 100 + '%' }"></div></div></div><div class="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 flex flex-col justify-between gap-3"><div class="flex items-center justify-between"><span class="text-xs font-bold text-slate-700">单账号课程并发</span><span class="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-slate-200/70 text-slate-600" data-course-cap="8">Max 8</span></div><div class="flex items-center justify-between bg-white rounded-xl p-1.5 border border-slate-200 shadow-sm"><button class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 hover:scale-105 text-slate-700 flex items-center justify-center font-bold text-sm transition-transform duration-150 active:scale-95 cursor-pointer select-none" type="button" :disabled="running" @click="decCourse()">-</button><div class="flex flex-col items-center leading-none"><input class="w-10 text-center font-mono text-base bg-transparent focus:outline-none text-[#4F46E5] font-bold pointer-events-none" :value="courseN" id="course-concurrency" readonly type="number"/><span class="text-[10px] text-slate-400 font-mono mt-0.5">任务</span></div><button class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 hover:scale-105 text-slate-700 flex items-center justify-center font-bold text-sm transition-transform duration-150 active:scale-95 cursor-pointer select-none" type="button" :disabled="running" @click="incCourse()">+</button></div><div class="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden"><div class="bg-[#4F46E5] h-1.5 rounded-full transition-all duration-300" :style="{ width: (courseN / 8) * 100 + '%' }"></div></div></div></div><div class="px-3.5 py-2.5 rounded-xl bg-slate-50/70 border border-slate-200/80"><div class="flex items-center justify-between gap-3"><span class="text-xs text-slate-600 font-medium">推荐：账号 {{ machine.recommendedAccount }} · 课程 {{ machine.recommendedCourse }}</span><span class="text-[11px] font-mono" :class="aboveRecommendation ? 'text-amber-600' : 'text-emerald-600'">{{ aboveRecommendation ? '当前配置高于建议' : '当前配置适合' }}</span></div><div class="text-[10px] text-slate-400 mt-1">浏览器均值 {{ machine.browserAverage }} · {{ machine.recommendationSampled ? '实际样本' : '保守估算' }}</div></div></div></div></div></div><div class="bg-white rounded-2xl border border-slate-200 shadow-sm px-7 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 anim-fade-up-delay-4 hover:shadow-md transition-all duration-300"><div class="flex items-center gap-2.5 text-slate-500 text-xs font-mono"><span class="w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-emerald-100 status-pulse-dot"></span><span>配置修改后本地实时热生效 · 无需重启桌面客户端</span></div><div class="flex items-center gap-3"><button class="h-9 px-4 rounded-full bg-slate-50 hover:bg-slate-100 text-slate-600 hover:text-slate-800 text-xs font-semibold border border-slate-200 shadow-sm transition-all duration-150 active:scale-95" type="button" :disabled="running" @click="restore">恢复默认</button><div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emerald-50 text-emerald-600 text-xs font-semibold border border-emerald-200 transition-all duration-300" id="save-hint"><span class="material-symbols-outlined text-[16px]">check_circle</span><span>已保存最新配置</span></div><button class="h-9 px-6 rounded-full bg-[#4F46E5] hover:bg-[#4338CA] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/25 text-white text-xs font-bold shadow-sm transition-all duration-200 active:translate-y-0 active:scale-[0.98] flex items-center gap-2" id="save-btn" :disabled="running" @click="save" type="button"><span class="material-symbols-outlined text-[16px]">save</span><span>保存并应用配置</span></button></div></div></div>

</div></main>
<button type="button" class="fixed bottom-5 left-5 z-[90] rounded-full border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-[#4F46E5] shadow-sm" @click="checkUpdates">检查更新 <span v-if="updateText" class="ml-1 text-slate-400">{{ updateText }}</span></button>
<div v-if="connectivityOpen" class="fixed inset-0 z-[80] bg-slate-900/35 backdrop-blur-[2px] flex items-center justify-center p-6" @click.self="connectivityOpen = false">
  <section class="w-full max-w-3xl max-h-[82vh] overflow-hidden rounded-2xl bg-white border border-slate-200 shadow-2xl">
    <div class="flex items-center justify-between px-6 py-4 border-b border-slate-100">
      <div><h2 class="text-base font-bold text-slate-900">AI 模型连通性测试</h2><p class="text-xs text-slate-500 mt-1">真实最小请求，最多并发 3 个，不改变答题降级顺序</p></div>
      <button type="button" class="w-8 h-8 rounded-full text-slate-400 hover:bg-slate-100" @click="connectivityOpen = false">×</button>
    </div>
    <div class="px-6 py-4 bg-indigo-50/70 border-b border-indigo-100 flex items-center justify-between">
      <span class="text-sm font-semibold text-[#4F46E5]">{{ connectivitySummary }}</span>
      <span class="text-xs text-slate-500">{{ connectivityTestedAt ? new Date(connectivityTestedAt).toLocaleString() : '检测中…' }}</span>
    </div>
    <div class="p-6 overflow-auto max-h-[60vh] grid grid-cols-1 md:grid-cols-2 gap-2">
      <div v-for="item in connectivityResults" :key="item.model" class="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50/60">
        <div class="min-w-0"><div class="font-mono text-xs text-slate-800 truncate">{{ item.model }}</div><div class="text-[11px] text-slate-500 mt-1">{{ item.reason || (item.status === 'queued' ? '排队' : item.status === 'running' ? '检测中' : item.ok ? '可用' : '失败') }}<template v-if="item.elapsedMs"> · {{ item.elapsedMs }}ms</template><template v-if="item.httpStatus"> · HTTP {{ item.httpStatus }}</template></div></div>
        <div class="flex items-center gap-2 shrink-0">
          <button v-if="item.status === 'failed'" type="button" class="text-[11px] px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50" :disabled="Boolean(retestingModel)" @click="retestModel(item.model)">{{ retestingModel === item.model ? '重测中' : '重新检测' }}</button>
          <span class="text-lg" :class="item.status === 'success' ? 'text-emerald-600' : item.status === 'failed' ? 'text-red-500' : 'text-indigo-500'">{{ item.status === 'success' ? '✓' : item.status === 'failed' ? '✕' : item.status === 'running' ? '…' : '○' }}</span>
        </div>
      </div>
      <div v-if="testing" class="col-span-full py-8 text-center text-sm text-slate-500">正在按受控并发检测模型…</div>
    </div>
  </section>
</div>
  </div>
</template>

<style scoped>
:global(div:has(> div > label[for="supabase-url"])),
:global(div:has(> div > label[for="supabase-anon"])) {
  display: none;
}
</style>
