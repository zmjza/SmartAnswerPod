import assert from 'node:assert/strict'
import { build } from 'esbuild'

process.env.KAIDA_BROWSER_CLOSE_TIMEOUT_MS = '120'
process.env.KAIDA_BROWSER_FORCE_CLOSE_CONFIRM_MS = '120'

type Fixture = {
  releaseEvents: Array<{ localId: string; reason: string }>
  closeStarted: boolean
  closeResolve?: () => void
  launchResolve?: (context: unknown) => void
  launchStarted: boolean
  launchCount: number
  launchPromise?: Promise<unknown>
  launchContext?: unknown
  context?: unknown
  contextCloseCount: number
  closeHandlers: Array<() => void>
}

const fixture: Fixture = {
  releaseEvents: [],
  closeStarted: false,
  launchStarted: false,
  launchCount: 0,
  contextCloseCount: 0,
  closeHandlers: [],
}

const fakeContext = () => ({
  setDefaultTimeout() {},
  setDefaultNavigationTimeout() {},
  on(event: string, handler: () => void) {
    if (event === 'close') fixture.closeHandlers.push(handler)
  },
  pages: () => [],
  newPage: async () => ({ close: async () => {} }),
  close: async () => {
    fixture.contextCloseCount++
    fixture.closeStarted = true
    await new Promise<void>((resolve) => {
      fixture.closeResolve = resolve
    })
  },
})

const launchedContext = fakeContext()
const immediateLateContext = {
  ...fakeContext(),
  close: async () => {
    fixture.contextCloseCount++
  },
}

const modules: Record<string, string> = {
  'patchright': `
    const f = () => globalThis.__t006Pool
    export const chromium = {
      launchPersistentContext: async () => {
        f().launchStarted = true
        f().launchCount++
        if (f().launchPromise) return await f().launchPromise
        return f().launchContext || f().context
      }
    }
  `,
  './core/browser-mode.ts': `
    export const browserExecutablePath = () => '/fixture/chrome'
    export const headlessUserAgent = () => 'fixture-agent'
  `,
  './store.ts': `
    export const profileDir = (id) => process.cwd() + '/.playwright/t006-pool-profile-' + id
  `,
}

globalThis.__t006Pool = fixture as never
globalThis.__t006Pool.context = launchedContext

const built = await build({
  entryPoints: ['electron/pool.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [{
    name: 't006-pool-mocks',
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, (args) => {
        if (Object.prototype.hasOwnProperty.call(modules, args.path)) {
          return { path: args.path, namespace: 't006-pool-mock' }
        }
        return undefined
      })
      plugin.onLoad({ filter: /.*/, namespace: 't006-pool-mock' }, (args) => ({
        contents: modules[args.path],
        loader: 'js',
      }))
    },
  }],
})

const pool = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
)
const windowsCommand = pool.buildWindowsProfileProcessCommand('C:\\fixture\\profile path')
assert.equal(windowsCommand.options.env.KAIDA_PROFILE_PATH, 'C:\\fixture\\profile path')
assert.equal(
  JSON.stringify(windowsCommand.args).includes('C:\\fixture\\profile path'),
  false,
  'Windows 进程查询不能把 profile 路径放进 PowerShell 命令行',
)
assert.match(windowsCommand.script, /\$env:KAIDA_PROFILE_PATH/)
assert.match(windowsCommand.script, /-ne \$PID/)
const offPoolRelease = pool.onPoolRelease((event: { localId: string; reason: string }) => {
  fixture.releaseEvents.push(event)
})

const a = await pool.acquire('a', false)
const b = await pool.acquire('b', false)
assert.equal(a.ok, true)
assert.equal(b.ok, true)
assert.equal((await pool.acquire('c', false)).queued, true)

const firstRelease = pool.release('a')
while (!fixture.closeStarted) await new Promise((resolve) => setTimeout(resolve, 5))
const secondRelease = pool.release('a')
assert.equal(pool.slots.get('c'), 'queued', 'closing 未完成时不能提前提升排队账号')
fixture.closeResolve?.()
await Promise.race([
  Promise.all([firstRelease, secondRelease]),
  new Promise((_, reject) => setTimeout(() => reject(new Error('release-deadlock')), 2_000)),
])
assert.equal(pool.slots.get('c'), 'launching', '关闭完成后应补位一次')
assert.equal(fixture.releaseEvents.filter((event) => event.localId === 'a').length, 1)

