import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'patchright'
import {
  classifyNoqrPage,
  ensureNoqrHomeReady,
  ensureNoqrSession,
  NoqrSessionError,
  reloadNoqrPage,
} from '../electron/noqr/session.ts'
import {
  openNoqrCourseWork,
  readNoqrCourseMenu,
  switchNoqrCourse,
} from '../electron/noqr/course.ts'
import {
  evaluateNoqrHomeworkRule,
  isSupportedNoqrWorkType,
  openNoqrHomework,
  readNoqrHomeworks,
  shouldResetNoqrCoursePage,
} from '../electron/noqr/homework.ts'

const ROOT = new URL('./fixtures/t005-page-io/', import.meta.url)
const ORIGIN = 'https://coursework.shou.org.cn'
const BROWSER_EXECUTABLE = findBrowserExecutable()

function findBrowserExecutable(): string | undefined {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  if (process.platform === 'darwin' && existsSync(cache)) {
    const revision = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1)
    if (revision) {
      const executable = join(cache, revision, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      if (existsSync(executable)) return executable
    }
  }
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return process.platform === 'darwin' && existsSync(systemChrome) ? systemChrome : undefined
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, executablePath: BROWSER_EXECUTABLE })
}

function fixture(name: string): string {
  return readFileSync(new URL(name, ROOT), 'utf8')
}

function pageUrl(path: string): string {
  return ORIGIN + path
}

async function withTimeout<T>(task: Promise<T>, message: string, ms = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function installFixtureRoutes(context: BrowserContext, options: {
  loginMode?: 'success' | 'slow' | 'failure' | 'blocked' | 'blank' | 'delayed-redirect' | 'unrelated-4xx' | 'no-form-failure'
  loginDocumentDelayMs?: number
  courseMode?: 'ready' | 'empty' | 'skeleton-once'
} = {}) {
  let courseLoads = 0
  const optionsWithDefaults = {
    loginMode: options.loginMode || 'success',
    courseMode: options.courseMode || 'ready',
  }
  await context.route(`${ORIGIN}/**`, async (route: Route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    const cookies = await context.cookies()
    const signedIn = cookies.some((cookie) => cookie.name === 'fixture_session' && cookie.value === '1')

    if (pathname === '/login/index.html') {
      if (options.loginDocumentDelayMs) await new Promise((resolve) => setTimeout(resolve, options.loginDocumentDelayMs))
      if (signedIn) {
        await route.fulfill({ status: 302, headers: { location: '/index.html' } })
        return
      }
      if (optionsWithDefaults.loginMode === 'blank') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: fixture('blank.html') })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: fixture(optionsWithDefaults.loginMode === 'no-form-failure'
          ? 'login-no-form-failure.html'
          : optionsWithDefaults.loginMode === 'failure'
            ? 'login-failure.html'
            : optionsWithDefaults.loginMode === 'slow'
              ? 'login-slow.html'
              : optionsWithDefaults.loginMode === 'delayed-redirect'
                ? 'login-delayed.html'
                : optionsWithDefaults.loginMode === 'unrelated-4xx'
                  ? 'login-unrelated-4xx.html'
                  : 'login.html'),
      })
      return
    }

    if (pathname === '/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: fixture('home.html') })
      return
    }

    if (pathname === '/course_work/index.html') {
      courseLoads++
      if (optionsWithDefaults.courseMode === 'skeleton-once' && courseLoads === 1) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: fixture('course-skeleton.html') })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: fixture(optionsWithDefaults.courseMode === 'empty' ? 'course-empty.html' : 'course-work.html'),
      })
      return
    }

    if (pathname === '/fixture-login') {
      const response = optionsWithDefaults.loginMode === 'failure'
        ? { status: 401, contentType: 'application/json', body: JSON.stringify({ success: false }) }
        : { status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }
      if (optionsWithDefaults.loginMode === 'slow') await new Promise((resolve) => setTimeout(resolve, 650))
      await route.fulfill(response)
      return
    }

    if (pathname === '/fixture-analytics') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false }) })
      return
    }

    if (pathname === '/course_work_detail/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: fixture('answer-boot.html') })
      return
    }

    if (pathname === '/course_work_record/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: fixture('record.html') })
      return
    }

    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
  })
}

async function signedInContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.addCookies([{ name: 'fixture_session', value: '1', domain: 'coursework.shou.org.cn', path: '/' }])
  await installFixtureRoutes(context)
  return context
}

async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  page.setDefaultTimeout(3_000)
  page.setDefaultNavigationTimeout(3_000)
  return page
}

