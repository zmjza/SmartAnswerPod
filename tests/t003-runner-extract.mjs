import assert from 'node:assert/strict'
import { build } from 'esbuild'

const state = { events: [], released: false }
globalThis.__runnerExtract = state
const page = (url = 'https://l.shou.org.cn/scenter') => ({
  url: () => url,
  goto: async (href) => { url = href; return { ok: () => true } },
  locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
  close: async () => {},
  context: () => context,
})
const context = { pages: () => [page()], newPage: async () => page() }
const mock = (...lines) => lines.join('\n')
const modules = {
  electron: mock("export const app = { getVersion: () => '2.3' }", 'export class Notification { static isSupported() { return false } }'),
  './store': mock(
    "export const listAccounts = () => [{ local_id: 'one', name: '甲', username: 'one', display_mode: 'headless', work_mode: 'extract', course_scope: 'all', answer_round_limit: 1 }]",
    "export const getSettings = () => ({ account_parallel: 1, course_parallel: 2 })",
    'export const getWriteback = () => []; export const getExtractWriteback = () => []; export const saveWriteback = () => {}; export const saveExtractWriteback = () => {}; export const patchAccount = () => {}; export class ExtractWritebackSaveError extends Error {}',
  ),
  './pool': mock(
    'export const slots = { setLimit() {} }; export const acquire = async () => ({ ok: true, context: globalThis.__runnerContext }); export const release = async () => { globalThis.__runnerExtract.released = true }',
    'export const isHeld = () => false; export const markVerify = () => {}; export const markOccupied = () => {}; export const browserWindowVisible = () => false; export const toolbarBrowserCount = () => 0; export const averageBrowserMemoryBytes = () => 0; export const browserMemoryStatus = () => "idle"; export const getContext = () => globalThis.__runnerContext',
  ),
  './login': 'export const loginIam = async () => ({ ok: true })',
  './detect': mock(
    "export const listCourses = async () => [{ key: 'course-1', name: '同名课', href: '/course' }]",
    "export const detectCourse = async () => ({ key: 'course-1', name: '同名课', status: '已检测', homeworks: [{ section: 'onlineHomework', name: '作业', status: 'todo', needDo: false, previewHref: '/preview', page: globalThis.__runnerPreview }] })",
    "export const readHistory = async () => [{ status: '已批阅', historyHref: '/history?id=1', submittedAt: 'one' }, { status: '已批阅', historyHref: '/history?id=2', submittedAt: 'two' }]",
  ),
  './review.ts': mock(
    'export const readReviewedQuestions = async (page) => { const id = new URL(page.url()).searchParams.get("id"); globalThis.__runnerExtract.events.push("read:" + id); if (id === globalThis.__runnerExtract.failRead) throw new Error("unreadable"); if (globalThis.__runnerExtract.unhashedRetry) return [{ hash: "", referenceState: "invalid", answerTexts: [], qtype: "unknown", stem: "待证", options: [], selected: [] }]; return [{ hash: "same-hash", referenceState: "valid", answerTexts: [id], qtype: "single", stem: "题", options: ["一", "二"], selected: [] }] }',
    'export const contradictoryReferenceHashes = (rows) => new Set(rows.map((q) => q.answerTexts[0]).length > 1 ? ["same-hash"] : [])',
    'export const extractReviewedQuestions = async (_page, _course, _progress, _stop, opts) => { globalThis.__runnerExtract.events.push("write:" + [...opts.blockedHashes].join(",")); return { added: 0, merged: 0, skipped: 0, conflict: 0, failed: 0, failedCandidates: [], pendingReferenceHashes: [], referenceStats: { added: 0, updated: 0, merged: 0, retry: globalThis.__runnerExtract.unhashedRetry ? 1 : 0, contradictions: globalThis.__runnerExtract.unhashedRetry ? 0 : 1 } } }',
    'export const reviewResults = async () => ({})',
  ),
  './progress': 'export const onProgress = () => () => {}; export const emitProgress = () => {}',
  './page-tools': 'export const hasQr = async () => false',
  './answer': 'export class ListeningBankMissError extends Error {} export const answerPage = async () => ({ results: [], bankCount: 0, aiCount: 0 })',
  './submit': 'export const historyHasNew = async () => false; export const submitHomework = async () => ({ ok: false })',
  './ai': 'export const resetAsked = () => {}',
  './bank.ts': "export const upsertQuestion = async () => 'added'",
}
globalThis.__runnerContext = context
globalThis.__runnerPreview = page('https://l.shou.org.cn/preview')
const built = await build({ entryPoints: ['electron/runner.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{
  name: 'runner-boundaries', setup(plugin) {
    plugin.onResolve({ filter: /^(electron|[.]\/(?:store|pool|login|detect|review.ts|progress|page-tools|answer|submit|ai|bank.ts))$/ }, (args) => ({ path: args.path, namespace: 'mock' }))
    plugin.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: modules[args.path], loader: 'js' }))
  },
}] })
const runner = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
await runner.loginAndRefresh(['one'])
assert.deepEqual(state.events.slice(0, 2).sort(), ['read:1', 'read:2'])
assert.deepEqual(state.events.slice(2), ['write:same-hash', 'write:same-hash'])
assert.equal(state.released, true)
state.events = []
state.failRead = '2'
await runner.loginAndRefresh(['one'])
assert.equal(state.events.filter((event) => event.startsWith('write:')).length, 1)
const second = runner.snapshot().students[0]
assert.equal(second.courses[0].groups[0].rows[0].status, 'extracting_done')
assert.match(second.action, /待处理项/)
state.events = []
state.failRead = undefined
state.unhashedRetry = true
await runner.loginAndRefresh(['one'])
const third = runner.snapshot().students[0]
assert.equal(third.courses[0].groups[0].rows[0].status, 'extracting_done', '无 hash 的待证题不应伪装成待回写')
assert.match(third.action, /待处理项/)
console.log('T003 同作业历史先比对后写库通过')
