import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { _electron as electron } from 'patchright'
import { parseGoalAccounts } from './helpers/goal-accounts.mjs'

const goalFile = process.env.KAIDA_GOAL_FILE
assert.ok(goalFile, '缺少 KAIDA_GOAL_FILE')
const accounts = parseGoalAccounts(readFileSync(goalFile, 'utf8')).slice(0, 2)
assert.equal(accounts.length, 2, '需要两个测试账号')
const mode = process.env.KAIDA_DISPLAY_MODE === 'visual' ? 'visual' : 'headless'
const userData = resolve('.playwright', `t003-workbench-${mode}-${process.pid}`)
const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '',
  KAIDA_E2E_USERDATA: userData, KAIDA_SUPABASE_URL: '', KAIDA_SUPABASE_ANON: '', KAIDA_SILICONFLOW_KEY: '' } })
const waitUntil = async (check, label, timeout = 300_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new Error(label + ' 超时')
}
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const renderer = source => app.evaluate(({ BrowserWindow }, script) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
  const invoke = (fn, arg) => renderer('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')')
  const configured = await invoke(async ({ accounts, mode }) => {
    const settings = await window.kaida.saveSettings({ account_parallel: 2, course_parallel: 1 })
    if (!settings.ok) return false
    for (const account of accounts) {
      if (!(await window.kaida.addAccount(account)).ok) return false
    }
    for (const account of await window.kaida.listAccounts()) {
      if (!(await window.kaida.setDisplay(account.local_id, mode)).ok) return false
      if (!(await window.kaida.setWorkMode(account.local_id, 'extract')).ok) return false
      if (!(await window.kaida.setCourseScope(account.local_id, 'selected')).ok) return false
    }
    return true
  }, { accounts, mode })
  assert.equal(configured, true, '隔离产品设置失败')
  const snapshot = () => renderer('window.kaida.snapshot()')
  await page.locator('#btn-primary-action').click()
  await waitUntil(async () => {
    const students = (await snapshot()).students
    return students.length === 2 && students.every(student => student.awaitingCourseSelection)
  }, '双学生真实课程扫描')
  const scanned = (await snapshot()).students
  assert.ok(scanned.every(student => student.courses.length > 0), '学生缺少真实课程')
  assert.ok(scanned.every(student => !student.verified && !student.needsVerify), '扫描阶段不应有授权态')

  const inspectStudent = async index => {
    const student = scanned[index]
    await page.locator(`#student-switcher [data-student="${index}"]`).click()
    await waitUntil(async () => (await page.locator('#student-name').innerText()).includes(student.name), '工作台切换')
    const actual = []
    const pageCount = Math.max(1, Math.ceil(student.courses.length / 7))
    for (let number = 1; number < pageCount; number++) {
      const previous = page.getByRole('button', { name: '上一页课程' })
      if (!(await previous.isEnabled())) break
      await previous.click()
    }
    for (let number = 1; number <= pageCount; number++) {
      const items = page.locator('#course-list .course-item')
      assert.equal(await items.count(), Math.min(7, student.courses.length - actual.length), '课程页容量不符')
      const labels = await items.allTextContents()
      actual.push(...student.courses.slice(actual.length, actual.length + labels.length).map((course, offset) => {
        assert.ok(labels[offset].includes(course.name), '课程页与真实扫描顺序不一致')
        return course.key
      }))
      if (number < pageCount) await page.getByRole('button', { name: '下一页课程' }).click()
    }
    assert.deepEqual(actual, student.courses.map(course => course.key), '课程翻页遗漏或重复')
    const target = student.courses.reduce((best, course) =>
      course.groups.flatMap(group => group.rows).length > best.groups.flatMap(group => group.rows).length ? course : best)
    const targetIndex = student.courses.findIndex(course => course.key === target.key)
    const targetPage = Math.floor(targetIndex / 7) + 1
    for (let number = pageCount; number > targetPage; number--) {
      await page.getByRole('button', { name: '上一页课程' }).click()
    }
    await page.locator('#course-list .course-item').filter({ hasText: target.name }).first().click()
    await page.locator('h1').filter({ hasText: target.name }).waitFor()
    const homework = target.groups.flatMap(group => group.rows)
    const homeworkPages = Math.max(1, Math.ceil(homework.length / 4))
    for (let number = 1; number <= homeworkPages; number++) {
      const section = page.locator('main > div.grid > section')
      assert.equal(await section.getByRole('button', { name: '历史成绩' }).count(),
        Math.min(4, homework.length - (number - 1) * 4), '作业页容量不符')
      for (const row of homework.slice((number - 1) * 4, number * 4)) {
        await section.getByText(row.name, { exact: true }).first().waitFor()
      }
      if (number < homeworkPages) await page.getByRole('button', { name: '下一页作业' }).click()
    }
    assert.equal((await snapshot()).running, true, '翻页或切换停止了后台扫描')
    return student
  }

  await inspectStudent(0)
  await inspectStudent(1)
  await page.getByText('学生账号', { exact: true }).first().click()
  await page.getByRole('heading', { name: '学生账号管理' }).waitFor()
  const card = page.locator('#accounts-grid > div').filter({ hasText: scanned[0].name }).first()
  await card.getByRole('button', { name: '查看工作台' }).click()
  await waitUntil(async () => (await page.locator('#student-name').innerText()).includes(scanned[0].name), '账号页进入工作台')
  await new Promise(resolve => setTimeout(resolve, 2200))
  assert.ok((await page.locator('#student-name').innerText()).includes(scanned[0].name), '快照刷新把学生切回')
  assert.equal(await page.locator('[aria-label="已授权"]').count(), 0, '扫码前错误显示已授权')
  const final = (await snapshot()).students
  assert.deepEqual(final.map(student => student.local_id), scanned.map(student => student.local_id), '后台学生身份被切换改变')
  console.log('T003 真实双学生工作台通过', { mode, courses: final.map(student => student.courses.length),
    maxHomeworks: final.map(student => Math.max(...student.courses.map(course => course.groups.flatMap(group => group.rows).length))),
    switched: true, accountEntry: true, authorizedBeforeScan: false })
} finally {
  try {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.kaida.stopAllStudents()'))
  } catch {}
  await app.close()
}