test('T005-P01 已有会话从登录入口复用首页，不重复提交账号密码', async () => {
  const browser = await launchBrowser()
  const context = await signedInContext(browser)
  const page = await newPage(context)
  try {
    let loginClicks = 0
    page.on('request', (request) => {
      if (request.url().includes('/fixture-login')) loginClicks++
    })
    const result = await withTimeout(ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' }), '会话复用没有完成')
    assert.equal(result.reused, true)
    assert.equal(loginClicks, 0)
    assert.equal(await classifyNoqrPage(page), 'home')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P02 慢登录不按固定 5 秒失败，真实完成后才判成功', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginMode: 'slow' })
  const page = await newPage(context)
  try {
    const result = await withTimeout(ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' }), '慢登录等待失败')
    assert.equal(result.reused, false)
    assert.equal(result.finalUrl, pageUrl('/index.html'))
    assert.equal(await classifyNoqrPage(page), 'home')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P03 明确登录失败不会误判成功', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginMode: 'failure' })
  const page = await newPage(context)
  try {
    await assert.rejects(
      withTimeout(ensureNoqrSession(page, { username: 'fixture-user', password: 'wrong-pass' }), '登录失败没有被识别'),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'login_failed',
    )
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P04 登录页无活动空白按预算刷新，认证阻塞页立即停止', async () => {
  const browser = await launchBrowser()
  const blankContext = await browser.newContext()
  await installFixtureRoutes(blankContext, { loginMode: 'blank' })
  const blankPage = await newPage(blankContext)
  try {
    await assert.rejects(
      withTimeout(ensureNoqrSession(blankPage, { username: 'fixture-user', password: 'fixture-pass' }), '空白登录页没有被安全隔离'),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'blank_page',
    )
  } finally {
    await blankContext.close()
  }

  const blockedContext = await browser.newContext()
  await blockedContext.route(`${ORIGIN}/**`, async (route) => {
    await route.fulfill({
      status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><meta charset="utf-8"></head><body><main><h1>请在企业微信客户端打开链接</h1></main></body></html>',
    })
  })
  const blockedPage = await newPage(blockedContext)
  try {
    await assert.rejects(
      withTimeout(ensureNoqrSession(blockedPage, { username: 'fixture-user', password: 'fixture-pass' }), '企业微信阻塞没有被识别'),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'auth_blocked',
    )
  } finally {
    await blockedContext.close()
    await browser.close()
  }
})

test('T005-P09 登录响应后延迟跳转超过旧稳定窗口仍继续等待首页', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginMode: 'delayed-redirect' })
  const page = await newPage(context)
  try {
    const result = await withTimeout(
      ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' }),
      '延迟跳转首页没有继续等待',
    )
    assert.equal(result.reused, false)
    assert.equal(result.finalUrl, pageUrl('/index.html'))
    assert.equal(await classifyNoqrPage(page), 'home')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P10 无关 POST 4xx 不得污染真实登录请求结果', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginMode: 'unrelated-4xx' })
  const page = await newPage(context)
  try {
    const result = await withTimeout(
      ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' }),
      '无关请求 4xx 被误判为登录失败',
    )
    assert.equal(result.reused, false)
    assert.equal(result.finalUrl, pageUrl('/index.html'))
    assert.equal(await classifyNoqrPage(page), 'home')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P11 无表单但明确显示登录失败时安全收口，不永久等待', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginMode: 'no-form-failure' })
  const page = await newPage(context)
  try {
    await assert.rejects(
      withTimeout(
        ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' }),
        '无表单明确失败页没有收口',
        4_000,
      ),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'login_failed',
    )
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P12 非答题页导航不使用 Playwright 默认 30 秒/测试页 3 秒固定上限', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginMode: 'success', loginDocumentDelayMs: 3_500 })
  const page = await newPage(context)
  try {
    const result = await withTimeout(
      ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' }),
      '慢导航被固定默认超时误杀',
    )
    assert.equal(result.reused, false)
    assert.equal(result.finalUrl, pageUrl('/index.html'))
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P05 首页只通过形考作业入口进入，并按真实顺序读取和切换课程', async () => {
  const browser = await launchBrowser()
  const context = await signedInContext(browser)
  const page = await newPage(context)
  try {
    await ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' })
    await withTimeout(openNoqrCourseWork(page), '形考作业入口没有打开')
    const courses = await withTimeout(readNoqrCourseMenu(page), '课程菜单没有读取')
    assert.deepEqual(courses.map((course) => ({ name: course.name, order: course.order, current: course.current })), [
      { name: '课程甲', order: 4, current: false },
      { name: '课程乙', order: 5, current: true },
      { name: '课程甲', order: 6, current: false },
    ])
    assert.equal(new Set(courses.map((course) => course.key)).size, 3, '同名课程必须使用稳定顺序身份区分')
    await withTimeout(switchNoqrCourse(page, courses[2]), '同名第三门课程没有切换成功')
    assert.match(await page.locator('.van-nav-bar__title').innerText(), /课程甲/)
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P05b 课程切换骨架刷新后会重新定位并点击原目标课程', async () => {
  const browser = await launchBrowser()
  const context = await signedInContext(browser)
  await installFixtureRoutes(context)
  const page = await newPage(context)
  const base = fixture('course-work.html')
  const recoveryScript = `
    <script>
      document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('.top-pop-item') : null
        if (!target || localStorage.getItem('t005-switch-once') === '1') return
        event.preventDefault()
        event.stopImmediatePropagation()
        localStorage.setItem('t005-switch-once', '1')
        document.body.innerHTML = '<div class="skeleton-area van-skeleton"></div>'
      }, true)
    </script>`
  await page.route(`${ORIGIN}/course_work/index.html`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: base.replace('</body>', `${recoveryScript}</body>`),
    })
  })
  try {
    await ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' })
    await withTimeout(openNoqrCourseWork(page), '形考作业入口没有打开')
    const courses = await withTimeout(readNoqrCourseMenu(page), '课程菜单没有读取')
    await withTimeout(switchNoqrCourse(page, courses[0]!, { refreshBudget: 2 }), '刷新后没有重新点击目标课程')
    assert.equal((await page.locator('.van-nav-bar__title').innerText()).trim(), '课程甲')
    assert.equal(await page.evaluate(() => localStorage.getItem('t005-switch-once')), '1')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P06 非答题页骨架等待、空白刷新后读取作业卡，不下钻答题页', async () => {
  const browser = await launchBrowser()
  const context = await signedInContext(browser)
  await installFixtureRoutes(context, { courseMode: 'skeleton-once' })
  const page = await newPage(context)
  try {
    await ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' })
    await withTimeout(openNoqrCourseWork(page), '形考作业入口没有打开')
    const homeworks = await withTimeout(readNoqrHomeworks(page), '作业卡没有恢复读取')
    assert.equal(homeworks.length, 2)
    assert.equal(homeworks[0]?.name, '记分作业一')
    assert.equal(homeworks[0]?.workType, 'onlineWork')
    assert.equal(homeworks[0]?.weightPercent, 20)
    assert.equal(homeworks[0]?.recordCount, 2)
    assert.equal(homeworks[1]?.workType, 'unknown')
    assert.equal(new URL(page.url()).pathname, '/course_work/index.html')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P07 作业规则 fail-closed：权重、非客观题、日期和次数用尽均不开始', () => {
  const base = {
    name: '合成作业',
    key: 'hw-1',
    workType: 'onlineWork',
    section: 'onlineHomework' as const,
    weightPercent: 20,
    startAt: '2026-01-01 00:00:00',
    endAt: '2026-12-31 23:59:59',
    reviewDeadline: '2027-01-01 00:00:00',
    attemptsText: '无限制',
    recordCount: 0,
    startEnabled: true,
    recordEnabled: false,
  }
  const now = Date.parse('2026-11-01T12:00:00+08:00')
  assert.deepEqual(evaluateNoqrHomeworkRule(base, now, 3), { needDo: true, maxRounds: 3, reason: '' })
  assert.equal(evaluateNoqrHomeworkRule({ ...base, weightPercent: 0 }, now, 3).reason, 'weight_zero')
  assert.deepEqual(evaluateNoqrHomeworkRule({ ...base, workType: 'stageExam' }, now, 3), { needDo: true, maxRounds: 3, reason: '' })
  assert.equal(evaluateNoqrHomeworkRule({ ...base, workType: 'unknown' }, now, 3).reason, 'unsupported_work_type')
  assert.equal(evaluateNoqrHomeworkRule({ ...base, startAt: '2026-12-01 00:00:00' }, now, 3).reason, 'out_of_window')
  assert.equal(evaluateNoqrHomeworkRule({ ...base, attemptsText: '作答次数: 2/2' }, now, 3).reason, 'attempts_exhausted')
  assert.equal(evaluateNoqrHomeworkRule({ ...base, startEnabled: false }, now, 3).reason, 'start_disabled')
  assert.equal(isSupportedNoqrWorkType('onlineWork'), true)
  assert.equal(isSupportedNoqrWorkType('stageExam'), true)
  assert.equal(isSupportedNoqrWorkType('unknown'), false)
  assert.equal(isSupportedNoqrWorkType(''), false)
})

test('T005-P07b 作业失败后不得复用仍停留在答题页的旧页面', () => {
  assert.equal(shouldResetNoqrCoursePage(pageUrl('/course_work/index.html'), false), false)
  assert.equal(shouldResetNoqrCoursePage(pageUrl('/course_work/index.html'), true), true)
  assert.equal(shouldResetNoqrCoursePage(pageUrl('/course_work_detail/index.html?workId=fixture'), false), true)
  assert.equal(shouldResetNoqrCoursePage('not-a-url', false), true)
})

test('T005-P08 从真实作业卡按钮打开作答启动页和作答记录页，不使用深链拼接', async () => {
  const browser = await launchBrowser()
  const context = await signedInContext(browser)
  const page = await newPage(context)
  try {
    await ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-pass' })
    await openNoqrCourseWork(page)
    const homeworks = await readNoqrHomeworks(page)
    await withTimeout(openNoqrHomework(page, homeworks[0]!, 'start'), '开始作答按钮没有打开答题启动页')
    assert.equal(new URL(page.url()).pathname, '/course_work_detail/index.html')

    await page.locator('.van-nav-bar__left').click()
    await withTimeout(page.waitForURL((url) => url.pathname === '/course_work/index.html', { waitUntil: 'domcontentloaded' }), '返回作业页没有完成')
    await withTimeout(openNoqrHomework(page, homeworks[0]!, 'record'), '作答记录按钮没有打开记录页')
    assert.equal(new URL(page.url()).pathname, '/course_work_record/index.html')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P13 停止可以中断挂起的页面刷新并释放等待', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await newPage(context)
  let loads = 0
  let stopped = false
  await page.route(`${ORIGIN}/**`, async (route) => {
    loads++
    if (loads === 1) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>fixture</title>' })
      return
    }
    await new Promise(() => {})
  })
  try {
    await page.goto(`${ORIGIN}/login/index.html`, { waitUntil: 'domcontentloaded' })
    const pending = reloadNoqrPage(page, { stopRequested: () => stopped })
    setTimeout(() => { stopped = true }, 80)
    await assert.rejects(
      withTimeout(pending, '停止没有中断挂起刷新', 3_000),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'stopped',
    )
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P14 登录加载已结束且表单仍在、无活动请求时安全失败', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await newPage(context)
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><body>
          <input name="用户名">
          <input name="密码" type="password">
          <button type="button">提交</button>
          <script>
            const button = document.querySelector('button')
            button.addEventListener('click', () => {
              button.textContent = '加载中...'
              setTimeout(() => { button.textContent = '提交' }, 20)
            })
          </script>
        </body></html>`,
      })
    })
    await assert.rejects(
      withTimeout(
        ensureNoqrSession(page, {
          username: 'fixture-user',
          password: 'fixture-password',
          loginIdleBudgetMs: 100,
        }),
        '稳定无请求登录没有安全失败',
        2_000,
      ),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'login_failed',
    )
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P15 标题型登录空白页按刷新预算收口', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await newPage(context)
  let loads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      loads++
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><body><div class="van-nav-bar__title">登录</div></body></html>',
      })
    })
    await assert.rejects(
      withTimeout(
        ensureNoqrSession(page, {
          username: 'fixture-user',
          password: 'fixture-password',
        }),
        '标题型登录空白页没有按预算收口',
        4_000,
      ),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'blank_page',
    )
    assert.equal(loads, 4)
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P16 活动慢登录请求即使超过空闲预算仍继续等待', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await newPage(context)
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/fixture-login') {
        await new Promise((resolve) => setTimeout(resolve, 250))
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })
        return
      }
      if (path === '/index.html') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<div class="menu-items">首页</div>' })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><body>
          <input name="用户名">
          <input name="密码" type="password">
          <button type="button">提交</button>
          <script>
            document.querySelector('button').addEventListener('click', async () => {
              document.querySelector('button').textContent = '加载中...'
              await fetch('/fixture-login', { method: 'POST', body: '{}' })
              location.href = '/index.html'
            })
          </script>
        </body></html>`,
      })
    })
    const result = await withTimeout(
      ensureNoqrSession(page, {
        username: 'fixture-user',
        password: 'fixture-password',
        loginIdleBudgetMs: 80,
      }),
      '活动慢登录被空闲预算误杀',
      3_000,
    )
    assert.equal(result.reused, false)
    assert.equal(result.finalUrl, pageUrl('/index.html'))
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P17 只有标题的首页按刷新预算收口', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await newPage(context)
  let loads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      loads++
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><body><div class="van-nav-bar__title">首页</div></body></html>',
      })
    })
    await page.goto(pageUrl('/index.html'), { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      withTimeout(ensureNoqrHomeReady(page, { refreshBudget: 3 }), '标题型首页没有按预算收口', 4_000),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'blank_page',
    )
    assert.equal(loads, 4)
  } finally {
    await context.close()
    await browser.close()
  }
})
