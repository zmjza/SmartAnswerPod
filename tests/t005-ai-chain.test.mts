import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Page } from 'patchright'
import {
  answerNoqrGroup,
  saveNoqrAnswerAndAdvance,
} from '../electron/noqr/answer.ts'
import { NoqrAiClient } from '../electron/noqr/ai-client.ts'
import type { ReadOnlyBankClient } from '../electron/noqr/bank-readonly.ts'
import { NoqrMutationObserver } from '../electron/noqr/network.ts'
import { submitNoqrHomework } from '../electron/noqr/submit.ts'

function browserExecutable(): string | undefined {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  if (process.platform === 'darwin' && existsSync(cache)) {
    const revision = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1)
    if (revision) {
      const executable = join(cache, revision, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      if (existsSync(executable)) return executable
    }
  }
  return undefined
}

async function launchPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() })
  const page = await browser.newPage()
  return { page, close: () => browser.close() }
}

async function waitFor(check: () => boolean, message: string, timeout = 3_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

async function technicalTimeout<T>(task: Promise<T>, message: string, timeout = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function aiResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('T005-AI01 单个模型返回错误正文后必须继续下一模型', async () => {
  const calls: string[] = []
  const client = new NoqrAiClient({
    apiKey: () => 'fixture-key',
    models: ['first-model', 'second-model'],
    waitSlot: async () => undefined,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { model?: string }
      calls.push(body.model || '')
      return aiResponse(body.model === 'first-model'
        ? '{"option_texts":["不存在"]}'
        : '{"option_texts":["乙"]}')
    },
  })

  const result = await client.answerQuestion({
    qtype: 'single',
    stem: '合成降级题',
    options: ['甲', '乙'],
  })

  assert.deepEqual(calls, ['first-model', 'second-model'])
  assert.equal(result.failed, false)
  assert.deepEqual(result.texts, ['乙'])
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0]?.reason, 'option_mismatch')
})

test('T005-AI02 复合组失败缓存身份必须包含各子题正文', async () => {
  let calls = 0
  const client = new NoqrAiClient({
    apiKey: () => 'fixture-key',
    models: ['fixture-model'],
    waitSlot: async () => undefined,
    fetchImpl: async () => {
      calls++
      return aiResponse(calls === 1
        ? '{"option_texts":["1 :: 甲"]}'
        : '{"option_texts":["1 :: 甲","2 :: 乙"]}')
    },
  })
  const common = {
    shared: '同一共享材料',
    slots: [
      { id: '1', stem: '子题一', options: ['甲', '乙'] },
      { id: '2', stem: '子题二', options: ['甲', '乙'] },
    ],
  }

  const failed = await client.answerGroup(common)
  assert.equal(failed.selected, null)
  assert.equal(calls, 1)

  const changedStems = await client.answerGroup({
    ...common,
    slots: common.slots.map((slot, index) => ({
      ...slot,
      stem: index === 0 ? '另一道子题一' : '另一道子题二',
    })),
  })
  assert.equal(calls, 2)
  assert.deepEqual(changedStems.selected, { '1': '甲', '2': '乙' })
})

