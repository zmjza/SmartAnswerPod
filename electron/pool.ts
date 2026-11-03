import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { chromium, type BrowserContext, type Page } from 'patchright'
import { SlotPool } from './core/slot-pool.ts'
import { browserExecutablePath, headlessUserAgent } from './core/browser-mode.ts'
import { withTimeout } from './core/timeout.ts'
import { profileDir } from './store.ts'

type BrowserMode = 'headless' | 'visual'

type Held = {
  context: BrowserContext
  mode: BrowserMode
}

const held = new Map<string, Held>()
const browserMemorySamples = new Map<string, number>()
type PoolReleaseReason = 'released' | 'context_closed' | 'launch_failed'
type PoolReleaseEvent = { localId: string; reason: PoolReleaseReason }
const releaseListeners = new Set<(event: PoolReleaseEvent) => void>()
const closingReleases = new Map<string, Promise<boolean>>()
const releaseEpochs = new Map<string, number>()
const acquireChains = new Map<string, Promise<void>>()
const launchCleanupConfirmations = new Map<string, boolean>()
const closingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const execFileAsync = promisify(execFile)
export const slots = new SlotPool(2)
let nextWindowIndex = 0
const BROWSER_CLOSE_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.KAIDA_BROWSER_CLOSE_TIMEOUT_MS) || 30_000,
)
const BROWSER_FORCE_CLOSE_CONFIRM_MS = Math.max(
  100,
  Number(process.env.KAIDA_BROWSER_FORCE_CLOSE_CONFIRM_MS) || 5_000,
)
const CLOSING_RETRY_MS = Math.max(
  100,
  Number(process.env.KAIDA_BROWSER_CLOSING_RETRY_MS) || 5_000,
)
const CLOSING_RETRY_LIMIT = Math.max(
  1,
  Number(process.env.KAIDA_BROWSER_CLOSING_RETRY_LIMIT) || 24,
)

export function onPoolRelease(listener: (event: PoolReleaseEvent) => void): () => void {
  releaseListeners.add(listener)
  return () => releaseListeners.delete(listener)
}

function bumpReleaseEpoch(localId: string) {
  releaseEpochs.set(localId, (releaseEpochs.get(localId) || 0) + 1)
}

function currentReleaseEpoch(localId: string): number {
  return releaseEpochs.get(localId) || 0
}

function notifyPoolRelease(localId: string, reason: PoolReleaseReason) {
  for (const listener of releaseListeners) {
    try {
      listener({ localId, reason })
    } catch {
      // A scheduler listener must never prevent browser cleanup.
    }
  }
}

function contextBrowserPid(context: BrowserContext): number | undefined {
  try {
    const browser = (context as unknown as {
      browser?: () => { process?: () => { pid?: number } | null } | null
    }).browser?.()
    const pid = browser?.process?.()?.pid
    return Number.isInteger(pid) && Number(pid) > 0 ? Number(pid) : undefined
  } catch {
    return undefined
  }
}

async function profileProcessPids(userDataDir: string): Promise<number[]> {
  if (process.platform === 'win32') {
    const command = buildWindowsProfileProcessCommand(userDataDir)
    const { stdout } = await execFileAsync(
      'powershell.exe',
      command.args,
      command.options,
    )
    return stdout.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { timeout: 2_000 })
  const pids: number[] = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (match && match[2].includes(userDataDir)) pids.push(Number(match[1]))
  }
  return pids
}

export function buildWindowsProfileProcessCommand(userDataDir: string) {
  const script = [
    '$needle = $env:KAIDA_PROFILE_PATH',
    'Get-CimInstance Win32_Process |',
    '  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($needle) } |',
    '  Select-Object -ExpandProperty ProcessId',
  ].join(' ')
  return {
    script,
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    options: {
      timeout: 3_000,
      env: {
        ...process.env,
        KAIDA_PROFILE_PATH: userDataDir,
      },
    },
  }
}

function processPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminateBrowserProcess(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 5_000 })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* Confirmation below decides whether the physical capacity is safe. */
  }
}

async function forceCloseBrowserContext(
  context: BrowserContext,
  userDataDir: string,
): Promise<boolean> {
  const rootPid = contextBrowserPid(context)
  let profilePids: number[]
  try {
    profilePids = await profileProcessPids(userDataDir)
  } catch {
    return false
  }
  const pids = new Set(profilePids)
  if (rootPid) pids.add(rootPid)
  if (!pids.size) return false
  await Promise.all([...pids].map((pid) => terminateBrowserProcess(pid)))
  return await waitForBrowserProcessesGone(context, userDataDir)
}

async function waitForBrowserProcessesGone(
  context: BrowserContext | undefined,
  userDataDir: string,
): Promise<boolean> {
  const rootPid = context ? contextBrowserPid(context) : undefined
  const deadline = Date.now() + BROWSER_FORCE_CLOSE_CONFIRM_MS
  for (;;) {
    let remaining: number[]
    try {
      remaining = await profileProcessPids(userDataDir)
    } catch {
      return false
    }
    const rootAlive = rootPid ? processPidAlive(rootPid) : false
    if (!rootAlive && remaining.length === 0) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function closeContextConfirmed(context: BrowserContext, userDataDir: string): Promise<boolean> {
  try {
    await withTimeout(context.close(), BROWSER_CLOSE_TIMEOUT_MS)
    return await waitForBrowserProcessesGone(context, userDataDir)
  } catch {
    return await forceCloseBrowserContext(context, userDataDir)
  }
}

async function forceCloseProfile(userDataDir: string): Promise<boolean> {
  try {
    const pids = await profileProcessPids(userDataDir)
    if (!pids.length) return await waitForBrowserProcessesGone(undefined, userDataDir)
    await Promise.all(pids.map((pid) => terminateBrowserProcess(pid)))
    return await waitForBrowserProcessesGone(undefined, userDataDir)
  } catch {
    return false
  }
}

async function confirmClosedProfile(
  userDataDir: string,
  context?: BrowserContext,
): Promise<boolean> {
  if (context) {
    try {
      if (await waitForBrowserProcessesGone(context, userDataDir)) return true
    } catch {
      // Fall through to the forced, profile-based cleanup.
    }
    try {
      if (await forceCloseBrowserContext(context, userDataDir)) return true
    } catch {
      // Fall through to the profile-based cleanup.
    }
  }
  return await forceCloseProfile(userDataDir)
}

export function toolbarBrowserCount() {
  return slots.toolbarCount()
}

export function averageBrowserMemoryBytes() {
  if (!browserMemorySamples.size) return undefined
  return [...browserMemorySamples.values()].reduce((sum, value) => sum + value, 0) / browserMemorySamples.size
}

export function browserMemoryStatus(): 'idle' | 'sampled' | 'unavailable' {
  if (!held.size) return 'idle'
  return browserMemorySamples.size === held.size ? 'sampled' : 'unavailable'
}

async function browserRssBytes(context: BrowserContext, userDataDir: string) {
  const browser = (context as unknown as {
    browser?: () => { process?: () => { pid?: number } | null } | null
  }).browser?.()
  const pid = browser?.process?.()?.pid
  try {
    if (process.platform === 'win32') {
      const script = '$memory = @{}; Get-Process | ForEach-Object { $memory[$_.Id] = $_.WorkingSet64 }; Get-CimInstance Win32_Process | ForEach-Object { $rss = $memory[$_.ProcessId]; if ($rss) { "$($_.ProcessId)|$($_.ParentProcessId)|$rss|$($_.CommandLine)" } }'
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3000 })
      const rows = stdout.split('\n').map((line) => {
        const [rawPid, rawParentPid, rawRss, ...command] = line.trim().split('|')
        return { pid: Number(rawPid), parentPid: Number(rawParentPid), rss: Number(rawRss), command: command.join('|') }
      }).filter((row) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid) && row.rss > 0)
      return processTreeRss(rows, pid, userDataDir)
    }
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { timeout: 1500 })
    const rows = [] as Array<{ pid: number; parentPid: number; rss: number; command: string }>
    for (const line of stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
      if (!match) continue
      rows.push({ pid: Number(match[1]), parentPid: Number(match[2]), rss: Number(match[3]), command: match[4] })
    }
    return processTreeRss(rows, pid, userDataDir, 1024)
  } catch {
    return undefined
  }
}

