import assert from 'node:assert/strict'
import { build } from 'esbuild'

const fixture = {
  accounts: [
    { local_id: 'a', name: 'A', username: 'fixture-a', password: 'fixture', display_mode: 'headless', work_mode: 'noqr', course_scope: 'all', answer_round_limit: 10 },
    { local_id: 'b', name: 'B', username: 'fixture-b', password: 'fixture', display_mode: 'headless', work_mode: 'noqr', course_scope: 'all', answer_round_limit: 10 },
    { local_id: 'c', name: 'C', username: 'fixture-c', password: 'fixture', display_mode: 'headless', work_mode: 'noqr', course_scope: 'all', answer_round_limit: 10 },
  ],
  limit: 2,
  occupied: new Set<string>(),
  starts: [] as string[],
  releases: [] as string[],
  courses: [] as Array<{ key: string; name: string; order: number; current?: boolean }>,
  releaseListeners: [] as Array<(event: { localId: string; reason: string }) => void>,
  failUsernames: new Set<string>(),
  blockUsernames: new Set<string>(),
  blockCourseOwners: new Set<string>(),
  afterSelection: false,
  courseLimit: 1,
  delayCourseReads: false,
  courseReadActive: 0,
  courseReadPeak: 0,
  releaseFailure: new Set<string>(),
  slotStates: new Map<string, string>(),
}

globalThis.__t006 = fixture as never

