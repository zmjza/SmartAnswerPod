import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'patchright'

const html = readFileSync('tests/fixtures/大学英语当前试卷/大学英语当前试卷-本地脱敏测试案例.html', 'utf8')
const built = await build({ entryPoints: ['electron/answer.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{
  name: 'external-boundaries', setup(plugin) {
    plugin.onResolve({ filter: /bank$|ai$/ }, args => ({ path: args.path, namespace: 'external-boundary' }))
    plugin.onLoad({ filter: /.*/, namespace: 'external-boundary' }, args => ({
      contents: args.path === './bank'
        ? 'export const lookupByHash=async hash=>globalThis.__englishBank?.get(hash)||null'
        : 'export const askAi=async()=>({texts:null,attempts:[]});export const askAiGroup=async ({slots})=>{globalThis.__englishAiCalls=(globalThis.__englishAiCalls||0)+1;globalThis.__englishAiSlots=slots;return {selected:Object.fromEntries(slots.map((slot,i)=>[slot.id,slot.options[i%slot.options.length]])),attempts:[]}};export const retryAsked=()=>{}',
      loader: 'js',
    }))
  },
}] })
const answer = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
assert.equal(typeof answer.readEnglishGroup, 'function', '缺少生产英语复合题解析入口')
const submitBuilt = await build({ entryPoints: ['electron/submit.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{
  name: 'local-history', setup(plugin) {
    plugin.onResolve({ filter: /detect$/ }, args => ({ path: args.path, namespace: 'local-history' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-history' }, () => ({ contents: 'export const readHistory=async()=>[]', loader: 'js' }))
  },
}] })
const submit = await import('data:text/javascript;base64,' + Buffer.from(submitBuilt.outputFiles[0].text).toString('base64'))
const aiBuilt = await build({ entryPoints: ['electron/ai.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{
  name: 'local-settings', setup(plugin) {
    plugin.onResolve({ filter: /store$/ }, args => ({ path: args.path, namespace: 'local-settings' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-settings' }, () => ({ contents: 'export const getSettings=()=>({siliconflow_key:"local-test"})', loader: 'js' }))
  },
}] })
const ai = await import('data:text/javascript;base64,' + Buffer.from(aiBuilt.outputFiles[0].text).toString('base64'))
assert.equal(typeof ai.validateGroupSelection, 'function', '缺少组级答案校验')
const groupSlots = [{ id: '1', options: ['alpha', 'beta'] }, { id: '2', options: ['yes', 'no'] }]
assert.deepEqual(ai.validateGroupSelection(['1 :: beta', '2 :: yes'], groupSlots), { '1': 'beta', '2': 'yes' })
assert.equal(ai.validateGroupSelection(['1 :: beta'], groupSlots), null)
assert.equal(ai.validateGroupSelection(['1 :: beta', '1 :: alpha'], groupSlots), null)
assert.equal(ai.validateGroupSelection(['1 :: beta', '2 :: maybe'], groupSlots), null)
const originalFetch = globalThis.fetch
let aiPrompt = ''
globalThis.fetch = async (_url, request) => {
  aiPrompt = JSON.parse(request.body).messages[1].content
  return new Response(JSON.stringify({ choices: [{ message: { content:
    JSON.stringify({ option_texts: ['1 :: beta', '2 :: yes'] }) } }] }), { status: 200 })
}
try {
  const solved = await ai.askAiGroup({ hash: 'local-group', shared: 'Shared passage',
    slots: [{ id: '1', stem: 'First question', options: ['alpha', 'beta'] },
      { id: '2', stem: 'Second question', options: ['yes', 'no'] }] })
  assert.deepEqual(solved.selected, { '1': 'beta', '2': 'yes' })
  assert.ok(aiPrompt.includes('Shared passage') && aiPrompt.includes('First question') && aiPrompt.includes('Second question'))
  assert.ok(!aiPrompt.includes('0. 1 ::'), '整组选项不应叠加外层列表序号')
} finally {
  globalThis.fetch = originalFetch
}
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const listening = await answer.readEnglishGroup(page, '1', '11')
  const matching = await answer.readEnglishGroup(page, '12', '7')
  const cloze = await answer.readEnglishGroup(page, '13', '9')
  const readingA = await answer.readEnglishGroup(page, '14', '8')
  const readingB = await answer.readEnglishGroup(page, '15', '8')
  assert.equal(listening.slots.length, 5)
  assert.equal(matching.slots.length, 10)
  assert.equal(cloze.slots.length, 10)
  assert.equal(readingA.slots.length, 5)
  assert.equal(readingB.slots.length, 5)
  assert.notEqual(readingA.slots[0].hash, readingB.slots[0].hash)
  assert.ok(matching.slots.every(slot => slot.options.length === 10 && slot.hash))
  assert.ok(cloze.slots.every(slot => slot.stem.includes(cloze.shared) && slot.hash))
  assert.equal(listening.reliableAudioText, false)
  assert.ok(listening.slots.every(slot => slot.hash), '无转写的固定听力题应有可检索的题库身份')
  globalThis.__englishBank = new Map()
  await assert.rejects(answer.answerPage({ page, local_id: 'student-test', slot: 'occupied',
    account: 'auto_answering', courseName: 'English', homeworkName: 'Listening' }), /听力题库缺少/)
  console.log('T003 英语父题、子题、匹配槽解析通过')

  const saved = new Map()
  const posts = []
  let persist = true
  let stalePrefill = false
  let failSave = false
  const liveHtml = (kind = '8') => `<div class="e-selects-g"><a class="e-item" data-num="1"></a></div>
    <div class="e-q-body" data-num="1" data-questiontype="${kind}"><div class="e-q-r"><div class="e-q-quest">
      <div class="e-q-q">A short passage about two people.</div>
      ${kind === '11' ? '<p class="transcript">Person one is here. Person two is away.</p>' : ''}
      ${[1, 2].map(n => `<form data-slot="${n}" action="/study/ajax-assignment-online_homework_subanswer">
        <div class="e-q-quest"><div class="e-q-q">${kind === '9' ? '' : `Person ${n} is here?`}</div></div>
        <input name="answer" value="${saved.get(n) ?? (stalePrefill && n === 1 ? '0' : '')}">
        <ul><li class="e-a" data-index="1" data-subquestiontype="3">正确</li>
        <li class="e-a" data-index="0" data-subquestiontype="3">错误</li></ul></form>`).join('')}
    </div></div></div><script>
    document.querySelectorAll('form li.e-a').forEach(li => li.onclick = async () => {
      const form = li.closest('form'); const slot = form.dataset.slot;
      form.querySelector('[name=answer]').value = li.dataset.index;
      const res = await fetch(form.action, {method:'POST', body:new URLSearchParams({slot, answer:li.dataset.index})});
      if (res.ok && [...document.querySelectorAll('form [name=answer]')].every(input => input.value !== ''))
        document.querySelector('.e-item').classList.add('active');
    });
    </script>`
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      let raw = ''
      for await (const part of req) raw += part
      const form = new URLSearchParams(raw)
      posts.push([form.get('slot'), form.get('answer')])
      if (persist && !failSave) saved.set(Number(form.get('slot')), form.get('answer'))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: failSave ? 0 : 1 }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(liveHtml(req.url.includes('cloze') ? '9' : req.url.includes('listening') ? '11' : '8'))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const live = await browser.newPage()
    await live.goto('http://127.0.0.1:' + server.address().port)
    assert.deepEqual(await submit.submitHomework({ page: live, local_id: 'student-test', slot: 'occupied',
      account: 'auto_answering', homeworkName: 'Homework' }), { ok: false, incomplete: true })
    const group = await answer.readEnglishGroup(live, '1', '8')
    globalThis.__englishBank = new Map(group.slots.map((slot, i) => [slot.hash, { answer_texts: [slot.options[i]] }]))
    const result = await answer.answerPage({ page: live, local_id: 'student-test', slot: 'occupied',
      account: 'auto_answering', courseName: 'English', homeworkName: 'Homework' })
    assert.equal(result.results.length, 2)
    assert.deepEqual(result.results.map(row => [row.no, row.parentNo, row.slot]), [['1', '1', 1], ['2', '1', 2]])
    assert.deepEqual(posts, [['1', '1'], ['2', '0']])
    await live.reload()
    assert.deepEqual(await live.locator('form [name=answer]').evaluateAll(items => items.map(item => item.value)), ['1', '0'])
    console.log('T003 英语子题逐项保存并重载读回通过')
    saved.clear(); posts.length = 0; stalePrefill = true
    await live.reload()
    globalThis.__englishBank = new Map(group.slots.map((slot, i) => [slot.hash, { answer_texts: [slot.options[i === 0 ? 1 : 0]] }]))
    await answer.answerPage({ page: live, local_id: 'student-test', slot: 'occupied',
      account: 'auto_answering', courseName: 'English', homeworkName: 'Prefilled but unsaved' })
    assert.deepEqual(posts, [['1', '0'], ['2', '1']], '页面预填答案也必须发保存请求')
    stalePrefill = false
    saved.clear(); persist = false
    await live.reload()
    const noHydration = await answer.answerPage({ page: live, local_id: 'student-test', slot: 'occupied',
      account: 'auto_answering', courseName: 'English', homeworkName: 'No GET hydration' })
    assert.equal(noHydration.compositeVerified, true, '保存成功且页面答案完整时可继续提交')
    console.log('T003 站点 GET 不回显时保留当前作答页通过')
    persist = true
    failSave = true; await live.reload()
    await assert.rejects(answer.answerPage({ page: live, local_id: 'student-test', slot: 'occupied',
      account: 'auto_answering', courseName: 'English', homeworkName: 'Rejected save' }), /英语子项保存失败/)
    failSave = false
    for (const [path, type] of [['cloze', '9']]) {
      saved.clear(); posts.length = 0
      await live.goto('http://127.0.0.1:' + server.address().port + '/?' + path)
      globalThis.__englishBank = new Map()
      const variant = await answer.answerPage({ page: live, local_id: 'student-test', slot: 'occupied',
        account: 'auto_answering', courseName: 'English', homeworkName: path })
      assert.equal(variant.results.length, 2)
      assert.equal(variant.results.every(row => row.parentNo === '1' && row.source === 'AI 答题'), true)
      assert.ok(globalThis.__englishAiSlots.every(slot => !slot.stem.includes('A short passage about two people.')), '整组提示词的共享材料不应在每个子题中重复')
      assert.deepEqual(posts, [['1', '1'], ['2', '0']], type)
      assert.equal(variant.compositeVerified, true)
    }
    console.log('T003 完型空题干整组求解保存通过')
    saved.clear(); posts.length = 0
    await live.goto('http://127.0.0.1:' + server.address().port + '/?listening')
    const listeningGroup = await answer.readEnglishGroup(live, '1', '11')
    const aiCalls = globalThis.__englishAiCalls || 0
    globalThis.__englishBank = new Map([[listeningGroup.slots[0].hash, { answer_texts: [listeningGroup.slots[0].options[0]] }]])
    await assert.rejects(answer.answerPage({ page: live, local_id: 'student-test', slot: 'occupied',
      account: 'auto_answering', courseName: 'English', homeworkName: 'Listening' }), /听力题库缺少.*第 2 题/)
    assert.deepEqual(posts, [], '听力题库缺项时不能部分保存')
    assert.equal(globalThis.__englishAiCalls || 0, aiCalls, '听力不得调用 AI')
    globalThis.__englishBank.set(listeningGroup.slots[1].hash, { answer_texts: [listeningGroup.slots[1].options[1]] })
    const bankListening = await answer.answerPage({ page: live, local_id: 'student-test', slot: 'occupied',
      account: 'auto_answering', courseName: 'English', homeworkName: 'Listening' })
    assert.equal(bankListening.bankCount, 2)
    assert.ok(bankListening.results.every(row => row.source === '题库答题'))
    assert.deepEqual(posts, [['1', '1'], ['2', '0']])
    assert.equal(globalThis.__englishAiCalls || 0, aiCalls)
  } finally {
    server.close()
  }

  const matchSaved = new Map()
  const matchPosts = []
  const matchHtml = () => `<div class="e-q-body" data-num="1" data-questiontype="7"><div class="e-q-r">
    <form action="/study/ajax-assignment-online_homework_match"><div class="e-q-quest">
      <div class="e-q-q">Match words.</div><div class="e-a-g e-short-a">
      <div class="am-u-sm-5"><div class="ErichText">1、cat</div><div class="ErichText">2、dog</div></div>
      <div class="am-u-sm-1">${[1, 2].map(n => `<select name="answer" data-slot="${n}">
        <option value="0" ${matchSaved.get(n) === '0' ? 'selected' : ''}>A</option>
        <option value="1" ${matchSaved.get(n) === '1' ? 'selected' : ''}>B</option></select>`).join('')}</div>
      <div class="am-u-offset-1 am-u-sm-5"><div class="ErichText">A 、猫</div>
        <div class="ErichText">B 、狗</div></div></div></div></form></div></div><script>
    document.querySelectorAll('select').forEach(select => select.onchange = async () => {
      await fetch('/study/ajax-assignment-online_homework_match', {method:'POST',
        body:new URLSearchParams({slot:select.dataset.slot, answer:select.value})});
    });</script>`
  const matchServer = createServer(async (req, res) => {
    if (req.method === 'POST') {
      let raw = ''; for await (const part of req) raw += part
      const form = new URLSearchParams(raw)
      matchPosts.push([form.get('slot'), form.get('answer')])
      matchSaved.set(Number(form.get('slot')), form.get('answer'))
      res.writeHead(200); res.end('ok'); return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(matchHtml())
  })
  await new Promise(resolve => matchServer.listen(0, '127.0.0.1', resolve))
  try {
    const match = await browser.newPage()
    await match.goto('http://127.0.0.1:' + matchServer.address().port)
    const group = await answer.readEnglishGroup(match, '1', '7')
    globalThis.__englishBank = new Map(group.slots.map((slot, i) => [slot.hash, { answer_texts: [slot.options[i]] }]))
    const result = await answer.answerPage({ page: match, local_id: 'student-test', slot: 'occupied',
      account: 'auto_answering', courseName: 'English', homeworkName: 'Matching' })
    assert.equal(result.compositeVerified, true)
    assert.deepEqual(matchPosts, [['1', '0'], ['2', '1']])
    assert.deepEqual(await match.locator('select[name=answer]').evaluateAll(items => items.map(item => item.value)), ['0', '1'])
    console.log('T003 词汇匹配默认 A 和逐槽保存读回通过')
  } finally {
    matchServer.close()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await browser.close()
}
