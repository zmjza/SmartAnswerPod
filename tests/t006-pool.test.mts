import assert from 'node:assert/strict'
import { build } from 'esbuild'

process.env.KAIDA_BROWSER_CLOSE_TIMEOUT_MS = '120'
process.env.KAIDA_BROWSER_FORCE_CLOSE_CONFIRM_MS = '120'
process.env.KAIDA_BROWSER_CLOSING_RETRY_MS = '120'

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
  psFailuresRemaining: number
  psCalls: number
  psCallTimes: number[]
  psActive: number
  psPeak: number
  psGate?: Promise<void>
  psStdoutQueue: string[]
}

const fixture: Fixture = {
  releaseEvents: [],
  closeStarted: false,
  launchStarted: false,
  launchCount: 0,
  contextCloseCount: 0,
  closeHandlers: [],
  psFailuresRemaining: 0,
  psCalls: 0,
  psCallTimes: [],
  psActive: 0,
  psPeak: 0,
  psStdoutQueue: [],
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
  'node:child_process': `
    export function execFile(command, args, options, callback) {
      const f = () => globalThis.__t006Pool
      const done = typeof options === 'function' ? options : callback
      f().psCalls++
      if (f().psFailuresRemaining > 0) {
        f().psFailuresRemaining--
        queueMicrotask(() => done(new Error('fixture-ps-unavailable'), '', ''))
        return
      }
      queueMicrotask(() => done(null, '', ''))
    }
    execFile[Symbol.for('nodejs.util.promisify.custom')] = async () => {
      const f = () => globalThis.__t006Pool
      f().psCalls++
      f().psCallTimes.push(performance.now())
      f().psActive++
      f().psPeak = Math.max(f().psPeak, f().psActive)
      try {
        if (f().psGate) await f().psGate
        if (f().psFailuresRemaining > 0) {
          f().psFailuresRemaining--
          throw new Error('fixture-ps-unavailable')
        }
        return { stdout: f().psStdoutQueue.shift() || '', stderr: '' }
      } finally {
        f().psActive--
      }
    }
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(10)
  }
  throw new Error(label)
}

function resetPsProbe() {
  fixture.psCalls = 0
  fixture.psCallTimes = []
  fixture.psActive = 0
  fixture.psPeak = 0
  fixture.psGate = undefined
}

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

fixture.launchStarted = false
fixture.launchPromise = undefined
fixture.launchContext = {
  ...immediateLateContext,
  close: async () => {
    fixture.contextCloseCount++
  },
}
pool.slots.setLimit(pool.slots.toolbarCount() + 1)
assert.equal((await pool.acquire('unexpected-slow-close', false)).ok, true)
resetPsProbe()
const unexpectedCloseGate = deferred()
fixture.psGate = unexpectedCloseGate.promise
fixture.closeHandlers.at(-1)?.()
await waitFor(() => fixture.psActive === 1, 'unexpected-close confirmation did not start')
const unexpectedCloseRelease = pool.release('unexpected-slow-close')
await sleep(30)
assert.equal(fixture.psPeak, 1, 'release joined unexpected-close confirmation with a parallel scan')
assert.equal(pool.slots.get('unexpected-slow-close'), 'closing')
unexpectedCloseGate.resolve()
assert.equal(await unexpectedCloseRelease, true, 'release did not reuse the successful unexpected-close confirmation')
assert.equal(pool.slots.get('unexpected-slow-close'), 'released')
resetPsProbe()

// Let the two deliberately unconfirmed contexts above finish their own retry
// chains before testing shared retry-chain invariants.
fixture.psFailuresRemaining = 0
for (const id of ['close-timeout', 'close-residual']) {
  await waitFor(() => pool.slots.get(id) === 'released', `${id} retry chain did not settle`)
}

resetPsProbe()
pool.slots.setLimit(pool.slots.toolbarCount() + 1)
fixture.closeStarted = false
fixture.closeResolve = undefined
fixture.launchStarted = false
fixture.launchPromise = undefined
fixture.launchContext = {
  ...fakeContext(),
  close: async () => {
    fixture.contextCloseCount++
    await new Promise<never>(() => {})
  },
}
const retryChainAcquire = await pool.acquire('retry-chain', false)
assert.equal(retryChainAcquire.ok, true)
assert.equal((await pool.acquire('retry-chain-waiter', false)).queued, true)

fixture.psFailuresRemaining = 1_000
assert.equal(await pool.release('retry-chain'), false)
resetPsProbe()
fixture.psFailuresRemaining = 1_000
const retryGate = deferred()
fixture.psGate = retryGate.promise
await waitFor(() => fixture.psActive === 1, 'closing retry scan did not start')
const secondRetryRelease = pool.release('retry-chain')
const thirdRetryRelease = pool.release('retry-chain')
await sleep(30)
assert.equal(fixture.psPeak, 1, 'duplicate release started a parallel process scan')
assert.equal(pool.slots.get('retry-chain'), 'closing', 'retry scan released capacity before confirmation')
assert.equal(pool.slots.get('retry-chain-waiter'), 'queued', 'queued account started before close confirmation')
assert.equal(pool.slots.promoteQueued(), null, 'closing retry scan incorrectly promoted a queued account')
retryGate.resolve()
await Promise.race([
  Promise.all([secondRetryRelease, thirdRetryRelease]),
  new Promise((_, reject) => setTimeout(() => reject(new Error('duplicate-retry-deadlock')), 2_000)),
])

fixture.psGate = undefined
fixture.psFailuresRemaining = 0
await waitFor(() => pool.slots.get('retry-chain') === 'released', 'retry chain did not release after confirmation')
assert.equal(pool.slots.get('retry-chain-waiter'), 'launching', 'queued account was not promoted once after confirmation')
const scansAfterSuccess = fixture.psCalls
const retryReleaseEvents = fixture.releaseEvents.filter((event) => event.localId === 'retry-chain').length
await sleep(350)
assert.equal(fixture.psCalls, scansAfterSuccess, 'retry timer continued scanning after final release')
assert.equal(
  fixture.releaseEvents.filter((event) => event.localId === 'retry-chain').length,
  retryReleaseEvents,
  'retry chain emitted another release event after success',
)
await pool.release('retry-chain-waiter')

// A pending timer from the previous epoch must not release the new closing
// episode, and the new epoch must install its own retry chain.
resetPsProbe()
pool.slots.setLimit(pool.slots.toolbarCount() + 1)
fixture.launchStarted = false
fixture.launchPromise = undefined
fixture.launchContext = {
  ...fakeContext(),
  close: async () => {
    fixture.contextCloseCount++
    await new Promise<never>(() => {})
  },
}
assert.equal((await pool.acquire('retry-epoch', false)).ok, true)
fixture.psFailuresRemaining = 1_000
assert.equal(await pool.release('retry-epoch'), false)

// Simulate a completed previous episode while its old retry timer is pending.
pool.slots.release('retry-epoch')
fixture.launchContext = immediateLateContext
fixture.launchStarted = false
fixture.launchPromise = undefined
assert.equal((await pool.acquire('retry-epoch', false)).ok, true)
assert.equal((await pool.acquire('retry-epoch-waiter', false)).queued, true)
const epochRelease = pool.release('retry-epoch')
assert.equal(await epochRelease, false)
await sleep(180)
assert.equal(pool.slots.get('retry-epoch'), 'closing', 'old retry timer released a newer closing epoch')
assert.equal(pool.slots.get('retry-epoch-waiter'), 'queued', 'old retry timer promoted a newer queued account')
fixture.psFailuresRemaining = 0
await waitFor(() => pool.slots.get('retry-epoch') === 'released', 'new epoch retry chain did not recover')
assert.equal(pool.slots.get('retry-epoch-waiter'), 'launching', 'new epoch did not promote its queued account')
await pool.release('retry-epoch-waiter')

fixture.launchStarted = false
fixture.launchPromise = undefined
fixture.launchContext = {
  ...fakeContext(),
  close: async () => {
    fixture.contextCloseCount++
    await new Promise<never>(() => {})
  },
}
pool.slots.setLimit(pool.slots.toolbarCount() + 1)
const retryingCloseAcquire = await pool.acquire('close-retrying', false)
assert.equal(retryingCloseAcquire.ok, true)
fixture.psFailuresRemaining = 30
const retryingCloseRelease = pool.release('close-retrying')
assert.equal(await retryingCloseRelease, false)
resetPsProbe()
fixture.psFailuresRemaining = 30
const retryingCloseDeadline = Date.now() + 6_000
while (pool.slots.get('close-retrying') !== 'released' && Date.now() < retryingCloseDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
assert.equal(
  pool.slots.get('close-retrying'),
  'released',
  '短暂进程查询失败超过旧重试上限后仍必须继续重试并最终释放容量',
)
const failedRetryStarts = fixture.psCallTimes.slice(0, 30)
assert.equal(failedRetryStarts.length, 30, 'closing retry did not continue beyond the old retry limit')
const retryIntervals = failedRetryStarts
  .slice(1)
  .map((time, index) => time - failedRetryStarts[index])
assert.ok(
  Math.min(...retryIntervals) >= 100,
  `closing retry interval fell below 100ms: ${JSON.stringify(retryIntervals)}`,
)

// A rejected launch can still leave a transient Chromium process behind. Keep
// capacity in closing until the profile is physically confirmed gone.
pool.slots.setLimit(pool.slots.toolbarCount() + 1)
fixture.launchStarted = false
fixture.launchCount = 0
fixture.launchContext = undefined
fixture.launchPromise = Promise.reject(new Error('fixture launch failed'))
fixture.psStdoutQueue = ['12345\n', '']
await assert.rejects(pool.acquire('launch-failed', false), /fixture launch failed/)
assert.equal(
  pool.slots.get('launch-failed'),
  'closing',
  'launch rejection released capacity before physical cleanup was confirmed',
)
pool.slots.setLimit(pool.slots.toolbarCount())
const launchFailedWaiter = await pool.acquire('launch-failed-waiter', false)
assert.equal(
  launchFailedWaiter.queued,
  true,
  'queued account started while a failed launch still held closing capacity',
)
await waitFor(
  () => pool.slots.get('launch-failed') === 'released',
  'failed launch did not finish closing after the residual process disappeared',
)
fixture.psStdoutQueue = []
fixture.launchPromise = undefined
fixture.launchContext = immediateLateContext
pool.slots.setLimit(pool.slots.toolbarCount() + 1)
assert.equal(
  (await pool.acquire('launch-failed-waiter', false)).ok,
  true,
  'queued account did not start after failed-launch cleanup was confirmed',
)
await pool.release('launch-failed-waiter')
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
  closingRetryContinuesUntilConfirmed: true,
  launchFailureKeepsCapacityUntilConfirmed: true,
}))
