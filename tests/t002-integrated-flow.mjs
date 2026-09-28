import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'patchright'

const state = { accounts: [{ local_id: 'student-1', name: '模拟学生', username: 'student-1', password: 'fake', display_mode: 'headless', work_mode: 'answer', course_scope: 'all', answer_round_limit: 1 }], qr: false, clicks: 0, submitted: false, held: false, released: false, portalWaiting: false, saves: [], ai: 0, writeback: [], rows: new Map() }
globalThis.__t002Integrated = state
const question = (no, type, stem, a, b) => `<div class='e-q-body' data-num='${no}' data-questiontype='${type}'><div class='e-q-q'>${stem}</div><form><input name='answer'></form><ul><li class='e-a' data-index='${type === 3 ? 1 : 0}'>A) ${a}</li><li class='e-a' data-index='${type === 3 ? 0 : 1}'>B) ${b}</li></ul></div><a class='e-item' data-num='${no}'></a>`
const answerHtml = `<div class='e-selects-g'>${question(1, 1, '第一题单选', '甲', '乙')}${question(2, 3, '第二题判断', '正确', '错误')}${question(3, 2, '第三题多选', '丙', '丁')}</div><button id='submitHomeWork'>提交作业</button><div class='xcConfirm' style='display:none'><span id='message'></span><a class='sgBtn ok'>确定</a><a class='sgBtn cancel'>取消</a></div><script>
document.querySelectorAll('li.e-a').forEach(li => li.addEventListener('click', async () => { const b = li.closest('.e-q-body'); if (b.dataset.questiontype === '2') li.classList.toggle('checked'); else { b.querySelectorAll('li.e-a').forEach(x => x.classList.remove('checked')); li.classList.add('checked') } const value = [...b.querySelectorAll('li.checked')].map(x => x.dataset.index).join(','); b.querySelector('[name=answer]').value = value; const res = await fetch('/study/ajax-assignment-online_homework_answer', {method:'POST', body:new URLSearchParams({answer:value})}); if (res.ok) document.querySelector('.e-item[data-num="' + b.dataset.num + '"]').classList.add('active') }));
const dialog = document.querySelector('.xcConfirm'); document.querySelector('#submitHomeWork').onclick = () => { document.querySelector('#message').textContent = '作业提交后将不可修改，您确定要提交作业吗？'; dialog.style.display = 'block' }; document.querySelector('.sgBtn.ok').onclick = () => { dialog.style.display = 'none'; location.href = '/study/assignment-preview.aspx' }; document.querySelector('.sgBtn.cancel').onclick = () => { dialog.style.display = 'none' };
</script>`
const reviewed = (type, stem, a, b, _answer, score) => `<div class='e-q-body' data-questiontype='${type}'><div class='e-q'><div class='e-q-q'>${stem}</div><div class='e-q-l'><span class='e-q-right'></span></div><input name='GiveScore' value='${score}'><div class='e-a-g e-choice-a'><ul><li class='e-a checked'>A) ${a}</li><li class='e-a ${type === 2 ? 'checked' : ''}'>B) ${b}</li></ul></div></div></div>`
const historyHtml = reviewed(1, '第一题单选', '甲', '乙', '甲', 33.33) + reviewed(3, '第二题判断', '正确', '错误', '正确', 33.33) + reviewed(2, '第三题多选', '丙', '丁', '丙', 33.34)
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.endsWith('/questions')) {
    const hash = url.searchParams.get('content_hash')?.slice(3)
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') res.end(JSON.stringify(hash && state.rows.has(hash) ? [state.rows.get(hash)] : []))
    else { let raw = ''; for await (const part of req) raw += part; const item = JSON.parse(raw); state.rows.set(item.content_hash, item); res.end(JSON.stringify([item])) }
    return
  }
  if (req.method === 'POST') { let raw = ''; for await (const part of req) raw += part; state.saves.push(new URLSearchParams(raw).get('answer')); setTimeout(() => { res.writeHead(200); res.end('ok') }, 30); return }
  if (url.pathname.endsWith('history.aspx')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(historyHtml); return }
  if (url.pathname.endsWith('assignment-preview.aspx')) state.submitted = true
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(url.pathname.endsWith('assignment/preview.aspx') ? answerHtml : '<main id=mainContent><table class=am-table></table></main>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
state.origin = origin
const browser = await chromium.launch({ headless: true })
const realContext = await browser.newContext()
const answer = await realContext.newPage()
await answer.goto(origin + '/study/assignment/preview.aspx')
class FakeLocator {
  constructor(page, selector) { this.page = page; this.selector = selector }
  first() { return this }
  async count() { return 1 }
  async screenshot() { return Buffer.from('local-qr') }
  async waitFor() {}
  async click() { if (this.selector.includes('assignment/preview.aspx')) { state.clicks++; state.qr = state.clicks === 1 } }
}
class FakePage {
  constructor(kind) { this.kind = kind }
  context() { return context }
  locator(selector) { return new FakeLocator(this, selector) }
  url() { return origin + (this.kind === 'portal' ? '/scenter' : '/study/assignment-preview.aspx?homeWorkId=1') }
  async reload() {}
  async bringToFront() {}
  async waitForTimeout() {}
}
const portal = new FakePage('portal')
const preview = new FakePage('preview')
const context = { pages: () => [portal, preview, ...realContext.pages()], newPage: () => realContext.newPage(), waitForEvent: async () => answer }
state.preview = preview
state.context = context
const mock = (...lines) => lines.join(String.fromCharCode(10))
const modules = {
  electron: mock("export const app = { getVersion: () => '2.2.1' }", 'export class Notification { static isSupported() { return false } }'),
  './store': mock(
    'const s = () => globalThis.__t002Integrated',
    'export const listAccounts = () => s().accounts; export const getSettings = () => ({ account_parallel: 1, course_parallel: 1, siliconflow_key: "fake", supabase_url: s().origin, supabase_anon: "fake" })',
    'export const patchAccount = (id, patch) => Object.assign(s().accounts.find(a => a.local_id === id), patch)',
    'export const getWriteback = () => s().writeback; export const saveWriteback = rows => { s().writeback = rows }',
    'export const isReferenceHashProtected = () => false; export const protectReferenceHash = () => true',
    'export const getExtractWriteback = () => []; export const saveExtractWriteback = () => {}; export class ExtractWritebackSaveError extends Error {}',
  ),
  './pool': mock(
    'const s = () => globalThis.__t002Integrated',
    'export const slots = { setLimit() {} }; export const acquire = async () => { s().held = true; return { ok: true, context: s().context } }',
    'export const release = async () => { s().held = false; s().released = true }; export const isHeld = () => s().held',
    'export const markVerify = () => {}; export const markOccupied = () => {}; export const browserWindowVisible = () => false',
    'export const toolbarBrowserCount = () => Number(s().held); export const averageBrowserMemoryBytes = () => 0; export const browserMemoryStatus = () => "idle"; export const getContext = () => s().context',
  ),
  './login': 'export const loginIam = async ({onNeedVerify}) => { globalThis.__t002Integrated.portalWaiting = true; await onNeedVerify(); return {ok:true} }',
  './detect': mock(
    'export const listCourses = async () => [{name:"测试课程", href:"/course"}]',
    'export const detectCourse = async () => ({name:"测试课程", status:"已检测", homeworks:[{section:"onlineHomework",name:"测试作业",workType:"网上记分作业",weightPercent:100,previewHref:"/study/assignment-preview.aspx",status:"todo",needDo:true,remainingCap:1,page:globalThis.__t002Integrated.preview}]})',
    'export const readHistory = async () => globalThis.__t002Integrated.submitted ? [{submittedAt:"2026-09-25T00:00:00.000Z",status:"已批阅",score:100,historyHref:globalThis.__t002Integrated.origin + "/study/assignment/history.aspx?id=1"}] : []',
  ),
  'runner-page-tools': 'export const hasQr = async page => page.kind === "preview" && globalThis.__t002Integrated.qr',
}
const built = await build({ entryPoints: ['electron/runner.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{
  name: 'integrated-boundaries', setup(plugin) {
    plugin.onResolve({ filter: new RegExp('^(electron|[.]/(store|pool|login|detect))$') }, args => ({ path: args.path, namespace: 'boundary' }))
    plugin.onResolve({ filter: new RegExp('^[.]/page-tools$') }, args => args.importer.endsWith('/runner.ts') ? { path: 'runner-page-tools', namespace: 'boundary' } : undefined)
    plugin.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: modules[args.path], loader: 'js' }))
  }
}] })
const runner = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const originalFetch = globalThis.fetch
globalThis.fetch = (url, opts) => {
  if (!String(url).startsWith('https://api.siliconflow.cn/')) return originalFetch(url, opts)
  state.ai++
  const prompt = JSON.parse(opts.body).messages[1].content
  const chosen = prompt.includes('第一题单选') ? ['甲'] : prompt.includes('第二题判断') ? ['正确'] : ['丙', '丁']
  return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ option_texts: chosen }) } }] }))
}
const waitFor = async (condition, label) => {
  for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(label + ' 超时')
}
try {
  const run = runner.loginAndRefresh(['student-1'])
  await waitFor(() => state.portalWaiting, '门户验证')
  assert.equal((await runner.signalVerified('student-1')).ok, true)
  await waitFor(() => state.qr && runner.snapshot().students[0].needsVerify, '作业二维码')
  assert.equal((await runner.signalVerified('student-1')).ok, false, '二维码仍在时不得作答')
  assert.equal(state.saves.length, 0)
  state.qr = false
  assert.equal((await runner.signalVerified('student-1')).ok, true)
  await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error(JSON.stringify(runner.snapshot().students[0]))), 20000))])
  const student = runner.snapshot().students[0]
  assert.equal(student.account, 'round_ended')
  assert.equal(student.slot, 'released')
  assert.equal(student.configLocked, false)
  assert.equal(runner.snapshot().running, false)
  assert.equal(state.released, true)
  assert.equal(state.submitted, true)
  assert.deepEqual(state.saves, ['0', '1', '0', '0,1'])
  assert.equal(state.ai, 3)
  assert.equal(state.rows.size, 3, '批阅后全部 AI 正确答案应经真实题库模块入库')
  assert.deepEqual(state.writeback, [], '本轮成功后不应留待回写记录')
  console.log('T002 真实 runner/作答/AI/提交/批阅/题库受控端到端通过')
} finally {
  globalThis.fetch = originalFetch
  await browser.close()
  server.close()
}
