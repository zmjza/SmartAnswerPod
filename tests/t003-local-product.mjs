import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron, chromium } from 'patchright'

const mode = process.env.KAIDA_DISPLAY_MODE === 'visual' ? 'visual' : 'headless'
const courseKind = process.env.KAIDA_LOCAL_COURSE === 'pinned' ? 'pinned' : 'english'
const targetCourseName = courseKind === 'pinned' ? '形势与政策(1)' : '大学英语'
const fixture = readFileSync('tests/fixtures/大学英语当前试卷/大学英语当前试卷-本地脱敏测试案例.html', 'utf8')
const rows = new Map()
let correctedHash = ''
let correctedAnswer = ''
let missingListeningHash = ''
const saved = new Map()
const events = { saves: 0, submits: 0, bankGets: 0, bankPatches: 0, historyGets: 0, scanned: false, verified: false }
const source = code => '<script>' + code + '</script>'
const savedObject = () => Object.fromEntries(saved)
const answerScript = () => source(`
  const stored = ${JSON.stringify(savedObject())};
  const done = (body) => {
    const controls = body.dataset.questiontype === '7' ? [...body.querySelectorAll('select[name=answer]')] :
      [...body.querySelectorAll('form input[name=answer]')];
    document.querySelector('.e-selects-g .e-item[data-num="' + body.dataset.num + '"]')
      ?.classList.toggle('active', controls.length > 0 && controls.every(control => control.value !== ''));
  };
  document.querySelectorAll('.e-q-body').forEach(body => {
    const matching = body.dataset.questiontype === '7';
    const forms = matching ? [body.querySelector('form')] : [...body.querySelectorAll('form')];
    forms.forEach((form, index) => {
      const controls = matching ? [...form.querySelectorAll('select[name=answer]')] : [form.querySelector('input[name=answer]') || (() => {
        const input = document.createElement('input'); input.name = 'answer'; input.type = 'hidden'; form.append(input); return input;
      })()];
      controls.forEach((control, offset) => {
        const slot = matching ? offset + 1 : index + 1;
        const key = body.dataset.num + ':' + slot;
        control.value = stored[key] ?? (matching ? '' : '');
        const save = async value => {
          control.value = value;
          const path = matching ? 'match' : ['8','9','11'].includes(body.dataset.questiontype) ? 'subanswer' : 'answer';
          const response = await fetch('/study/ajax-assignment-online_homework_' + path, { method:'POST',
            body:new URLSearchParams({ key, answer:value }) });
          if (response.ok) done(body);
        };
        if (matching) control.addEventListener('change', () => save(control.value));
        else form.querySelectorAll('li.e-a').forEach(li => li.addEventListener('click', () => {
          form.querySelectorAll('li.e-a').forEach(other => other.classList.remove('checked'));
          li.classList.add('checked'); save(li.dataset.index);
        }));
      });
    });
    done(body);
  });
  document.body.insertAdjacentHTML('beforeend', '<button id="submitHomeWork">提交作业</button><div class="xcConfirm" style="display:none">作业提交后将不可修改，您确定要提交作业吗？<a class="sgBtn ok">确定</a><a class="sgBtn cancel">取消</a></div>');
  const dialog = document.querySelector('.xcConfirm');
  document.querySelector('#submitHomeWork').onclick = () => { dialog.style.display = 'block'; };
  dialog.querySelector('.cancel').onclick = () => { dialog.style.display = 'none'; };
  dialog.querySelector('.ok').onclick = async () => {
    dialog.style.display = 'none';
    const response = await fetch('/internal/submit', { method:'POST' });
    if (response.ok) location.href = '/study/assignment-preview.aspx?homeWorkId=1';
  };
`)
const answerHtml = () => fixture.replace('</body>', answerScript() + '</body>')
const historyScript = () => source(`
  const stored = ${JSON.stringify(savedObject())};
  document.querySelectorAll('.e-q-body').forEach(body => {
    const type = body.dataset.questiontype;
    if (type === '7') {
      const group = body.querySelector('.e-short-a');
      group.insertAdjacentHTML('beforeend', Array.from({ length: 10 }, (_, index) =>
        '<div class="e-ans-ref"><span class="e-ans-r">' + String.fromCharCode(65 + index) + '</span></div>').join(''));
      return;
    }
    const forms = [...body.querySelectorAll('form')];
    forms.forEach((form, index) => {
      const key = body.dataset.num + ':' + (index + 1);
      const selected = stored[key];
      const options = [...form.querySelectorAll('li.e-a')];
      options.forEach(li => li.classList.toggle('checked', li.dataset.index === selected));
      const target = ['8','9','11'].includes(type) ? form : form.querySelector('.e-q');
      if (!target) return;
      const correct = selected === options[0]?.dataset.index;
      target.insertAdjacentHTML('beforeend',
        '<div class="e-q-l"><span class="' + (correct ? 'e-q-right' : 'e-q-wrong') + '"></span></div>' +
        '<input name="GiveScore" value="' + (correct ? '2' : '0') + '">' +
        '<div class="e-a-ans"><div class="e-ans-ref">' +
        (options[0]?.dataset.subquestiontype === '3'
          ? '<div class="e-ans-r"><div class="e-a-g"><p class="checked">正确</p></div></div>'
          : '<span class="e-ans-r">A</span>') + '</div></div>');
    });
  });
`)
const historyHtml = () => fixture.replace('</body>', historyScript() + '</body>')
const portalHtml = `<html><body><!-- assets/ ${'x'.repeat(2200)} -->
  <div id="tab-courseList" class="is-active">我的课程</div>
  <div class="box-card"><div class="el-card__body"><div class="el-tabs__content">
  <div class="course-item"><div class="course-title"><a class="el-link" title="点击进入学习" href="/study/learnCatalogNew.aspx?courseOpenId=pinned"><span class="el-link__inner">形势与政策(1)</span></a></div></div>
  </div></div></div>
  <div id="pane-courseList"><div class="course-item"><div class="course-title">
  <a class="el-link" title="点击进入学习" href="/study/learnCatalogNew.aspx?courseOpenId=english"><span class="el-link__inner">大学英语</span></a>
  </div></div></div></body></html>`
