import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'patchright'

const html = mode => `<button id="submitHomeWork">提交作业</button><input name="answer" value="saved-answer">
  <div id="dl_qrCodeCheck" style="display:none;width:300px;height:200px">微信扫码验证 未扫码<div id="qrCode" style="width:100px;height:100px"></div></div>
  <div class="xcConfirm" style="display:none"><span id="message"></span>
    <a class="sgBtn ok">确定</a><a class="sgBtn cancel">取消</a></div>
  <script>
    window.__submitted = false; window.__cancelled = false; window.__step = 0; window.__clicks = 0;
    const dialog = document.querySelector('.xcConfirm');
    const message = document.querySelector('#message');
    document.querySelector('#submitHomeWork').onclick = () => {
      window.__clicks++; document.body.dataset.clicks = String(window.__clicks);
      message.textContent = '${mode === 'incomplete' ? '部分题目没有作答，是否继续提交？' : '作业提交后将不可修改，您确定要提交作业吗？'}';
      dialog.style.display = 'block';
    };
    document.querySelector('.sgBtn.cancel').onclick = () => { dialog.style.display = 'none'; document.body.dataset.cancelled = 'yes'; window.__cancelled = true };
    document.querySelector('.sgBtn.ok').onclick = () => {
      dialog.style.display = 'none';
      if ('${mode}' === 'qr' && document.body.dataset.verified !== 'yes' && localStorage.getItem('fixture-submit-verified') !== 'yes') { document.querySelector('#dl_qrCodeCheck').style.display = 'block'; return }
      if ('${mode}' === 'stuck') return;
      if ('${mode}' === 'single') { window.location.href = '/study/assignment-preview.aspx'; return }
      if (++window.__step === 1) setTimeout(() => { message.textContent = '再次确认提交'; dialog.style.display = 'block' }, 200);
      else { window.__submitted = true; window.location.href = '/study/assignment-preview.aspx' }
    };
  </script>`
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(req.url.includes('assignment-preview.aspx') ? '<main>已提交</main>' : html(new URL(req.url, 'http://local').searchParams.get('mode') || (req.url.includes('incomplete') ? 'incomplete' : 'normal')))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const built = await build({ entryPoints: ['electron/submit.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{
  name: 'local-history', setup(plugin) {
    plugin.onResolve({ filter: /detect$/ }, args => ({ path: args.path, namespace: 'local-detect' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-detect' }, () => ({ contents: 'export const readHistory=async()=>[]', loader: 'js' }))
  },
}] })
const submit = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const browser = await chromium.launch({ headless: process.env.KAIDA_DISPLAY_MODE !== 'visual', channel: process.env.KAIDA_TEST_BROWSER ? 'chromium' : 'chrome', executablePath: process.env.KAIDA_TEST_BROWSER })
try {
  const page = await browser.newPage()
  const origin = 'http://127.0.0.1:' + server.address().port
  const opts = { page, local_id: 'student-1', slot: 'occupied', account: 'auto_answering', homeworkName: '测试作业' }
  await page.goto(origin + '/?incomplete')
  const blocked = await submit.submitHomework(opts)
  assert.deepEqual(blocked, { ok: false, incomplete: true })
  assert.equal(await page.locator('body').getAttribute('data-cancelled'), 'yes')
  assert.equal(new URL(page.url()).pathname, '/')
  await page.goto(origin + '/')
  const normal = await submit.submitHomework(opts)
  assert.deepEqual(normal, { ok: true })
  assert.equal(new URL(page.url()).pathname, '/study/assignment-preview.aspx')
  await page.goto(origin + '/?mode=single')
  assert.deepEqual(await submit.submitHomework(opts), { ok: true }, '完整答案一次确认即可成功')
  await page.goto(origin + '/?mode=qr')
  const qrStop = new AbortController()
  const evaluate = page.evaluate.bind(page)
  let stoppedQrCalls = 0
  page.evaluate = async (fn, arg) => {
    const result = await evaluate(fn, arg)
    if (arg === '#dl_qrCodeCheck' && result?.display !== 'none') qrStop.abort()
    return result
  }
  try {
    assert.deepEqual(await submit.submitHomework({ ...opts, signal: qrStop.signal,
      onNeedVerify: async () => { stoppedQrCalls++ } }), { ok: false })
    assert.equal(stoppedQrCalls, 0, '二维码检查期间停止不能再创建扫码等待器')
  } finally { page.evaluate = evaluate }
  await page.goto(origin + '/?mode=single')
  const confirmStop = new AbortController()
  const locator = page.locator.bind(page)
  page.locator = (selector, ...args) => {
    const target = locator(selector, ...args)
    return selector === '.xcConfirm a.sgBtn.ok' ? wrapConfirm(target) : target
  }
  function wrapConfirm(target) {
    return new Proxy(target, { get(object, key) {
      if (key === 'filter' || key === 'first') return (...args) => wrapConfirm(object[key](...args))
      if (key === 'locator') return (...args) => {
        const text = object.locator(...args)
        const innerText = text.innerText.bind(text)
        text.innerText = async (...params) => { const result = await innerText(...params); confirmStop.abort(); return result }
        return text
      }
      return typeof object[key] === 'function' ? object[key].bind(object) : object[key]
    } })
  }
  try {
    assert.deepEqual(await submit.submitHomework({ ...opts, signal: confirmStop.signal }), { ok: false })
    assert.equal(new URL(page.url()).pathname, '/', '读取确认框期间停止不能继续确认交卷')
    assert.equal(await page.locator('.xcConfirm').isVisible(), true)
  } finally { page.locator = locator }
  await page.goto(origin + '/?mode=qr')
  let scans = 0
  const withQr = await submit.submitHomework({ ...opts, onNeedVerify: async () => {
    scans++
    assert.equal(await page.locator('[name=answer]').inputValue(), 'saved-answer', '扫码不能丢失答案')
    assert.equal(Number(await page.locator('body').getAttribute('data-clicks')), 1, '扫码前不能重复点击提交')
    await page.evaluate(() => { document.body.dataset.verified = 'yes'; localStorage.setItem('fixture-submit-verified','yes'); document.querySelector('#dl_qrCodeCheck').style.display = 'none' })
  } })
  assert.equal(scans, 1, '提交原生二维码必须交给扫码等待流程')
  assert.deepEqual(withQr, { ok: true })
  await page.goto(origin + '/?mode=qr')
  assert.deepEqual(await submit.submitHomework({ ...opts, onNeedVerify: async () => assert.fail('学校免扫码时不能强制再次验证') }), { ok: true })
  await page.evaluate(() => localStorage.removeItem('fixture-submit-verified'))
  await page.goto(origin + '/?mode=stuck')
  assert.deepEqual(await submit.submitHomework(opts), { ok: false }, '未跳转不能报提交成功')
  assert.equal(Number(await page.locator('body').getAttribute('data-clicks')), 1, '提交已确认时不盲重试')
  await page.goto(origin + '/?mode=qr')
  const controller = new AbortController()
  const stopped = await submit.submitHomework({ ...opts, signal: controller.signal, onNeedVerify: async () => controller.abort() })
  assert.deepEqual(stopped, { ok: false })
  assert.equal(Number(await page.locator('body').getAttribute('data-clicks')), 1, '扫码停止后不得恢复提交')
  console.log('T002 真实提交确认与未作答警告取消路径通过')
} finally {
  await browser.close()
  server.close()
}
