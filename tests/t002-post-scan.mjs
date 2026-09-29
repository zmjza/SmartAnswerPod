import assert from 'node:assert/strict'
import { build } from 'esbuild'

const fixture = {
  events: [], actions: [], portalWaiting: false, qrWaiting: false, qrOpen: true,
  homeworkClicks: 0, submitted: false, released: false, held: false, noAnswerPage: false,
  accounts: [{ local_id: 'student-1', name: '测试学生', username: 'student-1', password: 'fake', display_mode: 'headless', work_mode: 'answer', course_scope: 'all', answer_round_limit: 1 }],
}
globalThis.__t002 = fixture

class FakeLocator {
  constructor(page, selector) { this.page = page; this.selector = selector }
  first() { return this }
  async count() { return 1 }
  async click() {
    if (this.selector.includes('assignment/preview.aspx')) {
      fixture.homeworkClicks++
      if (fixture.homeworkClicks > 1 && !fixture.noAnswerPage) this.page.path = '/study/assignment/preview.aspx'
    }
  }
  async screenshot() { return Buffer.from('internal-qr') }
  async waitFor() {}
  async innerText() { return '' }
  async getAttribute() { return '' }
}

class FakePage {
  constructor(kind, ctx) { this.kind = kind; this.ctx = ctx; this.path = kind === 'portal' ? '/scenter' : '/study/assignment-preview.aspx' }
  context() { return this.ctx }
  locator(selector) { return new FakeLocator(this, selector) }
  url() { return 'https://l.shou.org.cn' + this.path }
  async reload() {}
  async bringToFront() {}
  async waitForTimeout() {}
  async waitForLoadState() {}
  async goto(url) { this.path = new URL(url).pathname; return { ok: () => true, status: () => 200 } }
  async close() {}
}

 const context = { pages: () => [context.portal, context.preview, context.answer], newPage: async () => new FakePage('history', context), waitForEvent: async () => { if (fixture.noAnswerPage) await new Promise(resolve => setTimeout(resolve, 100)); return context.answer }, portal: null, preview: null, answer: null }
context.portal = new FakePage('portal', context)
context.preview = new FakePage('preview', context)
context.answer = new FakePage('answer', context)
globalThis.__t002Context = context
const mock = (...lines) => lines.join(String.fromCharCode(10))
const modules = {
  electron: mock(
    "export const app = { getVersion: () => '2.2.1' }",
    "export class Notification { static isSupported() { return false } }",
  ),
  "./store": mock(
    "export const listAccounts = () => globalThis.__t002.accounts",
    "export const getSettings = () => ({ account_parallel: 1, course_parallel: 1 })",
    "export const getWriteback = () => []",
    "export const getExtractWriteback = () => []",
    "export const saveWriteback = () => {}",
    "export const saveExtractWriteback = () => {}",
    "export const patchAccount = () => {}",
    "export class ExtractWritebackSaveError extends Error {}",
  ),
  "./pool": mock(
    "export const slots = { setLimit() {}, occupy() {}, release() {}, occupyingVerify() {}, request() { return 'occupied' }, promoteQueued() {} }",
    "export const acquire = async () => { globalThis.__t002.held = true; return { ok: true, context: globalThis.__t002Context } }",
    "export const release = async () => { globalThis.__t002.released = true; globalThis.__t002.held = false }",
    "export const isHeld = () => globalThis.__t002.held",
    "export const markVerify = () => {}",
    "export const markOccupied = () => {}",
    "export const browserWindowVisible = () => false",
    "export const toolbarBrowserCount = () => 1",
    "export const averageBrowserMemoryBytes = () => 0",
    "export const browserMemoryStatus = () => 'idle'",
    "export const getContext = () => globalThis.__t002Context",
  ),
  "./login": mock(
    "export const loginIam = async ({ onNeedVerify }) => { globalThis.__t002.events.push('portal_waiting'); globalThis.__t002.portalWaiting = true; await onNeedVerify(); globalThis.__t002.events.push('portal_verified'); return { ok: true } }",
  ),
  "./detect": mock(
    "export const listCourses = async () => [{ name: '测试课程', href: '/course' }]",
    "export const detectCourse = async () => { const hw = name => ({ section: 'onlineHomework', name, workType: '网上记分作业', weightPercent: 100, previewHref: '/study/assignment-preview.aspx', status: 'todo', needDo: true, remainingCap: 1, page: globalThis.__t002Context.preview }); return { name: '测试课程', status: '已检测', homeworks: globalThis.__t002.failureCase ? [hw('失败作业'), hw('后续作业')] : [hw('测试作业')] } }",
     "export const readHistory = async () => globalThis.__t002.submitted ? [{ submittedAt: '2026-09-24T00:00:00.000Z', status: '已批阅', score: 100, historyHref: '/study/assignment/history.aspx?id=1' }] : []",
  ),
  "./answer": mock(
    "export class ListeningBankMissError extends Error {}",
    "export const answerPage = async ({ homeworkName }) => { globalThis.__t002.events.push('answering'); if (globalThis.__t002.stopDuringAnswer) await new Promise((_, reject) => { globalThis.__t002.answerReject = reject }); if (globalThis.__t002.failureCase && !globalThis.__t002.submitFailure && homeworkName === '失败作业') throw new Error('题目保存失败'); return { results: [{ no: '1', hash: 'hash-1', source: 'AI 答题', qtype: 'single', stem: '题目', options: ['甲', '乙'], selected: ['甲'] }], bankCount: 0, aiCount: 1 } }",
  ),
  "./submit": mock(
    "export const submitHomework = async ({ homeworkName }) => { globalThis.__t002.events.push('submitting'); if (homeworkName === '失败作业' && globalThis.__t002.submitFailure === 'throw') throw new Error('提交控件失效'); if (homeworkName === '失败作业' && globalThis.__t002.submitFailure === 'result') return { ok: false }; globalThis.__t002.submitted = true; return { ok: true } }",
    "export const historyHasNew = () => globalThis.__t002.submitted",
  ),
  "./progress": mock(
    "export const onProgress = () => () => {}",
    "export const emitProgress = (event) => { globalThis.__t002.events.push(event.account || event.homework || event.action); globalThis.__t002.actions.push(event.action) }",
  ),
  "./page-tools": mock(
    "export const hasQr = async (page) => page?.kind === 'preview' && globalThis.__t002.qrOpen",
  ),
  "./ai": "export const resetAsked = () => {}",
  "./review.ts": mock(
    "export const readReviewedQuestions = async () => []",
    "export const contradictoryReferenceHashes = () => new Set()",
    "export const extractReviewedQuestions = async () => ({})",
    "export const reviewResults = async () => { globalThis.__t002.events.push('reviewing'); return { reviewed: 1, matched: 1, graded: 1, inserted: 1, conflicts: 0, deleted: 0, wrong: 0, bankWrong: 0, aiWrong: 0, deleteFailed: 0, pendingCandidates: [], pendingInsertHashes: [], pendingDeleteHashes: [], score: 100 } }",
  ),
  "./bank.ts": "export const upsertQuestion = async () => 'added'",
}

