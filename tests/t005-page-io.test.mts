import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'patchright'
import {
  classifyNoqrPage,
  ensureNoqrHomeReady,
  ensureNoqrSession,
  navigateNoqrPage,
  NoqrNetworkActivity,
  NoqrSessionError,
  reloadNoqrPage,
} from '../electron/noqr/session.ts'
import {
  openNoqrCourseWork,
  readNoqrCourseMenu,
  switchNoqrCourse,
  waitForNoqrCourseWorkReady,
} from '../electron/noqr/course.ts'
import {
  evaluateNoqrHomeworkRule,
  isSupportedNoqrWorkType,
  openNoqrHomework,
  readNoqrHomeworks,
  shouldResetNoqrCoursePage,
} from '../electron/noqr/homework.ts'
import { detectNoqrAnswerPageInterruption } from '../electron/noqr/page-policy.ts'

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
  loginMode?: 'success' | 'slow' | 'failure' | 'blocked' | 'blank' | 'delayed-redirect' | 'unrelated-4xx' | 'no-form-failure' | 'session-storage' | 'session-storage-no-redirect'
  loginDocumentDelayMs?: number
  loginDocumentDelayCount?: number
  loginDocumentAbortCount?: number
  courseMode?: 'ready' | 'empty' | 'skeleton-once'
} = {}) {
  let courseLoads = 0
  let loginDocumentLoads = 0
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
      loginDocumentLoads++
      if (options.loginDocumentAbortCount && loginDocumentLoads <= options.loginDocumentAbortCount) {
        await route.abort('failed')
        return
      }
      if (options.loginDocumentDelayMs && loginDocumentLoads <= (options.loginDocumentDelayCount ?? Number.POSITIVE_INFINITY)) {
        await new Promise((resolve) => setTimeout(resolve, options.loginDocumentDelayMs))
      }
      if (signedIn) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html><body><script>location.replace("/index.html")</script></body></html>',
        })
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
                : optionsWithDefaults.loginMode === 'session-storage'
                  ? 'login-session.html'
                  : optionsWithDefaults.loginMode === 'session-storage-no-redirect'
                    ? 'login-session-no-redirect.html'
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

