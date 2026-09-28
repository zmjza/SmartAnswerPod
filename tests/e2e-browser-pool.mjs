import assert from 'node:assert/strict'
import { _electron as electron } from 'patchright'

const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
const renderer = (source) => app.evaluate(({ BrowserWindow }, script) =>
  BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
const call = (fn, arg) => renderer('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')')
const waitUntil = async (check, timeout = 45_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('等待浏览器池排队状态超时')
}

let ids = []
let originalSettings
try {
  const accounts = await renderer('window.kaida.listAccounts()')
  assert.ok(accounts.length >= 3, '至少需要三个已保存真机账号')
  ids = accounts.slice(0, 3).map((account) => account.local_id)
  originalSettings = await renderer('window.kaida.getSettings()')
  const configured = await renderer('window.kaida.saveSettings({ account_parallel: 2, course_parallel: 1 })')
  assert.equal(configured.ok, true, configured.error || '无法设置浏览器池并发')

  for (const id of ids) {
    assert.equal((await call((value) => window.kaida.setWorkMode(value, 'extract'), id)).ok, true)
    assert.equal((await call((value) => window.kaida.setCourseScope(value, 'all'), id)).ok, true)
    assert.equal((await call((value) => window.kaida.setDisplay(value, 'headless'), id)).ok, true)
  }

  await renderer('window.__kaidaPoolRun = window.kaida.loginRefresh(' + JSON.stringify(ids) + '); true')
  await waitUntil(async () => {
    const snapshot = await renderer('window.kaida.snapshot()')
    const selected = snapshot.students.filter((student) => ids.includes(student.local_id))
    const queued = selected.filter((student) => student.slot === 'queued')
    const occupied = selected.filter((student) => ['launching', 'occupied', 'occupying_verify'].includes(student.slot))
    return snapshot.running && queued.length >= 1 && occupied.length === 2 && snapshot.machine.browsers === 2 && snapshot.machine.recommendationSampled && /^\d+MB$/.test(snapshot.machine.browserAverage)
  })

  const snapshot = await renderer('window.kaida.snapshot()')
  const selected = snapshot.students.filter((student) => ids.includes(student.local_id))
  const occupied = selected.filter((student) => ['launching', 'occupied', 'occupying_verify'].includes(student.slot))
  const queued = selected.filter((student) => student.slot === 'queued')
  assert.equal(occupied.length, 2, '占用中的浏览器数量不符合账号并发')
  assert.equal(queued.length, 1, '第三个账号没有进入排队')
  assert.equal(snapshot.machine.browsers, occupied.length, '顶栏浏览器数把排队账号计入了占用数')
  assert.ok(queued.every((student) => !['launching', 'occupied', 'occupying_verify'].includes(student.slot)), '排队账号错误占用浏览器槽位')
  assert.ok(['正常', '偏高', '过高'].includes(snapshot.machine.pressure), '压力状态不是由真实指标计算出的已知状态')
  assert.equal(snapshot.machine.recommendationSampled, true, '浏览器运行后推荐值没有使用真实内存样本')
  assert.match(snapshot.machine.browserAverage, /^\d+MB$/, '浏览器平均内存样本格式不正确')

  console.log(JSON.stringify({ ok: true, accountParallel: 2, occupiedStudents: occupied.length, queuedStudents: queued.length, browsers: snapshot.machine.browsers, queuedExcluded: true, pressure: snapshot.machine.pressure, recommendationSampled: snapshot.machine.recommendationSampled, browserAverage: snapshot.machine.browserAverage }))
} finally {
  for (const id of ids) await call((value) => window.kaida.stop(value), id).catch(() => {})
  await waitUntil(async () => !(await renderer('window.kaida.snapshot()')).running, 45_000).catch(() => {})
  if (originalSettings) {
    await renderer('window.kaida.saveSettings(' + JSON.stringify({ account_parallel: originalSettings.account_parallel, course_parallel: originalSettings.course_parallel }) + ')').catch(() => {})
  }
  await app.close()
}
