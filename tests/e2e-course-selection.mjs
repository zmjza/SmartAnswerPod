import assert from 'node:assert/strict'
import { _electron as electron } from 'patchright'

const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
const renderer = (script) => app.evaluate(({ BrowserWindow }, source) =>
  BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), script)
const call = (fn, arg) => renderer('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')')
const waitUntil = async (check, timeout = 120_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('等待多学生课程选择状态超时')
}
const selectStudentInUi = async (student) => {
  if ((await page.locator('#student-id').innerText()) !== student.studentNo) {
    await page.locator('#student-more button').first().click()
    await page.locator('#student-more .source-popover button').filter({ hasText: student.name }).click()
    await waitUntil(async () => (await page.locator('#student-id').innerText()) === student.studentNo)
  }
}
const chooseCoursesInUi = async (student, courseNames) => {
  await selectStudentInUi(student)
  for (const courseName of courseNames) {
    const item = page.locator('#course-list .course-item').filter({ hasText: courseName }).first()
    await item.getByText(courseName, { exact: true }).click()
    await waitUntil(async () => {
      const snapshot = await renderer('window.kaida.snapshot()')
      const current = snapshot.students.find((row) => row.local_id === student.local_id)
      return current?.selectedCourseNames?.includes(courseName)
    })
  }
  await page.getByText('已选 ' + courseNames.length + ' 门', { exact: true }).first().waitFor()
  assert.equal(await page.locator('#course-list .material-symbols-outlined').filter({ hasText: /^check_box$/ }).count(), courseNames.length, '界面选中课程数量不正确')
}