function processTreeRss(rows: Array<{ pid: number; parentPid: number; rss: number; command: string }>, pid?: number, userDataDir?: string, unit = 1) {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const children = new Map<number, number[]>()
  for (const row of rows) children.set(row.parentPid, [...(children.get(row.parentPid) || []), row.pid])
  const roots = pid ? [pid] : rows.filter((row) => row.command.includes(userDataDir || '')).map((row) => row.pid)
  const seen = new Set<number>()
  const visit = (currentPid: number): number => {
    if (seen.has(currentPid)) return 0
    seen.add(currentPid)
    return (byPid.get(currentPid)?.rss || 0) + (children.get(currentPid) || []).reduce((sum, childPid) => sum + visit(childPid), 0)
  }
  const rss = roots.reduce((sum, rootPid) => sum + visit(rootPid), 0)
  return rss > 0 ? rss * unit : undefined
}

export async function refreshBrowserMemorySamples() {
  await Promise.all([...held.entries()].map(async ([localId, item]) => {
    const bytes = await browserRssBytes(item.context, profileDir(localId))
    if (bytes) browserMemorySamples.set(localId, bytes)
  }))
}

async function tileContextForE2e(context: BrowserContext, index: number) {
  if (process.env.KAIDA_E2E_TILE_BROWSERS !== '1') return
  for (const page of context.pages()) {
    let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined
    try {
      cdp = await context.newCDPSession(page)
      const { windowId } = await cdp.send('Browser.getWindowForTarget')
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal', left: 20 + (index % 2) * 920, top: 60, width: 880, height: 760 },
      })
    } catch {
      /* 测试窗口排布失败不影响产品流程 */
    } finally {
      await cdp?.detach().catch(() => {})
    }
  }
}