test('T005-AI03 停止信号会中止飞行中的 AI 请求且不再启动下一模型', async () => {
  let stopped = false
  let calls = 0
  let rejectPending: ((reason?: unknown) => void) | undefined
  const client = new NoqrAiClient({
    apiKey: () => 'fixture-key',
    models: ['first-model', 'second-model'],
    waitSlot: async () => undefined,
    fetchImpl: async (_url, init) => {
      calls++
      return await new Promise<Response>((_resolve, reject) => {
        rejectPending = reject
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    },
  })

  const pending = client.answerQuestion({
    qtype: 'single',
    stem: '合成停止题',
    options: ['甲', '乙'],
    stopRequested: () => stopped,
  })
  await waitFor(() => calls === 1 && Boolean(rejectPending), 'AI 请求没有开始')
  stopped = true
  const result = await pending

  assert.equal(result.failed, true)
  assert.equal(calls, 1)
})

test('T005-AI04 题库查询结束后检测到停止时不得启动 AI', async () => {
  const fixture = await launchPage()
  let stopped = false
  let aiCalls = 0
  try {
    await fixture.page.setContent(`
      <div id="submit-clicks">0</div>
      <div class="content-area">
        <div>单选题 1/10</div>
        <div class="question-info">
          <span class="question-title">合成停止题</span>
          <div class="question-options">
            <div role="radio" aria-checked="false" class="option-item" data-index="0">甲</div>
            <div role="radio" aria-checked="false" class="option-item" data-index="1">乙</div>
          </div>
        </div>
      </div>
    `)
    const bank = {
      getByHash: async () => {
        stopped = true
        return { ok: true, row: null }
      },
    } as unknown as ReadOnlyBankClient
    const ai = {
      answerQuestion: async () => {
        aiCalls++
        return { hash: 'fixture', texts: ['甲'], failed: false, attempts: [] }
      },
      answerGroup: async () => ({ selected: null, attempts: [] }),
      retryAsked: () => undefined,
    } as unknown as NoqrAiClient

    await assert.rejects(
      answerNoqrGroup({
        page: fixture.page,
        bank,
        ai,
        stopRequested: () => stopped,
      }),
      /任务已停止/,
    )
    assert.equal(aiCalls, 0)
  } finally {
    await fixture.close()
  }
})

test('T005-AI05 停止后保存流程不得再点击下一题', async () => {
  const fixture = await launchPage()
  try {
    await fixture.page.setContent(`
      <div class="content-area">
        <div>单选题 1/10</div>
        <div class="question-info"><span class="question-title">合成停止题</span></div>
        <button class="next-btn">下一题</button>
      </div>
    `)
    await fixture.page.locator('.next-btn').evaluate((node) => {
      const state = window as unknown as { __clicks: number }
      state.__clicks = 0
      node.addEventListener('click', () => { state.__clicks++ })
    })
    const observer = new NoqrMutationObserver(fixture.page)
    try {
      await assert.rejects(
        saveNoqrAnswerAndAdvance({
          page: fixture.page,
          observer,
          workId: 'work-fixture',
          group: {
            kind: 'single',
            title: '单选题',
            position: 1,
            total: 10,
            sharedStem: '',
            stem: '合成停止题',
            options: [],
            subQuestions: [],
            pickerValues: [],
            lastQuestion: false,
            units: [{
              id: 'u1',
              ordinal: 1,
              qtype: 'single',
              stem: '合成停止题',
              options: [],
            }],
          },
          answers: [],
          stopRequested: () => true,
        }),
        /任务已停止/,
      )
      assert.equal(await fixture.page.evaluate(() => (window as unknown as { __clicks: number }).__clicks), 0)
    } finally {
      observer.dispose()
    }
  } finally {
    await fixture.close()
  }
})

test('T005-AI06 停止发生在交卷前检查期间时不得再点击交卷', async () => {
  const fixture = await launchPage()
  let stopped = false
  try {
    await fixture.page.setContent(`
      <div class="content-area">
        <div class="question-info"><span class="question-title">合成题</span></div>
        <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
      </div>
    `)
    await fixture.page.evaluate(() => {
      const state = window as unknown as { __submitClicks: number }
      state.__submitClicks = 0
      document.querySelectorAll('.btn-item')[1]?.addEventListener('click', () => { state.__submitClicks++ })
    })
    const observer = new NoqrMutationObserver(fixture.page)
    try {
      const pending = submitNoqrHomework({
        page: fixture.page,
        workId: 'work-fixture',
        observer,
        stopRequested: () => stopped,
      })
      stopped = true
      await assert.rejects(pending, /任务已停止/)
      assert.equal(await fixture.page.evaluate(() => (window as unknown as { __submitClicks: number }).__submitClicks), 0)
    } finally {
      observer.dispose()
    }
  } finally {
    await fixture.close()
  }
})

test('T005-AI07 首次交卷点击未发出请求时状态化重试，成功后收口', async () => {
  const fixture = await launchPage()
  let finishRequests = 0
  try {
    await fixture.page.route('https://noqr.fixture.local/**', async (route) => {
      if (!route.request().url().endsWith('/FinishJsonAsync')) {
        await route.fulfill({ status: 404, body: 'not found' })
        return
      }
      finishRequests++
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, result: { status: 'success' } }),
      })
    })
    await fixture.page.setContent(`
      <base href="https://noqr.fixture.local/">
      <div id="submit-clicks">0</div>
      <div class="content-area">
        <div class="question-info"><span class="question-title">合成题</span></div>
        <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
      </div>
      <script>
        let clicks = 0
        const submit = document.querySelectorAll('.btn-item')[1]
        submit.addEventListener('click', async () => {
          clicks++
          document.querySelector('#submit-clicks').textContent = String(clicks)
          if (clicks < 2) return
          const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/FinishJsonAsync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workId: 'work-fixture',
              homeWorkUniqueFlag: 'homework-flag',
              paperStructUniqueFlag: 'paper-flag'
            })
          })
          if ((await response.json()).success) {
            submit.classList.add('disable-btn')
            const toast = document.createElement('div')
            toast.className = 'van-toast van-toast--success'
            toast.textContent = '交卷成功!'
            document.body.appendChild(toast)
          }
        })
      </script>
    `)
    const observer = new NoqrMutationObserver(fixture.page)
    try {
      const result = await Promise.race([
        submitNoqrHomework({
          page: fixture.page,
          workId: 'work-fixture',
          observer,
          stopRequested: () => false,
          noRequestRetryBudgetMs: 100,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('交卷无请求重试超时')), 8_000)),
      ])
      assert.equal(finishRequests, 1)
      assert.equal(await fixture.page.locator('#submit-clicks').innerText(), '2')
      assert.equal(result.ok, true)
      assert.equal(result.successToast, true)
      assert.equal(result.buttonDisabled, true)
    } finally {
      observer.dispose()
    }
  } finally {
    await fixture.close()
  }
})

test('T005-AI08 交卷请求已发出但网络失败时必须收口为结果不确定', async () => {
  const fixture = await launchPage()
  try {
    await fixture.page.route('https://noqr.fixture.local/**', async (route) => {
      if (route.request().url().endsWith('/FinishJsonAsync')) {
        await route.abort('connectionreset')
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await fixture.page.setContent(`
      <base href="https://noqr.fixture.local/">
      <div class="content-area">
        <div class="question-info"><span class="question-title">合成题</span></div>
        <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
      </div>
      <script>
        const submit = document.querySelectorAll('.btn-item')[1]
        submit.addEventListener('click', () => {
          void fetch('/dotNet_api/api/services/app/HomeWorkStudent/FinishJsonAsync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workId: 'work-fixture',
              homeWorkUniqueFlag: 'homework-flag',
              paperStructUniqueFlag: 'paper-flag'
            })
          }).catch(() => undefined)
        })
      </script>
    `)
    const observer = new NoqrMutationObserver(fixture.page)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page: fixture.page,
        workId: 'work-fixture',
        observer,
        stopRequested: () => false,
      }), '交卷网络失败没有收口')
      assert.equal(result.ok, false)
      assert.equal(result.uncertain, true)
      assert.equal(result.state, 'submitted_uncertain')
      assert.match(result.reason || '', /HTTP|业务|响应|网络|失败/)
    } finally {
      observer.dispose()
    }
  } finally {
    await fixture.close()
  }
})
