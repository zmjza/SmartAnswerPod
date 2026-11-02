import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Browser, type Page, type Request, type Response } from 'patchright'
import { readNoqrHistoryAfterOpen } from '../electron/noqr/history.ts'
import { NOQR_API, NOQR_ORIGIN } from '../electron/noqr/selectors.ts'

const ORIGIN = NOQR_ORIGIN

function browserExecutable(): string | undefined {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  if (process.platform === 'darwin' && existsSync(cache)) {
    const revisions = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1)
    if (revisions) {
      const executable = join(
        cache,
        revisions,
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
  return chromium.launch({ headless: true, executablePath: browserExecutable() })
}

async function technicalTimeout<T>(task: Promise<T>, message: string, ms = 4_000): Promise<T> {
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

function htmlResponse(body: string) {
  return { status: 200, contentType: 'text/html; charset=utf-8', body }
}

test('T005-HISTORY-NET01 旧记录已存在时新记录请求失败必须有限返回分数待确认', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let recordLoads = 0
  let historyRequests = 0
  let answerPageLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === NOQR_API.history) {
        historyRequests++
        await route.abort('connectionreset')
        return
      }
      if (url.pathname === '/course_work_record/index.html') {
        recordLoads++
        await route.fulfill(htmlResponse(`
          <!doctype html>
          <html><body>
            <nav class="van-nav-bar"><button class="van-nav-bar__left">返回</button><div class="van-nav-bar__title">作答记录</div></nav>
            <div class="record-item">
              <div class="record-info">完成时间: 2026-11-01 12:00:00</div>
              <div class="score-num">91</div>
            </div>
            <script>
              fetch('${NOQR_API.history}?workId=work-new', { cache: 'no-store' })
            </script>
          </body></html>
        `))
        return
      }
      if (url.pathname === '/course_work_detail/index.html') {
        answerPageLoads++
        await route.fulfill({ status: 404, body: 'must not open answer page' })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    const result = await technicalTimeout(readNoqrHistoryAfterOpen({
      page,
      workId: 'work-new',
      blankGraceMs: 30,
      refreshBudget: 3,
      requireFreshRecord: true,
      baseline: [{
        finishedTime: '2026-11-01 12:00:00',
        score: 91,
        isMarked: true,
        status: '已批阅',
      }],
      open: async () => {
        await page.goto(`${ORIGIN}/course_work_record/index.html?workId=work-new`, {
          waitUntil: 'domcontentloaded',
        })
      },
      stopRequested: () => false,
    }), '作答记录请求失败后读取函数没有收口')

    assert.equal(result.ok, false)
    assert.equal(result.latest, null)
    assert.match(result.error || '', /网络|请求失败|HTTP/)
    assert.equal(result.failureKind, 'network')
    assert.equal(historyRequests, 1)
    assert.equal(recordLoads, 1)
    assert.equal(answerPageLoads, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-HISTORY-NET02 响应体永不结束时必须有限返回分数待确认', async () => {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const request = {
    method: () => 'GET',
    url: () => `${ORIGIN}${NOQR_API.history}?workId=work-new`,
  } as unknown as Request
  const response = {
    request: () => request,
    url: () => `${ORIGIN}${NOQR_API.history}?workId=work-new`,
    finished: () => new Promise<void>(() => {}),
    text: async () => '',
    status: () => 200,
  } as unknown as Response
  const page = {
    on(event: string, listener: (value: unknown) => void) {
      const current = listeners.get(event) || new Set()
      current.add(listener)
      listeners.set(event, current)
    },
    off(event: string, listener: (value: unknown) => void) {
      listeners.get(event)?.delete(listener)
    },
    url: () => `${ORIGIN}/course_work_record/index.html?workId=work-new`,
    waitForTimeout: async () => {},
  } as unknown as Page
  const result = await technicalTimeout(readNoqrHistoryAfterOpen({
    page,
    workId: 'work-new',
    responseHardDeadlineMs: 200,
    open: async () => {
      for (const listener of listeners.get('response') || []) listener(response)
    },
    stopRequested: () => false,
  }), '历史响应体挂起后没有收口', 1_500)

  assert.equal(result.ok, false)
  assert.equal(result.failureKind, 'network')
  assert.match(result.error || '', /安全上限|请求失败/)
})

test('T005-HISTORY-NET03 旧记录卡无本次请求时仍必须有限返回分数待确认', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_record/index.html') {
        await route.fulfill(htmlResponse(`
          <!doctype html>
          <html><body>
            <nav class="van-nav-bar"><button class="van-nav-bar__left">返回</button><div class="van-nav-bar__title">作答记录</div></nav>
            <div class="record-item">
              <div class="record-info">完成时间: 2026-11-01 12:00:00</div>
              <div class="score-num">91</div>
            </div>
          </body></html>
        `))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    const result = await technicalTimeout(readNoqrHistoryAfterOpen({
      page,
      workId: 'work-new',
      responseHardDeadlineMs: 250,
      blankGraceMs: 30,
      open: async () => {
        await page.goto(`${ORIGIN}/course_work_record/index.html?workId=work-new`, {
          waitUntil: 'domcontentloaded',
        })
      },
      stopRequested: () => false,
    }), '旧记录卡无请求场景没有有限收口', 1_500)

    assert.equal(result.ok, false)
    assert.equal(result.failureKind, 'network')
    assert.match(result.error || '', /安全上限|接口/)
  } finally {
    await page.close()
    await browser.close()
  }
})