async function acquireUnlocked(local_id: string, visual: boolean): Promise<{ ok: boolean; queued?: boolean; context?: BrowserContext; error?: string }> {
  const mode: BrowserMode = visual ? 'visual' : 'headless'
  const state = slots.request(local_id)
  if (state === 'queued' || state === 'closing') return { ok: false, queued: true }
  const existing = held.get(local_id)
  if (existing) {
    if (existing.mode !== mode) {
      return { ok: false, error: '浏览器模式已锁定，请停止任务并释放浏览器后再切换' }
    }
    slots.occupy(local_id)
    return { ok: true, context: existing.context }
  }
  const launchEpoch = releaseEpochs.get(local_id) || 0
  const dir = profileDir(local_id)
  mkdirSync(dir, { recursive: true })
  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(dir, {
      executablePath: browserExecutablePath(),
      headless: mode === 'headless',
      channel: 'chromium',
      userAgent: mode === 'headless' ? headlessUserAgent() : undefined,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      args: ['--disable-blink-features=AutomationControlled', '--hide-crash-restore-bubble'],
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      timeout: 120_000,
    })
  } catch (error) {
    bumpReleaseEpoch(local_id)
    launchCleanupConfirmations.set(local_id, true)
    slots.release(local_id)
    slots.promoteQueued()
    notifyPoolRelease(local_id, 'launch_failed')
    throw error
  }
  if (
    (releaseEpochs.get(local_id) || 0) !== launchEpoch ||
    slots.get(local_id) !== 'launching'
  ) {
    const confirmed = await closeContextConfirmed(context, dir)
    launchCleanupConfirmations.set(local_id, confirmed)
    if (!confirmed) {
      throw new Error('停止后未能确认浏览器进程退出，已保留关闭占位')
    }
    return { ok: false, queued: true }
  }
  launchCleanupConfirmations.delete(local_id)
  context.setDefaultTimeout(20000)
  context.setDefaultNavigationTimeout(30000)
  const schoolOrigin = process.env.KAIDA_E2E_USERDATA && process.env.KAIDA_E2E_SCHOOL_ORIGIN
  if (schoolOrigin && new URL(schoolOrigin).hostname === '127.0.0.1') {
    await context.route((url) => ['learning.shou.org.cn', 'aiedu.shou.org.cn', 'l.shou.org.cn', 'iam.shou.org.cn'].includes(url.hostname), async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      try {
        const response = await fetch(schoolOrigin + url.pathname + url.search, {
          method: request.method(),
          headers: { 'x-kaida-test-host': url.hostname, 'content-type': request.headers()['content-type'] || 'text/plain' },
          body: request.postData() || undefined,
        })
        await route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'text/html; charset=utf-8' }, body: Buffer.from(await response.arrayBuffer()) })
      } catch { await route.abort() }
    })
  }
  const windowIndex = nextWindowIndex++
  held.set(local_id, { context, mode })
  context.on('close', () => {
    const current = held.get(local_id)
    if (!current || current.context !== context) return
    bumpReleaseEpoch(local_id)
    const closingEpoch = currentReleaseEpoch(local_id)
    held.delete(local_id)
    browserMemorySamples.delete(local_id)
    slots.closing(local_id)
    notifyPoolRelease(local_id, 'context_closed')
    void confirmClosedProfile(dir, context).then((confirmed) => {
      if (confirmed) {
        finalizeClosingRelease(local_id, closingEpoch)
      } else {
        scheduleClosingRetry(local_id, closingEpoch)
      }
    })
  })
  slots.occupy(local_id)
  if (visual) await tileContextForE2e(context, windowIndex)
  return { ok: true, context }
}

export async function acquire(local_id: string, visual: boolean): Promise<{ ok: boolean; queued?: boolean; context?: BrowserContext; error?: string }> {
  const previous = acquireChains.get(local_id) || Promise.resolve()
  let finishCurrent!: () => void
  const current = new Promise<void>((resolve) => {
    finishCurrent = resolve
  })
  const chain = previous.then(() => current)
  acquireChains.set(local_id, chain)
  await previous
  try {
    return await acquireUnlocked(local_id, visual)
  } finally {
    finishCurrent()
    if (acquireChains.get(local_id) === chain) acquireChains.delete(local_id)
  }
}

export function browserWindowVisible(local_id: string) {
  const mode = held.get(local_id)?.mode
  return mode ? mode === 'visual' : null
}

export function markVerify(local_id: string) {
  slots.occupyingVerify(local_id)
}

export function markOccupied(local_id: string) {
  slots.occupy(local_id)
}

function finalizePoolRelease(local_id: string): boolean {
  const retry = closingRetryTimers.get(local_id)
  if (retry) clearTimeout(retry)
  closingRetryTimers.delete(local_id)
  launchCleanupConfirmations.delete(local_id)
  const released = slots.release(local_id)
  slots.promoteQueued()
  if (released) notifyPoolRelease(local_id, 'released')
  return released
}

function finalizeClosingRelease(local_id: string, expectedEpoch: number): boolean {
  if (slots.get(local_id) !== 'closing' || currentReleaseEpoch(local_id) !== expectedEpoch) {
    return false
  }
  return finalizePoolRelease(local_id)
}

