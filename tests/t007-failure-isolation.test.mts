import assert from 'node:assert/strict'
import { build } from 'esbuild'

type FixtureCourse = {
  key: string
  name: string
  order: number
  current?: boolean
}

type FixtureHomework = {
  key: string
  name: string
  workType: string
  section: 'onlineHomework'
  weightPercent: number
  startAt: string
  endAt: string
  reviewDeadline: string
  attemptsText: string
  recordCount: number
  startEnabled: boolean
  recordEnabled: boolean
}

type FixturePage = {
  owner: string
  courseKey: string
  homeworkKey: string
  currentUrl: string
  previousUrl: string
  close(): Promise<void>
  url(): string
  setDefaultNavigationTimeout(): void
}

type FailureFixture = {
  accounts: Array<{
    local_id: string
    name: string
    username: string
    password: string
    display_mode: 'headless'
    work_mode: 'noqr'
    course_scope: 'all' | 'selected'
    answer_round_limit: number
  }>
  limit: number
  courseLimit: number
  occupied: Set<string>
  slotStates: Map<string, string>
  starts: string[]
  releases: string[]
  releaseListeners: Array<(event: { localId: string; reason: string }) => void>
  contexts: Map<string, {
    pages(): FixturePage[]
    newPage(): Promise<FixturePage>
    close(): Promise<void>
  }>
  contextCloses: Record<string, number>
  pageCloses: number
  pageCloseHangs: Set<string>
  emptyContextPages: Set<string>
  newPageHangs: Set<string>
  createdPages: number
  coursesByOwner: Record<string, FixtureCourse[]>
  homeworksByOwner: Record<string, Record<string, FixtureHomework[]>>
  courseFailures: Record<string, Set<string>>
  blockedCourseKeys: Record<string, Set<string>>
  courseWorkOpenFailures: number
  answerPageOwners: Set<string>
  classifyCalls: number
  laneAborts: number
  answerCalls: Record<string, number>
  homeworkOpenCalls: Record<string, number>
  unsupportedOpenKeys: Set<string>
  homeworkReads: number
  answerBootCalls: Record<string, number>
  answerBootFailures: number
  recoveryCalls: number
  recoveryFailures: number
  saveCalls: Record<string, number>
  homeworkMutationCalls: Record<string, {
    answer: number
    save: number
    finish: number
  }>
  auditCalls: Record<string, number>
  expectedGroupCounts: number[]
  preflightReads: Record<string, number>
  preflightCode: 'unsupported_non_objective' | 'answer_interrupted' | 'page_error' | null
  repairNewGroupOnce: boolean
  answerBehavior: 'normal' | 'normal-last' | 'normal-two' | 'progress-terminal' | 'no-progress' | 'submitted-uncertain'
  historyPending: boolean
  historyReadHangs: boolean
  freshHistoryReads: number
  answeredKind: 'single' | 'multiple' | 'judge' |
    'picker' | 'english_grammar' | 'english_listening' | 'english_cloze' |
    'english_reading' | 'unknown'
  failUsernames: Set<string>
  blockUsernames: Set<string>
  afterSelection: boolean
}

const homework = (name: string): FixtureHomework => ({
  key: name,
  name,
  workType: 'onlineWork',
  section: 'onlineHomework',
  weightPercent: 20,
  startAt: '',
  endAt: '',
  reviewDeadline: '',
  attemptsText: '',
  recordCount: 0,
  startEnabled: true,
  recordEnabled: true,
})

const fixture: FailureFixture = {
  accounts: [],
  limit: 1,
  courseLimit: 2,
  occupied: new Set(),
  slotStates: new Map(),
  starts: [],
  releases: [],
  releaseListeners: [],
  contexts: new Map(),
  contextCloses: {},
  pageCloses: 0,
  pageCloseHangs: new Set(),
  emptyContextPages: new Set(),
  newPageHangs: new Set(),
  createdPages: 0,
  coursesByOwner: {},
  homeworksByOwner: {},
  courseFailures: {},
  blockedCourseKeys: {},
  courseWorkOpenFailures: 0,
  answerPageOwners: new Set(),
  classifyCalls: 0,
  laneAborts: 0,
  answerCalls: {},
  homeworkOpenCalls: {},
  unsupportedOpenKeys: new Set(),
  homeworkReads: 0,
  answerBootCalls: {},
  answerBootFailures: 0,
  recoveryCalls: 0,
  recoveryFailures: 0,
  saveCalls: {},
  homeworkMutationCalls: {},
  auditCalls: {},
  expectedGroupCounts: [],
  preflightReads: {},
  preflightCode: null,
  preflightCodeSequence: [],
  repairNewGroupOnce: false,
  answerBehavior: 'normal',
  historyPending: false,
  historyReadHangs: false,
  freshHistoryReads: 0,
  answeredKind: 'single',
  failUsernames: new Set(),
  blockUsernames: new Set(),
  afterSelection: false,
}

globalThis.__t007 = fixture as never