const modules: Record<string, string> = {
  '../pool.ts': `
    const f = () => globalThis.__t006
    export const slots = {
      setLimit(n) { f().limit = n },
      get(id) { return f().slotStates.get(id) || 'queued' },
    }
    export const acquire = async (id) => {
      if (f().occupied.size >= f().limit) return { ok: false, queued: true }
      f().occupied.add(id)
      f().slotStates.set(id, 'occupied')
      f().starts.push(id)
      const page = { owner: id, close: async () => {} }
      return { ok: true, context: { pages: () => [page], newPage: async () => page } }
    }
    export const release = async (id) => {
      if (f().releaseFailure.has(id)) {
        f().slotStates.set(id, 'closing')
        return false
      }
      f().occupied.delete(id)
      f().slotStates.set(id, 'released')
      f().releases.push(id)
      for (const listener of [...f().releaseListeners]) listener({ localId: id, reason: 'released' })
      return true
    }
    export const onPoolRelease = (listener) => {
      f().releaseListeners.push(listener)
      return () => { f().releaseListeners = f().releaseListeners.filter((item) => item !== listener) }
    }
    export const browserWindowVisible = () => false
    export const getContext = () => ({ pages: () => [{}], newPage: async () => ({ close: async () => {} }) })
    export const isHeld = () => false
  `,
  '../store.ts': `
    export const listAccounts = () => globalThis.__t006.accounts
    export const getSettings = () => ({ account_parallel: globalThis.__t006.limit, course_parallel: globalThis.__t006.courseLimit, log_enabled: true })
    export const getAccountWorkMode = (id) => globalThis.__t006.accounts.find((item) => item.local_id === id)?.work_mode
    export const patchAccount = (id, patch) => Object.assign(globalThis.__t006.accounts.find((item) => item.local_id === id) || {}, patch)
  `,
  './ai-client.ts': `export class NoqrAiClient {}`,
  './bank-readonly.ts': `export const createReadOnlyBankClient = () => ({})`,
  './answer.ts': `
    export const answerNoqrGroup = async () => { throw new Error('answer path not used') }
    export const saveNoqrAnswerAndAdvance = async () => { throw new Error('save path not used') }
    export const waitForNoqrAnswerReady = async () => { throw new Error('answer boot not used') }
  `,
  './course.ts': `
    export const openNoqrCourseWork = async () => {}
    export const readNoqrCourseMenu = async () => globalThis.__t006.courses
    export const switchNoqrCourse = async () => {}
    export const waitForNoqrCourseWorkReady = async () => 'ready'
  `,
  './homework.ts': `
    const f = () => globalThis.__t006
    export const evaluateNoqrHomeworkRule = () => ({ needDo: false, maxRounds: 0, reason: 'fixture' })
    export const noqrHomeworkRuleStatus = () => 'todo'
    export const openNoqrHomework = async () => {}
    export const readNoqrHomeworks = async (page, opts) => {
      if (f().afterSelection && f().blockCourseOwners.has(page.owner)) {
        await new Promise((resolve, reject) => {
          if (opts.signal?.aborted) {
            reject(new Error('fixture stopped'))
            return
          }
          const abort = () => {
            opts.signal?.removeEventListener('abort', abort)
            reject(new Error('fixture stopped'))
          }
          opts.signal?.addEventListener('abort', abort, { once: true })
        })
      }
      if (f().afterSelection && f().delayCourseReads) {
        f().courseReadActive++
        f().courseReadPeak = Math.max(f().courseReadPeak, f().courseReadActive)
        try {
          await new Promise((resolve) => setTimeout(resolve, 40))
        } finally {
          f().courseReadActive--
        }
      }
      return []
    }
    export const resolveNoqrHomeworkCard = (cards) => cards[0]
    export const shouldResetNoqrCoursePage = () => false
  `,
  './history.ts': `
    export const newestFreshNoqrHistoryRecord = () => null
    export const readNoqrHistoryAfterOpen = async () => ({ ok: true, records: [] })
  `,
  './network.ts': `export class NoqrMutationObserver { dispose() {} }`,
  './limits.ts': `export const NOQR_ANSWER_BOOT_HARD_WAIT_MS = 1000`,
  './recovery.ts': `export const recoverNoqrCourseWorkWithoutLogin = async () => {}`,
  './selectors.ts': `export const NOQR_PATH = { home: '/index.html', courseWork: '/course_work/index.html', answer: '/course_work_detail/index.html' }; export const NOQR_SEL = {}`,
  './workflow-errors.ts': `
    export const isNoqrFatalWorkflowError = () => false
    export class NoqrScoreUnavailableError extends Error {}
    export const noqrHomeworkFailureStatus = () => null
    export const shouldDegradeNoqrBaselineFailure = () => true
  `,
  './page-policy.ts': `
    export const applyNoqrFailureToView = () => ({ preservePage: false, phase: 'unsupported' })
    export const assertNoqrRecordPageCanReturn = () => {}
    export const detectNoqrAnswerPageInterruption = async () => null
    export const noqrAnswerProgressInterruption = () => null
    export const noqrFailurePolicy = () => ({ preservePage: false, phase: 'unsupported' })
    export const shouldRestoreNoqrRecordPage = () => false
    export const shouldStopNoqrCourseAfterHomeworkFailure = () => false
    export const terminalNoqrPhase = (error) => error?.code === 'login_failed' ? 'login_failed' : 'stopped'
  `,
  './score-cache.ts': `export const newNoqrHistoryCache = () => new Map()`,
  './timing.ts': `
    export const createNoqrTimingAccumulator = () => ({})
    export const noqrPacingDelayMs = () => 0
    export const noqrPacingElapsedMs = () => 0
    export const recordNoqrGroupTiming = () => {}
    export const snapshotNoqrTiming = () => ({})
  `,
  './submit.ts': `
    export const auditNoqrAnswerCard = async () => ({ ok: true })
    export const goToNoqrAnswerCardQuestion = async () => {}
    export const noqrAnswerCardGroupKeys = () => []
    export const noqrAnswerCardExpectedGroups = () => []
    export const noqrAnswerCardKey = () => ''
    export const returnToNoqrCourseWork = async () => {}
    export const submitNoqrHomework = async () => ({ ok: true })
  `,
  './session.ts': `
    const f = () => globalThis.__t006
    export class NoqrSessionError extends Error {
      constructor(code, message) { super(message); this.code = code }
    }
    export const ensureNoqrSession = async (page, opts) => {
      opts.onPhase?.('home')
      if (f().failUsernames.has(opts.username)) {
        throw new NoqrSessionError('login_failed', 'fixture login failure')
      }
      if (f().blockUsernames.has(opts.username)) {
        await new Promise((resolve, reject) => {
          if (opts.signal?.aborted) {
            reject(new NoqrSessionError('stopped', 'fixture stopped'))
            return
          }
          const abort = () => {
            opts.signal?.removeEventListener('abort', abort)
            reject(new NoqrSessionError('stopped', 'fixture stopped'))
          }
          opts.signal?.addEventListener('abort', abort, { once: true })
        })
      }
      return { reused: true }
    }
    export const ensureNoqrHomeReady = async () => {}
    export const classifyNoqrPage = async () => 'home'
    export class NoqrNetworkActivity { dispose() {} }
    export const sleepNoqr = async () => {}
  `,
  './startup-queue.ts': `export const withNoqrStartupLock = async (_key, task) => task()`,
}

