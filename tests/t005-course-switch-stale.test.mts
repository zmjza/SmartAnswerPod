import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Browser, type BrowserContext, type Page } from 'patchright'
import { openNoqrCourseWork, readNoqrCourseMenu, switchNoqrCourse } from '../electron/noqr/course.ts'
import { ensureNoqrSession } from '../electron/noqr/session.ts'

const ORIGIN = 'https://coursework.shou.org.cn'

function findBrowserExecutable(): string | undefined {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  if (process.platform === 'darwin' && existsSync(cache)) {
    const revision = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1)
    if (revision) {
      const executable = join(
        cache,
        revision,
        'chrome-mac-arm64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      )
      if (existsSync(executable)) return executable
    }
  }
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return process.platform === 'darwin' && existsSync(systemChrome) ? systemChrome : undefined
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, executablePath: findBrowserExecutable() })
}

async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  page.setDefaultTimeout(3_000)
  page.setDefaultNavigationTimeout(3_000)
  return page
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

const COURSE_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>形考作业</title></head>
<body>
  <nav class="van-nav-bar">
    <button class="van-nav-bar__left" type="button">返回</button>
    <div class="van-nav-bar__title">课程甲</div>
    <div class="van-nav-bar__right">
      <button class="van-popover__wrapper" type="button">菜单</button>
    </div>
  </nav>
  <div class="van-popover__content" role="menu">
    <button class="van-popover__action top-pop-item" type="button">中文</button>
    <button class="van-popover__action top-pop-item" type="button">English</button>
    <button class="van-popover__action top-pop-item" type="button">切换课程</button>
    <button class="van-popover__action top-pop-item top-pop-active" data-target="course-a" type="button">课程甲</button>
    <button class="van-popover__action top-pop-item" data-target="course-b" type="button">课程乙</button>
  </div>
  <main id="work-list">
    <article class="work-item" data-work-id="work-a">
      <h2 class="work-title">课程甲旧作业</h2>
      <span class="work-type">客观题试卷</span>
      <div class="work-btns"><button class="btn-item" type="button">开始作答</button><button class="btn-item" type="button">作答记录(0)</button></div>
    </article>
  </main>
  <script>
    window.__t005ReplacementApplied = false
    const popup = document.querySelector('.van-popover__content')
    document.querySelector('.van-popover__wrapper').addEventListener('click', () => {
      popup.hidden = !popup.hidden
    })
    for (const item of document.querySelectorAll('.top-pop-item')) {
      item.addEventListener('click', () => {
        for (const other of document.querySelectorAll('.top-pop-item')) other.classList.remove('top-pop-active')
        item.classList.add('top-pop-active')
        popup.hidden = true
        if (item.dataset.target !== 'course-b') return
        document.querySelector('.van-nav-bar__title').textContent = '课程乙'
        history.replaceState(null, '', '/course_work/index.html?courseId=course-b')
        setTimeout(() => {
          document.querySelector('#work-list').innerHTML = \`
            <article class="work-item" data-work-id="work-b">
              <h2 class="work-title">课程乙目标作业</h2>
              <span class="work-type">客观题试卷</span>
              <div class="work-btns"><button class="btn-item" type="button">开始作答</button><button class="btn-item" type="button">作答记录(0)</button></div>
            </article>\`
          window.__t005ReplacementApplied = true
        }, 700)
      })
    }
  </script>
</body>
</html>`

const HOME_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>合成首页</title></head><body>
  <main>
    <section class="menu-items">
      <span>课程提醒</span>
      <a href="/course_work/index.html?courseId=course-a">形考作业</a>
      <span>形考成绩</span>
    </section>
    <article class="course-card"><h3 class="course-title">课程甲</h3></article>
  </main>
</body></html>`

test('T005-P05c 课程标题先变化时不得读取旧作业卡，必须等待目标卡片替换', async () => {
  const browser = await launchBrowser()
  const context = await browser.newContext()
  await context.addCookies([{
    name: 'fixture_session',
    value: '1',
    domain: 'coursework.shou.org.cn',
    path: '/',
  }])
  await context.route(`${ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/login/index.html') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><script>location.replace("/index.html")</script>',
      })
      return
    }
    if (pathname === '/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: HOME_HTML })
      return
    }
    if (pathname === '/course_work/index.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: COURSE_HTML })
      return
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
  })

  const page = await newPage(context)
  try {
    await withTimeout(
      ensureNoqrSession(page, { username: 'fixture-user', password: 'fixture-password' }),
      'fixture login did not complete',
    )
    await withTimeout(
      openNoqrCourseWork(page, { blankGraceMs: 30_000 }),
      'course work did not open',
    )
    const courses = await readNoqrCourseMenu(page)
    assert.equal(courses.length, 2)
    await withTimeout(
      switchNoqrCourse(page, courses[1]!, { blankGraceMs: 30_000 }),
      'course switch did not wait for the target work card',
    )
    assert.equal(
      (await page.locator('.work-title').first().innerText()).trim(),
      '课程乙目标作业',
      'switch returned while the old course work cards were still mounted',
    )
  } finally {
    await context.close()
    await browser.close()
  }
})

