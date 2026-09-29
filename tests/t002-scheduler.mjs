import assert from "node:assert/strict"
import { build } from "esbuild"

const account = (id) => ({ local_id: id, name: id, username: id, password: "fake", display_mode: "headless", work_mode: "answer", course_scope: "all", answer_round_limit: 10 })
const fixture = { accounts: [account("a"), account("b"), account("c")], occupied: new Set(), starts: [], pending: new Map(), acquireGates: new Map(), acquiring: new Set(), limit: 2 }
globalThis.__t002 = fixture
const modules = {
  electron: "export const app = {}; export class Notification { static isSupported() { return false } }",
  "./store": "export class ExtractWritebackSaveError extends Error {} export const listAccounts = () => globalThis.__t002.accounts; export const getSettings = () => ({ account_parallel: 2, course_parallel: 1 }); export const patchAccount = (id, patch) => { const a = globalThis.__t002.accounts.find(x => x.local_id === id); Object.assign(a, patch) }; export const getWriteback = () => []; export const getExtractWriteback = () => []; export const saveWriteback = () => {}; export const saveExtractWriteback = () => {}",
  "./pool": [
    "const f = () => globalThis.__t002;",
    "export const slots = { setLimit(n) { f().limit = n } };",
    "export const isHeld = id => f().occupied.has(id);",
    "export const acquire = async id => { if (f().occupied.size >= f().limit) return { ok: false, queued: true }; const gate=f().acquireGates.get(id); if (gate) { f().acquiring.add(id); await gate; f().acquireGates.delete(id); f().acquiring.delete(id) } f().occupied.add(id); return { ok: true, context: { pages: () => [{}] } } };",
    "export const release = async id => { f().occupied.delete(id) };",
    "export const averageBrowserMemoryBytes = () => 0; export const browserMemoryStatus = () => 'idle';",
    "export const browserWindowVisible = () => false; export const getContext = () => null;",
    "export const markOccupied = () => {}; export const markVerify = () => {};",
    "export const toolbarBrowserCount = () => f().occupied.size",
  ].join(""),
  "./login": "export const loginIam = ({ local_id }) => new Promise(resolve => { globalThis.__t002.starts.push(local_id); globalThis.__t002.pending.set(local_id, resolve) })",
  "./detect": "export const detectCourse = async () => null; export const listCourses = async () => []; export const readHistory = async () => []",
  "./answer": "export class ListeningBankMissError extends Error {} export const answerPage = async () => []",
  "./submit": "export const historyHasNew = () => false; export const submitHomework = async () => null",
  "./progress": "export const onProgress = () => {}; export const emitProgress = () => {}",
  "./page-tools": "export const hasQr = async () => false",
  "./ai": "export const resetAsked = () => {}",
  "./review.ts": "export const contradictoryReferenceHashes = () => []; export const readReviewedQuestions = async () => []; export const extractReviewedQuestions = async () => []; export const reviewResults = async () => null",
  "./bank.ts": "export const upsertQuestion = async () => null",
}
const built = await build({ entryPoints: ["electron/runner.ts"], bundle: true, platform: "node", format: "esm", write: false, plugins: [{
  name: "offline-runner",
  setup(plugin) {
    plugin.onResolve({ filter: /^(electron|[.][/](?:store|pool|login|detect|answer|submit|progress|page-tools|ai|review.ts|bank.ts))$/, }, args => ({ path: args.path, namespace: "mock" }))
    plugin.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: modules[args.path], loader: "js" }))
  },
}] })
const runner = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"))
const waitFor = async (check) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("离线调度超时")
}
const finish = (id) => { const resolve = fixture.pending.get(id); assert.ok(resolve, id + " 未运行"); fixture.pending.delete(id); resolve({ ok: true }) }
const firstRun = runner.loginAndRefresh(["a"])
await waitFor(() => fixture.starts.includes("a"))
assert.equal(runner.isRunning(), true)
assert.equal(runner.applyStudentSettingsToAll("a").ok, false, "运行中不能批量改配置")
assert.equal(runner.setCourseScope("a", "selected").ok, false, "运行中不能改单人课程模式")
assert.equal(runner.enqueueNewStudents(["b"]), 1)
await waitFor(() => fixture.starts.includes("b"))
assert.equal(fixture.occupied.size, 2)
assert.equal(runner.enqueueNewStudents(["c"]), 1)
assert.equal(runner.enqueueNewStudents(["c"]), 0, "不得重复入队")
await new Promise(resolve => setTimeout(resolve, 450))
assert.equal(fixture.starts.includes("c"), false, "满额时必须排队")
const stopA = runner.stopStudent("a")
finish("a")
await stopA
await firstRun
await waitFor(() => fixture.starts.includes("c"))
assert.equal(fixture.occupied.size, 2, "释放名额后必须补位")
assert.equal(runner.startStudent("a").ok, true)
assert.equal(runner.startStudent("a").ok, false, "重启不得重复入队")
const stopB = runner.stopStudent("b")
finish("b")
await stopB
await waitFor(() => fixture.starts.filter(id => id === "a").length === 2)
assert.equal(fixture.occupied.size, 2, "单人重启不得超并发")
const stopAll = runner.stopAllStudents()
finish("a")
finish("c")
await stopAll
assert.equal(runner.isRunning(), false)
assert.equal(fixture.occupied.size, 0)
assert.equal(runner.enqueueNewStudents(["b"]), 0, "全部停止后新增账号保持空闲")
assert.equal(runner.setCourseScope("a", "all").ok, true, "全部释放后应恢复配置编辑")
assert.equal(runner.snapshot().running, false, "全部释放后主按钮必须解锁")
const rerun = runner.loginAndRefresh(["a"])
await waitFor(() => fixture.starts.filter(id => id === "a").length === 3)
finish("a")
await rerun
assert.equal(runner.snapshot().running, false, "自然结束后主按钮必须解锁")
let openA, openB
fixture.acquireGates.set('a', new Promise(resolve => { openA = resolve }))
fixture.acquireGates.set('b', new Promise(resolve => { openB = resolve }))
const interrupted = runner.loginAndRefresh(['a', 'b'])
await waitFor(() => fixture.acquiring.has('a') && fixture.acquiring.has('b'))
const stopLaunchingA = runner.stopStudent('a')
const stopLaunchingB = runner.stopStudent('b')
openA()
openB()
await Promise.all([stopLaunchingA, stopLaunchingB, interrupted])
assert.equal(fixture.occupied.size, 0, '启动浏览器期间停止后不得残留两个占用名额')
fixture.acquireGates.set('a', new Promise(resolve => { openA = resolve }))
fixture.acquireGates.set('b', new Promise(resolve => { openB = resolve }))
const interruptedAll = runner.loginAndRefresh(['a', 'b'])
await waitFor(() => fixture.acquiring.has('a') && fixture.acquiring.has('b'))
const stopBoth = runner.stopAllStudents()
openA()
openB()
await Promise.all([stopBoth, interruptedAll])
assert.equal(fixture.occupied.size, 0, '全部停止后不得残留占用名额')
const restartBoth = runner.loginAndRefresh(['a', 'b'])
await waitFor(() => fixture.starts.filter(id => id === 'a').length === 4 && fixture.starts.filter(id => id === 'b').length === 2)
finish('a')
finish('b')
await restartBoth
assert.equal(fixture.occupied.size, 0, '重新开始的两个账号结束后应释放名额')
runner.views.get("a").selectedCourseNames = ["课程甲"]
runner.views.get("b").selectedCourseNames = ["课程乙"]
fixture.accounts[0].course_scope = "selected"
fixture.accounts[1].course_scope = "selected"
runner.views.get("a").courseScope = "selected"
runner.views.get("b").courseScope = "selected"
assert.equal(runner.applyStudentSettingsToAll("a").ok, true)
assert.deepEqual(runner.views.get("a").selectedCourseNames, ["课程甲"], "同步模式不应清空源学生选课")
assert.deepEqual(runner.views.get("b").selectedCourseNames, ["课程乙"], "同步模式不应清空其他学生选课")
fixture.accounts[1].course_scope = "all"
runner.views.get("b").courseScope = "all"
assert.equal(runner.applyStudentSettingsToAll("a").ok, true)
assert.deepEqual(runner.views.get("b").selectedCourseNames, [], "课程模式变化应清理过期本轮选课")
console.log("T002 离线调度测试通过")