const modules: Record<string, string> = {
  '../pool.ts': `
    const f = () => globalThis.__t007
    const pagesByOwner = new Map()
    const makePage = (owner, isMain) => {
      const page = {
        owner,
        courseKey: '',
        homeworkKey: '',
        previousUrl: '',
        currentUrl: isMain
          ? 'https://coursework.shou.org.cn/course_work/index.html'
          : 'https://coursework.shou.org.cn/index.html',
        close: async () => {
          f().pageCloses++
          if (f().pageCloseHangs.has(owner)) await new Promise(() => {})
        },
        url() { return this.currentUrl },
        setDefaultNavigationTimeout() {},
        locator() {
          const locator = {
            first() { return locator },
            last() { return locator },
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
            evaluate: async () => true,
            evaluateAll: async () => [],
          }
          return locator
        },
      }
      return page
    }
    export const slots = {
      setLimit(n) { f().limit = n },
      get(id) { return f().slotStates.get(id) || 'queued' },
    }
    export const acquire = async (id) => {
      if (f().occupied.size >= f().limit) return { ok: false, queued: true }
      f().occupied.add(id)
      f().slotStates.set(id, 'occupied')
      f().starts.push(id)
      const main = makePage(id, true)
      pagesByOwner.set(id, [main])
      const context = {
        pages: () => f().emptyContextPages.has(id) ? [] : (pagesByOwner.get(id) || [main]),
        newPage: async () => {
          f().createdPages++
          if (f().newPageHangs.has(id)) await new Promise(() => {})
          const page = makePage(id, false)
          pagesByOwner.get(id)?.push(page)
          return page
        },
        close: async () => {
          f().contextCloses[id] = (f().contextCloses[id] || 0) + 1
        },
      }
      f().contexts.set(id, context)
      return { ok: true, context }
    }
    export const release = async (id) => {
      const context = f().contexts.get(id)
      if (context) await context.close()
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
    export const getContext = (id) => f().contexts.get(id)
    export const isHeld = (id) => f().occupied.has(id)
  `,
  '../store.ts': `
    export const listAccounts = () => globalThis.__t007.accounts
    export const getSettings = () => ({
      account_parallel: globalThis.__t007.limit,
      course_parallel: globalThis.__t007.courseLimit,
      log_enabled: true,
    })
    export const getAccountWorkMode = (id) =>
      globalThis.__t007.accounts.find((item) => item.local_id === id)?.work_mode
    export const patchAccount = (id, patch) =>
      Object.assign(globalThis.__t007.accounts.find((item) => item.local_id === id) || {}, patch)
  `,
  '../core/live-view.ts': `
    export const emptyExtractStats = () => ({ added: 0, merged: 0, skipped: 0, conflict: 0, failed: 0 })
    export const courseOutcome = (statuses) => {
      if (statuses.some((status) => ['submit_failed', 'answer_page_interrupted', 'page_interrupted', 'submitted_uncertain'].includes(status))) {
        return '有失败待处理'
      }
      if (!statuses.length) return '无作业'
      if (statuses.some((status) => status !== 'done_100' && !status.startsWith('skip_'))) return '尚未完成'
      return '本轮可做作业已完成'
    }
    export const upsertHomework = (groups, _section, name, status) => {
      const next = groups.map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row })) }))
      let group = next.find((item) => item.title === '网上记分作业')
      if (!group) {
        group = { title: '网上记分作业', rows: [] }
        next.push(group)
      }
      const index = group.rows.findIndex((row) => row.name === name)
      if (index >= 0) group.rows[index] = { ...group.rows[index], status }
      else group.rows.push({ name, status, questions: [] })
      return next
    }
    export const recordQuestion = () => {}
  `,
  './ai-client.ts': `export class NoqrAiClient {}`,
  './bank-readonly.ts': `export const createReadOnlyBankClient = () => ({})`,
  './question.ts': `
    export const buildNoqrQuestionGroupSessionKey = (group, occurrence = 1) => {
      const base = JSON.stringify({ kind: group.kind, position: group.position || 0, total: group.total || 0 })
      return occurrence > 1 ? base + '#' + occurrence : base
    }
    export const readNoqrQuestionGroup = async ({ owner }) => {
      globalThis.__t007.preflightReads[owner] =
        (globalThis.__t007.preflightReads[owner] || 0) + 1
      return {
        ok: true,
        group: {
          kind: 'single',
          position: globalThis.__t007.repairNewGroupOnce ? 2 : 1,
          total: 2,
          units: [{ id: 'unit-1', ordinal: 1, qtype: 'single', stem: 'fixture', options: [] }],
        },
      }
    }
  `,
  './answer.ts': `
    const f = () => globalThis.__t007
    const recordMutation = (page, kind) => {
      const key = page.homeworkKey
      if (!key) throw new Error('fixture mutation had no homework attribution')
      const entry = f().homeworkMutationCalls[key] || { answer: 0, save: 0, finish: 0 }
      entry[kind]++
      f().homeworkMutationCalls[key] = entry
    }
    const group = {
      kind: f().answeredKind,
      title: '',
      position: 1,
      total: 2,
      sharedStem: '',
      stem: '',
      options: [],
      subQuestions: [],
      pickerValues: [],
      lastQuestion: false,
      units: [{
        id: 'unit-1',
        ordinal: 1,
        qtype: 'single',
        stem: 'fixture',
        options: [],
      }],
    }
    export const answerNoqrGroup = async ({ page }) => {
      const calls = (f().answerCalls[page.owner] || 0) + 1
      f().answerCalls[page.owner] = calls
      recordMutation(page, 'answer')
      if (f().answerBehavior === 'no-progress') {
        throw new Error('fixture normal AI failure')
      }
      return {
        group: { ...group, kind: f().answeredKind },
        answers: [{ source: 'ai', selectedTexts: ['fixture'] }],
        bankCount: 0,
        aiCount: 1,
      }
    }
    export const saveNoqrAnswerAndAdvance = async (opts) => {
      const page = opts?.page
      const owner = page?.owner || 'unknown'
      f().saveCalls[owner] = (f().saveCalls[owner] || 0) + 1
      recordMutation(page, 'save')
      if (f().answerBehavior === 'submitted-uncertain') {
        return {
          saved: false,
          advanced: false,
          lastQuestion: false,
          uncertain: true,
          state: 'submitted_uncertain',
        }
      }
      if (f().answerBehavior === 'progress-terminal') {
        return {
          saved: true,
          advanced: false,
          lastQuestion: false,
          uncertain: false,
          state: 'saved',
        }
      }
      if (f().answerBehavior === 'normal-two') {
        return {
          saved: true,
          advanced: true,
          lastQuestion: f().saveCalls[owner] >= 2,
          uncertain: false,
          state: 'saved',
        }
      }
      if (f().answerBehavior === 'normal-last') {
        return {
          saved: true,
          advanced: true,
          lastQuestion: true,
          uncertain: false,
          state: 'saved',
        }
      }
      return {
        saved: true,
        advanced: true,
        lastQuestion: false,
        uncertain: false,
        state: 'saved',
      }
    }
    export const waitForNoqrAnswerReady = async ({ page }) => {
      const calls = (f().answerBootCalls[page.owner] || 0) + 1
      f().answerBootCalls[page.owner] = calls
      if (f().answerBootFailures > 0) {
        f().answerBootFailures--
        throw new Error('fixture answer boot failure')
      }
    }
  `,
  './course.ts': `
    const f = () => globalThis.__t007
    export const openNoqrCourseWork = async (page) => {
      if (f().courseWorkOpenFailures > 0) {
        f().courseWorkOpenFailures--
        throw Object.assign(new Error('fixture blank course work page'), { code: 'blank_page' })
      }
      page.currentUrl = 'https://coursework.shou.org.cn/course_work/index.html'
    }
    export const readNoqrCourseMenu = async (page) => f().coursesByOwner[page.owner] || []
    export const switchNoqrCourse = async (page, course) => {
      page.courseKey = course.key
      page.currentUrl = 'https://coursework.shou.org.cn/course_work/index.html?courseId=' + encodeURIComponent(course.key)
      if (f().courseFailures[page.owner]?.has(course.key)) {
        throw new Error('fixture course failure')
      }
    }
    export const waitForNoqrCourseWorkReady = async () => 'ready'
  `,
  './homework.ts': `
    const f = () => globalThis.__t007
    export const evaluateNoqrHomeworkRule = () => ({ needDo: true, maxRounds: 1, reason: 'fixture' })
    export const noqrHomeworkRuleStatus = () => 'todo'
    export const openNoqrHomework = async (page, item) => {
      f().homeworkOpenCalls[item.key] = (f().homeworkOpenCalls[item.key] || 0) + 1
      page.previousUrl = page.currentUrl
      page.homeworkKey = item.key
      page.currentUrl = 'https://coursework.shou.org.cn/course_work_detail/index.html?workId=' + encodeURIComponent(item.key)
      if (f().unsupportedOpenKeys.has(item.key)) {
        throw Object.assign(new Error('fixture unsupported work type'), { code: 'unsupported_work_type' })
      }
      f().answerPageOwners.add(page.owner)
    }
    export const readNoqrHomeworks = async (page, opts) => {
      f().homeworkReads++
      if (!f().afterSelection) return []
      if (f().blockedCourseKeys[page.owner]?.has(page.courseKey)) {
        await new Promise((resolve, reject) => {
          const signal = opts.signal
          if (signal?.aborted) {
            f().laneAborts++
            reject(new Error('fixture lane aborted'))
            return
          }
          const abort = () => {
            signal?.removeEventListener('abort', abort)
            f().laneAborts++
            reject(new Error('fixture lane aborted'))
          }
          signal?.addEventListener('abort', abort, { once: true })
        })
      }
      return f().homeworksByOwner[page.owner]?.[page.courseKey] || []
    }
    export const resolveNoqrHomeworkCard = (cards, planned) =>
      cards.find((card) => card.key === planned.key) || cards[0]
    export const shouldResetNoqrCoursePage = () => false
  `,
  './history.ts': `
    const f = () => globalThis.__t007
    export const newestFreshNoqrHistoryRecord = () => null
    export const readNoqrHistoryAfterOpen = async (opts) => {
      if (opts?.requireFreshRecord) f().freshHistoryReads++
      if (opts?.requireFreshRecord && f().historyReadHangs) {
        await new Promise(() => {})
      }
      if (opts?.requireFreshRecord && f().historyPending) {
        return {
          ok: false,
          records: [],
          latest: null,
          apiCount: 0,
          domCount: 0,
          error: '作答记录尚未出现新的有效分数',
        }
      }
      return { ok: true, records: [] }
    }
  `,
  './network.ts': `export class NoqrMutationObserver { dispose() {} }`,
  './limits.ts': `
    export const NOQR_ANSWER_CARD_HARD_WAIT_MS = 1000
    export const NOQR_ANSWER_BOOT_HARD_WAIT_MS = 1000
    export const NOQR_SCORE_PENDING_WAIT_MS = 600000
    export const withNoqrHardDeadline = (task, deadlineMs, onTimeout) => {
      let timer
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          Promise.resolve().then(onTimeout).then(resolve, reject)
        }, Math.max(50, Number(deadlineMs) || 0))
      })
      return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
    }
  `,
  './recovery.ts': `
    export const recoverNoqrCourseWorkWithoutLogin = async (page) => {
      globalThis.__t007.recoveryCalls++
      if (globalThis.__t007.afterSelection && globalThis.__t007.recoveryFailures > 0) {
        globalThis.__t007.recoveryFailures--
        throw new Error('fixture recovery failure')
      }
      page.currentUrl = page.previousUrl || page.currentUrl
    }
  `,
  './selectors.ts': `
    export const NOQR_PATH = {
      home: '/index.html',
      courseWork: '/course_work/index.html',
      answer: '/course_work_detail/index.html',
    }
    export const NOQR_SEL = {}
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
    export const preflightNoqrObjectiveOnlyAnswerCard = async () => {
      const queuedCodes = globalThis.__t007.preflightCodeSequence
      const code = queuedCodes.length
        ? queuedCodes.shift()
        : globalThis.__t007.preflightCode
      return code
        ? { ok: false, code, reason: 'fixture preflight rejection', titles: [] }
        : { ok: true, titles: ['单选题'] }
    }
    export const auditNoqrAnswerCard = async (page, opts) => {
      const calls = (globalThis.__t007.auditCalls[page.owner] || 0) + 1
      globalThis.__t007.auditCalls[page.owner] = calls
      if (Array.isArray(opts?.expectedGroups)) {
        globalThis.__t007.expectedGroupCounts.push(opts.expectedGroups.length)
      }
      if (globalThis.__t007.repairNewGroupOnce && calls === 1) {
        return { ok: false, answered: 1, current: 0, unanswered: 1, missingKeys: ['single#2'] }
      }
      return { ok: true }
    }
    export const goToNoqrAnswerCardQuestion = async () => {}
    export const noqrAnswerCardGroupKeys = () => []
    export const noqrAnswerCardExpectedGroups = () => []
    export const noqrAnswerCardKey = () => ''
    export const hasVisibleNoqrAnswerCardButton = async () => true
    export const readNoqrAnswerCardDiagnostic = async () => null
    export const returnToNoqrCourseWork = async (page) => {
      page.currentUrl = page.previousUrl || page.currentUrl
    }
    export const submitNoqrHomework = async (opts) => {
      const key = opts?.page?.homeworkKey || ''
      if (!key) throw new Error('fixture finish had no homework attribution')
      const entry = globalThis.__t007.homeworkMutationCalls[key] ||
        { answer: 0, save: 0, finish: 0 }
      entry.finish++
      globalThis.__t007.homeworkMutationCalls[key] = entry
      return { ok: true }
    }
  `,
  './submit-surface.ts': `
    export const waitForNoqrAnswerSurfaceBeforeSubmit = async () => {}
  `,
  './session.ts': `
    const f = () => globalThis.__t007
    const answerPath = '/course_work_detail/index.html'
    export class NoqrSessionError extends Error {
      constructor(code, message) {
        super(message)
        this.code = code
      }
    }
    export const isNoqrAnswerPath = (url) => {
      try { return new URL(url).pathname === answerPath } catch { return false }
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
    export const classifyNoqrPage = async (page) => {
      f().classifyCalls++
      if (isNoqrAnswerPath(page.url())) {
        if (f().answerBehavior === 'normal-last' || f().answerBehavior === 'normal-two') return 'answer'
        if (f().answerPageOwners.has(page.owner)) return 'blank'
      }
      return 'home'
    }
    export class NoqrNetworkActivity {
      isBusinessActive() { return false }
      dispose() {}
    }
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
    name: 't007-failure-isolation-mocks',
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, (args) => {
        if (Object.prototype.hasOwnProperty.call(modules, args.path)) {
          return { path: args.path, namespace: 't007-mock' }
        }
        return undefined
      })
      plugin.onLoad({ filter: /.*/, namespace: 't007-mock' }, (args) => ({
        contents: modules[args.path],
        loader: 'js',
      }))
    },
  }],
})

const runner = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
)

function account(id: string, courseScope: 'all' | 'selected') {
  return {
    local_id: id,
    name: id.toUpperCase(),
    username: `fixture-${id}`,
    password: 'fixture',
    display_mode: 'headless' as const,
    work_mode: 'noqr' as const,
    course_scope: courseScope,
    answer_round_limit: 10,
  }
}

function resetFixture(opts: {
  accounts: ReturnType<typeof account>[]
  limit: number
  courseLimit: number
}) {
  fixture.accounts = opts.accounts
  fixture.limit = opts.limit
  fixture.courseLimit = opts.courseLimit
  fixture.occupied.clear()
  fixture.slotStates.clear()
  fixture.starts.length = 0
  fixture.releases.length = 0
  fixture.contexts.clear()
  fixture.contextCloses = {}
  fixture.pageCloses = 0
  fixture.pageCloseHangs = new Set()
  fixture.emptyContextPages = new Set()
  fixture.newPageHangs = new Set()
  fixture.createdPages = 0
  fixture.coursesByOwner = {}
  fixture.homeworksByOwner = {}
  fixture.courseFailures = {}
  fixture.blockedCourseKeys = {}
  fixture.courseWorkOpenFailures = 0
  fixture.answerPageOwners = new Set()
  fixture.classifyCalls = 0
  fixture.laneAborts = 0
  fixture.answerCalls = {}
  fixture.homeworkOpenCalls = {}
  fixture.unsupportedOpenKeys = new Set()
  fixture.homeworkReads = 0
  fixture.answerBootCalls = {}
  fixture.answerBootFailures = 0
  fixture.recoveryCalls = 0
  fixture.recoveryFailures = 0
  fixture.saveCalls = {}
  fixture.homeworkMutationCalls = {}
  fixture.auditCalls = {}
  fixture.expectedGroupCounts = []
  fixture.preflightReads = {}
  fixture.preflightCode = null
  fixture.preflightCodeSequence = []
  fixture.repairNewGroupOnce = false
  fixture.answerBehavior = 'normal'
  fixture.historyPending = false
  fixture.historyReadHangs = false
  fixture.freshHistoryReads = 0
  fixture.answeredKind = 'single'
  fixture.failUsernames = new Set()
  fixture.blockUsernames = new Set()
  fixture.afterSelection = false
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(label)
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function selectAndStart(owner: string, keys: string[]) {
  await waitFor(
    () => runner.snapshot().students.find(
      (student: { local_id: string }) => student.local_id === owner,
    )?.awaitingCourseSelection === true,
    `${owner} did not enter course selection`,
  )
  assert.equal(runner.setNoqrSelectedCourses(owner, keys).ok, true, `${owner} selection failed`)
  fixture.afterSelection = true
  fixture.recoveryCalls = 0
  assert.equal(runner.startNoqrSelectedCourseExecution().ok, true, `${owner} did not start`)
}

function student(id: string) {
  return runner.snapshot().students.find(
    (item: { local_id: string }) => item.local_id === id,
  )
}

const courses = [
  { key: 'course-1', name: 'Course 1', order: 1, current: true },
  { key: 'course-2', name: 'Course 2', order: 2 },
]
let repairNewGroupFailsBeforeSave = false

// A saved progress failure is account-terminal. The answer page is never
// refreshed or re-entered; the account must release and the queued account
// must start without processing the next homework in the failed account.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 2 })
fixture.coursesByOwner.a = courses
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1'), homework('Homework 2')],
  'course-2': [],
}
fixture.answerBehavior = 'progress-terminal'
const terminalRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1', 'course-2'])
fixture.pageCloseHangs = new Set(['a'])
const terminalStartedAt = Date.now()
await within(terminalRun, 6000, 'saved progress failure kept the account slot occupied')
assert.ok(Date.now() - terminalStartedAt < 5000, 'account terminal handling was not prompt')
assert.deepEqual(fixture.starts, ['a', 'b'], 'queued B did not start after A terminal failure')
assert.ok(fixture.releases.includes('a') && fixture.releases.includes('b'), 'terminal failure did not release both slots')
assert.ok((fixture.contextCloses.a || 0) >= 1, 'terminal failure did not close A browser context')
assert.ok(fixture.pageCloses > 0, 'terminal failure did not close A pages')
assert.ok(fixture.releases.includes('a'), 'hung page close blocked the bounded release path')
assert.equal(student('a')?.phase, 'needs_user', 'saved-progress failure was not account-terminal')
assert.match(student('a')?.action || '', /答題|答案|保存|中断|interrupted|异常/i, 'A did not retain the real failure status')
assert.equal(fixture.answerCalls.a, 1, 'saved-progress failure incorrectly continued to the next homework')
assert.equal(fixture.recoveryCalls, 0, 'saved-progress failure incorrectly created a fresh course page')
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'answer_page_interrupted',
  'saved progress failure status was not retained',
)
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[1]?.status,
  undefined,
  'the next homework was started after an account-terminal progress failure',
)

// A blank course-work entry after the bounded non-answer retries is an
// account-local detection failure. It must release the slot and let the
// queued account continue instead of switching the whole app to needs_user.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = [courses[0]]
fixture.homeworksByOwner.a = { 'course-1': [] }
fixture.homeworksByOwner.b = { 'course-1': [] }
fixture.courseWorkOpenFailures = 1
const blankCourseWorkRun = runner.loginAndRefreshNoqr(['a', 'b'])
await within(blankCourseWorkRun, 2500, 'blank course-work detection blocked the queue')
assert.deepEqual(fixture.starts, ['a', 'b'], 'blank course-work detection did not wake queued B')
assert.equal(fixture.releases.includes('a'), true, 'blank course-work detection did not release A')
assert.equal(student('a')?.phase, 'not_full', 'blank course-work detection was promoted to manual handling')
assert.notEqual(
  student('a')?.accountState,
  'needs_verify',
  'blank course-work detection left the account in manual verification',
)

// Detection lane pages must close with a bounded budget. A hung extra page
// cannot retain the account slot or leave the next account queued forever.
resetFixture({ accounts: [account('a', 'all'), account('b', 'all')], limit: 1, courseLimit: 2 })
fixture.coursesByOwner.a = courses
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [],
  'course-2': [],
}
fixture.pageCloseHangs = new Set(['a'])
const laneCloseRun = runner.loginAndRefreshNoqr(['a', 'b'])
await within(laneCloseRun, 4_000, 'hung detection lane page blocked account release')
assert.deepEqual(fixture.starts, ['a', 'b'], 'queued B did not start after A detection lane close')
assert.ok(fixture.releases.includes('a') && fixture.releases.includes('b'),
  'hung detection lane page prevented both accounts from releasing')

// Stopping an account that is only waiting for browser-close confirmation
// must actively retry release instead of leaving it in closing forever.
resetFixture({ accounts: [account('a', 'all')], limit: 1, courseLimit: 1 })
fixture.slotStates.set('a', 'closing')
await runner.stopNoqrStudent('a')
assert.equal(fixture.slotStates.get('a'), 'released',
  'closing-only stop did not actively retry browser release')
assert.ok(fixture.releases.includes('a'), 'closing-only stop did not call pool release')

// An uncertain save is account-terminal even before a logical group is saved.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1')],
}
fixture.answerBehavior = 'submitted-uncertain'
const uncertainRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(uncertainRun, 2500, 'submitted_uncertain did not release the account')
assert.deepEqual(fixture.starts, ['a', 'b'], 'submitted_uncertain did not wake queued B')
assert.equal(student('a')?.phase, 'needs_user', 'submitted_uncertain did not retain terminal phase')
assert.equal(fixture.answerCalls.a, 1, 'submitted_uncertain triggered a second answer/save attempt')
assert.equal(fixture.recoveryCalls, 0, 'submitted_uncertain entered answer_interrupted recovery')
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'submitted_uncertain',
  'submitted_uncertain status was not retained',
)

// Answer-card repair must fail closed before writing a logical group that was
// never recorded during the original read-through.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1')],
}
fixture.answerBehavior = 'normal-last'
fixture.repairNewGroupOnce = true
const repairRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(repairRun, 2500, 'repair new-group rejection did not release the account')
assert.equal(fixture.preflightReads.a, 1, 'repair did not preflight the unexpected logical group')
assert.equal(fixture.answerCalls.a, 1, 'repair entered answerNoqrGroup before rejecting the new logical group')
assert.equal(fixture.saveCalls.a, 1, 'repair saved before rejecting an unrecorded logical group')
assert.equal(student('a')?.phase, 'needs_user', 'repair new-group rejection was not retained')
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'answer_page_interrupted',
  'repair new-group rejection did not retain the interrupted answer-page status',
)
repairNewGroupFailsBeforeSave = true

// Two visible groups with identical content, position, and identity are still
// two logical groups. Their session keys must be occurrence-scoped so the
// answer-card audit receives both groups rather than silently dropping one.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1')],
}
fixture.answerBehavior = 'normal-two'
const duplicateGroupRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(duplicateGroupRun, 2500, 'duplicate-content groups did not finish')
assert.equal(fixture.saveCalls.a, 2, 'duplicate-content groups were not saved twice')
assert.ok(
  fixture.expectedGroupCounts.includes(2),
  `duplicate-content groups were folded before the answer-card audit: ` +
    `counts=${fixture.expectedGroupCounts.join(',')}, audit=${fixture.auditCalls.a || 0}, ` +
    `phase=${student('a')?.phase || 'missing'}`,
)

// A submitted homework whose history never exposes a fresh score must not
// occupy the account forever. After the bounded wait, it is recorded as
// score_unavailable and the same account continues with the next homework.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1'), homework('Homework 2')],
}
fixture.historyPending = true
fixture.answerBehavior = 'normal-last'
const pendingPreviousBudget = process.env.KAIDA_T005_SCORE_PENDING_BUDGET_MS
process.env.KAIDA_T005_SCORE_PENDING_BUDGET_MS = '50'
try {
  const pendingScoreRun = runner.loginAndRefreshNoqr(['a', 'b'])
  await selectAndStart('a', ['course-1'])
  await within(pendingScoreRun, 2500, 'pending history score blocked queue release')
  assert.deepEqual(fixture.starts, ['a', 'b'], 'pending history score did not wake the queued account')
  assert.ok(fixture.releases.includes('a') && fixture.releases.includes('b'),
    'pending history score prevented both accounts from releasing')
  assert.equal(
    fixture.answerCalls.a,
    2,
    `pending score did not continue to the next homework (calls=${fixture.answerCalls.a}, recovery=${fixture.recoveryCalls}, homeworkReads=${fixture.homeworkReads}, starts=${fixture.starts.join(',')}, rows=${JSON.stringify(student('a')?.courses?.find((course: { key: string }) => course.key === 'course-1')?.groups?.[0]?.rows?.map((row: { name: string; status: string }) => [row.name, row.status]))})`,
  )
  assert.equal(
    student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
      ?.groups[0]?.rows[0]?.status,
    'score_unavailable',
    `pending history score was not retained as score_unavailable (calls=${fixture.answerCalls.a}, recovery=${fixture.recoveryCalls}, homeworkReads=${fixture.homeworkReads}, action=${student('a')?.action || ''})`,
  )
  assert.equal(
    student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
      ?.groups[0]?.rows[1]?.status,
    'score_unavailable',
    'the next homework did not receive the same bounded score handling',
  )
} finally {
  if (pendingPreviousBudget === undefined) delete process.env.KAIDA_T005_SCORE_PENDING_BUDGET_MS
  else process.env.KAIDA_T005_SCORE_PENDING_BUDGET_MS = pendingPreviousBudget
}

// A non-objective answer-card preflight must skip the whole homework before
// answer/save, keep the account alive, and continue with the next homework.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1'), homework('Homework 2')],
}
fixture.preflightCode = 'unsupported_non_objective'
const preflightSkipRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(preflightSkipRun, 2500, 'non-objective preflight did not continue the queue')
assert.deepEqual(fixture.starts, ['a', 'b'], 'non-objective preflight did not wake queued B')
assert.equal(fixture.answerCalls.a || 0, 0, 'non-objective preflight reached answer/save planning')
assert.equal(fixture.saveCalls.a || 0, 0, 'non-objective preflight reached save')
assert.deepEqual(
  fixture.homeworkMutationCalls['Homework 1'] || { answer: 0, save: 0, finish: 0 },
  { answer: 0, save: 0, finish: 0 },
  'the isolated homework emitted an answer/save/finish mutation',
)
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'skip_non_objective',
  'non-objective preflight was not retained as skip_non_objective',
)
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[1]?.status,
  'skip_non_objective',
  'non-objective preflight blocked the next homework',
)

// A rejected non-objective homework must not poison the rest of the course.
// The next naturally objective homework must enter the real answer/save path.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1'), homework('Homework 2')],
}
fixture.preflightCodeSequence = ['unsupported_non_objective', null]
fixture.answerBehavior = 'normal-last'
const mixedPreflightRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(mixedPreflightRun, 2500, 'skip-then-success preflight did not finish the course')
assert.deepEqual(fixture.starts, ['a', 'b'], 'skip-then-success preflight did not wake queued B')
assert.equal(fixture.answerCalls.a, 1, 'the second objective homework did not enter the answer path')
assert.equal(fixture.saveCalls.a, 1, 'the second objective homework did not save')
assert.deepEqual(
  fixture.homeworkMutationCalls['Homework 1'] || { answer: 0, save: 0, finish: 0 },
  { answer: 0, save: 0, finish: 0 },
  'the first skipped homework emitted a mutation before the second homework ran',
)
assert.deepEqual(
  fixture.homeworkMutationCalls['Homework 2'],
  { answer: 1, save: 1, finish: 1 },
  'the successful homework did not own exactly one answer/save/finish sequence',
)
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'skip_non_objective',
  'the first non-objective homework was not isolated',
)
assert.notEqual(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[1]?.status,
  'skip_non_objective',
  'the next objective homework was incorrectly isolated with the first one',
)

// A composite card whose later row is textarea/unreadable is an unprovable
// structure, not a reason to write or submit the first objective group.
// The first homework must remain zero-mutation and the second must still run.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Unprovable composite'), homework('Objective after composite')],
}
fixture.preflightCodeSequence = ['unsupported_non_objective', null]
fixture.answerBehavior = 'normal-last'
const unprovableCompositeRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(unprovableCompositeRun, 2500, 'unprovable composite did not continue to the next homework')
assert.deepEqual(fixture.starts, ['a', 'b'], 'unprovable composite did not wake queued B')
assert.equal(fixture.answerCalls.a, 1, 'the second homework after the unprovable composite was not answered')
assert.equal(fixture.saveCalls.a, 1, 'the second homework after the unprovable composite was not saved')
assert.deepEqual(
  fixture.homeworkMutationCalls['Unprovable composite'] || { answer: 0, save: 0, finish: 0 },
  { answer: 0, save: 0, finish: 0 },
  'the unprovable composite emitted an answer/save/finish mutation',
)
assert.deepEqual(
  fixture.homeworkMutationCalls['Objective after composite'],
  { answer: 1, save: 1, finish: 1 },
  'the homework after the unprovable composite did not own its mutation chain',
)
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'skip_non_objective',
  'the unprovable composite was not isolated as skip_non_objective',
)
assert.notEqual(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[1]?.status,
  'skip_non_objective',
  'the homework after the unprovable composite was incorrectly skipped',
)

// A work card that advertises a supported work type but opens an unsupported
// answer URL is a homework-local skip. It must not be retried indefinitely,
// and the next objective homework must remain reachable.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1'), homework('Homework 2'), homework('Homework 3')],
}
fixture.unsupportedOpenKeys = new Set(['Homework 1', 'Homework 2'])
fixture.answerBehavior = 'normal-last'
const unsupportedOpenRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(unsupportedOpenRun, 2500, 'unsupported work type retried instead of skipping')
assert.deepEqual(fixture.starts, ['a', 'b'], 'unsupported work type did not wake queued B')
assert.equal(fixture.homeworkOpenCalls['Homework 1'], 1, 'first unsupported homework was retried')
assert.equal(fixture.homeworkOpenCalls['Homework 2'], 1, 'second unsupported homework was retried')
assert.equal(fixture.answerCalls.a, 1, 'the objective homework after unsupported cards was not answered')
assert.equal(fixture.saveCalls.a, 1, 'the objective homework after unsupported cards was not saved')
assert.deepEqual(
  fixture.homeworkMutationCalls['Homework 1'] || { answer: 0, save: 0, finish: 0 },
  { answer: 0, save: 0, finish: 0 },
  'the first unsupported work type emitted a mutation',
)
assert.deepEqual(
  fixture.homeworkMutationCalls['Homework 2'] || { answer: 0, save: 0, finish: 0 },
  { answer: 0, save: 0, finish: 0 },
  'the second unsupported work type emitted a mutation',
)
assert.deepEqual(
  fixture.homeworkMutationCalls['Homework 3'],
  { answer: 1, save: 1, finish: 1 },
  'the objective homework after unsupported cards lacked its own mutation chain',
)
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'skip_non_objective',
  'the first unsupported work type was not isolated',
)
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[1]?.status,
  'skip_non_objective',
  'the second unsupported work type was not isolated',
)
assert.notEqual(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[2]?.status,
  'skip_non_objective',
  'the objective homework after unsupported cards was incorrectly isolated',
)

// Existing answer-card progress must stay a preserved answer_interrupted
// failure, not be downgraded to a non-objective skip.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1')],
}
fixture.preflightCode = 'answer_interrupted'
const preflightInterruptedRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(preflightInterruptedRun, 2500, 'answer_interrupted preflight did not release the queue')
assert.deepEqual(fixture.starts, ['a', 'b'], 'answer_interrupted preflight did not wake queued B')
assert.equal(fixture.answerCalls.a || 0, 0, 'answer_interrupted preflight reached answer/save planning')
assert.equal(fixture.saveCalls.a || 0, 0, 'answer_interrupted preflight reached save')
assert.equal(student('a')?.phase, 'needs_user', 'answer_interrupted preflight did not preserve manual handling')
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'answer_page_interrupted',
  'answer_interrupted preflight was downgraded to another status',
)

// The pending-score budget must also bound a single history helper call that
// never returns. Checking the budget only after the helper resolves can hold
// the account forever.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1'), homework('Homework 2')],
}
fixture.historyReadHangs = true
fixture.answerBehavior = 'normal-last'
const hangingReadPreviousBudget = process.env.KAIDA_T005_SCORE_PENDING_BUDGET_MS
process.env.KAIDA_T005_SCORE_PENDING_BUDGET_MS = '50'
try {
  const hangingReadRun = runner.loginAndRefreshNoqr(['a', 'b'])
  await selectAndStart('a', ['course-1'])
  await within(hangingReadRun, 2500, 'unreturned history read bypassed the pending-score budget')
  assert.deepEqual(fixture.starts, ['a', 'b'], 'unreturned history read did not wake the queued account')
  assert.equal(
    student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
      ?.groups[0]?.rows[0]?.status,
    'score_unavailable',
    'unreturned history read was not retained as score_unavailable',
  )
  assert.equal(fixture.answerCalls.a, 2, 'unreturned history read prevented the next homework')
} finally {
  if (hangingReadPreviousBudget === undefined) delete process.env.KAIDA_T005_SCORE_PENDING_BUDGET_MS
  else process.env.KAIDA_T005_SCORE_PENDING_BUDGET_MS = hangingReadPreviousBudget
}

// An ordinary answer/AI error with zero saved logical groups is homework-local:
// it must not be promoted to answer_interrupted or hold the account slot.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = courses
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1'), homework('Homework 2')],
  'course-2': [],
}
fixture.answerBehavior = 'no-progress'
const ordinaryRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1', 'course-2'])
await within(ordinaryRun, 2500, 'ordinary no-progress error did not release the account')
assert.deepEqual(fixture.starts, ['a', 'b'], 'ordinary failure did not let queued B start')
assert.equal(fixture.answerCalls.a, 2, 'ordinary no-progress failure did not continue the next homework')
assert.equal(fixture.recoveryCalls, 2, 'each no-progress homework failure did not attempt one bounded recovery')
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'submit_failed',
  'ordinary homework failure was not isolated',
)
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[1]?.status,
  'submit_failed',
  'the next homework in the same course was not processed',
)

// An answer-page boot failure with no saved progress is also homework-local.
// Recover back to the course work page, then continue with the next homework.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = courses
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1'), homework('Homework 2')],
  'course-2': [],
}
fixture.answerBootFailures = 1
fixture.answerBehavior = 'no-progress'
const bootFailureRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(bootFailureRun, 2500, 'answer boot failure did not release the account')
assert.equal(fixture.answerBootCalls.a, 2, 'answer boot failure did not continue the next homework')
assert.equal(fixture.answerCalls.a, 1, 'answer boot failure should not enter the answer flow')
assert.equal(fixture.recoveryCalls, 2, 'answer boot failure and later homework did not recover locally')
assert.ok(fixture.releases.includes('a'), 'answer boot failure did not release the account')
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[0]?.status,
  'submit_failed',
  'answer boot failure was not isolated to the first homework',
)
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[1]?.status,
  'submit_failed',
  'the next homework was not processed after an answer boot failure',
)

// If returning from an answer page fails, replace only the unusable course
// page and continue the next homework instead of stopping the whole course.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = courses
fixture.coursesByOwner.b = []
fixture.homeworksByOwner.a = {
  'course-1': [homework('Homework 1'), homework('Homework 2')],
  'course-2': [],
}
fixture.answerBehavior = 'no-progress'
fixture.recoveryFailures = 1
const recoveryFailureRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(recoveryFailureRun, 2500, 'recovery failure did not allow the course to continue')
assert.equal(fixture.recoveryCalls, 2, 'recovery failure did not retry from a fresh course page')
assert.equal(fixture.createdPages, 2, 'recovery failure did not create one replacement course page')
assert.equal(fixture.answerCalls.a, 2, 'recovery failure skipped the next homework in the same course')
assert.deepEqual(fixture.starts, ['a', 'b'], 'recovery failure stopped the queued account')
assert.equal(
  student('a')?.courses.find((course: { key: string }) => course.key === 'course-1')
    ?.groups[0]?.rows[1]?.status,
  'submit_failed',
  'the next homework was not isolated after a recovery failure',
)

// A course-level failure must be isolated and must not prevent the next
// account from starting.
resetFixture({ accounts: [account('a', 'selected'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = [courses[0]]
fixture.coursesByOwner.b = []
fixture.courseFailures.a = new Set(['course-1'])
const courseFailureRun = runner.loginAndRefreshNoqr(['a', 'b'])
await selectAndStart('a', ['course-1'])
await within(courseFailureRun, 2500, 'course failure did not release the account')
assert.deepEqual(fixture.starts, ['a', 'b'], 'course failure stopped the queued account')
assert.ok(fixture.releases.includes('a') && fixture.releases.includes('b'), 'course failure leaked a slot')
assert.equal(student('a')?.courses[0]?.status, '检测失败', 'course failure was not retained')

// Login failure is account-terminal but must be skipped cleanly so B starts.
resetFixture({ accounts: [account('a', 'all'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.coursesByOwner.a = []
fixture.coursesByOwner.b = []
fixture.failUsernames = new Set(['fixture-a'])
const loginFailureRun = runner.loginAndRefreshNoqr(['a', 'b'])
await within(loginFailureRun, 2000, 'login failure did not release the account')
assert.deepEqual(fixture.starts, ['a', 'b'], 'login failure did not start the queued account')
assert.equal(student('a')?.phase, 'login_failed', 'login failure did not retain its terminal phase')
assert.equal(student('a')?.slot, 'released', 'login failure did not release the slot')

// A browser context that never resolves newPage must still be stoppable and
// release both the active and queued accounts.
resetFixture({ accounts: [account('a', 'all'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.emptyContextPages.add('a')
fixture.newPageHangs.add('a')
fixture.coursesByOwner.a = []
fixture.coursesByOwner.b = []
const hangingPageRun = runner.loginAndRefreshNoqr(['a', 'b'])
await waitFor(() => fixture.starts.includes('a'), 'hanging newPage scenario did not acquire A')
await within(
  runner.stopNoqrStudent('a'),
  1000,
  'stop could not interrupt a permanently hanging context.newPage()',
)
await within(hangingPageRun, 2000, 'hanging newPage kept the account run alive')
assert.deepEqual(fixture.starts, ['a', 'b'], 'hanging newPage prevented the queued account from starting')
assert.equal(fixture.occupied.size, 0, 'hanging newPage leaked browser capacity')

// stopAll must abort queued waiters so B cannot start late after A releases.
resetFixture({ accounts: [account('a', 'all'), account('b', 'all')], limit: 1, courseLimit: 1 })
fixture.blockUsernames = new Set(['fixture-a'])
const stopRun = runner.loginAndRefreshNoqr(['a', 'b'])
await waitFor(() => fixture.starts.includes('a'), 'stop scenario did not start A')
await runner.stopAllNoqr()
await within(stopRun, 2000, 'stopAll left the run hanging')
await new Promise((resolve) => setTimeout(resolve, 250))
assert.deepEqual(fixture.starts, ['a'], 'stopAll allowed queued B to start late')
assert.equal(fixture.occupied.size, 0, 'stopAll left capacity occupied')

console.log(JSON.stringify({
  ok: true,
  terminalReleasesSlot: true,
  submittedUncertainReleasesSlot: true,
  repairNewGroupFailsBeforeSave,
  sameAccountLaneCancelled: true,
  skipHomeworkMutationIsolation: true,
  nextObjectiveHomeworkMutationOwned: true,
  noProgressStaysLocal: true,
  noProgressContinuesCourse: true,
  answerBootFailureContinuesCourse: true,
  recoveryFailureContinuesCourse: true,
  courseFailureContinuesQueue: true,
  loginFailureReleases: true,
  hangingNewPageReleases: true,
  stopAllPreventsLateStart: true,
}))