function scheduleClosingRetry(local_id: string, expectedEpoch: number) {
  if (closingRetryTimers.has(local_id) || held.has(local_id)) return
  let attempts = 0
  const tick = async () => {
    closingRetryTimers.delete(local_id)
    if (
      held.has(local_id) ||
      slots.get(local_id) !== 'closing' ||
      currentReleaseEpoch(local_id) !== expectedEpoch
    ) return
    const confirmed = await confirmClosedProfile(profileDir(local_id))
    if (confirmed) {
      finalizeClosingRelease(local_id, expectedEpoch)
      return
    }
    attempts++
    if (
      attempts >= CLOSING_RETRY_LIMIT ||
      slots.get(local_id) !== 'closing' ||
      currentReleaseEpoch(local_id) !== expectedEpoch
    ) return
    const timer = setTimeout(tick, CLOSING_RETRY_MS)
    timer.unref?.()
    closingRetryTimers.set(local_id, timer)
  }
  const timer = setTimeout(tick, CLOSING_RETRY_MS)
  timer.unref?.()
  closingRetryTimers.set(local_id, timer)
}

export async function release(local_id: string): Promise<boolean> {
  const inFlight = closingReleases.get(local_id)
  if (inFlight) {
    return await inFlight
  }
  const h = held.get(local_id)
  if (h && process.env.KAIDA_E2E_KEEP_BROWSERS === '1') {
    bumpReleaseEpoch(local_id)
    return finalizePoolRelease(local_id)
  }
  if (h) {
    bumpReleaseEpoch(local_id)
    const closingEpoch = currentReleaseEpoch(local_id)
    slots.closing(local_id)
    held.delete(local_id)
    browserMemorySamples.delete(local_id)
    let closeConfirmed = false
    const closeTask = (async (): Promise<boolean> => {
      const physicallyClosed = await closeContextConfirmed(h.context, profileDir(local_id))
      if (!physicallyClosed) {
        return false
      }
      closeConfirmed = true
      return true
    })().finally(() => {
      closingReleases.delete(local_id)
      if (slots.get(local_id) === 'closing') {
        if (closeConfirmed) {
          finalizeClosingRelease(local_id, closingEpoch)
        } else {
          scheduleClosingRetry(local_id, closingEpoch)
        }
      }
    })
    closingReleases.set(local_id, closeTask)
    return await closeTask.catch(() => false)
  }
  if (slots.get(local_id) === 'launching') {
    bumpReleaseEpoch(local_id)
    const closingEpoch = currentReleaseEpoch(local_id)
    slots.closing(local_id)
    let closeConfirmed = false
    const closeTask = (async (): Promise<boolean> => {
      const launch = acquireChains.get(local_id)
      if (launch) await launch
      let confirmed = launchCleanupConfirmations.get(local_id)
      launchCleanupConfirmations.delete(local_id)
      if (confirmed === undefined) {
        try {
          confirmed = await waitForBrowserProcessesGone(undefined, profileDir(local_id))
        } catch {
          confirmed = false
        }
      }
      if (!confirmed) return false
      closeConfirmed = true
      return true
    })().finally(() => {
      closingReleases.delete(local_id)
      if (closeConfirmed && slots.get(local_id) === 'closing') {
        finalizeClosingRelease(local_id, closingEpoch)
      } else if (!closeConfirmed && slots.get(local_id) === 'closing') {
        scheduleClosingRetry(local_id, closingEpoch)
      }
    })
    closingReleases.set(local_id, closeTask)
    return await closeTask.catch(() => false)
  }
  if (slots.get(local_id) === 'closing') {
    const closingEpoch = currentReleaseEpoch(local_id)
    try {
      if (await waitForBrowserProcessesGone(undefined, profileDir(local_id))) {
        return finalizeClosingRelease(local_id, closingEpoch)
      }
    } catch {
      // A failed process-table read is not proof that capacity is safe.
    }
    scheduleClosingRetry(local_id, closingEpoch)
    return false
  }
  bumpReleaseEpoch(local_id)
  return finalizePoolRelease(local_id)
}

export function getContext(local_id: string): BrowserContext | undefined {
  return held.get(local_id)?.context
}

export function isHeld(local_id: string) {
  return held.has(local_id)
}

export async function newPage(local_id: string): Promise<Page> {
  const ctx = held.get(local_id)?.context
  if (!ctx) throw new Error('no context')
  return ctx.newPage()
}