test('T005-P18 新标签页复用已登录 sessionStorage，不重复提交账号密码', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginMode: 'session-storage' })
  const first = await newPage(context)
  let loginSubmissions = 0
  let loginDocuments = 0
  context.on('request', (request) => {
    if (request.url().includes('/fixture-login')) loginSubmissions++
    if (new URL(request.url()).pathname === '/login/index.html') loginDocuments++
  })
  try {
    const firstResult = await withTimeout(
      ensureNoqrSession(first, { username: 'fixture-user', password: 'fixture-pass' }),
      '首次 sessionStorage 登录没有完成',
    )
    assert.equal(firstResult.reused, false)
    assert.equal(loginSubmissions, 1)
    assert.equal(loginDocuments, 1)
    assert.equal(await first.evaluate(() => sessionStorage.getItem('fixture_session_token')), '1')

    const second = await newPage(context)
    const secondResult = await withTimeout(
      ensureNoqrSession(second, { username: 'fixture-user', password: 'fixture-pass' }),
      '新标签页复用 sessionStorage 没有完成',
    )
    assert.equal(secondResult.reused, true)
    assert.equal(loginSubmissions, 1)
    assert.equal(loginDocuments, 2)
    assert.equal(await second.evaluate(() => sessionStorage.getItem('fixture_session_token')), '1')
    assert.equal(await classifyNoqrPage(second), 'home')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P18b 登录页不自动跳转时从唯一登录入口受控续接一次', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginMode: 'session-storage-no-redirect' })
  const first = await newPage(context)
  let loginSubmissions = 0
  let loginDocuments = 0
  let homeDocuments = 0
  context.on('request', (request) => {
    if (request.url().includes('/fixture-login')) loginSubmissions++
    const path = new URL(request.url()).pathname
    if (path === '/login/index.html') loginDocuments++
    if (path === '/index.html') homeDocuments++
  })
  try {
    const firstResult = await withTimeout(
      ensureNoqrSession(first, { username: 'fixture-user', password: 'fixture-pass' }),
      '首次 sessionStorage 登录没有完成',
    )
    assert.equal(firstResult.reused, false)
    assert.equal(loginSubmissions, 1)

    const second = await newPage(context)
    const secondResult = await withTimeout(
      ensureNoqrSession(second, { username: 'fixture-user', password: 'fixture-pass' }),
      '登录页不自动跳转时会话受控续接没有完成',
    )
    assert.equal(secondResult.reused, true)
    assert.equal(loginSubmissions, 1)
    assert.equal(loginDocuments, 2)
    assert.equal(homeDocuments, 2)
    assert.equal(await classifyNoqrPage(second), 'home')
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
      withTimeout(ensureNoqrSession(blankPage, {
        username: 'fixture-user',
        password: 'fixture-pass',
        blankGraceMs: 30,
      }), '空白登录页没有被安全隔离'),
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

test('T006-NAV01 登录入口首次文档失败时仍能通过有界空白恢复继续登录', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginDocumentAbortCount: 1 })
  const page = await newPage(context)
  let loginDocuments = 0
  context.on('request', (request) => {
    if (new URL(request.url()).pathname === '/login/index.html') loginDocuments++
  })
  try {
    const result = await withTimeout(
      ensureNoqrSession(page, {
        username: 'fixture-user',
        password: 'fixture-password',
        blankGraceMs: 30,
      }),
      '首次登录文档失败后的恢复没有完成',
      4_000,
    )
    assert.equal(result.reused, false)
    assert.equal(await classifyNoqrPage(page), 'home')
    assert.ok(loginDocuments >= 2, '首次登录文档失败后没有进行受控恢复')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T006-NAV02 登录入口文档延迟 commit 时不误杀慢响应', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, { loginDocumentDelayMs: 500, loginDocumentDelayCount: 1 })
  const page = await newPage(context)
  let loginDocuments = 0
  context.on('request', (request) => {
    if (new URL(request.url()).pathname === '/login/index.html') loginDocuments++
  })
  try {
    const result = await withTimeout(
      ensureNoqrSession(page, {
        username: 'fixture-user',
        password: 'fixture-password',
        blankGraceMs: 20,
        blankMaxActiveWaitMs: 80,
      }),
      '登录文档长期不 commit 时没有恢复',
      4_000,
    )
    assert.equal(result.reused, false)
    assert.equal(await classifyNoqrPage(page), 'home')
    assert.ok(loginDocuments >= 1, '登录文档请求没有发生')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T006-NAV03 首次登录文档永久挂起时按注入的活动上限恢复', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await installFixtureRoutes(context, {
    loginDocumentDelayMs: 1_500,
    loginDocumentDelayCount: 1,
  })
  const page = await newPage(context)
  let loginDocuments = 0
  context.on('request', (request) => {
    if (new URL(request.url()).pathname === '/login/index.html') loginDocuments++
  })
  try {
    const result = await withTimeout(
      ensureNoqrSession(page, {
        username: 'fixture-user',
        password: 'fixture-password',
        blankGraceMs: 20,
        blankMaxActiveWaitMs: 80,
        blankMaxHeartbeatWaitMs: 80,
      }),
      '首次登录文档永久挂起时没有按活动上限恢复',
      1_200,
    )
    assert.equal(result.reused, false)
    assert.equal(await classifyNoqrPage(page), 'home')
    assert.ok(loginDocuments >= 2, '悬挂的首次登录文档没有触发受控恢复')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T006-NAV04 非空未识别的登录中转页必须按预算收口', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await context.route(`${ORIGIN}/**`, async (route) => {
    if (new URL(route.request().url()).pathname === '/login/index.html') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<main>登录中转页加载中</main>',
      })
      return
    }
    await route.fulfill({ status: 404, body: 'not found' })
  })
  const page = await newPage(context)
  try {
    await assert.rejects(
      withTimeout(ensureNoqrSession(page, {
        username: 'fixture-user',
        password: 'fixture-password',
        blankGraceMs: 20,
        blankMaxActiveWaitMs: 40,
        blankMaxHeartbeatWaitMs: 40,
      }), '非空未知中转页没有被安全收口', 1_200),
      (error: unknown) => error instanceof NoqrSessionError &&
        ['blank_page', 'page_error'].includes(error.code),
    )
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T006-NAV05 登录提交后进入空白页仍按 60/90/120 恢复预算安全停止', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await newPage(context)
  let blankLoads = 0
  await context.route(`${ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/login/index.html') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><body>
          <input name="用户名">
          <input name="密码" type="password">
          <button type="button">提交</button>
          <script>
            document.querySelector('button').addEventListener('click', async () => {
              await fetch('/fixture-login', { method: 'POST', body: '{}' })
              location.href = '/blank-after-login'
            })
          </script>
        </body></html>`,
      })
      return
    }
    if (pathname === '/fixture-login') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })
      return
    }
    if (pathname === '/blank-after-login') {
      blankLoads++
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
      return
    }
    await route.fulfill({ status: 404, body: 'not found' })
  })
  try {
    await assert.rejects(
      withTimeout(ensureNoqrSession(page, {
        username: 'fixture-user',
        password: 'fixture-pass',
        blankGraceMs: 20,
        blankMaxActiveWaitMs: 40,
        blankMaxHeartbeatWaitMs: 40,
      }), '登录提交后的空白页没有安全收口', 3_000),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'blank_page',
    )
    assert.ok(blankLoads >= 4, '登录提交后的空白页没有执行限定刷新预算')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T006-NAV06 commit 后慢正文响应不得因网络监听过早释放而被刷新', async () => {
  const server = createServer(async (request, response) => {
    if (request.url !== '/index.html') {
      response.writeHead(404)
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.write('<!doctype html><html><body>')
    await new Promise((resolve) => setTimeout(resolve, 300))
    response.end('<div class="menu-items">形考作业</div></body></html>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await newPage(context)
  const startedAt = Date.now()
  try {
    await withTimeout(navigateNoqrPage(page, `${origin}/index.html`, {
      origin,
      blankGraceMs: 20,
      blankMaxActiveWaitMs: 1_000,
      blankMaxHeartbeatWaitMs: 500,
    }), 'commit 后的慢正文响应没有等待完成', 3_000)
    assert.ok(Date.now() - startedAt >= 200, 'commit 后过早返回并丢失了仍活动的文档请求')
    assert.equal(await classifyNoqrPage(page), 'home')
  } finally {
    await context.close()
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('T006-NAV07 空白恢复重导航后的慢正文响应仍保持活动跟踪', async () => {
  let loads = 0
  const server = createServer(async (request, response) => {
    if (request.url !== '/index.html') {
      response.writeHead(404)
      response.end('not found')
      return
    }
    loads++
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (loads === 1) {
      response.end('<!doctype html><html><body></body></html>')
      return
    }
    response.write('<!doctype html><html><body>')
    await new Promise((resolve) => setTimeout(resolve, 300))
    response.end('<div class="menu-items">形考作业</div></body></html>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await newPage(context)
  const startedAt = Date.now()
  try {
    await withTimeout(navigateNoqrPage(page, `${origin}/index.html`, {
      origin,
      blankGraceMs: 20,
      blankMaxActiveWaitMs: 1_000,
      blankMaxHeartbeatWaitMs: 500,
    }), '重导航后的慢正文响应没有等待完成', 3_000)
    assert.ok(loads >= 2, '空白恢复没有重新导航')
    assert.ok(Date.now() - startedAt >= 200, '重导航后过早返回并丢失了仍活动的文档请求')
    assert.equal(await classifyNoqrPage(page), 'home')
  } finally {
    await context.close()
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('T006-NAV08 首页恢复必须复用登录阶段已建立的慢正文活动监听', async () => {
  let loads = 0
  const server = createServer(async (request, response) => {
    if (request.url !== '/index.html') {
      response.writeHead(404)
      response.end('not found')
      return
    }
    loads++
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.write('<!doctype html><html><body>')
    await new Promise((resolve) => setTimeout(resolve, 300))
    response.end('<div class="menu-items">形考作业</div></body></html>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const page = await newPage(context)
  const network = new NoqrNetworkActivity(page, origin)
  const startedAt = Date.now()
  try {
    await page.goto(`${origin}/index.html`, { waitUntil: 'commit', timeout: 0 })
    await withTimeout(ensureNoqrHomeReady(page, {
      network,
      blankGraceMs: 20,
      blankMaxActiveWaitMs: 1_000,
      blankMaxHeartbeatWaitMs: 500,
    }), '首页恢复没有复用已有活动监听', 3_000)
    assert.ok(Date.now() - startedAt >= 200, '首页恢复过早返回')
    assert.equal(loads, 1, '首页恢复错误刷新了仍在加载的慢正文')
    assert.equal(await classifyNoqrPage(page), 'home')
  } finally {
    network.dispose()
    await context.close()
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('T006-PAGE01 答题页短暂未知中转不得被包装成人工中断', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await context.route(`${ORIGIN}/course_work_detail/index.html**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<main>短暂中转</main>',
    })
  })
  const page = await context.newPage()
  try {
    await page.goto(pageUrl('/course_work_detail/index.html?workId=fixture&workType=onlineWork'), {
      waitUntil: 'domcontentloaded',
    })
    assert.equal(await classifyNoqrPage(page), 'unknown')
    const detection = detectNoqrAnswerPageInterruption(page, { settleMs: 160 })
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    await page.evaluate(() => {
      document.body.innerHTML = '<div class="question-info"><div class="question-title">合成题</div></div>'
    })
    assert.equal(await detection, null)
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T006-PAGE02 已启动的慢请求在恢复监听器交接后仍算业务活动', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  let courseLoads = 0
  await context.route(`${ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/course_work/index.html') {
      courseLoads++
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<div class="van-nav-bar"><div class="van-nav-bar__title">合成课程</div></div><div class="skeleton-area van-skeleton"></div>',
      })
      return
    }
    if (pathname === '/slow.json') {
      await new Promise((resolveWait) => setTimeout(resolveWait, 450))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      })
      return
    }
    await route.fulfill({ status: 404, body: 'not found' })
  })
  const page = await context.newPage()
  const tracker = new NoqrNetworkActivity(page)
  const controller = new AbortController()
  try {
    await page.goto(pageUrl('/course_work/index.html?courseId=fixture'), {
      waitUntil: 'domcontentloaded',
    })
    const fetchTask = page.evaluate(() =>
      fetch('/slow.json').then(() => true))
    await page.waitForRequest((request) => new URL(request.url()).pathname === '/slow.json')
    const waiting = waitForNoqrCourseWorkReady(page, {
      signal: controller.signal,
      network: tracker,
      blankGraceMs: 30,
    })
    await new Promise((resolveWait) => setTimeout(resolveWait, 220))
    assert.equal(courseLoads, 1, '慢请求仍在进行时恢复了课程页')
    controller.abort()
    await assert.rejects(
      withTimeout(waiting, '慢请求恢复等待没有在停止后收口', 2_000),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'stopped',
    )
    await fetchTask
  } finally {
    tracker.dispose()
    await context.close()
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
    await withTimeout(switchNoqrCourse(page, courses[0]!, {
      refreshBudget: 2,
      blankGraceMs: 30,
    }), '刷新后没有重新点击目标课程')
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
    await withTimeout(openNoqrCourseWork(page, { blankGraceMs: 30 }), '形考作业入口没有打开')
    const homeworks = await withTimeout(readNoqrHomeworks(page, { blankGraceMs: 30 }), '作业卡没有恢复读取')
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

test('T005-P06b 形考作业页连续刷新仍无作业时按当前课程无作业收口', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let courseLoads = 0
  try {
    await page.route(`${ORIGIN}/course_work/index.html*`, async (route) => {
      courseLoads++
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<div class="van-nav-bar">
          <div class="van-nav-bar__title">空课程</div>
          <div class="van-nav-bar__right"><div class="van-popover__wrapper">菜单</div></div>
        </div>`,
      })
    })
    await page.goto(pageUrl('/course_work/index.html?courseId=course-empty'), {
      waitUntil: 'domcontentloaded',
    })
    const homeworks = await withTimeout(
      readNoqrHomeworks(page, { blankGraceMs: 30, refreshBudget: 1 }),
      '连续空白没有按无作业收口',
      3_000,
    )
    assert.deepEqual(homeworks, [])
    assert.equal(courseLoads, 2)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T006-COURSE01 形考作业页活动请求达到上限时不得误判为空课程', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname === '/slow-course-work-request') {
        await new Promise(() => {})
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<div class="van-nav-bar">
          <div class="van-nav-bar__title">活动课程</div>
          <div class="van-nav-bar__right"><div class="van-popover__wrapper">菜单</div></div>
        </div>
        <script>fetch('/slow-course-work-request')</script>`,
      })
    })
    await page.goto(pageUrl('/course_work/index.html?courseId=course-active'), {
      waitUntil: 'domcontentloaded',
    })
    await assert.rejects(
      withTimeout(waitForNoqrCourseWorkReady(page, {
        blankGraceMs: 20,
        blankMaxActiveWaitMs: 80,
        blankMaxHeartbeatWaitMs: 80,
        refreshBudget: 1,
      }), '活动慢请求被误判为空课程', 2_000),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'blank_page',
    )
  } finally {
    await page.close()
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
          blankGraceMs: 30,
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
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<div class="menu-items">形考作业</div>' })
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
      withTimeout(ensureNoqrHomeReady(page, {
        refreshBudget: 3,
        blankGraceMs: 30,
      }), '标题型首页没有按预算收口', 4_000),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'blank_page',
    )
    assert.equal(loads, 4)
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P19 非答题恢复流程绝不刷新已有内容的答题页', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let loads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      loads++
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<div class="van-nav-bar"><div class="van-nav-bar__title">答题页</div></div><div class="question-info"><div class="question-title">合成题</div></div>',
      })
    })
    await page.goto(pageUrl('/course_work_detail/index.html?workId=fixture'), { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      withTimeout(ensureNoqrHomeReady(page, { blankGraceMs: 20 }), '答题页被错误刷新'),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'answer_interrupted',
    )
    assert.equal(loads, 1)
    assert.equal(await classifyNoqrPage(page), 'answer')
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-P19b 通用刷新入口必须集中拒绝答题页', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let loads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      loads++
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<div class="van-nav-bar"><div class="van-nav-bar__title">答题页</div></div><div class="question-info"><div class="question-title">合成题</div></div>',
      })
    })
    await page.goto(pageUrl('/course_work_detail/index.html?workId=fixture'), { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      withTimeout(reloadNoqrPage(page), '通用刷新入口错误刷新了答题页'),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'answer_interrupted',
    )
    assert.equal(loads, 1)
    assert.equal(await classifyNoqrPage(page), 'answer')
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-P20 业务点击同步发出的慢请求在空白计时前已被监听', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let courseLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/index.html') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: fixture('home.html') })
        return
      }
      if (path === '/course_work/index.html') {
        courseLoads++
        await new Promise((resolveWait) => setTimeout(resolveWait, 450))
        await route.fulfill({ status: 200, contentType: 'text/html', body: fixture('course-work.html') })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await page.goto(pageUrl('/index.html'), { waitUntil: 'domcontentloaded' })
    await withTimeout(
      openNoqrCourseWork(page, { blankGraceMs: 30, refreshBudget: 1 }),
      '慢业务请求被误判为空白',
    )
    assert.equal(courseLoads, 1)
    assert.equal(await classifyNoqrPage(page), 'course_work')
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-P20b 同源心跳不能无限推迟无活动空白恢复', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let courseLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/course_work/index.html') {
        courseLoads++
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<div class="van-nav-bar"><div class="van-nav-bar__title">课程作业</div></div>
            <script>setInterval(() => fetch('/heartbeat').catch(() => undefined), 20)</script>`,
        })
        return
      }
      if (path === '/heartbeat') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await page.goto(pageUrl('/course_work/index.html?courseId=course-1'), { waitUntil: 'domcontentloaded' })
    assert.equal(
      await withTimeout(waitForNoqrCourseWorkReady(page, {
        blankGraceMs: 100,
        refreshBudget: 1,
      }), '同源心跳让空白恢复永久挂起', 3_000),
      'empty',
    )
    assert.equal(courseLoads, 2)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-P20c 同路径不同查询的慢业务请求不能被当成心跳', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let courseLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work/index.html') {
        courseLoads++
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<div class="van-nav-bar"><div class="van-nav-bar__title">课程作业</div></div>
            <script>
              fetch('/api/data?courseId=course-a').then(() =>
                fetch('/api/data?courseId=course-b'))
            </script>`,
        })
        return
      }
      if (url.pathname === '/api/data' && url.searchParams.get('courseId') === 'course-a') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
        return
      }
      if (url.pathname === '/api/data' && url.searchParams.get('courseId') === 'course-b') {
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_500))
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await page.goto(pageUrl('/course_work/index.html?courseId=course-a'), { waitUntil: 'domcontentloaded' })
    const waiting = waitForNoqrCourseWorkReady(page, {
      blankGraceMs: 50,
      refreshBudget: 1,
    })
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    assert.equal(courseLoads, 1, '慢业务请求仍处于活动状态时页面被提前刷新')
    assert.equal(
      await withTimeout(waiting, '慢业务请求结束后空白恢复没有收口', 5_000),
      'empty',
    )
    assert.equal(courseLoads, 2)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-P20d 同路径动态查询心跳不能无限推迟空白恢复', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let courseLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work/index.html') {
        courseLoads++
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<div class="van-nav-bar"><div class="van-nav-bar__title">课程作业</div></div>
            <script>
              let heartbeat = 0
              setInterval(() => {
                heartbeat++
                fetch('/status?ts=' + heartbeat).catch(() => undefined)
              }, 20)
            </script>`,
        })
        return
      }
      if (url.pathname === '/status') {
        await new Promise((resolveWait) => setTimeout(resolveWait, 220))
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await page.goto(pageUrl('/course_work/index.html?courseId=course-1'), { waitUntil: 'domcontentloaded' })
    assert.equal(
      await withTimeout(waitForNoqrCourseWorkReady(page, {
        blankGraceMs: 100,
        refreshBudget: 1,
      }), '动态查询心跳让空白恢复永久挂起', 4_000),
      'empty',
    )
    assert.equal(courseLoads, 2)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-P20e 同路径三个以上稳定业务参数仍分别计为业务活动', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let courseLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work/index.html') {
        courseLoads++
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<div class="van-nav-bar"><div class="van-nav-bar__title">课程作业</div></div>
            <script>
              fetch('/api/data?page=1')
                .then(() => fetch('/api/data?page=2'))
                .then(() => fetch('/api/data?page=3'))
            </script>`,
        })
        return
      }
      if (url.pathname === '/api/data') {
        if (url.searchParams.get('page') === '3') {
          await new Promise((resolveWait) => setTimeout(resolveWait, 1_500))
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await page.goto(pageUrl('/course_work/index.html?courseId=course-a'), { waitUntil: 'domcontentloaded' })
    const waiting = waitForNoqrCourseWorkReady(page, {
      blankGraceMs: 50,
      refreshBudget: 1,
    })
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    assert.equal(courseLoads, 1, '第三个不同业务参数请求仍被误判为静默')
    assert.equal(
      await withTimeout(waiting, '第三个业务请求结束后空白恢复没有收口', 5_000),
      'empty',
    )
    assert.equal(courseLoads, 2)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T006-ANSWER-NAV01 开始作答的慢文档导航期间绝不刷新课程页', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let courseLoads = 0
  let answerLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/course_work/index.html') {
        courseLoads++
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<div class="van-nav-bar"><div class="van-nav-bar__title">合成课程</div></div>
            <article class="work-item" data-work-id="work-1" data-course-id="course-1">
              <span class="work-title">合成作业</span>
              <div class="work-btns">
                <button class="btn-item" onclick="location.href='/course_work_detail/index.html?workId=work-1&courseId=course-1&workType=onlineWork'">开始作答</button>
                <button class="btn-item">作答记录(0)</button>
              </div>
            </article>`,
        })
        return
      }
      if (path === '/course_work_detail/index.html') {
        answerLoads++
        await new Promise((resolve) => setTimeout(resolve, 500))
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<div class="van-nav-bar"><div class="van-nav-bar__title">合成作业</div></div><div class="question-info"><div class="question-title">合成题</div></div>',
        })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await page.goto(pageUrl('/course_work/index.html?courseId=course-1'), { waitUntil: 'domcontentloaded' })
    const homeworks = await readNoqrHomeworks(page, { blankGraceMs: 20, refreshBudget: 1 })
    const waiting = openNoqrHomework(page, homeworks[0]!, 'start', {
      blankGraceMs: 20,
      refreshBudget: 1,
      blankMaxActiveWaitMs: 80,
      blankMaxHeartbeatWaitMs: 80,
      answerNavigationHardDeadlineMs: 1_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 220))
    assert.equal(courseLoads, 1, '答题文档尚未 commit 时课程页被错误刷新')
    await withTimeout(waiting, '慢答题文档导航没有到达答题页', 3_000)
    assert.equal(answerLoads, 1)
    assert.match(page.url(), /\/course_work_detail\/index\.html\?/)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-P21 首页和答题页隐藏的业务标记不能冒充页面就绪', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/index.html') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<div class="menu-items" style="display:none">形考作业</div>
            <div class="course-card" style="display:none">隐藏课程</div>
            <main>首页加载中</main>`,
        })
        return
      }
      if (path === '/course_work_detail/index.html') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<div class="van-nav-bar"><div class="van-nav-bar__title">测试作业</div></div>
            <div class="content-area">
              <div class="question-info" style="display:none">
                <span class="question-title">隐藏题目</span>
              </div>
              <main>页面加载中</main>
            </div>`,
        })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(pageUrl('/index.html'), { waitUntil: 'domcontentloaded' })
    assert.equal(await classifyNoqrPage(page), 'home_blank')
    await page.locator('.menu-items').evaluate((node) => {
      ;(node as HTMLElement).style.display = 'block'
    })
    assert.equal(await classifyNoqrPage(page), 'home')

    await page.goto(pageUrl('/course_work_detail/index.html?workId=work-1&courseId=course-1&workType=onlineWork'), {
      waitUntil: 'domcontentloaded',
    })
    assert.notEqual(await classifyNoqrPage(page), 'answer')
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-P22 隐藏的旧作业卡不参与读取或点击', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/course_work/index.html') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><body>
            <div class="van-nav-bar">
              <div class="van-nav-bar__title">课程甲</div>
              <div class="van-nav-bar__right"><div class="van-popover__wrapper">菜单</div></div>
            </div>
            <article class="work-item" data-work-id="hidden-old" style="display:none">
              <span class="work-title">旧课程作业</span>
              <div class="work-btns">
                <button class="btn-item" onclick="window.__oldClicked=true">开始作答</button>
                <button class="btn-item">作答记录(0)</button>
              </div>
            </article>
            <article class="work-item" data-work-id="new">
              <span class="work-title">当前课程作业</span>
              <div class="work-btns">
                <button class="btn-item" onclick="location.href='/course_work_detail/index.html?workId=new&courseId=course&workType=onlineWork'">开始作答</button>
                <button class="btn-item">作答记录(0)</button>
              </div>
            </article>
          </body>`,
        })
        return
      }
      if (path === '/course_work_detail/index.html') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<div class="van-nav-bar"><div class="van-nav-bar__title">测试作业</div></div>',
        })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await page.goto(pageUrl('/course_work/index.html?courseId=course'), { waitUntil: 'domcontentloaded' })
    const homeworks = await readNoqrHomeworks(page, { blankGraceMs: 50, refreshBudget: 1 })
    assert.equal(homeworks.length, 1)
    assert.equal(homeworks[0]?.name, '当前课程作业')
    await openNoqrHomework(page, homeworks[0]!, 'start', { blankGraceMs: 50, refreshBudget: 1 })
    assert.match(page.url(), /workId=new/)
    assert.equal(await page.evaluate(() => Boolean((window as typeof window & { __oldClicked?: boolean }).__oldClicked)), false)
  } finally {
    await page.close()
    await browser.close()
  }
})