test('T005-P05d 课程菜单只出现语言项时不提前读取，必须等待真实课程项', async () => {
  const browser = await launchBrowser()
  const page = await newPage(await browser.newContext())
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      if (new URL(route.request().url()).pathname !== '/course_work/index.html') {
        await route.fulfill({ status: 404, body: 'not found' })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><body>
          <div class="van-nav-bar">
            <div class="van-nav-bar__title">课程甲</div>
            <div class="van-nav-bar__right"><button class="van-popover__wrapper">菜单</button></div>
          </div>
          <article class="work-item"><span class="work-title">作业一</span></article>
          <div class="van-popover__content" hidden>
            <button class="van-popover__action top-pop-item">中文</button>
            <button class="van-popover__action top-pop-item">English</button>
            <button class="van-popover__action top-pop-item">切换课程</button>
          </div>
          <script>
            document.querySelector('.van-popover__wrapper').addEventListener('click', () => {
              document.querySelector('.van-popover__content').hidden = false
              setTimeout(() => {
                document.querySelector('.van-popover__content').insertAdjacentHTML('beforeend', \`
                  <button class="van-popover__action top-pop-item top-pop-active">课程甲</button>
                  <button class="van-popover__action top-pop-item">课程乙</button>
                \`)
              }, 450)
            })
          </script>
        </body>`,
      })
    })
    await page.goto(`${ORIGIN}/course_work/index.html`, { waitUntil: 'domcontentloaded' })
    const courses = await withTimeout(
      readNoqrCourseMenu(page, { blankGraceMs: 30_000 }),
      '课程菜单没有等待真实课程项',
    )
    assert.deepEqual(courses.map((course) => course.name), ['课程甲', '课程乙'])
  } finally {
    await page.context().close()
    await browser.close()
  }
})

test('T005-P05e 作业区已就绪但缺少菜单入口时有界收口为课程错误', async () => {
  const browser = await launchBrowser()
  const page = await newPage(await browser.newContext())
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      if (new URL(route.request().url()).pathname !== '/course_work/index.html') {
        await route.fulfill({ status: 404, body: 'not found' })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><body>
          <div class="van-nav-bar"><div class="van-nav-bar__title">课程甲</div></div>
          <article class="work-item" data-work-id="work-a">
            <span class="work-title">作业一</span>
            <span class="work-type">客观题试卷</span>
          </article>
        </body>`,
      })
    })
    await page.goto(`${ORIGIN}/course_work/index.html`, { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      withTimeout(readNoqrCourseMenu(page, {
        blankGraceMs: 40,
        refreshBudget: 0,
      }), '缺少菜单入口时课程读取没有收口', 3_000),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'course_contract',
    )
  } finally {
    await page.context().close()
    await browser.close()
  }
})