let ids = []
let notificationPatched = false
try {
  const accounts = await renderer('window.kaida.listAccounts()')
  assert.ok(accounts.length >= 2, '至少需要两个已保存真机账号')
  ids = accounts.slice(0, 2).map((account) => account.local_id)
  const initialStudents = (await renderer('window.kaida.snapshot()')).students
  const testStudents = ids.map((id) => initialStudents.find((student) => student.local_id === id))
  assert.ok(testStudents.every(Boolean), '测试账号没有对应的工作台学生卡')

  const notificationSupported = await app.evaluate(({ Notification }) => {
    globalThis.__kaidaCourseNotifications = []
    if (!Notification.isSupported()) return false
    const prototype = Notification.prototype
    globalThis.__kaidaOriginalNotificationShow = prototype.show
    prototype.show = function () {
      globalThis.__kaidaCourseNotifications.push({ title: this.title || '', body: this.body || '' })
      return this
    }
    return true
  })
  notificationPatched = notificationSupported

  for (const id of ids) {
    assert.equal((await call((value) => window.kaida.setWorkMode(value.id, 'extract'), { id })).ok, true)
    assert.equal((await call((value) => window.kaida.setCourseScope(value.id, 'selected'), { id })).ok, true)
    await call((value) => window.kaida.setDisplay(value.id, 'headless'), { id })
  }

  await renderer('window.__kaidaSelectionRun = window.kaida.loginRefresh(' + JSON.stringify(ids) + '); true')
  await waitUntil(async () => {
    const snapshot = await renderer('window.kaida.snapshot()')
    return ids.every((id) => {
      const student = snapshot.students.find((item) => item.local_id === id)
      return student?.awaitingCourseSelection && student.courses.length > 0
    })
  })

  if (notificationSupported) {
    const notifications = await app.evaluate(() => globalThis.__kaidaCourseNotifications || [])
    assert.ok(notifications.some((item) => item.title === '课程检测完成' && /已检测 [0-9]+ 门课程/.test(item.body)), '等待选课没有产生真实桌面通知')
  }

  const waiting = await renderer('window.kaida.snapshot()')
  const chosen = []
  for (const [index, id] of ids.entries()) {
    const student = waiting.students.find((item) => item.local_id === id)
    const eligible = student.courses.filter((course) => course.groups.some((group) => group.rows.some((row) => row.previewHref)))
    assert.ok(eligible.length, '学生 ' + (index + 1) + ' 没有可选课程')
    const courses = index === 0 ? eligible.slice(0, Math.min(2, eligible.length)) : eligible.slice(0, 1)
    assert.ok(courses.length >= (index === 0 ? 2 : 1), '第一个学生没有足够课程用于多选测试')
    await chooseCoursesInUi(testStudents[index], courses.map((course) => course.name))
    chosen.push({ id, courses: courses.map((course) => course.name) })
  }

  const selected = await renderer('window.kaida.snapshot()')
  for (const item of chosen) {
    const student = selected.students.find((row) => row.local_id === item.id)
    assert.deepEqual(student.selectedCourseNames, item.courses)
    assert.equal(student.courses.filter((course) => course.status === '本轮未选择').length, student.courses.length - item.courses.length)
  }

  await page.locator('#btn-primary-action').click()
  await waitUntil(async () => {
    const snapshot = await renderer('window.kaida.snapshot()')
    return chosen.every((item) => snapshot.students.find((row) => row.local_id === item.id)?.extractTotalCourses === item.courses.length)
  })
  const startedSnapshot = await renderer('window.kaida.snapshot()')
  for (const item of chosen) {
    const student = startedSnapshot.students.find((row) => row.local_id === item.id)
    assert.equal(student.extractTotalCourses, item.courses.length)
    assert.deepEqual(student.selectedCourseNames, item.courses)
  }

  for (const id of ids) await call((value) => window.kaida.stop(value.id), { id })
  await waitUntil(async () => !(await renderer('window.kaida.snapshot()')).running, 45_000)

  await renderer('window.__kaidaSelectionRun2 = window.kaida.loginRefresh(' + JSON.stringify(ids) + '); true')
  await waitUntil(async () => {
    const snapshot = await renderer('window.kaida.snapshot()')
    return ids.every((id) => {
      const student = snapshot.students.find((item) => item.local_id === id)
      return student?.awaitingCourseSelection && student.courses.length > 0 && student.selectedCourseNames.length === 0
    })
  })
  const rescanned = await renderer('window.kaida.snapshot()')
  for (const id of ids) {
    const student = rescanned.students.find((item) => item.local_id === id)
    assert.deepEqual(student.selectedCourseNames, [], '重新扫描没有清空上一轮课程选择')
  }
  const firstStudent = rescanned.students.find((item) => item.local_id === ids[0])
  const secondStudent = rescanned.students.find((item) => item.local_id === ids[1])
  const firstEligible = firstStudent.courses.find((course) => course.groups.some((group) => group.rows.some((row) => row.previewHref)))
  assert.ok(firstEligible, '重新扫描后的第一个学生没有可选课程')
  await chooseCoursesInUi(testStudents[0], [firstEligible.name])
  await page.locator('#btn-primary-action').click()
  await waitUntil(async () => {
    const snapshot = await renderer('window.kaida.snapshot()')
    const first = snapshot.students.find((item) => item.local_id === ids[0])
    const second = snapshot.students.find((item) => item.local_id === ids[1])
    return first?.extractTotalCourses === 1 && second?.account === 'round_ended'
  })
  const partial = await renderer('window.kaida.snapshot()')
  const partialSecond = partial.students.find((item) => item.local_id === ids[1])
  assert.match(partialSecond.action, /本轮未选择课程/)
  assert.equal(partialSecond.extractTotalCourses, 0)

  for (const id of ids) {
    await call((value) => window.kaida.stop(value.id), { id })
  }
  await waitUntil(async () => !(await renderer('window.kaida.snapshot()')).running, 45_000)
  for (const id of ids) {
    assert.equal((await call((value) => window.kaida.setSelectedCourses(value.id, []), { id })).ok, true)
    const reset = await renderer('window.kaida.snapshot()')
    assert.deepEqual(reset.students.find((row) => row.local_id === id).selectedCourseNames, [])
  }
  console.log(JSON.stringify({ ok: true, students: ids.length, independentSelections: true, multiSelect: true, notification: notificationSupported, unselectedExcluded: true, queueScoped: true, stoppedAndEditable: true, rescanClearsSelection: true, partialStudentSkipped: true }))
} finally {
  for (const id of ids) await call((value) => window.kaida.stop(value.id), { id }).catch(() => {})
  if (notificationPatched) await app.evaluate(({ Notification }) => {
    if (globalThis.__kaidaOriginalNotificationShow) Notification.prototype.show = globalThis.__kaidaOriginalNotificationShow
  }).catch(() => {})
  await app.close()
}
