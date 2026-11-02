import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'patchright'
import { recoverNoqrCourseWorkWithoutLogin } from '../electron/noqr/recovery.ts'
import { NoqrSessionError } from '../electron/noqr/session.ts'

const ORIGIN = 'https://coursework.shou.org.cn'

function browserExecutable(): string | undefined {
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
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return process.platform === 'darwin' && existsSync(chrome) ? chrome : undefined
}

async function withTimeout<T>(task: Promise<T>, label: string, ms = 6_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('T005-REC01 已登录课程页空白只刷新当前页，不重新打开登录页', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() })
  const page = await browser.newPage()
  let courseDocuments = 0
  let loginDocuments = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/login/index.html') {
        loginDocuments++
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<form>login</form>' })
        return
      }
      if (path === '/course_work/index.html') {
        courseDocuments++
        const body = courseDocuments === 1
          ? '<!doctype html><body></body>'
          : `<!doctype html><body>
              <div class="van-nav-bar"><div class="van-nav-bar__title">课程甲</div>
                <div class="van-nav-bar__right"><div class="van-popover__wrapper">菜单</div></div>
              </div>
              <article class="work-item"><span class="work-title">作业一</span></article>
            </body>`
        await route.fulfill({ status: 200, contentType: 'text/html', body })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(`${ORIGIN}/course_work/index.html`, { waitUntil: 'domcontentloaded' })
    await withTimeout(
      recoverNoqrCourseWorkWithoutLogin(page, {
        refreshBudget: 1,
        blankGraceMs: 50,
      }),
      '空白课程页没有在刷新后恢复',
    )
    assert.equal(courseDocuments, 2)
    assert.equal(loginDocuments, 0)
    assert.equal(await page.locator('.work-item').count(), 1)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-REC02 已作答答题页禁止用恢复流程刷新或返回', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() })
  const page = await browser.newPage()
  let documentRequests = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      documentRequests++
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><body>
          <div class="van-nav-bar"><button class="van-nav-bar__left" onclick="window.__back=(window.__back||0)+1">返回</button></div>
          <div class="content-area">
            <div class="question-info"><span class="question-title">已答题目</span></div>
            <div class="van-popup van-popup--bottom"><div class="question-card">
              <span class="sub-question has-answered">1</span>
            </div></div>
          </div>
        </body>`,
      })
    })
    await page.goto(`${ORIGIN}/course_work_detail/index.html?workId=work-1&courseId=course-1&workType=onlineWork`, {
      waitUntil: 'domcontentloaded',
    })
    documentRequests = 0
    await assert.rejects(
      recoverNoqrCourseWorkWithoutLogin(page),
      (error: unknown) => error instanceof NoqrSessionError && error.code === 'answer_interrupted',
    )
    assert.equal(documentRequests, 0)
    assert.equal(await page.evaluate(() => Number((window as typeof window & { __back?: number }).__back || 0)), 0)
  } finally {
    await page.close()
    await browser.close()
  }
})