const built = await build({
  entryPoints: ['electron/noqr/run.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [{
    name: 't006-scheduler-mocks',
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, (args) => {
        if (Object.prototype.hasOwnProperty.call(modules, args.path)) {
          return { path: args.path, namespace: 't006-mock' }
        }
        return undefined
      })
      plugin.onLoad({ filter: /.*/, namespace: 't006-mock' }, (args) => ({
        contents: modules[args.path],
        loader: 'js',
      }))
    },
  }],
})

const runner = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
)

async function waitFor(check: () => boolean, label: string) {
  for (let index = 0; index < 100; index++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(label)
}

const first = runner.loginAndRefreshNoqr(['a', 'b', 'c'])
await waitFor(() => fixture.starts.includes('a') && fixture.starts.includes('b'), '前两个账号没有启动')
assert.equal(fixture.starts.includes('c'), false, '第三个账号在名额未释放时不应启动')
const queueStartedAt = Date.now()
await first
const queueLatencyMs = Date.now() - queueStartedAt
assert.deepEqual(fixture.starts, ['a', 'b', 'c'], '释放名额后没有按队列启动第三个账号')
assert.ok(queueLatencyMs < 300, `排队账号依赖轮询补位，延迟 ${queueLatencyMs}ms`)
assert.equal(fixture.occupied.size, 0, '全部账号结束后仍残留浏览器名额')
assert.deepEqual(fixture.releases.sort(), ['a', 'b', 'c'], '账号结束后没有逐一释放名额')

// Selected-course runs must not wait for queued accounts before allowing the
// active scanning accounts to start. The queued account is not scanning yet.
fixture.limit = 2
fixture.occupied.clear()
fixture.starts.length = 0
fixture.releases.length = 0
fixture.courses = [
  { key: 'course-1', name: '合成课程一', order: 1, current: true },
  { key: 'course-2', name: '合成课程二', order: 2 },
]
for (const account of fixture.accounts) account.course_scope = 'selected'
const selectedRun = runner.loginAndRefreshNoqr(['a', 'b', 'c'])
await waitFor(
  () => runner.snapshot().students.filter((student: { awaitingCourseSelection: boolean }) => student.awaitingCourseSelection).length === 2,
  '前两个可选课程账号没有进入选课阶段',
)
const firstSelection = runner.snapshot().students
  .filter((student: { awaitingCourseSelection: boolean }) => student.awaitingCourseSelection)
for (const student of firstSelection) {
  assert.equal(runner.setNoqrSelectedCourses(student.local_id, ['course-1']).ok, true, '选中课程没有写入')
}
fixture.afterSelection = true
fixture.blockCourseOwners = new Set(['a'])
assert.equal(
  runner.startNoqrSelectedCourseExecution().ok,
  true,
  '排队中的第三个账号被错误算作正在扫描，阻塞了当前批次选课',
)
await waitFor(
  () => runner.snapshot().students.find((student: { local_id: string }) => student.local_id === 'c')?.awaitingCourseSelection === true,
  '第三个账号释放后没有自动进入选课阶段',
)
assert.equal(runner.setNoqrSelectedCourses('c', ['course-1']).ok, true, '第三个账号课程没有写入')
assert.equal(runner.startNoqrSelectedCourseExecution().ok, true, '下一批排队账号的选课没有独立开始')
fixture.blockCourseOwners = new Set()
fixture.afterSelection = false
await runner.stopNoqrStudent('a')
await selectedRun
assert.deepEqual(fixture.starts, ['a', 'b', 'c'], '可选课程账号没有按队列自动接续')
assert.equal(fixture.occupied.size, 0, '可选课程账号结束后仍残留名额')

for (const courseLimit of [2, 3, 4, 5, 6, 8]) {
  fixture.limit = 1
  fixture.courseLimit = courseLimit
  fixture.occupied.clear()
  fixture.starts.length = 0
  fixture.releases.length = 0
  fixture.courses = Array.from({ length: courseLimit }, (_, index) => ({
    key: `concurrency-course-${courseLimit}-${index + 1}`,
    name: `并发课程${courseLimit}-${index + 1}`,
    order: index + 1,
    current: index === 0,
  }))
  for (const account of fixture.accounts) account.course_scope = 'selected'
  fixture.afterSelection = false
  fixture.blockCourseOwners = new Set()
  fixture.delayCourseReads = false
  fixture.courseReadActive = 0
  fixture.courseReadPeak = 0
  const courseParallelRun = runner.loginAndRefreshNoqr(['a'])
  await waitFor(
    () => runner.snapshot().students.find((student: { local_id: string }) => student.local_id === 'a')
      ?.awaitingCourseSelection === true,
    `课程并发 ${courseLimit} 没有进入选课阶段`,
  )
  assert.equal(
    runner.setNoqrSelectedCourses(
      'a',
      fixture.courses.map((course) => course.key),
    ).ok,
    true,
    `课程并发 ${courseLimit} 无法选择课程`,
  )
  fixture.afterSelection = true
  fixture.delayCourseReads = true
  assert.equal(
    runner.startNoqrSelectedCourseExecution().ok,
    true,
    `课程并发 ${courseLimit} 无法开始执行`,
  )
  await courseParallelRun
  assert.equal(
    fixture.courseReadPeak,
    courseLimit,
    `课程并发 ${courseLimit} 没有按生产接线达到配置峰值`,
  )
  await waitFor(
    () => runner.snapshot().students.find((student: { local_id: string }) => student.local_id === 'a')
      ?.slot === 'released',
    `课程并发 ${courseLimit} 结束后没有释放`,
  )
}

fixture.afterSelection = false
fixture.delayCourseReads = false
fixture.limit = 1
fixture.occupied.clear()
fixture.starts.length = 0
fixture.releases.length = 0
fixture.courses = []
for (const account of fixture.accounts) account.course_scope = 'all'
const second = runner.loginAndRefreshNoqr(['a', 'b', 'c'])
await waitFor(() => fixture.starts.includes('a'), '单并发第一个账号没有启动')
await second
assert.deepEqual(fixture.starts, ['a', 'b', 'c'], '单并发下后续账号没有自动接续')
assert.equal(fixture.occupied.size, 0, '单并发结束后仍残留名额')

fixture.limit = 2
fixture.occupied.clear()
fixture.starts.length = 0
fixture.releases.length = 0
fixture.failUsernames = new Set(['fixture-a'])
const failed = runner.loginAndRefreshNoqr(['a', 'b', 'c'])
await waitFor(
  () => fixture.starts.includes('a') && fixture.starts.includes('b'),
  '失败补位场景的前两个账号没有启动',
)
await failed
assert.deepEqual(fixture.starts, ['a', 'b', 'c'], '失败账号结束后没有自动启动下一名')
assert.deepEqual(fixture.releases.sort(), ['a', 'b', 'c'], '失败补位没有释放全部账号')
assert.equal(fixture.occupied.size, 0, '失败补位结束后仍残留名额')
assert.equal(
  runner.snapshot().students.find((student: { local_id: string }) => student.local_id === 'a')?.phase,
  'login_failed',
  '失败账号没有进入真实失败终态',
)

fixture.occupied.clear()
fixture.starts.length = 0
fixture.releases.length = 0
fixture.failUsernames = new Set()
fixture.blockUsernames = new Set(['fixture-a'])
const stoppedRun = runner.loginAndRefreshNoqr(['a', 'b', 'c'])
await waitFor(
  () => fixture.starts.includes('a') && fixture.starts.includes('b'),
  '停止补位场景的前两个账号没有启动',
)
await runner.stopNoqrStudent('a')
await waitFor(() => fixture.starts.includes('c'), '停止一个账号后排队账号没有启动')
await stoppedRun
assert.deepEqual(fixture.starts.sort(), ['a', 'b', 'c'], '停止补位没有按队列启动下一名')
assert.equal(fixture.occupied.size, 0, '停止补位结束后仍残留名额')

fixture.occupied.clear()
fixture.starts.length = 0
fixture.releases.length = 0
fixture.blockUsernames = new Set()
fixture.limit = 1
const queuedStopRun = runner.loginAndRefreshNoqr(['a', 'b'])
await waitFor(() => fixture.starts.includes('a'), '排队停止场景第一个账号没有启动')
await runner.stopNoqrStudent('b')
await queuedStopRun
assert.deepEqual(fixture.starts, ['a'], '停止排队账号后仍然晚到启动')
assert.equal(fixture.occupied.size, 0, '停止排队账号后名额没有释放')
assert.equal(
  runner.snapshot().students.find((student: { local_id: string }) => student.local_id === 'b')?.queued,
  false,
  '排队账号停止后仍残留 queued 标记',
)

fixture.occupied.clear()
fixture.starts.length = 0
fixture.releases.length = 0
fixture.blockUsernames = new Set(['fixture-a'])
fixture.limit = 2
const closeAbortRun = runner.loginAndRefreshNoqr(['a', 'b'])
await waitFor(
  () => fixture.starts.includes('a') && fixture.starts.includes('b'),
  '浏览器意外关闭场景的前两个账号没有启动',
)
for (const listener of [...fixture.releaseListeners]) {
  listener({ localId: 'a', reason: 'context_closed' })
}
await closeAbortRun
assert.equal(fixture.occupied.size, 0, '浏览器意外关闭后仍有占用名额')
assert.equal(runner.isRunning(), false, '浏览器意外关闭后运行锁没有清理')
assert.deepEqual(fixture.starts.sort(), ['a', 'b'], '浏览器意外关闭不应重复启动账号')

fixture.limit = 1
fixture.occupied.clear()
fixture.starts.length = 0
fixture.releases.length = 0
fixture.blockUsernames = new Set()
fixture.releaseFailure = new Set(['a'])
fixture.slotStates.clear()
const unconfirmedCloseRun = runner.loginAndRefreshNoqr(['a'])
await unconfirmedCloseRun
const unconfirmedCloseStudent = runner.snapshot().students.find(
  (student: { local_id: string }) => student.local_id === 'a',
)
assert.equal(
  unconfirmedCloseStudent?.slot,
  'closing',
  '浏览器关闭未确认时视图不能伪装成 released',
)
assert.equal(runner.isRunning(), true, '浏览器关闭未确认时运行锁不能提前结束')
assert.equal(runner.isStudentLocked('a'), true, '浏览器关闭未确认时同一学生不能再次启动')
assert.equal(runner.startNoqrStudent('a').ok, false, '关闭占位期间不允许重复启动同一学生')
await assert.rejects(
  runner.deleteNoqrRuntime('a'),
  /浏览器关闭尚未确认/,
  '关闭未确认时不能删除视图并隐藏容量占用',
)
assert.ok(
  runner.snapshot().students.some((student: { local_id: string }) => student.local_id === 'a'),
  '关闭未确认时删除操作不应移除学生视图',
)
fixture.releaseFailure.clear()
await runner.stopAllNoqr()
assert.equal(
  runner.snapshot().students.find((student: { local_id: string }) => student.local_id === 'a')?.slot,
  'released',
  '停止全部没有处理仅剩 closing 的账号',
)
assert.equal(runner.isRunning(), false, '停止全部后 closing 容量没有释放')

console.log(JSON.stringify({
  ok: true,
  queueLimit2: true,
  queueLimit1: true,
  failureRequeue: true,
  stopRequeue: true,
  queuedStopSuppressed: true,
  contextCloseAbort: true,
  unconfirmedCloseLocked: true,
  closingOnlyStopAll: true,
  closingDeleteGuarded: true,
  courseWiringMatrix: true,
  started: true,
  released: true,
  queueLatencyMs,
}))