const catalogHtml = '<html><body><a id="courseHomeWorkNew" href="/study/HomeWorkNew.aspx">形考作业</a></body></html>'
const homeworkHtml = `<html><body><div id="onlineHomework"><table><tbody><tr>
  <td>1</td><td title="本地英语试卷">本地英语试卷</td><td></td><td>客观题</td><td>100%</td>
  <td title="2000-01-01">2000-01-01</td><td title="2099-01-01">2099-01-01</td>
  <td>0/1<input name="replyCount" value="1"><a href="/study/assignment-preview.aspx?homeWorkId=1">查看</a></td>
  </tr></tbody></table></div><div id="phasedTest"><table><tbody></tbody></table></div></body></html>`
const previewHtml = () => `<html><body><main id="mainContent"><table class="am-table"><tbody>
  ${Array.from({ length: events.submits }, (_, index) => '<tr><td>' + (index + 1) + '</td><td>2026-09-28 12:' + String(index).padStart(2, '0') + ':00</td><td></td><td>已批阅</td><td title="98">98</td><td><a href="/study/assignment/history.aspx?homeWorkId=1&amp;attempt=' + (index + 1) + '">查看</a></td></tr>').join('')}
  </tbody></table></main><a class="am-btn" href="/study/assignment/preview.aspx?homeWorkId=1">做作业</a>
  <div id="dl_qrCodeCheck" style="display:none;width:260px;height:220px;background:white">微信扫码验证<img id="qrCode" width="120" height="120" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="></div>
  <script>
  const button = document.querySelector('.am-btn');
  button.onclick = event => { event.preventDefault();
    if (${events.verified}) location.href = button.href;
    else document.querySelector('#dl_qrCodeCheck').style.display = 'block';
  };
  setInterval(async () => {
    const response = await fetch('/internal/qr-status');
    if (response.ok && (await response.json()).verified)
      document.querySelector('#dl_qrCodeCheck').style.display = 'none';
  }, 150);
  </script></body></html>`
