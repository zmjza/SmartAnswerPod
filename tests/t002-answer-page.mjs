import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'patchright'

const state = { saves: [], bankCalls: 0, aiCalls: 0 }
globalThis.__answerState = state
const question = (no, type, stem, a, b) => `
  <div class="e-q-body" data-num="${no}" data-questiontype="${type}">
    <div class="e-q-q">${stem}</div><form><input name="answer"></form><ul>
      <li class="e-a" data-index="${type === 3 ? 1 : 0}">A) ${a}</li>
      <li class="e-a" data-index="${type === 3 ? 0 : 1}">B) ${b}</li>
    </ul>
  </div><a class="e-item" data-num="${no}"></a>`
const html = `<div class="e-selects-g">
  ${question(1, 1, '第一题单选', '甲', '乙')}
  ${question(2, 3, '第二题判断', '正确', '错误')}
  ${question(3, 2, '第三题多选', '丙', '丁')}
  </div><script>
  document.querySelectorAll('li.e-a').forEach(li => li.addEventListener('click', async () => {
    const b = li.closest('.e-q-body')
    if (b.dataset.questiontype === '2') li.classList.toggle('checked')
    else { b.querySelectorAll('li.e-a').forEach(x => x.classList.remove('checked')); li.classList.add('checked') }
    const value = [...b.querySelectorAll('li.checked')].map(x => x.dataset.index).join(',')
    b.querySelector('[name=answer]').value = value
    const res = await fetch('/study/ajax-assignment-online_homework_answer', {method:'POST', body:new URLSearchParams({answer:value})})
    if (res.ok) document.querySelectorAll('.e-item')[Number(b.dataset.num) - 1].classList.add('active')
  }))
  </script>`
const server = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let raw = ''
    for await (const part of req) raw += part
    state.saves.push(new URLSearchParams(raw).get('answer'))
    setTimeout(() => { res.writeHead(200); res.end('ok') }, 80)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const built = await build({ entryPoints: ['electron/answer.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{
  name: 'local-answers', setup(plugin) {
    plugin.onResolve({ filter: /bank$|ai$/ }, args => ({ path: args.path, namespace: 'local-external' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-external' }, args => ({
      contents: args.path === './bank'
        ? "export const lookupByHash=async()=>{const f=globalThis.__answerState; f.bankCalls++; return f.bankCalls===2 ? null : {answer_texts:f.bankCalls===1 ? ['甲'] : ['丙','丁']}}"
        : "export const askAi=async()=>{globalThis.__answerState.aiCalls++; return {texts:['正确'],model:'local',failed:false,attempts:[]}}; export const askAiGroup=async()=>({selected:null,attempts:[]}); export const retryAsked=()=>{}",
      loader: 'js',
    }))
  },
}] })
const answer = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port)
  const result = await answer.answerPage({ page, local_id: 'student-1', slot: 'occupied', account: 'auto_answering', courseName: '测试课程', homeworkName: '测试作业' })
  assert.deepEqual(result.results.map(row => row.source), ['题库答题', 'AI 答题', '题库答题'])
  assert.deepEqual([result.bankCount, result.aiCount], [2, 1])
  assert.equal(state.aiCalls, 1)
  assert.deepEqual(state.saves, ['0', '1', '0', '0,1'])
  assert.deepEqual(await page.locator('.e-q-body [name=answer]').evaluateAll(items => items.map(x => x.value)), ['0', '1', '0,1'])
  assert.equal(await page.locator('.e-item.active').count(), 3)
  console.log('T002 真实 answerPage 单选、判断、多选整卷路径通过')
} finally {
  await browser.close()
  server.close()
}
