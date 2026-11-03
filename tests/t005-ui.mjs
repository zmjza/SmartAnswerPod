import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'patchright'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const packageVersion = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')).version
const userData = resolve(projectRoot, '.playwright', `t005-ui-${process.pid}-${Date.now()}`)
const accounts = [
  { name: 'E2E 无码甲', username: 't005-ui-a-001', password: ['fixture', 'ui', 'password', 'a'].join('-') },
  { name: 'E2E 无码乙', username: 't005-ui-b-001', password: ['fixture', 'ui', 'password', 'b'].join('-') },
]
const maskAccount = (value) => {
  const account = String(value)
  return account.length >= 8 ? account.slice(0, 4) + '****' + account.slice(-4) : '****'
}

async function waitForStudentNo(page, renderer, index, fallback) {
  const snapshot = await renderer('window.kaida.snapshot()').catch(() => null)
  const expected = snapshot?.students?.[index]?.studentNo || fallback
  await page.waitForFunction(
    (studentNo) => document.querySelector('#student-id')?.textContent === studentNo,
    expected,
  )
}

mkdirSync(userData, { recursive: true })

const loginHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <main>
    <h1>上海开放大学在线学习平台</h1>
    <input name="用户名" placeholder="用户名, 长度6~40位">
    <input name="密码" type="password" placeholder="密码, 长度6~40位">
    <button id="submit" type="button">提交</button>
  </main>
  <script>
    document.querySelector('#submit').addEventListener('click', () => {
      document.querySelector('#submit').textContent = '加载中...'
    })
  </script>
</body></html>`

const homeHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div class="menu-items"><span>形考作业</span></div>
  <div class="course-card"><h3 class="course-title">课程一</h3></div>
</body></html>`

function waitUntil(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  return (async () => {
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(label + ' 超时')
  })()
}

async function launchApp() {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: '',
      KAIDA_E2E_USERDATA: userData,
      KAIDA_E2E_MOCK_COURSES: '1',
      KAIDA_E2E_DISABLE_SNAPSHOT_INTERVAL: '1',
      KAIDA_SUPABASE_URL: '',
      KAIDA_SUPABASE_ANON: '',
      KAIDA_SILICONFLOW_KEY: '',
    },
  })
}

async function prepareProduct(app) {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const renderer = (source) => app.evaluate(({ BrowserWindow }, script) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
  const invoke = (fn, arg) => renderer('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')')

  // The product still runs the real pool/page lifecycle; only the school origin is
  // replaced with a local, delayed login fixture so this E3 test never touches the
  // real school or a real account.
  await app.evaluate(async ({ app }, fixture) => {
    const { createRequire } = process.getBuiltinModule('module')
    const { chromium } = createRequire(app.getAppPath() + '/package.json')('patchright')
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    chromium.executablePath = () => systemChrome
    const original = chromium.launchPersistentContext
    chromium.launchPersistentContext = async function (profile, options) {
      const context = await original.call(this, profile, options)
      await context.route('https://coursework.shou.org.cn/**', async (route) => {
        const url = new URL(route.request().url())
        if (url.pathname === '/login/index.html') {
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture.loginHtml })
          return
        }
        if (url.pathname === '/index.html') {
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture.homeHtml })
          return
        }
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'fixture only' })
      })
      return context
    }
  }, { loginHtml, homeHtml })

  const configured = await invoke(async ({ rows }) => {
    const ids = []
    for (const row of rows) {
      let account = (await window.kaida.listAccounts()).find((item) => item.account === row.username)
      if (!account) {
        const result = await window.kaida.addAccount(row)
        if (!result.ok) return { ok: false, error: result.error }
        account = (await window.kaida.listAccounts()).find((item) => item.account === row.username)
      }
      if (!account) return { ok: false, error: '账号没有写入' }
      ids.push(account.local_id)
    }
    return { ok: true, ids }
  }, { rows: accounts })
  assert.equal(configured.ok, true, configured.error || '测试账号创建失败')

  return {
    app,
    page,
    ids: configured.ids,
    renderer,
    invoke,
  }
}

async function pushSnapshot(product, snapshot) {
  await product.app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0].webContents.send('kaida:snapshot', value)
  }, snapshot)
}

async function selectedWorkMode(page) {
  return page.locator('#work-mode-switcher button').evaluateAll((buttons) => {
    const selected = buttons.find((button) => button.className.includes('bg-[#4F46E5]'))
    return selected?.textContent?.trim() || ''
  })
}

