import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { _electron as electron } from 'patchright'
import { parseGoalAccounts } from './helpers/goal-accounts.mjs'

const goalFile = process.env.KAIDA_GOAL_FILE
assert.ok(goalFile, '缺少 KAIDA_GOAL_FILE')
const account = parseGoalAccounts(readFileSync(goalFile, 'utf8'))[Number(process.env.KAIDA_E2E_INDEX || 0)]
assert.ok(account, '测试账号序号无效')
const mode = process.env.KAIDA_DISPLAY_MODE === 'visual' ? 'visual' : 'headless'
const workMode = process.env.KAIDA_WORK_MODE === 'answer' ? 'answer' : 'extract'
const courseKind = process.env.KAIDA_REAL_COURSE === 'pinned' ? 'pinned' : 'english'
const courseScope = process.env.KAIDA_COURSE_SCOPE === 'all' ? 'all' : 'selected'
const rows = new Map()
const calls = { get: 0, post: 0, patch: 0, delete: 0 }
const bank = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname !== '/rest/v1/questions') { res.writeHead(404); res.end(); return }
  const hash = url.searchParams.get('content_hash')?.replace(/^eq\./, '')
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET') {
    calls.get++
    res.end(JSON.stringify(hash ? rows.has(hash) ? [rows.get(hash)] : [] : [...rows.values()].slice(0, 1)))
    return
  }
  let raw = ''
  for await (const part of req) raw += part
  const item = raw ? JSON.parse(raw) : {}
  if (req.method === 'POST') { calls.post++; rows.set(item.content_hash, item); res.end(JSON.stringify([item])); return }
  if (req.method === 'PATCH' && hash) {
    calls.patch++
    rows.set(hash, { ...rows.get(hash), ...item })
    res.end(JSON.stringify([rows.get(hash)]))
    return
  }
  if (req.method === 'DELETE' && hash) { calls.delete++; rows.delete(hash); res.end('[]'); return }
  res.writeHead(405); res.end('[]')
})
await new Promise(resolve => bank.listen(0, '127.0.0.1', resolve))
const bankUrl = `http://127.0.0.1:${bank.address().port}`
const userData = resolve('.playwright', `t003-product-${workMode}-${mode}-${process.pid}`)
let app
const waitUntil = async (check, label, timeout = 180_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(label + ' 超时')
}
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '',
    KAIDA_E2E_USERDATA: userData, KAIDA_SUPABASE_URL: '', KAIDA_SUPABASE_ANON: '',
    KAIDA_SILICONFLOW_KEY: '' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const renderer = source => app.evaluate(({ BrowserWindow }, script) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
  const invoke = (fn, arg) => renderer('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')')
  const configured = await invoke(async ({ account, bankUrl, mode, workMode, courseScope }) => {
    const settings = await window.kaida.saveSettings({ supabase_url: bankUrl, supabase_anon: 'local-test',
      account_parallel: 1, course_parallel: 1 })
    if (!settings.ok) return { ok: false, step: 'settings' }
    const added = await window.kaida.addAccount(account)
    if (!added.ok) return { ok: false, step: 'account' }
    const id = (await window.kaida.listAccounts())[0]?.local_id
    if (!id) return { ok: false, step: 'identity' }
    const display = await window.kaida.setDisplay(id, mode)
    const work = await window.kaida.setWorkMode(id, workMode)
    const scope = await window.kaida.setCourseScope(id, courseScope)
    return { ok: display.ok && work.ok && scope.ok, id }
  }, { account, bankUrl, mode, workMode, courseScope })
  assert.equal(configured.ok, true, `隔离产品设置失败：${configured.step || 'mode'}`)
  const snapshot = () => renderer('window.kaida.snapshot()')
  await page.locator('#btn-primary-action').click()
 await waitUntil(async () => {
   const student = (await snapshot()).students[0]
    return student?.awaitingCourseSelection || (courseScope === 'all' && ['login_failed', 'round_ended'].includes(student?.account))
 }, '真实课程扫描', 240_000)
 const scanned = (await snapshot()).students[0]
  if (courseScope === 'selected') assert.equal(scanned.awaitingCourseSelection, true, '真实站点未进入课程选择')
  const english = scanned.courses.find(course => course.name.includes('英语'))
  const pinned = scanned.courses.filter(course => /^形势与政策[（(]\d+[）)]$/.test(course.name))
  if (workMode === 'extract') {
    if (courseKind === 'english') assert.ok(english, '真实课程列表没有大学英语')
    assert.equal(pinned.length, 1, '置顶课没有进入产品课程列表')
  }
  const canAnswer = course => course.groups.some(group => group.rows.some(row => row.status === 'todo'))
 const chosen = workMode === 'extract' ? courseKind === 'pinned' ? pinned[0] : english
   : scanned.courses.find(course => canAnswer(course) && !pinned.some(item => item.key === course.key)) || pinned.find(canAnswer)
assert.ok(chosen, '真实课程列表没有可作答作业')
 if (courseScope === 'all') {
   await waitUntil(async () => (await snapshot()).students[0].account === 'round_ended', '真实全部课程提取', 900_000)
   const finished = (await snapshot()).students[0]
   console.error('T003 全部课程现场', JSON.stringify({ account: finished.account, action: finished.action, completed: finished.extractCompletedCourses, total: finished.extractTotalCourses, courses: finished.courses.map(course => ({ name: course.name, status: course.status, rows: course.groups.flatMap(group => group.rows.map(row => ({ name: row.name, status: row.status }))) })) }))
   assert.equal(finished.extractCompletedCourses, finished.extractTotalCourses, '全部课程未按顺序完成提取')
   assert.ok(finished.extractHistoryCompleted > 0, '全部课程没有读取已批阅历史')
   assert.ok(rows.size > 0, '全部课程隔离题库没有收到可靠历史题')
   console.log('T003 真实全部课程提取通过', { mode, courses: finished.courses.length, histories: finished.extractHistoryCompleted, bankRows: rows.size, bankCalls: calls })
 } else {
const chosenIndex = scanned.courses.findIndex(course => course.key === chosen.key)
 const chosenPage = Math.floor(chosenIndex / 7) + 1
  const previousCoursePage = page.getByRole('button', { name: '上一页课程' })
  while (await previousCoursePage.count() && await previousCoursePage.isEnabled())
    await previousCoursePage.click()
 for (let number = 1; number < chosenPage; number++)
   await page.getByRole('button', { name: '下一页课程' }).click()
 await page.locator('#course-list .course-item').filter({ hasText: chosen.name }).first().click()
  await waitUntil(async () => (await snapshot()).students[0].selectedCourseKeys.includes(chosen.key), '页面选择目标课程')
  await page.locator('#btn-primary-action').click()
  if (workMode === 'answer') {
    await waitUntil(async () => {
      const student = (await snapshot()).students[0]
      return student.needsVerify || student.account === 'round_ended'
    }, '真实二维码等待', 180_000)
    const reached = (await snapshot()).students[0]
    assert.equal(reached.needsVerify, true, `可作答课程未进入二维码等待：${reached.account}`)
    await page.locator('#btn-open-qr').click()
    const qrHeading = page.getByRole('heading', { name: '作业二维码' })
    await qrHeading.waitFor()
    const qrDialog = qrHeading.locator('xpath=ancestor::section[1]')
    const qrImage = qrDialog.locator('img[alt="当前作业扫码二维码"]')
    await qrImage.waitFor()
    assert.equal(await qrImage.evaluate(img => img.complete && img.naturalWidth > 0), true, '程序内二维码图片未加载')
    await qrDialog.getByRole('button', { name: '关闭二维码弹窗' }).click()
    assert.equal(await qrHeading.count(), 0, '关闭后二维码弹窗仍可见')
    await page.locator('#btn-verify-done').click()
    const waiting = (await snapshot()).students[0]
    assert.equal(waiting.verified, false, '未扫码却显示已授权')
    assert.equal(waiting.needsVerify, true, '未扫码却越过验证闸门')
    assert.equal(rows.size, 0, '扫码前不应写入隔离题库')
    console.log('T003 真实产品扫码前通过', { mode, courses: scanned.courses.length, pinned: pinned.length,
      selected: waiting.selectedCourseKeys.length, bankWrites: calls.post })
  } else {
    await waitUntil(async () => (await snapshot()).students[0].account === 'round_ended', '真实英语提取', 600_000)
    const finished = (await snapshot()).students[0]
    const selectedCourse = finished.courses.find(course => course.key === chosen.key)
    assert.ok(selectedCourse, '提取后英语课程丢失')
    assert.ok(finished.extractHistoryCompleted > 0, '没有读取已批阅历史')
    assert.ok(rows.size > 0, '隔离题库没有收到可靠历史题')
    if (courseKind === 'english') {
      const selectedRows = selectedCourse.groups.flatMap(group => group.rows)
      assert.ok(selectedRows.length > 0 && selectedRows.every(row => row.status !== 'pending_writeback'),
        '历史读取或待证题不应把整份英语作业卡在待回写')
      assert.match(finished.action, /待重试|写入失败|提取完成/)
    }
    console.log('T003 真实产品只读提取通过', { mode, courseKind, courses: scanned.courses.length,
      histories: finished.extractHistoryCompleted, bankRows: rows.size, bankCalls: calls })
  }
 }
} finally {
  if (app) {
    try { await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.kaida.stopAllStudents()')) } catch {}
    await app.close()
  }
  bank.close()
}
