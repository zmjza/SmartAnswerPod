import assert from 'node:assert/strict'
import { _electron as electron } from 'patchright'

const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
let renderer
let rendererCall
let account
let secondAccount
let stageHistoryItems = 0
let stageHistoryStates = []
const historyStateEvidence = {}
let historyEmptyEvidence = null
let historyFailureEvidence = null
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  renderer = (source) => app.evaluate(({ BrowserWindow }, script) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
  rendererCall = (fn, arg) => renderer('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')')
  const waitUntil = async (check, timeout = 120_000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('等待工作台真实状态超时')
  }
  const selectCourseForUi = async (localId, courseName) => {
    const item = page.locator('#course-list .course-item').filter({ hasText: courseName })
    await item.getByText(courseName, { exact: true }).waitFor()
    const before = await renderer('window.kaida.snapshot()')
    const student = before.students.find((row) => row.local_id === localId)
    const alreadySelected = student?.selectedCourseNames.includes(courseName)
    const currentHeading = await page.locator('h1').innerText().catch(() => '')
    if (alreadySelected && currentHeading.includes(courseName)) return
    if (alreadySelected) {
      await item.getByText(courseName, { exact: true }).click()
      await waitUntil(async () => !(await renderer('window.kaida.snapshot()')).students.find((row) => row.local_id === localId)?.selectedCourseNames.includes(courseName))
    }
    await item.getByText(courseName, { exact: true }).click()
    await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((row) => row.local_id === localId)?.selectedCourseNames.includes(courseName))
  }

  const initial = await renderer('window.kaida.snapshot()')
  account = initial.students[0]
  secondAccount = initial.students[1]
  assert.ok(account, '没有可用于工作台测试的加密账号')
  assert.ok(secondAccount, '没有第二个可用于切换隔离测试的加密账号')
  assert.equal((await rendererCall((id) => window.kaida.setWorkMode(id, 'extract'), account.local_id)).ok, true)
  assert.equal((await rendererCall((id) => window.kaida.setCourseScope(id, 'selected'), account.local_id)).ok, true)
  assert.equal((await rendererCall((id) => window.kaida.setWorkMode(id, 'extract'), secondAccount.local_id)).ok, true)
  assert.equal((await rendererCall((id) => window.kaida.setCourseScope(id, 'selected'), secondAccount.local_id)).ok, true)
  await rendererCall((payload) => {
    window.__kaidaWorkbenchRun = window.kaida.loginRefresh([payload.first, payload.second])
    return true
  }, { first: account.local_id, second: secondAccount.local_id })

  let firstAction = ''
  await waitUntil(async () => {
    const snap = await renderer('window.kaida.snapshot()')
    const student = snap.students.find((item) => item.local_id === account.local_id)
    if (!firstAction && student?.action) firstAction = student.action
    const second = snap.students.find((item) => item.local_id === secondAccount.local_id)
    return snap.running && student?.awaitingCourseSelection && student.courses.length > 0 && second?.awaitingCourseSelection && second.courses.length > 0 && student.action !== firstAction
  })
  await page.getByText('工作台', { exact: true }).first().click()
  await page.locator('#student-id').waitFor()

  const waiting = await renderer('window.kaida.snapshot()')
  const student = waiting.students.find((item) => item.local_id === account.local_id)
  const secondStudent = waiting.students.find((item) => item.local_id === secondAccount.local_id)
  assert.ok(firstAction, '没有采集到初始当前动作')
  const course = student.courses.find((item) => item.groups.some((group) => group.rows.some((row) => row.previewHref)))
  const alternateCourse = student.courses.find((item) => item.name !== course?.name && item.groups.some((group) => group.rows.some((row) => row.previewHref)))
  assert.ok(course, '没有可用于工作台历史测试的真实课程')
  assert.ok(alternateCourse, '没有第二门可用于课程切换测试的真实课程')
  assert.ok(secondStudent, '第二个学生没有进入工作台快照')
  assert.equal(student.headline, '等待选择课程', '主状态不应重复拼接当前动作')
  assert.notEqual(student.headline, '等待选择课程 · ' + student.action, '主状态仍包含重复的当前动作')
  assert.equal(await page.locator('#status-title').innerText(), student.headline)
  assert.equal(await page.locator('#current-action').innerText(), student.action)
  assert.notEqual(await page.locator('#status-title').innerText(), await page.locator('#current-action').innerText())
  const homework = course.groups.flatMap((group) => group.rows).find((row) => row.previewHref)
  assert.ok(homework, '没有可用于历史成绩测试的真实作业')

  assert.equal(await page.locator('#tool-stop, #tool-log, #tool-delete').count(), 3)
  assert.equal(await page.locator('#tool-refresh').count(), 0)
  assert.equal(await page.locator('header').first().locator('nav a').count(), 4)
  assert.equal(await page.locator('header').first().locator('button').count(), 0)
  await page.getByText('全部自动执行', { exact: true }).waitFor()
  await page.getByText('可选课程执行', { exact: true }).waitFor()
  await page.getByText('开始执行（已选 0 门）', { exact: true }).waitFor()
  assert.equal(await page.locator('#btn-primary-action').isDisabled(), true)

  await page.locator('#student-more button').first().click()
  await page.locator('#student-more .source-popover button').filter({ hasText: secondAccount.name }).click()
  await waitUntil(async () => (await page.locator('#student-id').innerText()) === secondAccount.studentNo)
  assert.equal(await page.locator('#tool-log').isDisabled(), true, '未选课程时日志按钮没有禁用')
  const secondCourse = secondStudent.courses.find((item) => item.groups.some((group) => group.rows.some((row) => row.previewHref)))
  assert.ok(secondCourse, '第二个学生没有可选课程')
  const stageCourse = secondStudent.courses.find((item) => item.groups.some((group) => group.title === '阶段性测验' && group.rows.some((row) => row.previewHref)))
  if (!stageCourse) stageHistoryStates = ['not_naturally_available']
  await page.locator('#course-list .course-item').filter({ hasText: secondCourse.name }).waitFor()
  await page.locator('#course-list .course-item').filter({ hasText: secondCourse.name }).getByText(secondCourse.name, { exact: true }).click()
  await waitUntil(async () => {
    const snap = await renderer('window.kaida.snapshot()')
    return snap.students.find((item) => item.local_id === secondAccount.local_id)?.selectedCourseNames.includes(secondCourse.name)
  })
  await page.locator('#tool-log').click()
  await page.getByRole('heading', { name: '课程运行日志' }).waitFor()
  assert.ok((await page.getByRole('heading', { name: '课程运行日志' }).locator('xpath=ancestor::section[1]').innerText()).includes(secondCourse.name), '切换学生后课程日志仍显示旧课程')
  await page.getByRole('button', { name: '关闭课程日志' }).click()
  if ((await page.locator('#student-id').innerText()) !== account.studentNo) {
    await page.locator('#student-more button').first().click()
    await page.locator('#student-more .source-popover button').filter({ hasText: account.name }).click()
    await waitUntil(async () => (await page.locator('#student-id').innerText()) === account.studentNo)
  }

  const courseItem = page.locator('#course-list .course-item').filter({ hasText: course.name })
  await courseItem.getByText(course.name, { exact: true }).click()
  await waitUntil(async () => {
    const snap = await renderer('window.kaida.snapshot()')
    return snap.students.find((item) => item.local_id === account.local_id)?.selectedCourseNames.includes(course.name)
  })
  await courseItem.getByText('check_box', { exact: true }).waitFor()
  assert.match(await courseItem.getAttribute('class'), /bg-\[#EEF2FF\]/)
  const alternateItem = page.locator('#course-list .course-item').filter({ hasText: alternateCourse.name })
  await alternateItem.getByText(alternateCourse.name, { exact: true }).click()
  await page.locator('h1').filter({ hasText: alternateCourse.name }).waitFor()
  await alternateItem.getByText('check_box', { exact: true }).waitFor()
  await alternateItem.getByText(alternateCourse.name, { exact: true }).click()
  await page.getByText('开始执行（已选 2 门）', { exact: true }).waitFor()
  assert.equal(await page.locator('#btn-primary-action').isDisabled(), false)

  await page.locator('#tool-log').click()
  await page.getByRole('heading', { name: '课程运行日志' }).waitFor()
  assert.ok((await page.locator('section').filter({ has: page.getByRole('heading', { name: '课程运行日志' }) }).last().innerText()).includes(course.name))
  const firstLogText = await page.getByRole('heading', { name: '课程运行日志' }).locator('xpath=ancestor::section[1]').innerText()
  assert.doesNotMatch(firstLogText, /(password|token|cookie|xhtoken|sb_secret|sk-[a-z0-9]{12,}|https?:\/\/)/i, '课程日志包含敏感信息')
  const logCards = page.getByRole('heading', { name: '课程运行日志' }).locator('xpath=ancestor::section[1]').locator('article')
  for (let index = 0; index < await logCards.count(); index++) {
    assert.match(await logCards.nth(index).getAttribute('class'), /border-(slate|blue|emerald|amber|rose)-200/)
  }
  await page.getByRole('button', { name: '关闭课程日志' }).click()

  await page.locator('h1').filter({ hasText: course.name }).waitFor()

  const history = await rendererCall((payload) => window.kaida.getHomeworkHistory(payload.id, payload.course, payload.homework), {
    id: account.local_id,
    course: course.name,
    homework: homework.name,
  })
  assert.equal(history.ok, true, history.error || '历史成绩读取失败')
  for (let index = 1; index < history.items.length; index++) {
    assert.ok((Date.parse(history.items[index - 1].submittedAt) || 0) >= (Date.parse(history.items[index].submittedAt) || 0), '历史成绩没有按最新优先排序')
  }

  const homeworkCard = page.getByText(homework.name, { exact: true }).locator('xpath=ancestor::div[contains(@class,\"p-4\")][1]')
  await homeworkCard.getByRole('button', { name: '历史成绩' }).click()
  await page.getByRole('heading', { name: '历史成绩' }).waitFor()
  await page.getByText('正在读取真实历史记录', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 })
  if (history.items.length) await page.locator('article').filter({ hasText: '第 ' + history.items[0].attempt + ' 次' }).first().waitFor()
  else await page.getByText('暂无历史记录', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭历史成绩' }).click()

  if (stageCourse) {
    await page.locator('#student-more button').first().click()
  await page.locator('#student-more .source-popover button').filter({ hasText: secondAccount.name }).click()
  await waitUntil(async () => (await page.locator('#student-id').innerText()) === secondAccount.studentNo)
  const stageItem = page.locator('#course-list .course-item').filter({ hasText: stageCourse.name })
  await stageItem.getByText(stageCourse.name, { exact: true }).click()
  await waitUntil(async () => {
    const snap = await renderer('window.kaida.snapshot()')
    return snap.students.find((item) => item.local_id === secondAccount.local_id)?.selectedCourseNames.includes(stageCourse.name)
  })
  await page.locator('h1').filter({ hasText: stageCourse.name }).waitFor()
  const stageGroup = stageCourse.groups.find((group) => group.title === '阶段性测验')
  const stageHomework = stageGroup?.rows.find((row) => row.previewHref)
  assert.ok(stageHomework, '阶段性测验课程没有可查看历史的作业')
  const stageHistory = await rendererCall((payload) => window.kaida.getHomeworkHistory(payload.id, payload.course, payload.homework), {
    id: secondAccount.local_id,
    course: stageCourse.name,
    homework: stageHomework.name,
  })
  assert.equal(stageHistory.ok, true, stageHistory.error || '阶段性测验历史成绩读取失败')
  stageHistoryItems = stageHistory.items.length
  stageHistoryStates = [...new Set(stageHistory.items.map((item) => item.displayState))]
  const stageHomeworkCard = page.getByText(stageHomework.name, { exact: true }).locator('xpath=ancestor::div[contains(@class,\"p-4\")][1]')
  await stageHomeworkCard.getByRole('button', { name: '历史成绩' }).click()
  await page.getByRole('heading', { name: '历史成绩' }).waitFor()
  await page.getByText('正在读取真实历史记录', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 })
    if (stageHistory.items.length) await page.locator('article').filter({ hasText: '第 ' + stageHistory.items[0].attempt + ' 次' }).first().waitFor()
  else await page.getByText('暂无历史记录', { exact: true }).waitFor()
  if (stageHistoryStates.includes('no_view')) {
    const noViewButton = page.getByRole('button', { name: '无可靠查看入口', exact: true })
    assert.equal(await noViewButton.count(), 1, '无查看入口历史记录没有显示明确状态')
    assert.equal(await noViewButton.isDisabled(), true, '无查看入口历史记录仍允许打开')
  }
    await page.getByRole('button', { name: '关闭历史成绩' }).click()
  }

 // Discover naturally existing states from the live snapshot, then verify each one through its real UI card.
  const stateCandidates = [student, secondStudent]
  for (const candidateStudent of stateCandidates) {
    for (const candidateCourse of candidateStudent.courses) {
      for (const candidateHomework of candidateCourse.groups.flatMap((group) => group.rows)) {
        if (!candidateHomework.previewHref) {
          if (!historyFailureEvidence) {
            historyFailureEvidence = {
              localId: candidateStudent.local_id,
              studentNo: candidateStudent.studentNo,
              studentName: candidateStudent.name,
              course: candidateCourse.name,
              homework: candidateHomework.name,
            }
          }
          continue
        }
        const candidateHistory = await rendererCall((payload) => window.kaida.getHomeworkHistory(payload.id, payload.course, payload.homework), {
          id: candidateStudent.local_id,
          course: candidateCourse.name,
          homework: candidateHomework.name,
        })
        assert.equal(candidateHistory.ok, true, candidateHistory.error || '历史状态探针读取失败')
        if (!candidateHistory.items.length && !historyEmptyEvidence) {
          historyEmptyEvidence = {
            localId: candidateStudent.local_id,
            studentNo: candidateStudent.studentNo,
            studentName: candidateStudent.name,
            course: candidateCourse.name,
            homework: candidateHomework.name,
          }
        }
        for (const item of candidateHistory.items) {
          if (!historyStateEvidence[item.displayState]) {
            historyStateEvidence[item.displayState] = {
              localId: candidateStudent.local_id,
              studentNo: candidateStudent.studentNo,
              studentName: candidateStudent.name,
              course: candidateCourse.name,
              homework: candidateHomework.name,
              attempt: item.attempt,
            }
          }
        }
      }
    }
  }
  const stateLabels = {
    viewable: '查看只读答卷',
    ungraded: '尚未批阅',
    unfinished: '未完成提交',
    continue_only: '只有续做，无查看',
    no_view: '无可靠查看入口',
  }
  for (const [state, candidate] of Object.entries(historyStateEvidence)) {
    const currentStudentNo = await page.locator('#student-id').innerText()
    if (currentStudentNo !== candidate.studentNo) {
      await page.locator('#student-more button').first().click()
      await page.locator('#student-more .source-popover button').filter({ hasText: candidate.studentName }).click()
      await waitUntil(async () => (await page.locator('#student-id').innerText()) === candidate.studentNo)
    }
    await selectCourseForUi(candidate.localId, candidate.course)
    await page.locator('h1').filter({ hasText: candidate.course }).waitFor()
    const candidateCard = page.getByText(candidate.homework, { exact: true }).locator('xpath=ancestor::div[contains(@class,\"p-4\")][1]')
    await candidateCard.getByRole('button', { name: '历史成绩' }).click()
    await page.getByRole('heading', { name: '历史成绩' }).waitFor()
    await page.getByText('正在读取真实历史记录', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 })
    const historyRow = page.locator('article').filter({ hasText: '第 ' + candidate.attempt + ' 次' }).filter({ has: page.getByRole('button', { name: stateLabels[state], exact: true }) }).first()
    await historyRow.waitFor()
    const stateButton = historyRow.getByRole('button', { name: stateLabels[state], exact: true })
    assert.equal(await stateButton.count(), 1, state + ' 历史状态没有显示对应按钮')
    assert.equal(await stateButton.isDisabled(), state !== 'viewable', state + ' 历史状态按钮可用性错误')
    if (state === 'viewable') {
      await stateButton.click()
      await page.getByRole('heading', { name: '只读历史答卷' }).waitFor()
      await page.locator('img[alt="只读历史答卷截图"]').waitFor({ timeout: 60_000 })
      await page.getByRole('button', { name: '返回成绩' }).click()
    }
    await page.getByRole('button', { name: '关闭历史成绩' }).click()
  }
  const verifyHistoryCandidate = async (candidate, expected) => {
    if (!candidate) return false
    const currentStudentNo = await page.locator('#student-id').innerText()
    if (currentStudentNo !== candidate.studentNo) {
      await page.locator('#student-more button').first().click()
      await page.locator('#student-more .source-popover button').filter({ hasText: candidate.studentName }).click()
      await waitUntil(async () => (await page.locator('#student-id').innerText()) === candidate.studentNo)
    }
    await selectCourseForUi(candidate.localId, candidate.course)
    await page.locator('h1').filter({ hasText: candidate.course }).waitFor()
    const candidateCard = page.getByText(candidate.homework, { exact: true }).locator('xpath=ancestor::div[contains(@class,"p-4")][1]')
    await candidateCard.getByRole('button', { name: '历史成绩' }).click()
    await page.getByRole('heading', { name: '历史成绩' }).waitFor()
    await page.getByText('正在读取真实历史记录', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 })
    await page.getByText(expected, { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭历史成绩' }).click()
    return true
  }
  const emptyHistoryChecked = await verifyHistoryCandidate(historyEmptyEvidence, '暂无历史记录')
  const failedHistoryChecked = await verifyHistoryCandidate(historyFailureEvidence, '该作业没有可靠历史页面链接')
  if ((await page.locator('#student-id').innerText()) !== account.studentNo) {
    await page.locator('#student-more button').first().click()
    await page.locator('#student-more .source-popover button').filter({ hasText: account.name }).click()
    await waitUntil(async () => (await page.locator('#student-id').innerText()) === account.studentNo)
  }

  await page.locator('#btn-primary-action').click()
  await waitUntil(async () => {
    const snap = await renderer('window.kaida.snapshot()')
    const live = snap.students.find((item) => item.local_id === account.local_id)
    return snap.running && live?.extractTotalHomeworks > 0 && (live.extractTotals.merged + live.extractTotals.added + live.extractTotals.skipped + live.extractTotals.conflict + live.extractTotals.failed) > 0
  }, 120_000)
  let live
  let liveStudent
  let statusTitle
  let currentAction
  await waitUntil(async () => {
    const snap = await renderer('window.kaida.snapshot()')
    const current = snap.students.find((item) => item.local_id === account.local_id)
    const title = await page.locator('#status-title').innerText()
    const action = await page.locator('#current-action').innerText()
    if (!current || title !== current.headline || action !== current.action) return false
    live = snap
    liveStudent = current
    statusTitle = title
    currentAction = action
    return true
  })
 assert.equal(statusTitle, liveStudent.headline)
 assert.equal(currentAction, liveStudent.action)
  assert.match(await page.locator('#status-title').getAttribute('class') || '', /line-clamp-2/, '主状态没有限制为最多两行')
  assert.equal(await page.locator('#status-title').getAttribute('title'), liveStudent.headline, '主状态没有保留完整内容提示')
  assert.match(await page.locator('#current-action').getAttribute('class') || '', /line-clamp-2/, '当前动作没有限制为最多两行')
  assert.equal(await page.locator('#current-action').getAttribute('title'), liveStudent.action, '当前动作没有保留完整内容提示')
  assert.equal(await page.locator('#stat-repo').innerText(), String(liveStudent.bankCount))
  assert.equal(await page.locator('#stat-ai').innerText(), String(liveStudent.aiCount))
  assert.match(await page.locator('#extract-progress').innerText(), new RegExp('课程\\s+' + liveStudent.extractCompletedCourses + '/' + liveStudent.extractTotalCourses))
  assert.match(await page.locator('#extract-progress').innerText(), new RegExp('作业\\s+' + liveStudent.extractCompletedHomeworks + '/' + liveStudent.extractTotalHomeworks))
  assert.match(await page.locator('#extract-stats').innerText(), /新增/)
  assert.match(await page.locator('#extract-stats').innerText(), /去重/)
  assert.match(await page.locator('#extract-stats').innerText(), /跳过/)
  assert.match(await page.locator('#extract-stats').innerText(), /冲突/)
  assert.match(await page.locator('#extract-stats').innerText(), /失败/)

  await page.locator('#student-more button').first().click()
  await page.locator('#student-more .source-popover button').filter({ hasText: secondAccount.name }).click()
  await waitUntil(async () => (await page.locator('#student-id').innerText()) === secondAccount.studentNo)
  const secondLive = live.students.find((item) => item.local_id === secondAccount.local_id)
  assert.equal(await page.locator('#stat-repo').innerText(), String(secondLive.bankCount))
  assert.equal(await page.locator('#stat-ai').innerText(), String(secondLive.aiCount))
  await page.locator('#student-more button').first().click()
  await page.locator('#student-more .source-popover button').filter({ hasText: account.name }).click()
  await waitUntil(async () => (await page.locator('#student-id').innerText()) === account.studentNo)

  await rendererCall((id) => window.kaida.stop(id), account.local_id)
  await rendererCall((id) => window.kaida.stop(id), secondAccount.local_id)
  await waitUntil(async () => !(await renderer('window.kaida.snapshot()')).running, 45_000)
  assert.equal((await rendererCall((payload) => window.kaida.setWorkMode(payload.id, payload.mode), { id: account.local_id, mode: account.workMode })).ok, true)
  assert.equal((await rendererCall((payload) => window.kaida.setCourseScope(payload.id, payload.scope), { id: account.local_id, scope: account.courseScope })).ok, true)

  console.log(JSON.stringify({
    ok: true,
    courses: student.courses.length,
    selectedHighlighted: true,
    startGate: true,
    historyItems: history.items.length,
    historySorted: true,
    stageHistoryItems,
    stageHistoryStates,
    historyStateEvidence: Object.keys(historyStateEvidence),
    emptyHistoryChecked,
    failedHistoryChecked,
    courseLogScoped: true,
    refreshRemoved: true,
    avatarRemoved: true,
  }))
} finally {
  if (renderer && account) {
    await rendererCall((id) => window.kaida.stop(id), account.local_id).catch(() => {})
    if (secondAccount) await rendererCall((id) => window.kaida.stop(id), secondAccount.local_id).catch(() => {})
    await rendererCall((payload) => window.kaida.setWorkMode(payload.id, payload.mode), { id: account.local_id, mode: account.workMode }).catch(() => {})
    await rendererCall((payload) => window.kaida.setCourseScope(payload.id, payload.scope), { id: account.local_id, scope: account.courseScope }).catch(() => {})
  }
  await app.close()
}
