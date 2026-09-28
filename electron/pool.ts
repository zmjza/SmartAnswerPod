import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { chromium, type BrowserContext, type Page } from 'patchright'
import { SlotPool } from './core/slot-pool.ts'
import { browserExecutablePath, headlessUserAgent } from './core/browser-mode.ts'
import { profileDir } from './store.ts'

type BrowserMode = 'headless' | 'visual'

type Held = {
  context: BrowserContext
  mode: BrowserMode
}

const held = new Map<string, Held>()
const browserMemorySamples = new Map<string, number>()
const execFileAsync = promisify(execFile)
export const slots = new SlotPool(2)

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

export async function acquire(local_id: string, visual: boolean): Promise<{ ok: boolean; queued?: boolean; context?: BrowserContext; error?: string }> {
  const mode: BrowserMode = visual ? 'visual' : 'headless'
  const state = slots.request(local_id)
  if (state === 'queued') return { ok: false, queued: true }
  const existing = held.get(local_id)
  if (existing) {
    if (existing.mode !== mode) {
      return { ok: false, error: '浏览器模式已锁定，请停止任务并释放浏览器后再切换' }
    }
    slots.occupy(local_id)
    return { ok: true, context: existing.context }
  }
  const dir = profileDir(local_id)
  mkdirSync(dir, { recursive: true })
  const context = await chromium.launchPersistentContext(dir, {
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
  })
  context.setDefaultTimeout(20000)
  context.setDefaultNavigationTimeout(30000)
  const schoolOrigin = process.env.KAIDA_E2E_USERDATA && process.env.KAIDA_E2E_SCHOOL_ORIGIN
  if (schoolOrigin && new URL(schoolOrigin).hostname === '127.0.0.1') {
    await context.route((url) => ['learning.shou.org.cn', 'l.shou.org.cn', 'iam.shou.org.cn'].includes(url.hostname), async (route) => {
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
  const windowIndex = held.size
  held.set(local_id, { context, mode })
  context.on('close', () => {
    const current = held.get(local_id)
    if (!current || current.context !== context) return
    held.delete(local_id)
    browserMemorySamples.delete(local_id)
    slots.release(local_id)
    slots.promoteQueued()
  })
  slots.occupy(local_id)
  if (visual) await tileContextForE2e(context, windowIndex)
  return { ok: true, context }
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

export async function release(local_id: string) {
  const h = held.get(local_id)
  slots.release(local_id)
  if (h && process.env.KAIDA_E2E_KEEP_BROWSERS === '1') {
    slots.promoteQueued()
    return
  }
  held.delete(local_id)
  browserMemorySamples.delete(local_id)
  if (h) {
    try {
      await h.context.close()
    } catch {
      /* ignore */
    }
  }
  slots.promoteQueued()
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