const built = await build({
  entryPoints: ['electron/runner.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 't002-post-scan', setup(plugin) {
    plugin.onResolve({ filter: /^(electron|[.]\/(?:store|pool|login|detect|answer|submit|progress|page-tools|ai|review.ts|bank.ts))$/ }, args => ({ path: args.path, namespace: 't002-mock' }))
    plugin.onLoad({ filter: /.*/, namespace: 't002-mock' }, args => ({ contents: modules[args.path], loader: 'js' }))
  } }],
})
const runner = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))

const waitFor = async (check, label) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(label + ' 超时')
}

const run = runner.loginAndRefresh(['student-1'])
await waitFor(() => fixture.portalWaiting, '门户验证等待')
assert.equal(runner.snapshot().students[0].verified, false)
assert.deepEqual((await runner.signalVerified('student-1')).ok, true)
await waitFor(() => fixture.homeworkClicks === 1 && fixture.events.includes('needs_verify'), '作业二维码验证等待')
assert.equal(runner.snapshot().students[0].verified, false)
const denied = await runner.signalVerified('student-1')
assert.equal(denied.ok, false, '二维码仍显示时不得放行')
assert.equal(runner.snapshot().students[0].verified, false)
assert.match(denied.error, /验证|扫码|二维码/)
assert.equal(fixture.events.includes('answering'), false, '验证失败时不得作答')
assert.equal(runner.snapshot().students[0].slot, 'occupying_verify')
fixture.qrOpen = false
assert.deepEqual((await runner.signalVerified('student-1')).ok, true)
assert.equal(runner.snapshot().students[0].verified, true)
 let timeoutId
 const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error(JSON.stringify(fixture.events))), 3000) })
 try { await Promise.race([run, timeout]) } finally { clearTimeout(timeoutId) }