let first
let second
let third
try {
  first = await prepareProduct(await launchApp())
  const page = first.page
  const renderer = first.renderer
  const invoke = first.invoke

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('heading', { name: '系统偏好设置' }).waitFor()
  const settingsVersion = page.locator('[data-settings-version]')
  await settingsVersion.waitFor()
  assert.equal((await settingsVersion.innerText()).trim(), `v${packageVersion}`, '设置页版本徽记未使用应用实际版本')
  const courseCap = page.locator('[data-course-cap]')
  assert.equal((await courseCap.innerText()).trim(), 'Max 8', '设置页课程并发上限仍与保存上限不一致')
  assert.equal(await page.getByText('v0.1.7 开发版', { exact: true }).count(), 0, '设置页仍显示硬编码旧版本')
  await page.getByRole('button', { name: '工作台', exact: true }).click()

  await page.locator('#work-mode-switcher').waitFor()
  assert.deepEqual(await page.locator('#work-mode-switcher button').allTextContents(), ['答题', '提取题库', '无码答题'])
  assert.equal(await page.locator('#work-mode-switcher button').nth(2).isDisabled(), false)

  // Switch students in the same renderer task while the first IPC save is still
  // pending. The late result must not repaint or announce on the other student.
  await page.evaluate(() => {
    document.querySelector('.workmode-btn-noqr')?.click()
    document.querySelector('.student-pill[data-student="1"]')?.click()
  })
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[0])?.workMode === 'noqr', '无码模式异步写入')
  await waitForStudentNo(page, renderer, 1, accounts[1].username)
  await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  const secondView = (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[1])
  assert.equal(secondView.workMode, 'answer', '切换学生误改了另一名学生的工作模式')
  assert.match(await page.locator('.workmode-btn-ans').getAttribute('class'), /bg-\[#4F46E5\]/, '另一名学生显示了甲的选中态')
  assert.doesNotMatch(await page.locator('#toast-msg').innerText(), /模式已设为：无码答题/, '另一名学生收到了甲的模式提示')

  await page.locator('.workmode-btn-ext').click()
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[1])?.workMode === 'extract', '提取模式 UI 写入')
  assert.equal(await selectedWorkMode(page), '提取题库')
  await waitUntil(async () => (await page.locator('#toast-msg').innerText()).includes('模式已设为：提取题库'), '提取模式提示')
  assert.doesNotMatch(await page.locator('#toast-msg').innerText(), /模式已设为：无码答题/, '提取模式显示了无码答题提示')
  assert.equal(await page.getByLabel('作业重新答题次数').count(), 0, '提取模式仍显示作业重新答题次数')

  await page.locator('.workmode-btn-ans').click()
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[1])?.workMode === 'answer', '答题模式 UI 写入')
  await waitUntil(async () => (await page.locator('#toast-msg').innerText()).includes('模式已设为：智能答题'), '答题模式提示')
  assert.doesNotMatch(await page.locator('#toast-msg').innerText(), /模式已设为：无码答题/, '答题模式显示了无码答题提示')
  await page.getByLabel('作业重新答题次数').selectOption('5')
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[1])?.answerRoundLimit === 5, '乙学生重答次数保存')
  await page.getByRole('button', { name: '可选课程执行', exact: true }).click()
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[1])?.courseScope === 'selected', '乙学生课程范围保存')

  const answerWithVerify = await renderer('window.kaida.snapshot()')
  const answerVerifyStudent = answerWithVerify.students.find((student) => student.local_id === first.ids[1])
  answerVerifyStudent.needsVerify = true
  await pushSnapshot(first, answerWithVerify)
  await page.locator('#btn-open-qr').waitFor()
  await page.locator('#btn-open-qr').click()
  await page.getByRole('heading', { name: '作业二维码' }).waitFor()
  await page.getByRole('button', { name: '关闭二维码弹窗' }).click()
  answerVerifyStudent.needsVerify = false
  await pushSnapshot(first, answerWithVerify)

  await page.locator('.student-pill[data-student="0"]').click()
  await waitForStudentNo(page, renderer, 0, accounts[0].username)
  await page.locator('#work-mode-switcher button').nth(2).click()
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[0])?.workMode === 'noqr', '无码模式 UI 写入')
  assert.equal(await selectedWorkMode(page), '无码答题')
  await waitUntil(async () => (await page.locator('#toast-msg').innerText()).includes('模式已设为：无码答题'), '无码模式提示')
  const noqrView = (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[0])
  assert.deepEqual(noqrView.extractTotals, { added: 0, merged: 0, skipped: 0, conflict: 0, failed: 0 }, '无码快照污染了提取统计')
  assert.equal(noqrView.needsVerify, false, '无码快照夹带旧扫码状态')
  await page.getByLabel('作业重新答题次数').waitFor()
  assert.equal(await page.locator('#btn-open-qr').count(), 0, '无码模式误显示旧二维码入口')
  assert.equal(await page.locator('#btn-verify-done').count(), 0, '无码模式误显示旧验证按钮')
  assert.equal(await page.getByLabel('已授权').count(), 0, '无码模式误显示旧授权徽标')
  const noqrWithLegacyState = structuredClone(await renderer('window.kaida.snapshot()'))
  const legacyStateStudent = noqrWithLegacyState.students.find((student) => student.local_id === first.ids[0])
  legacyStateStudent.needsVerify = true
  legacyStateStudent.verified = true
  await pushSnapshot(first, noqrWithLegacyState)
  await page.waitForTimeout(300)
  assert.equal(await page.locator('#btn-open-qr').count(), 0, '无码模式收到旧扫码状态后显示了旧二维码入口')
  assert.equal(await page.locator('#btn-verify-done').count(), 0, '无码模式收到旧扫码状态后显示了旧验证按钮')
  assert.equal(await page.getByLabel('已授权').count(), 0, '无码模式收到旧扫码状态后显示了旧授权徽标')
  assert.doesNotMatch(await page.locator('#toast-msg').innerText(), /微信扫码|扫微信码|验证完毕/, '无码模式收到旧扫码状态后仍提示旧扫码流程')
  await pushSnapshot(first, (await renderer('window.kaida.snapshot()')))

  await page.locator('.student-pill[data-student="1"]').click()
  await waitForStudentNo(page, renderer, 1, accounts[1].username)
  await page.locator('.workmode-btn-ext').click()
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[1])?.workMode === 'extract', '提取模式二维码检查写入')
  const extractVerify = structuredClone(await renderer('window.kaida.snapshot()'))
  extractVerify.students.find((student) => student.local_id === first.ids[1]).needsVerify = true
  await pushSnapshot(first, extractVerify)
  await page.locator('#btn-open-qr').waitFor()
  await page.locator('#btn-open-qr').click()
  await page.getByRole('heading', { name: '作业二维码' }).waitFor()
  await page.getByRole('button', { name: '关闭二维码弹窗' }).click()
  await pushSnapshot(first, (await renderer('window.kaida.snapshot()')))
  await page.locator('.workmode-btn-ans').click()
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[1])?.workMode === 'answer', '二维码检查后恢复答题模式')
  await page.locator('.student-pill[data-student="0"]').click()
  await waitForStudentNo(page, renderer, 0, accounts[0].username)

  await page.getByRole('button', { name: '可选课程执行', exact: true }).click()
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[0])?.courseScope === 'selected', '甲学生课程范围保存')
  await page.getByLabel('作业重新答题次数').selectOption('3')
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[0])?.answerRoundLimit === 3, '甲学生重答次数保存')

  // Rapidly leave and return without waiting for a snapshot between clicks.
  await page.evaluate(() => {
    document.querySelector('.student-pill[data-student="1"]')?.click()
    document.querySelector('.student-pill[data-student="0"]')?.click()
  })
  await waitForStudentNo(page, renderer, 0, accounts[0].username)
  assert.equal(await selectedWorkMode(page), '无码答题', '快速切换后甲学生模式串号')
  assert.equal(await page.getByLabel('作业重新答题次数').inputValue(), '3', '快速切换后甲学生重答次数串号')
  assert.match(await page.getByRole('button', { name: '可选课程执行', exact: true }).getAttribute('class'), /bg-\[#4F46E5\]/, '快速切换后甲学生课程范围串号')

  await page.locator('.student-pill[data-student="1"]').click()
  await waitForStudentNo(page, renderer, 1, accounts[1].username)
  assert.equal(await selectedWorkMode(page), '答题', '切换到乙学生后显示了甲学生的模式')
  assert.equal(await page.getByLabel('作业重新答题次数').inputValue(), '5', '切换到乙学生后显示了甲学生的重答次数')
  await page.locator('.student-pill[data-student="0"]').click()
  await waitForStudentNo(page, renderer, 0, accounts[0].username)

  const started = await first.invoke((id) => window.kaida.startStudent(id), first.ids[0])
  assert.equal(started.ok, true, started.error || '无码学生启动失败')
  let lockSnapshot = null
  try {
    await waitUntil(async () => {
      lockSnapshot = await renderer('window.kaida.snapshot()')
      return lockSnapshot.running && lockSnapshot.students.find((student) => student.local_id === first.ids[0])?.account === 'logging_in'
    }, '无码运行锁状态', 20_000)
  } catch (error) {
    console.log('T005 UI 启动诊断', JSON.stringify({
      running: lockSnapshot?.running,
      student: lockSnapshot?.students?.find((student) => student.local_id === first.ids[0]),
    }))
    throw error
  }

  assert.equal((await page.locator('#work-mode-switcher button').evaluateAll((buttons) => buttons.every((button) => button.disabled))), true, '运行中模式按钮未全部锁定')
  assert.equal(await page.locator('.mode-headless-btn').isDisabled(), true, '运行中无头按钮未锁定')
  assert.equal(await page.locator('.mode-visual-btn').isDisabled(), true, '运行中可视化按钮未锁定')
  assert.equal(await page.getByRole('button', { name: '全部自动执行', exact: true }).isDisabled(), true, '运行中全部课程按钮未锁定')
  assert.equal(await page.getByRole('button', { name: '可选课程执行', exact: true }).isDisabled(), true, '运行中可选课程按钮未锁定')
  assert.equal(await page.getByLabel('作业重新答题次数').isDisabled(), true, '运行中重答次数字段未锁定')
  assert.equal(await page.getByRole('button', { name: '将配置设置到全部', exact: true }).isDisabled(), true, '运行中仍可全量同步配置')
  assert.equal(await page.locator('#tool-start').isDisabled(), true, '运行中仍可重复启动当前学生')
  assert.equal(await page.locator('#btn-primary-action').isDisabled(), true, '运行中主按钮未锁定')
  assert.equal(await page.locator('#tool-stop').isDisabled(), false, '运行中停止按钮不可用')
  assert.equal(await page.locator('#btn-stop-all').isDisabled(), false, '运行中全部停止按钮不可用')
  const rejected = await first.invoke(async (payload) => ({
    display: await window.kaida.setDisplay(payload.id, 'visual'),
    workMode: await window.kaida.setWorkMode(payload.id, 'answer'),
    courseScope: await window.kaida.setCourseScope(payload.id, 'all'),
    answerRoundLimit: await window.kaida.setAnswerRoundLimit(payload.id, 1),
    applyAll: await window.kaida.applyStudentSettingsToAll(payload.id),
  }), { id: first.ids[0] })
  assert.ok(Object.values(rejected).every((result) => result.ok === false), '运行中仍有 IPC 允许修改学生配置')

  await page.locator('.student-pill[data-student="1"]').click()
  await waitForStudentNo(page, renderer, 1, accounts[1].username)
  const runningAfterSwitch = await renderer('window.kaida.snapshot()')
  assert.equal(runningAfterSwitch.running, true, '普通页面切换误停了后台任务')
  assert.equal(runningAfterSwitch.students.find((student) => student.local_id === first.ids[0])?.configLocked, true, '切换学生后甲学生运行锁丢失')
  await page.locator('.student-pill[data-student="0"]').click()
  await waitForStudentNo(page, renderer, 0, accounts[0].username)

  await page.locator('#tool-stop').evaluate((button) => {
    button.click()
    button.click()
  })
  await page.getByText('正在停止', { exact: true }).waitFor({ timeout: 2_000 })
  await page.getByText('等待当前请求结束并释放浏览器', { exact: true }).waitFor({ timeout: 2_000 })
  let stopSnapshot = null
  try {
    await waitUntil(async () => {
      stopSnapshot = await renderer('window.kaida.snapshot()')
      return !stopSnapshot.running && stopSnapshot.students.every((student) => !student.configLocked)
    }, '无码停止释放', 60_000)
  } catch (error) {
    console.log('T005 UI 停止诊断', JSON.stringify({
      running: stopSnapshot?.running,
      students: stopSnapshot?.students?.map((student) => ({
        local_id: student.local_id,
        account: student.account,
        slot: student.slot,
        configLocked: student.configLocked,
        action: student.action,
      })),
    }))
    throw error
  }

  assert.equal(await page.locator('#work-mode-switcher button').first().isDisabled(), false, '停止后模式按钮仍锁定')
  assert.equal(await page.getByLabel('作业重新答题次数').isDisabled(), false, '停止后重答次数仍锁定')
  assert.equal(await page.getByRole('button', { name: '将配置设置到全部', exact: true }).isDisabled(), false, '停止后全量同步仍锁定')
  const afterFirstStop = await renderer('window.kaida.snapshot()')
  assert.equal(afterFirstStop.students.find((student) => student.local_id === first.ids[1])?.workMode, 'answer', '甲任务停止后改动了乙学生模式')

  await page.locator('#tool-start').click()
  await waitUntil(async () => {
    const snap = await renderer('window.kaida.snapshot()')
    return snap.running && snap.students.find((student) => student.local_id === first.ids[0])?.account === 'logging_in'
  }, '停止释放后再次启动')
  await page.locator('#tool-stop').click()
  await waitUntil(async () => !(await renderer('window.kaida.snapshot()')).running, '第二次停止释放', 60_000)

  await page.locator('.mode-visual-btn').click()
  await waitUntil(async () => (await renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === first.ids[0])?.displayMode === 'visual', '甲学生可视化环境保存')
  await page.locator('#tool-start').click()
  await waitUntil(async () => {
    const snapshot = await renderer('window.kaida.snapshot()')
    const student = snapshot.students.find((item) => item.local_id === first.ids[0])
    return snapshot.running && student?.account === 'logging_in' && student.displayMode === 'visual'
  }, '可视化无码运行锁状态', 20_000)
  assert.equal(await page.locator('#work-mode-switcher button').evaluateAll((buttons) => buttons.every((button) => button.disabled)), true, '可视化运行中模式按钮未锁定')
  assert.equal(await page.locator('#tool-stop').isDisabled(), false, '可视化运行中停止按钮不可用')
  await page.locator('#tool-stop').click()
  await waitUntil(async () => !(await renderer('window.kaida.snapshot()')).running, '可视化无码停止释放', 60_000)
  await page.getByRole('button', { name: /将配置设置到全部/ }).click()
  await waitUntil(async () => {
    const snap = await renderer('window.kaida.snapshot()')
    return snap.students.length === 2 && snap.students.every((student) =>
      student.workMode === 'noqr' &&
      student.displayMode === 'visual' &&
      student.courseScope === 'selected' &&
      student.answerRoundLimit === 3)
  }, '无码模式全量同步')
  const synced = await renderer('window.kaida.snapshot()')
  assert.deepEqual(
    synced.students.map((student) => [student.name, student.studentNo]).sort(),
    accounts.map((account) => [account.name, maskAccount(account.username)]).sort(),
    '全量同步改写了学生身份或账号',
  )

  await first.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1200, 760)
  })
  await page.waitForTimeout(300)
  const narrowMetrics = await page.evaluate(() => {
    const mode = document.querySelector('#work-mode-switcher')
    const footer = document.querySelector('footer')
    const modeButtons = [...document.querySelectorAll('#work-mode-switcher button')]
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      mode: mode ? { left: mode.getBoundingClientRect().left, right: mode.getBoundingClientRect().right } : null,
      footer: footer ? { left: footer.getBoundingClientRect().left, right: footer.getBoundingClientRect().right } : null,
      buttons: modeButtons.map((button) => ({ clientWidth: button.clientWidth, scrollWidth: button.scrollWidth })),
    }
  })
  assert.ok(narrowMetrics.scrollWidth <= narrowMetrics.innerWidth + 1, '最小窗口出现横向页面溢出')
  assert.ok(narrowMetrics.mode && narrowMetrics.mode.left >= 0 && narrowMetrics.mode.right <= narrowMetrics.innerWidth, '最小窗口模式切换器越界')
  assert.ok(narrowMetrics.footer && narrowMetrics.footer.left >= 0 && narrowMetrics.footer.right <= narrowMetrics.innerWidth, '最小窗口底部操作栏越界')
  assert.ok(narrowMetrics.buttons.every((button) => button.clientWidth > 0 && button.scrollWidth <= button.clientWidth + 1), '最小窗口模式按钮文字被截断')

  const actualBeforeEmpty = await renderer('window.kaida.snapshot()')
  const noCourses = structuredClone(actualBeforeEmpty)
  const noCoursesStudent = noCourses.students.find((student) => student.local_id === first.ids[0])
  noCoursesStudent.courses = []
  noCoursesStudent.groups = []
  noCoursesStudent.activeCourseName = ''
  noCoursesStudent.activeCourseKey = ''
  await pushSnapshot(first, noCourses)
  await page.getByText('暂无可见课程', { exact: true }).waitFor({ timeout: 3_000 })

  const noHomeworks = structuredClone(actualBeforeEmpty)
  const noHomeworksStudent = noHomeworks.students.find((student) => student.local_id === first.ids[0])
  noHomeworksStudent.courses = [{ key: 'empty-course', name: '空课程', status: '无作业', bankCount: 0, aiCount: 0, groups: [] }]
  noHomeworksStudent.groups = []
  noHomeworksStudent.activeCourseName = '空课程'
  noHomeworksStudent.activeCourseKey = 'empty-course'
  await pushSnapshot(first, noHomeworks)
  await page.getByText('暂无可见作业', { exact: true }).waitFor({ timeout: 3_000 })

  const noHistory = structuredClone(noHomeworks)
  const noHistoryStudent = noHistory.students.find((student) => student.local_id === first.ids[0])
  noHistoryStudent.courses[0].groups = [{
    title: '网上记分作业',
    rows: [{ name: '无记录作业', status: 'todo', questions: [] }],
  }]
  noHistoryStudent.groups = noHistoryStudent.courses[0].groups
  await pushSnapshot(first, noHistory)
  const emptyHistoryCard = page.getByText('无记录作业', { exact: true }).locator('xpath=ancestor::div[contains(@class,"p-4")][1]')
  await emptyHistoryCard.getByRole('button', { name: '历史成绩' }).click()
  await page.getByRole('heading', { name: '历史成绩' }).waitFor()
  await page.getByText('暂无历史记录', { exact: true }).waitFor({ timeout: 3_000 })
  await page.getByRole('button', { name: '关闭历史成绩' }).click()
  await pushSnapshot(first, actualBeforeEmpty)

  const isolated = structuredClone(actualBeforeEmpty)
  isolated.running = false
  const isolatedFirst = isolated.students.find((student) => student.local_id === first.ids[0])
  const isolatedSecond = isolated.students.find((student) => student.local_id === first.ids[1])
  Object.assign(isolatedFirst, {
    workMode: 'noqr',
    displayMode: 'visual',
    courseScope: 'selected',
    awaitingCourseSelection: false,
    selectedCourseKeys: ['course-a'],
    selectedCourseNames: ['甲课程'],
    answerRoundLimit: 3,
    headline: '甲学生进行中',
    action: '甲学生作答第七题',
    bankCount: 7,
    aiCount: 2,
    courses: [{
      key: 'course-a',
      name: '甲课程',
      status: '检测中',
      bankCount: 7,
      aiCount: 2,
      groups: [{ title: '网上记分作业', rows: [{ name: '甲作业', status: 'answering', questions: [] }] }],
    }],
    courseLogs: [{ time: '2026-11-01T00:00:00.000Z', level: 'running', courseName: '甲课程', courseKey: 'course-a', homeworkName: '甲作业', action: '无码作答中', result: '运行中', reason: '甲学生日志' }],
    activeCourseName: '甲课程',
    activeCourseKey: 'course-a',
  })
  isolatedFirst.groups = isolatedFirst.courses[0].groups
  Object.assign(isolatedSecond, {
    workMode: 'answer',
    displayMode: 'headless',
    courseScope: 'all',
    awaitingCourseSelection: false,
    selectedCourseKeys: ['course-b'],
    selectedCourseNames: ['乙课程'],
    answerRoundLimit: 5,
    headline: '乙学生进行中',
    action: '乙学生提取第十题',
    bankCount: 11,
    aiCount: 4,
    courses: [{
      key: 'course-b',
      name: '乙课程',
      status: '提取中',
      bankCount: 11,
      aiCount: 4,
      groups: [{ title: '网上记分作业', rows: [{ name: '乙作业', status: 'extracting', questions: [] }] }],
    }],
    courseLogs: [{ time: '2026-11-01T00:01:00.000Z', level: 'running', courseName: '乙课程', courseKey: 'course-b', homeworkName: '乙作业', action: '提取中', result: '运行中', reason: '乙学生日志' }],
    activeCourseName: '乙课程',
    activeCourseKey: 'course-b',
  })
  isolatedSecond.groups = isolatedSecond.courses[0].groups
  await pushSnapshot(first, isolated)
  await page.locator('.student-pill[data-student="0"]').click()
  await waitForStudentNo(page, renderer, 0, accounts[0].username)
  await page.getByText('甲学生进行中', { exact: true }).waitFor()
  assert.equal(await page.locator('#status-title').innerText(), '甲学生进行中')
  assert.equal(await page.locator('#stat-repo').innerText(), '7')
  assert.equal(await page.locator('#stat-ai').innerText(), '2')
  await page.getByText('甲课程', { exact: true }).first().waitFor()
  await page.getByText('甲作业', { exact: true }).waitFor()
  await page.waitForFunction(
    () => !document.querySelector('#tool-log')?.disabled,
    null,
    { timeout: 3_000 },
  )
  await page.locator('#tool-log').click()
  await page.getByRole('heading', { name: '课程运行日志' }).waitFor()
  assert.match(await page.getByRole('heading', { name: '课程运行日志' }).locator('xpath=ancestor::section[1]').innerText(), /甲学生日志/)

  await page.getByRole('button', { name: '关闭课程日志' }).click()
  await page.locator('.student-pill[data-student="1"]').click()
  await waitForStudentNo(page, renderer, 1, accounts[1].username)
  await pushSnapshot(first, isolated)
  await page.getByText('乙学生进行中', { exact: true }).waitFor({ timeout: 5_000 })
  await page.getByRole('heading', { name: '课程运行日志' }).waitFor({ state: 'hidden' })
  assert.equal(await selectedWorkMode(page), '答题')
  assert.equal(await page.getByLabel('作业重新答题次数').inputValue(), '5')
  assert.equal(await page.locator('#status-title').innerText(), '乙学生进行中')
  assert.equal(await page.locator('#stat-repo').innerText(), '11')
  assert.equal(await page.locator('#stat-ai').innerText(), '4')
  await page.getByText('乙课程', { exact: true }).first().waitFor()
  await page.getByText('乙作业', { exact: true }).waitFor()
  await page.waitForFunction(
    () => !document.querySelector('#tool-log')?.disabled,
    null,
    { timeout: 3_000 },
  )
  await page.locator('#tool-log').click()
  await page.getByRole('heading', { name: '课程运行日志' }).waitFor()
  const secondLogText = await page.getByRole('heading', { name: '课程运行日志' }).locator('xpath=ancestor::section[1]').innerText()
  assert.match(secondLogText, /乙学生日志/)
  assert.doesNotMatch(secondLogText, /甲学生日志/)
  await page.getByRole('button', { name: '关闭课程日志' }).click()
  await pushSnapshot(first, actualBeforeEmpty)
  await page.locator('.student-pill[data-student="0"]').click()
  await waitForStudentNo(page, renderer, 0, accounts[0].username)

  const failed = structuredClone(actualBeforeEmpty)
  const failedStudent = failed.students.find((student) => student.local_id === first.ids[0])
  failed.running = false
  failedStudent.headline = '登录失败'
  failedStudent.action = '页面明确显示账号或密码错误'
  failedStudent.account = 'login_failed'
  failedStudent.courses = []
  failedStudent.groups = []
  await pushSnapshot(first, failed)
  await page.getByText('登录失败', { exact: true }).waitFor({ timeout: 5_000 })
  assert.equal(await page.locator('#status-title').innerText(), '登录失败')
  assert.match(await page.locator('#current-action').innerText(), /账号或密码错误/)
  assert.equal(await page.locator('#btn-open-qr').count(), 0, '登录失败态误弹旧二维码入口')

  const blankRecovered = structuredClone(failed)
  const blankStudent = blankRecovered.students.find((student) => student.local_id === first.ids[0])
  blankStudent.headline = '需人工处理'
  blankStudent.action = '首页连续刷新后仍无业务标记'
  blankStudent.account = 'needs_verify'
  await pushSnapshot(first, blankRecovered)
  await page.getByText('需人工处理', { exact: true }).waitFor({ timeout: 5_000 })
  assert.equal(await page.locator('#status-title').innerText(), '需人工处理')
  assert.match(await page.locator('#current-action').innerText(), /连续刷新后仍无业务标记/)

  const unsupported = structuredClone(actualBeforeEmpty)
  const unsupportedStudent = unsupported.students.find((student) => student.local_id === first.ids[0])
  unsupported.running = false
  unsupportedStudent.headline = '当前作业不支持'
  unsupportedStudent.action = '未知作业已隔离，其它作业继续'
  unsupportedStudent.account = 'auto_answering'
  unsupportedStudent.courses = [{
    key: 'unsupported-course',
    name: '边界课程',
    status: '有失败待处理',
    bankCount: 0,
    aiCount: 0,
    groups: [{
      title: '网上记分作业',
      rows: [
        { name: '保存结果不确定', status: 'submit_failed', questions: [] },
        { name: '后续已完成', status: 'done_100', score: 100, attempt: 1, questions: [] },
      ],
    }],
  }]
  unsupportedStudent.groups = unsupportedStudent.courses[0].groups
  unsupportedStudent.activeCourseName = '边界课程'
  unsupportedStudent.activeCourseKey = 'unsupported-course'
  await pushSnapshot(first, unsupported)
  await page.getByText('当前作业不支持', { exact: true }).waitFor({ timeout: 5_000 })
  assert.equal(await page.locator('#status-title').innerText(), '当前作业不支持')
  await page.getByText('保存结果不确定', { exact: true }).waitFor()
  await page.getByText('后续已完成', { exact: true }).waitFor()
  assert.equal(await page.getByText('作业失败', { exact: true }).count(), 1, '失败作业没有显示真实状态')
  assert.doesNotMatch(await page.locator('body').innerText(), /本轮无码答题完成/, '失败状态被展示成整轮成功')
  assert.equal(await page.locator('#btn-open-qr').count(), 0, '失败/不支持状态误弹旧二维码入口')

  const interruptedAndUncertain = structuredClone(unsupported)
  const interruptedStudent = interruptedAndUncertain.students.find((student) => student.local_id === first.ids[0])
  interruptedStudent.courses[0].status = '有失败待处理'
  interruptedStudent.courses[0].groups[0].rows = [
    { name: '答题页中断作业', status: 'answer_page_interrupted', questions: [] },
    { name: '提交不确定作业', status: 'submitted_uncertain', questions: [] },
  ]
  await pushSnapshot(first, interruptedAndUncertain)
  await page.getByText('答题页异常，已保留页面', { exact: true }).waitFor({ timeout: 5_000 })
  assert.equal(await page.getByText('提交结果不确定', { exact: true }).count(), 1, '提交不确定状态没有显示准确中文')
  assert.equal(await page.getByText('answer_page_interrupted', { exact: true }).count(), 0, '答题页中断状态仍显示原始标识')
  assert.equal(await page.getByText('submitted_uncertain', { exact: true }).count(), 0, '提交不确定状态仍显示原始标识')
  assert.equal(await page.getByText('答题页异常，已保留页面', { exact: true }).count(), 1)

  const waitingSave = structuredClone(interruptedAndUncertain)
  const waitingSaveStudent = waitingSave.students.find((student) => student.local_id === first.ids[0])
  waitingSaveStudent.headline = '等待答案保存'
  waitingSaveStudent.action = '等待当前题目保存响应'
  await pushSnapshot(first, waitingSave)
  await page.getByText('等待答案保存', { exact: true }).waitFor({ timeout: 5_000 })
  assert.match(await page.locator('#current-action').innerText(), /等待当前题目保存响应/)
  await pushSnapshot(first, actualBeforeEmpty)

  await first.app.close()
  first = null

  second = await prepareProduct(await launchApp())
  const persisted = await second.renderer('window.kaida.snapshot()')
  assert.equal(persisted.students.length, 2, '重载后测试账号丢失')
  assert.ok(persisted.students.every((student) => student.workMode === 'noqr'), '重载后无码模式未持久化')
  assert.ok(persisted.students.every((student) =>
    student.displayMode === 'visual' && student.courseScope === 'selected' && student.answerRoundLimit === 3), '重载后学生配置丢失')
  assert.deepEqual(
    persisted.students.map((student) => [student.name, student.studentNo]).sort(),
    accounts.map((account) => [account.name, maskAccount(account.username)]).sort(),
    '重载后学生身份串号',
  )
  assert.deepEqual(await second.page.locator('#work-mode-switcher button').allTextContents(), ['答题', '提取题库', '无码答题'])
  assert.equal(await selectedWorkMode(second.page), '无码答题')
  assert.equal(await second.page.getByLabel('作业重新答题次数').inputValue(), '3')
  assert.match(await second.page.locator('.mode-visual-btn').getAttribute('class'), /bg-\[#4F46E5\]/)
  await second.page.locator('.student-pill[data-student="1"]').click()
  await waitForStudentNo(second.page, second.renderer, 1, accounts[1].username)
  assert.equal(await selectedWorkMode(second.page), '无码答题', '重启后切换学生模式串号')
  assert.equal(await second.page.getByLabel('作业重新答题次数').inputValue(), '3', '重启后切换学生配置串号')

  const invalid = await second.invoke((payload) => window.kaida.updateAccount(payload.id, { work_mode: 'invalid' }), { id: second.ids[1] })
  assert.equal(invalid.ok, true, invalid.error || '非法工作模式测试值写入失败')
  await waitUntil(async () => (await second.renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === second.ids[1])?.workMode === 'answer', '非法工作模式回退')
  assert.equal(await selectedWorkMode(second.page), '答题', '非法工作模式没有回退为答题')

  await second.page.locator('.workmode-btn-ext').click()
  await waitUntil(async () => (await second.renderer('window.kaida.snapshot()')).students.find((student) => student.local_id === second.ids[1])?.workMode === 'extract', '提取模式写入')
  assert.equal(await second.page.getByLabel('作业重新答题次数').count(), 0, '提取模式仍显示重答次数')
  await second.page.getByRole('button', { name: /将配置设置到全部/ }).click()
  await waitUntil(async () => {
    const snapshot = await second.renderer('window.kaida.snapshot()')
    return snapshot.students.length === 2 && snapshot.students.every((student) =>
      student.workMode === 'extract' &&
      student.displayMode === 'visual' &&
      student.courseScope === 'selected' &&
      student.answerRoundLimit === 3)
  }, '提取模式全量同步')
  const extractSynced = await second.renderer('window.kaida.snapshot()')
  assert.deepEqual(
    extractSynced.students.map((student) => [student.name, student.studentNo]).sort(),
    accounts.map((account) => [account.name, account.username]).sort(),
    '提取模式全量同步改写了学生身份或账号',
  )
  assert.equal(await selectedWorkMode(second.page), '提取题库')
  assert.equal(await second.page.getByLabel('作业重新答题次数').count(), 0, '全量同步后提取模式仍显示重答次数')

  await second.app.evaluate(({ app, safeStorage }, ids) => {
    const { readFileSync, writeFileSync } = process.getBuiltinModule('fs')
    const { join } = process.getBuiltinModule('path')
    const file = join(app.getPath('userData'), 'kaida-store.bin')
    const store = JSON.parse(safeStorage.decryptString(readFileSync(file)))
    const missing = store.accounts.find((account) => account.local_id === ids[0])
    const nullValue = store.accounts.find((account) => account.local_id === ids[1])
    delete missing.work_mode
    delete missing.course_scope
    missing.answer_round_limit = null
    nullValue.work_mode = null
    nullValue.course_scope = null
    nullValue.answer_round_limit = 0
    writeFileSync(file, safeStorage.encryptString(JSON.stringify(store)))
  }, second.ids)
  await second.app.close()
  second = null

  third = await prepareProduct(await launchApp())
  const fallback = await third.renderer('window.kaida.snapshot()')
  assert.ok(fallback.students.every((student) => student.workMode === 'answer'), '缺失或 null 工作模式未回退为答题')
  assert.ok(fallback.students.every((student) => student.courseScope === 'all'), '缺失或非法课程范围未回退为全部课程')
  assert.ok(fallback.students.every((student) => student.answerRoundLimit === 10), '缺失、null 或 0 重答次数未回退为 10')
  assert.equal(await selectedWorkMode(third.page), '答题')
  assert.equal(await third.page.getByLabel('作业重新答题次数').inputValue(), '10')

  console.log(JSON.stringify({
    ok: true,
    modeOrder: ['答题', '提取题库', '无码答题'],
    independentModePersisted: true,
    appRestartPersisted: true,
    invalidFallback: true,
    missingAndNullFallback: true,
    allStudentsSynced: true,
    extractApplyAll: true,
    runLockCombination: true,
    visualRunLock: true,
    stopReleasedAndRestarted: true,
    qrHidden: true,
    oldQrEntryPreserved: true,
    studentSwitchIsolated: true,
    snapshotIsolated: true,
    emptyStates: true,
    emptyHistory: true,
    terminalStatePresentation: true,
    interruptedAndUncertainLabels: true,
    narrowWindowOverflow: false,
    settingsVersionDynamic: true,
    settingsCourseCap: true,
  }))
} finally {
  if (first) await first.app.close().catch(() => {})
  if (second) await second.app.close().catch(() => {})
  if (third) await third.app.close().catch(() => {})
}
