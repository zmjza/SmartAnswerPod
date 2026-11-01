import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'patchright'
import { contentHash, normalizeOption, normalizeStem } from '../electron/core/hash.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = resolve(ROOT, 'tests/fixtures/t005-e3')
const USER_DATA = resolve(ROOT, '.playwright', `t005-e3-${process.pid}-${Date.now()}`)
const STORE_FILE = join(USER_DATA, 'kaida-store.bin')
const ACCOUNT = {
  name: 'E3 无码学生',
  username: 't005-e3-student',
  password: ['fixture', 'e3', 'password'].join('-'),
}
const QUESTIONS = [
  { qtype: 'single', stem: '合成单选题一', options: ['甲', '乙'], answers: ['乙'] },
  { qtype: 'single', stem: '合成单选题二', options: ['甲', '乙', '丙'], answers: ['丙'] },
  { qtype: 'multiple', stem: '合成多选题', options: ['甲', '乙', '丙'], answers: ['甲', '丙'] },
  { qtype: 'single', stem: '合成最后一题', options: ['甲', '乙'], answers: ['乙'] },
]

mkdirSync(USER_DATA, { recursive: true })

function storeDigest() {
  if (!existsSync(STORE_FILE)) return 'missing'
  return createHash('sha256').update(readFileSync(STORE_FILE)).digest('hex')
}

function fixture(name) {
  return readFileSync(resolve(FIXTURES, name), 'utf8')
}

function envelope(data) {
  return { result: { status: 'success', data, message: null }, targetUrl: null, success: true, error: null, unAuthorizedRequest: false, __abp: true }
}

function bankRows() {
  return QUESTIONS.map((question, index) => {
    const options = question.options.map((option) => normalizeOption(option, question.qtype))
    return {
      id: `question-${index + 1}`,
      qtype: question.qtype,
      stem: normalizeStem(question.stem),
      options,
      answer_texts: question.answers,
      course_names: ['合成课程一'],
      content_hash: contentHash(question.qtype, question.stem, question.options),
    }
  })
}

function waitUntil(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout
  return (async () => {
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))
    }
    throw new Error(label + ' 超时')
  })()
}