const snapshot = runner.snapshot()
const student = snapshot.students.find((item) => item.local_id === 'student-1')
assert.ok(student)
assert.equal(student.account, 'round_ended')
assert.equal(student.slot, 'released')
assert.equal(fixture.released, true)
assert.equal(fixture.events.filter((event) => event === 'needs_verify').length, 2)
assert.equal(fixture.homeworkClicks, 2)
assert.equal(student.configLocked, false)
assert.equal(fixture.submitted, true)
for (const event of ['portal_verified', 'answering', 'submitting', 'reviewing']) assert.ok(fixture.events.includes(event), event + ' 未触发')
assert.equal(runner.isRunning(), false)
fixture.portalWaiting = false
fixture.released = false
const completedAnswers = fixture.events.filter((event) => event === 'answering').length
assert.equal(runner.startStudent('student-1').ok, true)
await waitFor(() => fixture.portalWaiting, '重新扫描门户验证等待')
await runner.stopStudent('student-1')
assert.equal(runner.snapshot().students[0].verified, false)
assert.equal(runner.snapshot().students[0].account, 'stopped')
assert.equal(runner.snapshot().students[0].slot, 'released')
assert.equal(runner.snapshot().students[0].configLocked, false)
assert.equal(fixture.released, true)
assert.equal(fixture.events.filter((event) => event === 'answering').length, completedAnswers, '验证等待中停止不得继续作答')
fixture.noAnswerPage = true
fixture.qrOpen = false
fixture.submitted = false
fixture.homeworkClicks = 0
fixture.portalWaiting = false
context.preview.path = '/study/assignment-preview.aspx'
context.answer.path = '/study/assignment-preview.aspx'
const withoutRoute = runner.loginAndRefresh(['student-1'])
await waitFor(() => fixture.portalWaiting, '无作答页时门户验证等待')
assert.equal((await runner.signalVerified('student-1')).ok, true)
await waitFor(() => fixture.homeworkClicks === 1, '无二维码的做作业点击')
await new Promise(resolve => setTimeout(resolve, 20))
assert.equal(runner.snapshot().students[0].verified, false, '无二维码且未进入作答页不得授权')
await withoutRoute
assert.equal(runner.snapshot().students[0].account, 'round_ended')
fixture.noAnswerPage = false
fixture.failureCase = true
fixture.submitted = false
fixture.homeworkClicks = 1
fixture.portalWaiting = false
context.preview.path = '/study/assignment/preview.aspx'
const continued = runner.loginAndRefresh(['student-1'])
await waitFor(() => fixture.portalWaiting, '失败后继续场景门户验证等待')
assert.equal((await runner.signalVerified('student-1')).ok, true)
await continued
const rows = runner.snapshot().students[0].courses[0].groups[0].rows
assert.equal(rows.find(row => row.name === '失败作业')?.status, 'submit_failed')
assert.equal(rows.find(row => row.name === '后续作业')?.status, 'done_100', '前一份失败不能阻止后一份交卷回写')
assert.equal(runner.snapshot().students[0].account, 'round_ended')
for (const failure of ['result', 'throw']) {
  fixture.submitFailure = failure
  fixture.submitted = false
  fixture.homeworkClicks = 1
  fixture.portalWaiting = false
  context.preview.path = '/study/assignment/preview.aspx'
  const runAfterSubmitFailure = runner.loginAndRefresh(['student-1'])
  await waitFor(() => fixture.portalWaiting, '提交失败隔离场景门户验证等待')
  assert.equal((await runner.signalVerified('student-1')).ok, true)
  assert.deepEqual(await runAfterSubmitFailure, { ok: true })
  const homeworkRows = runner.snapshot().students[0].courses[0].groups[0].rows
  assert.equal(homeworkRows.find(row => row.name === '失败作业')?.status, 'submit_failed')
  assert.equal(homeworkRows.find(row => row.name === '后续作业')?.status, 'done_100', '提交失败不能阻止后续作业')
  assert.ok(fixture.actions.some(line => line.includes(failure === 'result' ? '提交确认弹窗未完成' : '提交控件失效')), '应留下可读的中文失败原因')
  assert.equal(runner.snapshot().students[0].slot, 'released', '提交失败后必须释放名额')
  assert.equal(runner.isRunning(), false, '提交失败后调度状态必须收口')
}
fixture.submitFailure = null
fixture.failureCase = false
fixture.stopDuringAnswer = true
fixture.answerReject = null
fixture.submitted = false
fixture.homeworkClicks = 1
fixture.portalWaiting = false
context.preview.path = '/study/assignment/preview.aspx'
const interruptedAnswer = runner.loginAndRefresh(['student-1'])
await waitFor(() => fixture.portalWaiting, '作答期间停止场景门户验证等待')
assert.equal((await runner.signalVerified('student-1')).ok, true)
await waitFor(() => fixture.answerReject, '等待作答开始')
const stopAnswer = runner.stopStudent('student-1')
fixture.answerReject(new Error('page.waitForTimeout: Target page, context or browser has been closed'))
await Promise.all([stopAnswer, interruptedAnswer])
const stopped = runner.snapshot().students[0]
assert.equal(stopped.account, 'stopped')
assert.notEqual(stopped.courses[0].groups[0].rows[0].status, 'submit_failed', '主动停止不能误记为提交失败')
console.log('T002 扫码后完整内部模拟链路通过')