fixture.closeStarted = false
fixture.closeResolve = undefined
fixture.launchStarted = false
pool.slots.setLimit(3)
fixture.launchContext = immediateLateContext
fixture.launchPromise = new Promise<unknown>((resolve) => {
  fixture.launchResolve = resolve
})
const lateAcquire = pool.acquire('late', false)
while (!fixture.launchStarted) await new Promise((resolve) => setTimeout(resolve, 5))
const lateQueued = await pool.acquire('late-queued', false)
assert.equal(lateQueued.queued, true)
const lateRelease = pool.release('late')
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(pool.slots.get('late'), 'closing', '启动中停止必须继续占住物理容量')
assert.equal(pool.slots.get('late-queued'), 'queued', '启动尚未确认关闭前不能补位')
fixture.launchResolve?.(immediateLateContext)
const lateResult = await lateAcquire
assert.equal(await lateRelease, true)
assert.equal(lateResult.ok, false)
assert.equal(lateResult.queued, true)
assert.equal(pool.isHeld('late'), false, '释放后的晚到启动不能重新占用槽位')
assert.ok(fixture.contextCloseCount >= 2, '晚到上下文必须被关闭')
assert.equal(pool.slots.get('late-queued'), 'launching', '物理关闭确认后才允许补位')

const sameContext = {
  ...immediateLateContext,
  close: async () => {
    fixture.contextCloseCount++
  },
}
fixture.launchStarted = false
fixture.launchCount = 0
fixture.launchContext = sameContext
fixture.launchPromise = new Promise<unknown>((resolve) => {
  fixture.launchResolve = resolve
})
pool.slots.setLimit(4)
const sameFirst = pool.acquire('same-id', false)
while (fixture.launchCount < 1) await new Promise((resolve) => setTimeout(resolve, 5))
const sameSecond = pool.acquire('same-id', false)
await new Promise((resolve) => setTimeout(resolve, 30))
assert.equal(fixture.launchCount, 1, '同一学生的并发 acquire 重复启动了持久化浏览器')
fixture.launchResolve?.(sameContext)
const [sameFirstResult, sameSecondResult] = await Promise.all([sameFirst, sameSecond])
assert.equal(sameFirstResult.ok, true)
assert.equal(sameSecondResult.ok, true)
assert.equal(sameFirstResult.context, sameSecondResult.context)

fixture.launchStarted = false
fixture.launchPromise = undefined
fixture.launchContext = {
  ...immediateLateContext,
  close: async () => {
    await new Promise<never>(() => {})
  },
}
pool.slots.setLimit(5)
const timedOutAcquire = await pool.acquire('close-timeout', false)
assert.equal(timedOutAcquire.ok, true)
const timeoutStartedAt = Date.now()
await Promise.race([
  pool.release('close-timeout'),
  new Promise((_, reject) => setTimeout(() => reject(new Error('close-timeout-deadlock')), 2_000)),
])
assert.ok(Date.now() - timeoutStartedAt < 2_000, '浏览器关闭超过安全上限后没有强制收口')
assert.equal(
  pool.slots.get('close-timeout'),
  'closing',
  '无法确认物理进程退出时不能只释放逻辑槽位',
)
assert.equal(
  pool.slots.promoteQueued(),
  null,
  '无法确认物理进程退出时不能补位下一名账号',
)

fixture.launchStarted = false
fixture.launchPromise = undefined
fixture.launchContext = {
  ...immediateLateContext,
  close: async () => {
    fixture.contextCloseCount++
  },
  browser: () => ({
    process: () => ({ pid: process.pid }),
  }),
}
pool.slots.setLimit(6)
const residualCloseAcquire = await pool.acquire('close-residual', false)
assert.equal(residualCloseAcquire.ok, true)
assert.equal(
  await pool.release('close-residual'),
  false,
  'context.close 返回成功但根进程仍存活时不能确认释放',
)
assert.equal(
  pool.slots.get('close-residual'),
  'closing',
  '成功 close 后仍必须核对物理进程退出',
)
assert.equal(pool.slots.promoteQueued(), null, '物理进程仍存活时不能补位')

fixture.launchStarted = false
fixture.launchPromise = undefined
fixture.launchContext = {
  ...immediateLateContext,
  close: async () => {
    fixture.contextCloseCount++
  },
}
pool.slots.setLimit(7)
const unexpectedCloseAcquire = await pool.acquire('unexpected-close', false)
assert.equal(unexpectedCloseAcquire.ok, true)
fixture.closeHandlers.at(-1)?.()
const unexpectedCloseDeadline = Date.now() + 2_000
while (pool.slots.get('unexpected-close') !== 'released' && Date.now() < unexpectedCloseDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
assert.equal(
  pool.slots.get('unexpected-close'),
  'released',
  '浏览器意外关闭必须先确认物理进程退出再释放槽位',
)
offPoolRelease()

console.log(JSON.stringify({
  ok: true,
  closingKeepsCapacity: true,
  duplicateReleaseSinglePromotion: true,
  lateAcquireRejected: true,
  sameIdLaunchCoalesced: true,
  stopDuringLaunchKeepsCapacity: true,
  closeTimeoutBounded: true,
  closeUnconfirmedStaysClosing: true,
  closeSuccessStillRequiresProcessExit: true,
  unexpectedClosePhysicallyConfirmed: true,
}))