async function startFixtureServer() {
  const rows = bankRows()
  const state = {
    saves: [],
    finish: [],
    historyGets: 0,
    bankGets: 0,
    bankWrites: 0,
    bankQueries: [],
    finished: false,
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const json = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(value))
    }
    const html = (name) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(fixture(name))
    }
    const body = async () => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      try { return raw ? JSON.parse(raw) : {} } catch { return {} }
    }

    if (url.pathname === '/rest/v1/questions') {
      if (request.method === 'GET') {
        state.bankGets++
        const hash = url.searchParams.get('content_hash')?.replace(/^eq\./, '') || ''
        const matched = rows.filter((row) => row.content_hash === hash)
        state.bankQueries.push({ hash, matched: matched.length })
        json(matched)
        return
      }
      state.bankWrites++
      json([], 405)
      return
    }
    if (url.pathname === '/fixture/login' && request.method === 'POST') {
      json({ ok: true })
      return
    }
    if (url.pathname === '/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync' && request.method === 'POST') {
      state.saves.push(await body())
      json(envelope(null))
      return
    }
    if (url.pathname === '/dotNet_api/api/services/app/HomeWorkStudent/SubmitAllJsonAsync' && request.method === 'POST') {
      state.saves.push(await body())
      json(envelope(null))
      return
    }
    if (url.pathname === '/dotNet_api/api/services/app/HomeWorkStudent/FinishJsonAsync' && request.method === 'POST') {
      state.finish.push(await body())
      state.finished = true
      json(envelope(null))
      return
    }
    if (url.pathname === '/dotNet_api/api/services/app/HomeWorkStudent/GetAnswerHistoryListJsonAsync') {
      state.historyGets++
      const data = state.finished ? [{
        homeWorkUniqueFlag: 'flag-1',
        paperStructUniqueFlag: 'paper-1',
        finishedTime: '2026-11-01 12:00:00',
        score: 100,
        useTime: 60,
        isMarked: true,
        paperId: 'paper-1',
        status: '已批阅',
      }] : []
      json(envelope(data))
      return
    }
    if (url.pathname === '/login/index.html') return html('login.html')
    if (url.pathname === '/index.html') return html('home.html')
    if (url.pathname === '/course_work/index.html') return html('course-work.html')
    if (url.pathname === '/course_work_detail/index.html') return html('answer.html')
    if (url.pathname === '/course_work_record/index.html') return html('record.html')
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('fixture not found')
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  return {
    state,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

async function launchProduct(fixtureOrigin, bankOrigin) {
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: '',
      KAIDA_E2E_USERDATA: USER_DATA,
      KAIDA_SUPABASE_URL: bankOrigin,
      KAIDA_SUPABASE_ANON: 'local-test-key',
      KAIDA_SILICONFLOW_KEY: '',
      KAIDA_T005_FORCE_RETRY: '1',
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const renderer = (source) => app.evaluate(({ BrowserWindow }, script) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)

  await app.evaluate(async ({ app }, proxyOrigin) => {
    const { createRequire } = process.getBuiltinModule('module')
    const { chromium } = createRequire(app.getAppPath() + '/package.json')('patchright')
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    chromium.executablePath = () => systemChrome
    const state = globalThis.__t005E3 = { contexts: [], requests: [] }
    const original = chromium.launchPersistentContext
    chromium.launchPersistentContext = async function (profile, options) {
      const context = await original.call(this, profile, options)
      state.contexts.push(context)
      context.on('request', (request) => {
        const url = new URL(request.url())
        state.requests.push({ host: url.hostname, path: url.pathname, method: request.method() })
      })
      await context.route('https://coursework.shou.org.cn/**', async (route) => {
        const request = route.request()
        const source = new URL(request.url())
        const target = new URL(source.pathname + source.search, proxyOrigin)
        try {
          const forwarded = await fetch(target, {
            method: request.method(),
            headers: { 'content-type': request.headers()['content-type'] || 'application/json' },
            body: request.postData() || undefined,
          })
          await route.fulfill({
            status: forwarded.status,
            headers: { 'content-type': forwarded.headers.get('content-type') || 'text/html; charset=utf-8' },
            body: Buffer.from(await forwarded.arrayBuffer()),
          })
        } catch {
          await route.abort()
        }
      })
      return context
    }
  }, fixtureOrigin)

  const setup = await renderer(`(async () => {
    const account = ${JSON.stringify(ACCOUNT)}
    const accounts = await window.kaida.listAccounts()
    if (!accounts.some((item) => item.account === account.username)) {
      const added = await window.kaida.addAccount(account)
      if (!added.ok) return { ok: false, error: added.error }
    }
    const saved = await window.kaida.saveSettings({
      account_parallel: 1,
      course_parallel: 2,
      log_enabled: true,
      supabase_url: ${JSON.stringify(bankOrigin)},
      supabase_anon: 'local-test-key',
    })
    if (!saved.ok) return { ok: false, error: saved.error }
    const current = (await window.kaida.listAccounts()).find((item) => item.account === account.username)
    if (!current) return { ok: false, error: '账号未写入' }
    return { ok: true, id: current.local_id }
  })()`)
  assert.equal(setup.ok, true, setup.error || '产品账号初始化失败')

  await page.locator('#work-mode-switcher button').nth(2).click()
  await waitUntil(async () => {
    const snapshot = await renderer('window.kaida.snapshot()')
    return snapshot.students.find((student) => student.local_id === setup.id)?.workMode === 'noqr'
  }, '无码模式写入')
  await page.getByRole('button', { name: '可选课程执行' }).click()
  await waitUntil(async () => {
    const snapshot = await renderer('window.kaida.snapshot()')
    return snapshot.students.find((student) => student.local_id === setup.id)?.courseScope === 'selected'
  }, '可选课程模式写入')

  return {
    app,
    page,
    id: setup.id,
    renderer,
    requests: () => app.evaluate(() => globalThis.__t005E3.requests),
    close: () => app.close(),
  }
}

const fixtureServer = await startFixtureServer()
let product
try {
  product = await launchProduct(fixtureServer.origin, fixtureServer.origin)
  const persistentStoreBefore = storeDigest()

  await product.page.locator('#btn-primary-action').click()
  try {
    await waitUntil(async () => {
      const snapshot = await product.renderer('window.kaida.snapshot()')
      return snapshot.running && snapshot.students.find((student) => student.local_id === product.id)?.awaitingCourseSelection
    }, '无码课程扫描与选课闸门', 120_000)
  } catch (error) {
    const snapshot = await product.renderer('window.kaida.snapshot()')
    console.log('T005 E3 扫描诊断', JSON.stringify({
      running: snapshot.running,
      student: snapshot.students.find((student) => student.local_id === product.id),
      requests: (await product.requests()).slice(-30),
    }))
    throw error
  }

  const scanned = await product.renderer('window.kaida.snapshot()')
  const student = scanned.students.find((item) => item.local_id === product.id)
  assert.equal(student.courses.length, 2, '课程菜单数量不正确')
  const objectiveCourse = student.courses.find((item) => item.name === '合成课程一')
  assert.ok(objectiveCourse, '缺少合成课程一')
  if (!objectiveCourse.groups?.[0]?.rows?.length) {
    console.log('T005 E3 课程快照诊断', JSON.stringify(student.courses))
  }
  assert.equal(objectiveCourse.groups[0]?.rows.length, 2, '作业卡没有进入快照')

  const course = objectiveCourse
  const courseIndex = student.courses.findIndex((item) => item.key === course.key)
  await waitUntil(async () => {
    const items = product.page.locator('#course-list .course-item')
    if (await items.count() !== student.courses.length) return false
    return ((await items.nth(courseIndex).textContent().catch(() => '')) || '').includes(course.name)
  }, '课程列表 UI 与主进程快照同步', 30_000)
  const courseItem = product.page.locator('#course-list .course-item').nth(courseIndex)
  await courseItem.waitFor({ state: 'visible', timeout: 5_000 })
  await courseItem.click()
  await waitUntil(async () => {
    const snapshot = await product.renderer('window.kaida.snapshot()')
    return snapshot.students.find((item) => item.local_id === product.id)?.selectedCourseKeys.includes(course.key)
  }, '产品页面选课')

  await product.page.locator('#btn-primary-action').click()
  try {
    await waitUntil(async () => {
      const snapshot = await product.renderer('window.kaida.snapshot()')
      const row = snapshot.students.find((item) => item.local_id === product.id)
      return !snapshot.running && row?.slot === 'released' && row?.account === 'round_ended'
    }, '无码全链路完成与释放', 60_000)
  } catch (error) {
    const snapshot = await product.renderer('window.kaida.snapshot()')
    console.log('T005 E3 执行诊断', JSON.stringify({
      running: snapshot.running,
      student: snapshot.students.find((item) => item.local_id === product.id),
      fixture: { saves: fixtureServer.state.saves.length, finish: fixtureServer.state.finish.length, historyGets: fixtureServer.state.historyGets },
      bankQueries: fixtureServer.state.bankQueries,
      requests: (await product.requests()).slice(-50),
    }))
    throw error
  }

  const final = await product.renderer('window.kaida.snapshot()')
  const finalStudent = final.students.find((item) => item.local_id === product.id)
  assert.equal(finalStudent.bankCount, 4, '题库作答计数不正确')
  assert.equal(finalStudent.aiCount, 0, '不应在题库全命中时调用 AI')
  assert.deepEqual(finalStudent.questionKindCounts, { single: 3, multiple: 1 }, '已保存题型计数不正确')
  const finalCourse = finalStudent.courses.find((item) => item.key === course.key)
  const homework = finalCourse.groups[0].rows.find((item) => item.name === '合成在线作业')
  assert.equal(homework.status, 'done_100')
  assert.equal(homework.score, 100)
  assert.equal(homework.attempt, 1)
  assert.equal(homework.noqrAnsweredQuestionCount, 4, '作业时长统计未覆盖全部成功保存题位')
  assert.ok(homework.noqrAverageQuestionDurationMs >= 2_800, '平均每题答题时长未体现约三秒节奏')
  assert.ok(homework.noqrMaxQuestionDurationMs >= homework.noqrAverageQuestionDurationMs, '最长单题时长小于平均每题时长')
  assert.ok(homework.noqrTotalDurationMs >= homework.noqrAverageQuestionDurationMs * 4, '作业完成总时长未覆盖全部作答')

  const timingPanel = product.page.locator('[data-noqr-timing]')
  await timingPanel.waitFor({ state: 'visible', timeout: 10_000 })
  const timingText = (await timingPanel.textContent()) || ''
  assert.match(timingText, /平均每题/)
  assert.match(timingText, /最长单题/)
  assert.match(timingText, /作业总时长/)
  assert.doesNotMatch(timingText, /undefined|NaN|\bms\b/i)

  assert.equal(fixtureServer.state.saves.length, 4, '单题保存请求数量不正确')
  assert.equal(fixtureServer.state.finish.length, 1, '最终交卷请求数量不正确')
  assert.ok(fixtureServer.state.saves.every((body) => body.workId === 'work-1' && body.homeWorkUniqueFlag === 'flag-1'))
  assert.equal(fixtureServer.state.finish[0].paperStructUniqueFlag, 'paper-1')
  assert.ok(fixtureServer.state.historyGets >= 2, '作答记录接口没有被真实读取')
  assert.equal(fixtureServer.state.bankWrites, 0, '无码模式出现题库写请求')
  assert.ok(fixtureServer.state.bankGets >= 4, '题库只读请求数量不足')

  const requests = await product.requests()
  assert.equal(requests.some((request) => /qr|weixin|oauth/i.test(request.path)), false, '无码模式出现旧扫码/授权请求')

  const savesBeforePacingStop = fixtureServer.state.saves.length
  await product.page.locator('#btn-primary-action').click()
  await waitUntil(async () => {
    const snapshot = await product.renderer('window.kaida.snapshot()')
    return snapshot.running && snapshot.students.find((student) => student.local_id === product.id)?.awaitingCourseSelection
  }, '节奏停止场景课程扫描与选课闸门', 120_000)

  const pacingScan = await product.renderer('window.kaida.snapshot()')
  const pacingStudent = pacingScan.students.find((item) => item.local_id === product.id)
  const pacingCourse = pacingStudent.courses.find((item) => item.name === course.name)
  assert.ok(pacingCourse, '节奏停止场景缺少目标课程')
  const pacingCourseIndex = pacingStudent.courses.findIndex((item) => item.key === pacingCourse.key)
  await waitUntil(async () => {
    const items = product.page.locator('#course-list .course-item')
    if (await items.count() !== pacingStudent.courses.length) return false
    return ((await items.nth(pacingCourseIndex).textContent().catch(() => '')) || '').includes(pacingCourse.name)
  }, '节奏停止场景课程列表同步', 30_000)
  const pacingCourseItem = product.page.locator('#course-list .course-item').nth(pacingCourseIndex)
  await pacingCourseItem.waitFor({ state: 'visible', timeout: 5_000 })
  await pacingCourseItem.click()
  await product.page.locator('#btn-primary-action').click()

  await waitUntil(async () => {
    const snapshot = await product.renderer('window.kaida.snapshot()')
    const student = snapshot.students.find((item) => item.local_id === product.id)
    return snapshot.running && student?.bankCount === 1
  }, '成功保存后的三秒节奏等待', 60_000)
  assert.equal(fixtureServer.state.saves.length, savesBeforePacingStop + 1, '节奏停止前不应进入下一题保存')
  const stopRequestedAt = Date.now()
  await product.page.locator('#tool-stop').click()
  await waitUntil(async () => {
    const snapshot = await product.renderer('window.kaida.snapshot()')
    const student = snapshot.students.find((item) => item.local_id === product.id)
    return !snapshot.running && student?.slot === 'released'
  }, '节奏等待停止后的释放', 30_000)
  const stopLatencyMs = Date.now() - stopRequestedAt
  assert.ok(stopLatencyMs < 2_000, `节奏等待停止耗时过长：${stopLatencyMs}ms`)

  const stopped = await product.renderer('window.kaida.snapshot()')
  const stoppedStudent = stopped.students.find((item) => item.local_id === product.id)
  const stoppedCourse = stoppedStudent.courses.find((item) => item.name === course.name)
  const stoppedHomework = stoppedCourse.groups[0].rows.find((item) => item.name === homework.name)
  assert.equal(stoppedStudent.phase, 'stopped')
  assert.equal(stoppedStudent.account, 'stopped')
  assert.equal(stoppedStudent.bankCount, 1)
  assert.equal(stoppedStudent.aiCount, 0)
  assert.deepEqual(stoppedStudent.questionKindCounts, { single: 1 })
  assert.equal(stoppedHomework.status, 'stopped')
  assert.equal(stoppedHomework.noqrAnsweredQuestionCount, 1)
  assert.ok(stoppedHomework.noqrAverageQuestionDurationMs > 0)
  assert.ok(stoppedHomework.noqrAverageQuestionDurationMs < 3_000)
  assert.ok(stoppedHomework.noqrMaxQuestionDurationMs >= stoppedHomework.noqrAverageQuestionDurationMs)
  assert.ok(stoppedHomework.noqrTotalDurationMs >= stoppedHomework.noqrAverageQuestionDurationMs)
  assert.equal(fixtureServer.state.saves.length, savesBeforePacingStop + 1, '停止后不应继续保存下一题')
  assert.equal(fixtureServer.state.finish.length, 1, '停止后不应把任务伪装成交卷完成')

  const persistentStoreAfter = storeDigest()
  assert.equal(persistentStoreAfter, persistentStoreBefore, '无码模式改写了本机持久化/待回写队列')

  console.log(JSON.stringify({
    ok: true,
    layer: 'E3',
    courses: finalStudent.courses.length,
    homeworks: finalCourse.groups[0].rows.length,
    saves: fixtureServer.state.saves.length,
    finish: fixtureServer.state.finish.length,
    historyGets: fixtureServer.state.historyGets,
    bankGets: fixtureServer.state.bankGets,
    bankWrites: fixtureServer.state.bankWrites,
    score: homework.score,
    attempt: homework.attempt,
    answeredQuestionCount: homework.noqrAnsweredQuestionCount,
    averageQuestionDurationMs: homework.noqrAverageQuestionDurationMs,
    maxQuestionDurationMs: homework.noqrMaxQuestionDurationMs,
    totalDurationMs: homework.noqrTotalDurationMs,
    pacingStop: {
      saves: fixtureServer.state.saves.length - savesBeforePacingStop,
      answeredQuestionCount: stoppedHomework.noqrAnsweredQuestionCount,
      averageQuestionDurationMs: stoppedHomework.noqrAverageQuestionDurationMs,
      maxQuestionDurationMs: stoppedHomework.noqrMaxQuestionDurationMs,
      totalDurationMs: stoppedHomework.noqrTotalDurationMs,
      status: stoppedHomework.status,
      released: stoppedStudent.slot === 'released',
      stopLatencyMs,
    },
    persistentStoreUnchanged: persistentStoreAfter === persistentStoreBefore,
    released: finalStudent.slot === 'released',
  }))
} finally {
  if (product) await product.close().catch(() => {})
  await fixtureServer.close()
}