const bundle = async (entryPoints, plugins = []) => {
  const result = await build({ entryPoints, bundle: true, platform: 'node', format: 'esm', write: false, plugins })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
const answer = await bundle(['electron/answer.ts'], [{
  name: 'local-boundaries', setup(plugin) {
    plugin.onResolve({ filter: /bank$|ai$/ }, args => ({ path: args.path, namespace: 'local-boundary' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-boundary' }, args => ({
      contents: args.path === './bank'
        ? 'export const lookupByHash=async()=>null'
        : 'export const askAi=async()=>({texts:null,attempts:[]});export const askAiGroup=async()=>({selected:null,attempts:[]});export const retryAsked=()=>{}',
      loader: 'js',
    }))
  },
}])
const hash = await bundle(['electron/core/hash.ts'])
const seedBrowser = await chromium.launch({ headless: true })
try {
  const page = await seedBrowser.newPage()
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(fixture))
  for (const [no, type] of [['1', '11'], ['12', '7'], ['13', '9'], ['14', '8'], ['15', '8']]) {
    const group = await answer.readEnglishGroup(page, no, type)
    for (const slot of group.slots) {
      if (type === '11' && slot.ordinal === 3) missingListeningHash = slot.hash
      const choice = type === '7' ? slot.ordinal - 1 : 0
      rows.set(slot.hash, { content_hash: slot.hash, qtype: slot.qtype, stem: slot.stem, options: slot.options,
        answer_texts: [slot.options[choice]], course_names: [], source: 'import', verified: true, conflict: false })
    }
  }
  const ordinary = await page.locator('.e-q-body[data-questiontype="1"]').evaluateAll(bodies => bodies.map(body => ({
    stem: body.querySelector('.e-q-q').textContent,
    options: [...body.querySelectorAll('li.e-a')].map(li => li.textContent),
  })))
  ordinary.forEach(({ stem, options }, index) => {
    const normalized = options.map(option => hash.normalizeOption(option, 'single'))
    const key = hash.contentHash('single', stem, normalized)
    if (index === 0) { correctedHash = key; correctedAnswer = normalized[0] }
    rows.set(key, { content_hash: key, qtype: 'single', stem: hash.normalizeStem(stem), options: normalized,
      answer_texts: [normalized[index === 0 ? 1 : 0]], course_names: [], source: 'import', verified: true, conflict: false })
  })
  assert.equal(rows.size, 45, '本地试卷应包含 45 个可识别作答位')
} finally { await seedBrowser.close() }
const review = await bundle(['electron/review.ts'], [{
  name: 'local-bank', setup(plugin) {
    plugin.onResolve({ filter: /bank.ts$/ }, args => ({ path: args.path, namespace: 'local-bank' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-bank' }, () => ({
      contents: 'export const deleteByHash=async()=>false;export const upsertQuestion=async()=>"failed"', loader: 'js',
    }))
  },
}])
const probe = await chromium.launch({ headless: true })
try {
  const page = await probe.newPage()
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(fixture))
  const selections = await page.locator('.e-q-body').evaluateAll(bodies => bodies.flatMap(body => {
    const controls = body.dataset.questiontype === '7' ? [...body.querySelectorAll('select[name=answer]')] :
      [...body.querySelectorAll('form')].map(form => form.querySelector('li.e-a'))
    return controls.map((control, index) => [body.dataset.num + ':' + (index + 1),
      body.dataset.num === '2' ? '1' : body.dataset.questiontype === '7' ? String(index) :
        control?.dataset.index || '0'])
  }))
  selections.forEach(([key, value]) => saved.set(key, value))
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(historyHtml()))
  const reviewed = await review.readReviewedQuestions(page)
  assert.equal(reviewed.length, 45, '本地批阅应展开为 45 个作答位')
  assert.equal(reviewed.filter(row => row.hash && rows.has(row.hash)).length, 45, '批阅身份未与作答题库匹配')
  assert.equal(reviewed.filter(row => row.stem.includes('[匹配槽') && row.referenceState === 'valid').length,
    10, '十个匹配槽必须各有可靠参考答案')
} finally { saved.clear(); await probe.close() }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (value, status = 200, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type }); res.end(value)
  }
  if (url.pathname === '/rest/v1/questions') {
    const key = url.searchParams.get('content_hash')?.replace(/^eq\./, '')
    if (req.method === 'GET') { events.bankGets++; send(JSON.stringify(key ? rows.has(key) ? [rows.get(key)] : [] : [...rows.values()]), 200, 'application/json'); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const item = JSON.parse(raw || '{}')
    if (req.method === 'PATCH' && key) { events.bankPatches++; rows.set(key, { ...rows.get(key), ...item }); send(JSON.stringify([rows.get(key)]), 200, 'application/json'); return }
    if (req.method === 'POST') { rows.set(item.content_hash, item); send(JSON.stringify([item]), 200, 'application/json'); return }
    if (req.method === 'DELETE' && key) { rows.delete(key); send('[]', 200, 'application/json'); return }
  }
  if (url.pathname === '/internal/scan' && req.method === 'POST') { events.scanned = true; events.verified = true; send('{}', 200, 'application/json'); return }
  if (url.pathname === '/internal/qr-status') { send(JSON.stringify({ verified: events.verified }), 200, 'application/json'); return }
  if (url.pathname === '/internal/submit' && req.method === 'POST') {
    if (saved.size !== 45) { send('incomplete', 409); return }
    events.submits++; send('ok'); return
  }
  if (url.pathname.startsWith('/study/ajax-assignment-online_homework_') && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk
    const params = new URLSearchParams(raw)
    if (!/^\d+:\d+$/.test(params.get('key') || '')) { send('invalid', 400); return }
    saved.set(params.get('key'), params.get('answer')); events.saves++; send('ok'); return
  }
  if (url.pathname === '/scenter') { send(portalHtml); return }
  if (url.pathname.toLowerCase() === '/study/learncatalognew.aspx') { send(catalogHtml); return }
  if (url.pathname.toLowerCase() === '/study/homeworknew.aspx') { send(homeworkHtml); return }
  if (url.pathname === '/study/assignment-preview.aspx') { send(previewHtml()); return }
  if (url.pathname === '/study/assignment/preview.aspx') { send(answerHtml()); return }
  if (url.pathname === '/study/assignment/history.aspx') { events.historyGets++; send(historyHtml()); return }
  send('missing local boundary', 404)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const waitUntil = async (check, label, timeout = 180_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(label + ' 超时')
}
const launchProduct = async round => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '',
    KAIDA_E2E_USERDATA: resolve('.playwright', `t003-local-product-${mode}-${process.pid}-${round}`),
    KAIDA_E2E_SCHOOL_ORIGIN: origin, KAIDA_SUPABASE_URL: '', KAIDA_SUPABASE_ANON: '', KAIDA_SILICONFLOW_KEY: '' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const renderer = source => app.evaluate(({ BrowserWindow }, script) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
  const invoke = (fn, arg) => renderer('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')')
  const config = await invoke(async ({ origin, mode }) => {
    const settings = await window.kaida.saveSettings({ supabase_url: origin, supabase_anon: 'local-test', account_parallel: 2, course_parallel: 1 })
    const added = await window.kaida.addAccount({ name: '内部测试学生', username: 'local-student', password: 'local-only' })
    const second = await window.kaida.addAccount({ name: '内部第二学生', username: 'local-student-2', password: 'local-only' })
    const id = (await window.kaida.listAccounts())[0]?.local_id
    const display = await window.kaida.setDisplay(id, mode)
    const work = await window.kaida.setWorkMode(id, 'answer')
    const scope = await window.kaida.setCourseScope(id, 'selected')
    const secondId = (await window.kaida.listAccounts())[1]?.local_id
    const secondDisplay = await window.kaida.setDisplay(secondId, mode)
    const secondScope = await window.kaida.setCourseScope(secondId, 'selected')
    return { ok: settings.ok && added.ok && second.ok && display.ok && work.ok && scope.ok && secondDisplay.ok && secondScope.ok, id, secondId }
  }, { origin, mode })
  assert.equal(config.ok, true, '隔离产品配置失败')
  return { app, page, ids: [config.id, config.secondId], snapshot: () => renderer('window.kaida.snapshot()') }
}
let app
try {
  let product = await launchProduct(1)
  app = product.app
  let { page, snapshot } = product
  for (let round = 1; round <= 1; round++) {
    await page.locator('#btn-primary-action').click()
    await waitUntil(async () => (await snapshot()).students.every(student => student.awaitingCourseSelection), '双学生课程选择')
    const scanned = (await snapshot()).students[0]
    assert.equal(scanned.courses.length, 2, '置顶课和英语课均应进入产品列表')
    const selected = scanned.courses.find(course => course.name === targetCourseName)
    assert.ok(selected, '目标课程缺失')
    await page.locator('#student-switcher [data-student="0"]').click()
    await page.locator('#course-list .course-item').filter({ hasText: targetCourseName }).first().click()
    await waitUntil(async () => (await snapshot()).students[0].selectedCourseKeys.includes(selected.key), '目标课程选课')
    await page.locator('#btn-primary-action').click()
    if (round === 1) {
      await waitUntil(async () => (await snapshot()).students[0].needsVerify, '内部二维码等待')
      await page.locator('#btn-verify-done').click()
      assert.equal((await snapshot()).students[0].verified, false, '未扫码不得授权')
      assert.equal(events.saves, 0, '未授权不得保存答案')
      await fetch(origin + '/internal/scan', { method: 'POST' })
      await waitUntil(async () => events.scanned, '内部边界扫码完成')
      await waitUntil(async () => {
        await page.locator('#btn-verify-done').click()
        return (await snapshot()).students[0].verified
      }, '扫码后的产品复核授权', 10_000)
      const authorized = (await snapshot()).students
      assert.equal(authorized[1].verified, false, '第二学生继承了第一学生授权')
      assert.equal(await page.locator('#student-name [aria-label="已授权"]').count(), 1, '工作台缺少第一学生授权标识')
      await page.locator('#student-switcher [data-student="1"]').click()
      assert.equal(await page.locator('#student-name [aria-label="已授权"]').count(), 0, '第二学生工作台误显示授权')
      await page.getByText('学生账号', { exact: true }).first().click()
      await page.getByRole('heading', { name: '学生账号管理' }).waitFor()
      const cards = page.locator('#accounts-grid > div')
      assert.equal(await cards.filter({ hasText: '内部测试学生' }).locator('[aria-label="已授权"]').count(), 1, '账号页第一学生缺少授权')
      assert.equal(await cards.filter({ hasText: '内部第二学生' }).locator('[aria-label="已授权"]').count(), 0, '账号页第二学生误显示授权')
      await page.getByText('工作台', { exact: true }).first().click()
      await page.locator('#student-switcher [data-student="0"]').click()
    }
    try {
      await waitUntil(async () => events.submits === round && events.historyGets > 0 &&
        rows.get(correctedHash)?.answer_texts?.[0] === correctedAnswer && events.bankPatches > 0, '英语保存提交与参考答案更新', 240_000)
    } catch (error) {
      const current = (await snapshot()).students[0]
      console.error('T003 内部链路状态', { round, account: current.account, slot: current.slot,
        verified: current.verified, needsVerify: current.needsVerify, action: current.action,
        homeworkStatuses: current.courses.flatMap(course => course.groups.flatMap(group => group.rows.map(row => row.status))),
        saves: events.saves, submits: events.submits, historyGets: events.historyGets, bankGets: events.bankGets })
      throw error
    }
    await waitUntil(async () => (await snapshot()).students[0].account === 'round_ended',
      '整卷批阅回写终态', 30_000).catch(async error => {
        const student = (await snapshot()).students[0]
        console.error('T003 整卷待处理', { account: student.account, action: student.action,
          statuses: student.courses.flatMap(course => course.groups.flatMap(group => group.rows.map(row => row.status))),
          bankPatches: events.bankPatches,
          reviewLogs: student.logs.filter(line => line.includes('校对读取') || line.includes('参考答案')).slice(-6) })
        throw error
      })
    const finished = (await snapshot()).students[0]
    assert.equal(finished.bankCount, 45, '每轮应由隔离题库命中 45 个作答位')
    assert.equal(events.submits, round, '本地边界提交次数不符')
    assert.equal(saved.size, 45, '45 个答案未全部保存并读回')
  }
  assert.ok(events.bankPatches >= 1, '参考答案未更新旧题库答案')
  assert.ok(events.historyGets >= 1 && events.bankGets >= 45, '批阅读回或题库命中缺证')
  assert.ok((await snapshot()).students[0].courses.every(course =>
    course.groups.every(group => group.rows.every(row => row.status !== 'pending_writeback'))),
  '有逐槽参考时不应留下待回写')
  const firstBankGets = events.bankGets
  const firstHistoryGets = events.historyGets
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.kaida.stopAllStudents()'))
  assert.ok((await snapshot()).students.every(student => !student.verified), '停止后授权没有撤销')
  await app.close()
  app = undefined
  events.verified = false
  events.scanned = false
  product = await launchProduct(2)
  app = product.app
  ;({ page, snapshot } = product)
  await page.locator('#btn-primary-action').click()
  await waitUntil(async () => (await snapshot()).students.every(student => student.awaitingCourseSelection), '再次双学生课程选择')
  const selectedAgain = (await snapshot()).students[0].courses.find(course => course.name === targetCourseName)
  assert.ok(selectedAgain, '再次扫描未找到目标课程')
  await page.locator('#student-switcher [data-student="0"]').click()
  await page.locator('#course-list .course-item').filter({ hasText: targetCourseName }).first().click()
  await waitUntil(async () => (await snapshot()).students[0].selectedCourseKeys.includes(selectedAgain.key), '再次目标课程选课')
  await page.locator('#btn-primary-action').click()
  await waitUntil(async () => (await snapshot()).students[0].needsVerify, '再次二维码等待')
  assert.equal((await snapshot()).students[0].verified, false, '新会话不得继承授权')
  await fetch(origin + '/internal/scan', { method: 'POST' })
  await waitUntil(async () => {
    await page.locator('#btn-verify-done').click()
    return (await snapshot()).students[0].verified
  }, '再次产品复核授权', 10_000)
  await waitUntil(async () => {
    const current = (await snapshot()).students[0]
    return current.account === 'round_ended' && current.bankCount === 45 &&
      events.submits === 2 && events.historyGets > firstHistoryGets
  }, '再次题库命中与本次批阅', 240_000)
  assert.ok(events.bankGets >= firstBankGets + 45, '第二轮未重新读取隔离题库')
  assert.equal(rows.get(correctedHash).answer_texts[0], correctedAnswer, '更正答案在第二轮丢失')
  const savesBeforeMiss = events.saves
  const submitsBeforeMiss = events.submits
  rows.delete(missingListeningHash)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.kaida.stopAllStudents()'))
  await app.close()
  app = undefined
  product = await launchProduct(3)
  events.verified = false
  events.scanned = false
  app = product.app
  ;({ page, snapshot } = product)
  await page.locator('#btn-primary-action').click()
  await waitUntil(async () => (await snapshot()).students.every(student => student.awaitingCourseSelection), '缺项轮课程选择')
  const missCourse = (await snapshot()).students[0].courses.find(course => course.name === targetCourseName)
  await page.locator('#student-switcher [data-student="0"]').click()
  await page.locator('#course-list .course-item').filter({ hasText: targetCourseName }).first().click()
  await waitUntil(async () => (await snapshot()).students[0].selectedCourseKeys.includes(missCourse.key), '缺项轮选课')
  await page.locator('#btn-primary-action').click()
  await waitUntil(async () => (await snapshot()).students[0].needsVerify, '缺项轮二维码等待')
  await fetch(origin + '/internal/scan', { method: 'POST' })
  await waitUntil(async () => {
    await page.locator('#btn-verify-done').click()
    return (await snapshot()).students[0].verified
  }, '缺项轮复核授权', 10_000)
  await waitUntil(async () => (await snapshot()).students[0].account === 'round_ended', '缺项轮结束')
  const missed = (await snapshot()).students[0]
  assert.equal(missed.courses.find(course => course.name === targetCourseName)?.groups.flatMap(group => group.rows).find(row => row.name === '本地英语试卷')?.status,
    'skip_bank_miss', '缺项应单独标记')
  assert.ok(missed.logs.some(line => line.includes('第 3 题')), '缺项题号未显示')
  assert.equal(events.saves, savesBeforeMiss, '缺项后不应保存任一答案')
  assert.equal(events.submits, submitsBeforeMiss, '缺项后不应提交')
  console.log('T003 内部产品链路通过', { mode, courseKind, slots: saved.size, saves: events.saves,
    submits: events.submits, historyGets: events.historyGets, bankGets: events.bankGets,
    bankPatches: events.bankPatches, matchingReference: '逐槽批阅完成' })
} finally {
  if (app) {
    try { await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.kaida.stopAllStudents()')) } catch {}
    await app.close()
  }
  server.close()
}
