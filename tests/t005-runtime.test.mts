import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, type Browser, type Page, type Request, type Route } from 'patchright'
import {
  answerNoqrGroup,
  saveNoqrAnswerAndAdvance,
  selectionMismatchCode,
  selectionMismatchDetailCode,
  waitForNoqrAnswerReady,
} from '../electron/noqr/answer.ts'
import type { NoqrAiClient } from '../electron/noqr/ai-client.ts'
import type { ReadOnlyBankClient } from '../electron/noqr/bank-readonly.ts'
import { readNoqrHistoryAfterOpen, waitForNoqrHistoryDomMatch, type NoqrHistoryRecord } from '../electron/noqr/history.ts'
import { NoqrMutationObserver } from '../electron/noqr/network.ts'
import { detectNoqrAnswerPageInterruption, noqrFailurePolicy } from '../electron/noqr/page-policy.ts'
import { readNoqrQuestionGroup } from '../electron/noqr/question.ts'
import {
  auditNoqrAnswerCard,
  goToNoqrAnswerCardQuestion,
  noqrAnswerCardGroupKeys,
  noqrAnswerCardKey,
  submitNoqrHomework,
} from '../electron/noqr/submit.ts'
import { noqrPacingDelayMs } from '../electron/noqr/timing.ts'

const ORIGIN = 'https://noqr.fixture.local'
const ANSWER_URL = `${ORIGIN}/course_work_detail/index.html?workId=work-1&courseId=course-1&workType=onlineWork`

function browserExecutable(): string | undefined {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  if (process.platform === 'darwin' && existsSync(cache)) {
    const revisions = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1)
    if (revisions) {
      const executable = join(cache, revisions, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      if (existsSync(executable)) return executable
    }
  }
  return undefined
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, executablePath: browserExecutable() })
}

async function technicalTimeout<T>(task: Promise<T>, message: string, ms = 8_000): Promise<T> {
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

function jsonResponse(data: unknown): { status: number; contentType: string; body: string } {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  }
}

const successEnvelope = {
  result: { status: 'success', data: null, message: null },
  targetUrl: null,
  success: true,
  error: null,
  unAuthorizedRequest: false,
  __abp: true,
}

function htmlResponse(body: string): { status: number; contentType: string; body: string } {
  return { status: 200, contentType: 'text/html; charset=utf-8', body }
}

async function openAnswerPage(
  page: Page,
  html: string,
  routeHandler: (route: Route) => Promise<void> | void,
) {
  const interactiveHtml = html.includes('class="option-item"')
    ? `${html}<script>
      document.querySelectorAll('.question-options').forEach((options) => {
        options.querySelectorAll('.option-item').forEach((item) => item.addEventListener('click', () => {
          const role = item.getAttribute('role')
          if (role === 'radio') {
            options.querySelectorAll('[role="radio"]').forEach((peer) => peer.setAttribute('aria-checked', 'false'))
          }
          item.setAttribute('aria-checked', item.getAttribute('aria-checked') === 'true' ? 'false' : 'true')
        }))
      })
    </script>`
    : html
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/course_work_detail/index.html') {
      await route.fulfill(htmlResponse(interactiveHtml))
      return
    }
    await routeHandler(route)
  })
  await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
}

function optionHtml(text: string, index: number, role: 'radio' | 'checkbox', checked = false) {
  return `<div role="${role}" aria-checked="${checked}" class="option-item" data-index="${index}">
    <span class="van-${role === 'radio' ? 'radio' : 'checkbox'}__label">${text}</span>
  </div>`
}

function bankStub(answerTexts: string[], qtype = 'single'): ReadOnlyBankClient {
  return {
    getByHash: async () => ({
      ok: true,
      row: {
        id: 'fixture',
        qtype,
        stem: 'fixture',
        options: [],
        answer_texts: answerTexts,
        course_names: [],
      },
    }),
  } as unknown as ReadOnlyBankClient
}

function sequenceBankStub(answerTexts: string[], qtype = 'single'): ReadOnlyBankClient {
  let index = 0
  return {
    getByHash: async () => ({
      ok: true,
      row: {
        id: 'fixture',
        qtype,
        stem: 'fixture',
        options: [],
        answer_texts: [answerTexts[Math.min(index++, answerTexts.length - 1)] || ''],
        course_names: [],
      },
    }),
  } as unknown as ReadOnlyBankClient
}

function aiStub(texts: string[]): NoqrAiClient {
  return {
    answerQuestion: async () => ({ hash: 'fixture', texts, failed: false, attempts: [] }),
    answerGroup: async () => ({ selected: null, attempts: [], failedReason: 'not used' }),
    retryAsked: () => undefined,
  } as unknown as NoqrAiClient
}

test('T005-RT00 保存答案差异只输出安全分类，不泄露选项内容或具体答案', () => {
  assert.equal(selectionMismatchCode('1', '1'), '')
  assert.equal(selectionMismatchCode(' 1,2 ', '2,1'), 'selection_order_mismatch')
  assert.equal(selectionMismatchCode('1', '1,2'), 'selection_count_mismatch')
  assert.equal(selectionMismatchCode('1', '3'), 'selection_values_mismatch')
  assert.equal(selectionMismatchCode('0', '1'), 'selection_offset_plus_one')
  assert.equal(selectionMismatchCode('1', '0'), 'selection_offset_minus_one')
  assert.equal(selectionMismatchCode('1', 'A'), 'selection_format_mismatch')
  assert.equal(selectionMismatchDetailCode('1', '0'), 'selection_mismatch_expected_1_actual_0')
  assert.equal(selectionMismatchDetailCode('0', '-1'), 'selection_mismatch_expected_0_actual_minus1')
  assert.equal(selectionMismatchDetailCode('1', 'A'), 'selection_mismatch_expected_1_actual_format')
})

test('T005-RT00b 答题卡组键同时兼容合并题号和同题型独立大题', () => {
  const base = {
    sharedStem: 'shared',
    stem: 'stem',
    options: [],
    subQuestions: [],
    pickerValues: [],
    lastQuestion: false,
  }
  assert.deepEqual(noqrAnswerCardGroupKeys({
    ...base,
    kind: 'english_grammar',
    position: 3,
    total: 10,
    units: [],
  }), ['语法@1#3'])
  assert.deepEqual(noqrAnswerCardGroupKeys({
    ...base,
    kind: 'english_reading',
    position: 2,
    total: 2,
    units: [],
  }), ['阅读理解@1#2', '阅读理解@2#1'])
})

test('T005-RT01 普通单选、多选、判断题填写后按 aria-checked 精确读回', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const cases = [
      {
        label: '单选题',
        qtype: 'single' as const,
        role: 'radio' as const,
        body: `<span class="question-title">合成单选题干</span>
          <div class="question-options">
            ${optionHtml('A. 甲', 0, 'radio')}
            ${optionHtml('B. 乙', 1, 'radio')}
            ${optionHtml('C. 丙', 2, 'radio')}
          </div>`,
        selected: ['丙'],
        expected: [2],
        expectedAnswerSelected: '2',
      },
      {
        label: '多选题',
        qtype: 'multiple' as const,
        role: 'checkbox' as const,
        body: `<span class="question-title">合成多选题干</span>
          <div class="question-options">
            ${optionHtml('A. 甲', 0, 'checkbox')}
            ${optionHtml('B. 乙', 1, 'checkbox')}
            ${optionHtml('C. 丙', 2, 'checkbox')}
          </div>`,
        selected: ['乙', '甲'],
        expected: [0, 1],
        expectedAnswerSelected: '0,1',
      },
      {
        label: '判断题',
        qtype: 'judge' as const,
        role: 'radio' as const,
        body: `<span class="question-title">合成判断题干</span>
          <div class="question-options">
            ${optionHtml('A. 正确', 0, 'radio')}
            ${optionHtml('B. 错误', 1, 'radio')}
          </div>`,
        selected: ['错误'],
        expected: [1],
        expectedAnswerSelected: '0',
      },
    ]

    for (const current of cases) {
      await openAnswerPage(page, `<div class="content-area"><div>${current.label} 1/10</div><div class="question-info">${current.body}</div></div>`, async (route) => {
        await route.fulfill(jsonResponse([]))
      })
      const result = await answerNoqrGroup({
        page,
        bank: bankStub(current.selected, current.qtype),
        ai: aiStub([]),
        stopRequested: () => false,
      })
      assert.equal(result.answerSelected, current.expectedAnswerSelected)
      const checked = await page.locator('.option-item[aria-checked="true"]').evaluateAll((nodes) =>
        nodes.map((node) => Number(node.getAttribute('data-index'))).sort((a, b) => a - b))
      assert.deepEqual(checked, current.expected)
      await page.unroute(`${ORIGIN}/**`)
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT02 Picker 十槽按左侧行顺序写入并在确认后读回', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const rows = Array.from({ length: 10 }, (_, index) => `
      <div role="button" class="van-cell van-cell--clickable van-field" data-row="${index}">
        <div class="van-field__label"><span>左侧 ${index + 1}</span></div>
        <div class="van-field__value"><input type="text" name="picker" readonly value=""></div>
      </div>`).join('')
    const candidates = Array.from({ length: 10 }, (_, index) =>
      `<div class="van-picker-column__item" data-value="${index}">候选 ${index + 1}</div>`).join('')
    const html = `<div class="content-area"><div>词汇匹配 1/1</div><div class="question-info">
      <span class="question-title">合成词汇匹配</span>
      <div class="question-options"><div class="van-cell-group">${rows}</div></div>
    </div></div>
    <div class="van-picker" style="display:none">
      <div class="van-picker__columns">${candidates}</div>
      <button class="van-picker__cancel">取消</button>
      <button class="van-picker__confirm">确认</button>
    </div>
    <script>
      let activeRow = null
      let pendingValue = ''
      document.querySelectorAll('.van-field').forEach((row) => row.addEventListener('click', () => {
        activeRow = row
        pendingValue = row.querySelector('input').value
        document.querySelector('.van-picker').style.display = 'block'
      }))
      document.querySelectorAll('.van-picker-column__item').forEach((item) => item.addEventListener('click', () => {
        document.querySelectorAll('.van-picker-column__item').forEach((node) => node.classList.remove('van-picker-column__item--selected'))
        item.classList.add('van-picker-column__item--selected')
        pendingValue = item.textContent.trim()
      }))
      document.querySelector('.van-picker__confirm').addEventListener('click', () => {
        if (activeRow) activeRow.querySelector('input').value = pendingValue
        document.querySelector('.van-picker').style.display = 'none'
      })
      document.querySelector('.van-picker__cancel').addEventListener('click', () => {
        document.querySelector('.van-picker').style.display = 'none'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => route.fulfill(jsonResponse([])))
    const selected = Array.from({ length: 10 }, (_, index) => `候选 ${index + 1}`)
    const result = await answerNoqrGroup({
      page,
      bank: sequenceBankStub(selected),
      ai: aiStub([]),
      stopRequested: () => false,
    })
    assert.equal(result.answerSelected, Array.from({ length: 10 }, (_, index) => index).join(','))
    assert.deepEqual(await page.locator('input[name="picker"]').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLInputElement).value)), selected)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT02b 保存答案使用选项 DOM 位置，不把 data-index 当作请求索引', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>判断题 1/2</div><div class="question-info">
      <span class="question-title">合成判断题</span>
      <div class="question-options">
        ${optionHtml('A. 正确', 1, 'radio')}
        ${optionHtml('B. 错误', 0, 'radio')}
      </div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        const checked = document.querySelector('.option-item[aria-checked="true"]')
        const selected = (checked?.textContent || '').includes('正确') ? '1' : '0'
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workId: 'work-1', homeWorkUniqueFlag: 'flag-1', workType: 'onlineWork',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: selected, answerContent: '', useTime: 0 }
          })
        })
        if ((await response.json()).success) {
          document.querySelector('.content-area').innerHTML = '<div>单选题 2/2</div><div class="question-info"><span class="question-title">合成第二题</span></div>'
        }
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    assert.deepEqual(read.group.units[0]?.options.map((option) => option.index), [0, 1])
    const answered = await answerNoqrGroup({
      page,
      bank: bankStub(['正确'], 'judge'),
      ai: aiStub([]),
      stopRequested: () => false,
    })
    assert.equal(answered.answerSelected, '1')
    assert.equal(await page.locator('.option-item[aria-checked="true"]').evaluate((node) =>
      [...node.parentElement!.children].indexOf(node)), 0)
    const observer = new NoqrMutationObserver(page)
    try {
      const saved = await saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: answered.answers,
        stopRequested: () => false,
      })
      assert.equal(saved.saved, true)
      assert.equal(saved.advanced, true)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT03 保存只接受本次 L1 请求、L2 业务成功和 L3 页面推进', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成第一题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      let clicks = 0
      document.querySelector('.next-btn').addEventListener('click', async () => {
        clicks++
        window.__clicks = clicks
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workId: 'work-1', homeWorkUniqueFlag: 'flag-1', workType: 'onlineWork',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 }
          })
        })
        const data = await response.json()
        if (data.success) {
          document.querySelector('.content-area').innerHTML = '<div>单选题 2/2</div><div class="question-info"><span class="question-title">合成第二题</span></div>'
        }
      })
    </script>`
    let requests = 0
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        requests++
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    await answerNoqrGroup({
      page,
      bank: sequenceBankStub(['乙']),
      ai: aiStub([]),
      stopRequested: () => false,
    })
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{
          unitId: read.group.units[0].id,
          ordinal: 1,
          qtype: 'single',
          source: 'bank',
          texts: ['乙'],
          indices: [1],
          selectionValues: [1],
        }],
        stopRequested: () => false,
      })
      assert.equal(result.saved, true)
      assert.equal(result.advanced, true)
      assert.equal(result.uncertain, false)
      assert.equal(requests, 1)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT04 慢保存期间只点击一次，页面先变化但无请求不能通过', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    let releaseResponse!: () => void
    const gate = new Promise<void>((resolve) => { releaseResponse = resolve })
    let requests = 0
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成慢题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        window.__clicks = (window.__clicks || 0) + 1
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 } })
        })
        if ((await response.json()).success) {
          document.querySelector('.content-area').innerHTML = '<div>单选题 2/2</div><div class="question-info"><span class="question-title">下一题</span></div>'
        }
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        requests++
        await gate
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    await answerNoqrGroup({ page, bank: sequenceBankStub(['乙']), ai: aiStub([]), stopRequested: () => false })
    const observer = new NoqrMutationObserver(page)
    try {
      const waitingStates: string[] = []
      const pending = saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{ unitId: read.group.units[0].id, ordinal: 1, qtype: 'single', source: 'bank', texts: ['乙'], indices: [1], selectionValues: [1] }],
        stopRequested: () => false,
        onWaiting: (state) => waitingStates.push(state),
      })
      await page.waitForTimeout(650)
      assert.equal(requests, 1)
      assert.ok(waitingStates.some((state) => /等待保存响应/.test(state)), '慢响应期间没有持续显示等待状态')
      releaseResponse()
      const result = await technicalTimeout(pending, '慢保存没有结束')
      assert.equal(result.saved, true)
      assert.equal(result.advanced, true)
    } finally {
      observer.dispose()
    }

    await page.unroute(`${ORIGIN}/**`)
    const pageChangeOnly = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成无请求</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>document.querySelector('.next-btn').addEventListener('click', () => {
      document.querySelector('.question-title').textContent = '仅页面变化'
    })</script>`
    await openAnswerPage(page, pageChangeOnly, async (route) => route.fulfill(jsonResponse([])))
    const unconfirmed = await readNoqrQuestionGroup(page)
    assert.equal(unconfirmed.ok, true)
    if (!unconfirmed.ok) return
    let stopped = false
    setTimeout(() => { stopped = true }, 250)
    const observer2 = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(saveNoqrAnswerAndAdvance({
        page,
        observer: observer2,
        workId: 'work-1',
        group: unconfirmed.group,
        answers: [{ unitId: unconfirmed.group.units[0].id, ordinal: 1, qtype: 'single', source: 'bank', texts: ['甲'], indices: [0], selectionValues: [0] }],
        stopRequested: () => stopped,
      }), '无请求分支没有按停止收口')
      assert.equal(result.saved, false)
      assert.equal(result.state, 'unconfirmed_page_change')
    } finally {
      observer2.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT04b 首次点击未发出保存请求时状态化重试，发出后照常等待响应', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    let saveRequests = 0
    const html = `<div id="next-clicks">0</div><div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成重试题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      let clicks = 0
      document.querySelector('.next-btn').addEventListener('click', async () => {
        clicks++
        document.querySelector('#next-clicks').textContent = String(clicks)
        if (clicks < 2) return
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-retry',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 } })
        })
        if ((await response.json()).success) {
          document.querySelector('.content-area').innerHTML = '<div>单选题 2/2</div><div class="question-info"><span class="question-title">重试成功</span></div>'
        }
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        saveRequests++
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{ unitId: read.group.units[0].id, ordinal: 1, qtype: 'single', source: 'bank', texts: ['乙'], indices: [1], selectionValues: [1] }],
        stopRequested: () => false,
      }), '无请求后的状态化重试没有成功', 8_000)
      assert.equal(saveRequests, 1)
      assert.equal(await page.locator('#next-clicks').innerText(), '2')
      assert.equal(result.saved, true)
      assert.equal(result.state, 'ready')
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT04c 已出现保存请求但 workId 不匹配时不得重复点击', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div id="next-clicks">0</div><div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成错 workId 题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        document.querySelector('#next-clicks').textContent =
          String(Number(document.querySelector('#next-clicks').textContent) + 1)
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'different-work', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 } })
        })
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    const observer = new NoqrMutationObserver(page)
    try {
      await assert.rejects(
        technicalTimeout(saveNoqrAnswerAndAdvance({
          page,
          observer,
          workId: 'work-1',
          group: read.group,
          answers: [{
            unitId: read.group.units[0].id,
            ordinal: 1,
            qtype: 'single',
            source: 'bank',
            texts: ['乙'],
            indices: [1],
            selectionValues: [1],
          }],
          stopRequested: () => false,
        }), '错 workId 请求没有安全失败', 8_000),
        /workId/,
      )
      assert.equal(await page.locator('#next-clicks').innerText(), '1')
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT04d 保存请求事件先到但 body 暂时不可读时也必须登记并禁止重复点击', () => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const fakePage = {
    on(event: string, handler: (...args: unknown[]) => void) {
      const current = handlers.get(event) || []
      current.push(handler)
      handlers.set(event, current)
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, (handlers.get(event) || []).filter((item) => item !== handler))
    },
  }
  let bodyReadable = false
  const request = {
    method: () => 'POST',
    url: () => `${ORIGIN}/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync`,
    postDataJSON: () => {
      if (!bodyReadable) throw new Error('body not ready')
      return { workId: 'work-1', homeWorkUniqueFlag: 'flag-1' }
    },
    postData: () => bodyReadable
      ? JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1' })
      : '',
  }
  const observer = new NoqrMutationObserver(fakePage as never)
  try {
    for (const handler of handlers.get('request') || []) handler(request)
    assert.ok(observer.findRequestAfter({ after: 0, kinds: ['submit_one'] }))
    assert.equal(observer.findRequest({ after: 0, kinds: ['submit_one'], workId: 'work-1' }), null)
    bodyReadable = true
    assert.equal(
      observer.findRequest({ after: 0, kinds: ['submit_one'], workId: 'work-1' })?.body.homeWorkUniqueFlag,
      'flag-1',
    )
  } finally {
    observer.dispose()
  }
})

test('T005-RT05 最后一题保存成功依赖“已是最后一题”，Finish 必须同时出现成功文案和禁用按钮', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const lastHtml = `<div class="content-area"><div>单选题 2/2</div><div class="question-info">
      <span class="question-title">合成最后一题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-2', questionId: 'q-2', answerSelected: '0', answerContent: '', useTime: 0 } })
        })
        if ((await response.json()).success) {
          const toast = document.createElement('div')
          toast.className = 'van-toast van-toast--text'
          toast.textContent = '已是最后一题'
          document.body.appendChild(toast)
        }
      })
    </script>`
    await openAnswerPage(page, lastHtml, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    await answerNoqrGroup({ page, bank: sequenceBankStub(['甲']), ai: aiStub([]), stopRequested: () => false })
    const observer = new NoqrMutationObserver(page)
    try {
      const saved = await saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{ unitId: read.group.units[0].id, ordinal: 1, qtype: 'single', source: 'bank', texts: ['甲'], indices: [0], selectionValues: [0] }],
        stopRequested: () => false,
      })
      assert.equal(saved.lastQuestion, true)
      assert.equal(saved.advanced, true)
    } finally {
      observer.dispose()
    }

    await page.unroute(`${ORIGIN}/**`)
    const submitHtml = `<div class="content-area">
      <div class="question-info"><span class="question-title">最后一题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[1].addEventListener('click', async () => {
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/FinishJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', workType: 'onlineWork', homeWorkUniqueFlag: 'flag-1',
            paperStructUniqueFlag: 'paper-1', useTime: 0 })
        })
        if ((await response.json()).success) {
          const toast = document.createElement('div')
          toast.className = 'van-toast van-toast--success'
          toast.textContent = '交卷成功!'
          document.body.appendChild(toast)
          document.querySelectorAll('.btn-item')[1].classList.add('disable-btn')
        }
      })
    </script>`
    await openAnswerPage(page, submitHtml, async (route) => {
      if (route.request().url().endsWith('/FinishJsonAsync')) {
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const observer2 = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer: observer2,
        stopRequested: () => false,
      }), '交卷成功证据没有收口')
      assert.equal(result.ok, true)
      assert.equal(result.successToast, true)
      assert.equal(result.buttonDisabled, true)
      assert.equal(result.homeWorkUniqueFlag, 'flag-1')
      assert.equal(result.paperStructUniqueFlag, 'paper-1')
    } finally {
      observer2.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05a 最后一题提示缺失且解析区域刷新时按题号收口，不得重复保存当前题', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div style="display:none">单选题 1/10</div><div>单选题 25/25</div><div class="question-info">
      <span class="question-title">合成最后一题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button><span id="next-clicks">0</span></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        document.querySelector('#next-clicks').textContent = String(Number(document.querySelector('#next-clicks').textContent) + 1)
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-25', questionId: 'q-25', answerSelected: '0', answerContent: '', useTime: 0 } })
        })
        document.querySelector('.content-area').insertAdjacentHTML('beforeend', '<div class="analysis">试题解析</div>')
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    await answerNoqrGroup({ page, bank: sequenceBankStub(['甲']), ai: aiStub([]), stopRequested: () => false })
    const observer = new NoqrMutationObserver(page)
    let stopped = false
    try {
      const saved = await technicalTimeout(saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{ unitId: read.group.units[0].id, ordinal: read.group.units[0].ordinal, qtype: 'single', source: 'bank', texts: ['甲'], indices: [0], selectionValues: [0] }],
        stopRequested: () => stopped,
      }), '最后一题提示缺失后没有按题号收口', 3_000)
      assert.equal(saved.saved, true)
      assert.equal(saved.lastQuestion, true)
      assert.equal(await page.locator('#next-clicks').innerText(), '1')
    } finally {
      stopped = true
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05a2 大题局部题号结束但页面切到下一题型时不得当作整卷最后一题', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>单选题 10/10</div><div class="question-info">
      <span class="question-title">单选题最后一题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-10', questionId: 'q-10', answerSelected: '0', answerContent: '', useTime: 0 } })
        })
        await new Promise((resolve) => setTimeout(resolve, 150))
        document.querySelector('.content-area').innerHTML = '<div>多选题 1/10</div><div class="question-info">' +
          '<span class="question-title">多选题第一题</span><div class="question-options">' +
          ${JSON.stringify(`${optionHtml('A. 丙', 0, 'checkbox')}${optionHtml('B. 丁', 1, 'checkbox')}`)} +
          '</div></div>'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    await answerNoqrGroup({ page, bank: sequenceBankStub(['甲']), ai: aiStub([]), stopRequested: () => false })
    const observer = new NoqrMutationObserver(page)
    try {
      const saved = await technicalTimeout(saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{
          unitId: read.group.units[0].id,
          ordinal: read.group.units[0].ordinal,
          qtype: 'single',
          source: 'bank',
          texts: ['甲'],
          indices: [0],
          selectionValues: [0],
        }],
        stopRequested: () => false,
      }), '大题切换未被识别为页面推进', 3_000)
      assert.equal(saved.saved, true)
      assert.equal(saved.advanced, true)
      assert.equal(saved.lastQuestion, false)
      assert.match(await page.locator('.content-area').innerText(), /多选题\s*1\/10/)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05b 历史 DOM 等待不设固定轮数，慢页面更新超过旧上限仍可完成', async () => {
  let observations = 0
  const result = await waitForNoqrHistoryDomMatch({
    matches: (records) => records.length > 0,
    readDom: async () => {
      observations++
      return observations >= 250
        ? [{ finishedTime: '2026-11-01 12:00:00', score: 100, isMarked: true, status: '已批阅' }] satisfies NoqrHistoryRecord[]
        : []
    },
    stopRequested: () => false,
    sleep: async () => undefined,
  })

  assert.equal(result.ok, true)
  assert.equal(result.domRecords[0]?.score, 100)
  assert.equal(observations, 250)
})

test('T005-RT05c 作答记录页只有标题没有记录卡时会刷新恢复', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let recordLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/GetAnswerHistoryListJsonAsync')) {
        await route.fulfill(jsonResponse({
          result: {
            data: [{
              finishedTime: '2026-11-01 12:00:00',
              score: 100,
              isMarked: true,
              status: '已批阅',
              paperId: 'paper-1',
            }],
          },
        }))
        return
      }
      if (url.pathname === '/course_work_record/index.html') {
        recordLoads++
        const record = recordLoads > 1
          ? '<div class="record-item"><div class="record-info">完成时间: 2026-11-01 12:00:00</div><div class="record-info get-score"><span class="score-num">100</span></div></div>'
          : ''
        await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">作答记录</div></div>
          ${record}<script>fetch('/dotNet_api/api/services/app/HomeWorkStudent/GetAnswerHistoryListJsonAsync')</script>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    const history = await technicalTimeout(readNoqrHistoryAfterOpen({
      page,
      workId: 'work-1',
      refreshBudget: 3,
      open: async () => {
        await page.goto(`${ORIGIN}/course_work_record/index.html?workId=work-1`, { waitUntil: 'domcontentloaded' })
      },
      stopRequested: () => false,
    }), '标题型空白记录页没有刷新恢复')

    assert.equal(history.ok, true)
    assert.equal(history.latest?.score, 100)
    assert.ok(recordLoads >= 2, '记录页没有在标题型空白时刷新')
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05d 记录标题先出现但脚本未发请求时按预算刷新，不无限等待', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let recordLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/GetAnswerHistoryListJsonAsync')) {
        await route.fulfill(jsonResponse({
          result: {
            data: [{
              finishedTime: '2026-11-01 12:00:00',
              score: 100,
              isMarked: true,
              status: '已批阅',
              paperId: 'paper-1',
            }],
          },
        }))
        return
      }
      if (url.pathname === '/course_work_record/index.html') {
        recordLoads++
        const body = recordLoads >= 3
          ? `<div class="record-item"><div class="record-info">完成时间: 2026-11-01 12:00:00</div><div class="record-info get-score"><span class="score-num">100</span></div></div>
            <script>fetch('/dotNet_api/api/services/app/HomeWorkStudent/GetAnswerHistoryListJsonAsync')</script>`
          : ''
        await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">作答记录</div></div>${body}`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    const history = await technicalTimeout(readNoqrHistoryAfterOpen({
      page,
      workId: 'work-1',
      refreshBudget: 3,
      open: async () => {
        await page.goto(`${ORIGIN}/course_work_record/index.html?workId=work-1`, { waitUntil: 'domcontentloaded' })
      },
      stopRequested: () => false,
    }), '标题型空白且无 API 的记录页没有刷新恢复')

    assert.equal(history.ok, true)
    assert.equal(history.latest?.score, 100)
    assert.equal(recordLoads, 3)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05e 答题卡当前题只有 is-current 仍按未保存处理', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 1 大题: 单选题</div>
        <span class="sub-question is-current">1</span>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const missing = await auditNoqrAnswerCard(page, { stopRequested: () => false })
    assert.equal(missing.ok, false)
    assert.equal(missing.unanswered, 1)
    const proven = await auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      savedKeys: new Set([noqrAnswerCardKey('single', 1)]),
    })
    assert.equal(proven.ok, true)
    assert.equal(proven.unanswered, 0)
    await page.locator('.sub-question').evaluate((node) => node.classList.add('has-answered'))
    const answered = await auditNoqrAnswerCard(page, { stopRequested: () => false })
    assert.equal(answered.ok, true)
    assert.equal(answered.unanswered, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05f 答题卡必须等已保存键全部出现后才允许交卷', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 1 大题: 单选题</div>
        <span class="sub-question has-answered">1</span>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
        setTimeout(() => {
          document.querySelector('.question-card').insertAdjacentHTML('beforeend',
            '<span class="sub-question has-answered">2</span>')
        }, 250)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      expectedKeys: new Set([
        noqrAnswerCardKey('single', 1),
        noqrAnswerCardKey('single', 2),
      ]),
    }), '答题卡没有等待完整题号加载')
    assert.equal(audit.ok, true)
    assert.equal(audit.answered, 2)
    assert.equal(audit.unanswered, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05f2 同题型多个大题必须用组身份隔离，不能复用第一组保存键', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 5 大题: 阅读理解</div>
        <span class="sub-question has-answered">1</span>
        <span class="sub-question has-answered">2</span>
      </div>
      <div class="question-card"><div class="question-cart-title">第 6 大题: 阅读理解</div>
        <span class="sub-question">1</span>
        <span class="sub-question">2</span>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const firstOne = noqrAnswerCardKey('english_reading', 1, 1)
    const firstTwo = noqrAnswerCardKey('english_reading', 2, 1)
    const secondOne = noqrAnswerCardKey('english_reading', 1, 2)
    const secondTwo = noqrAnswerCardKey('english_reading', 2, 2)
    const audit = await auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      savedKeys: new Set([firstOne, firstTwo]),
      expectedKeys: new Set([firstOne, firstTwo, secondOne, secondTwo]),
      noProgressBudgetMs: 100,
      maxReopens: 1,
    })
    assert.equal(audit.ok, false)
    assert.equal(audit.unanswered, 2)
    assert.deepEqual(audit.missingKeys.sort(), [secondOne, secondTwo].sort())
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05f3 合并题号的同题型大题按逻辑题位总数等待，不要求拆成多个答题卡组', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 5 大题: 阅读理解</div>
        ${Array.from({ length: 10 }, (_, index) =>
          `<span class="sub-question${index < 5 ? ' has-answered' : ''}">${index + 1}</span>`).join('')}
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const saved = new Set(Array.from({ length: 5 }, (_, index) =>
      noqrAnswerCardKey('english_reading', index + 1, 1)))
    const audit = await auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      savedKeys: saved,
      expectedCount: 10,
      noProgressBudgetMs: 100,
      maxReopens: 1,
    })
    assert.equal(audit.ok, false)
    assert.equal(audit.unanswered, 5)
    assert.deepEqual(
      audit.missingKeys,
      Array.from({ length: 5 }, (_, index) => noqrAnswerCardKey('english_reading', index + 6, 1)),
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05g 答题卡漏题可回跳对应题号补答', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="position">单选题 1/10</div>
      <div class="question-info"><span class="question-title">第一题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 1 大题: 单选题</div>
        <span class="sub-question has-answered">1</span>
        <span class="sub-question">2</span>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
        document.querySelectorAll('.sub-question')[1].addEventListener('click', () => {
          document.querySelector('.question-title').textContent = '第二题'
          document.querySelector('.position').textContent = '单选题 2/10'
          document.querySelector('.van-popup').style.display = 'none'
        })
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await goToNoqrAnswerCardQuestion(
      page,
      '第 1 大题: 单选题#2',
      () => false,
    )
    assert.equal(await page.locator('.question-title').innerText(), '第二题')
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05g2 答题卡点击后未到达目标题号时必须失败，不能重复作答原题', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div>单选题 1/10</div>
      <div class="question-info"><span class="question-title">第一题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 1 大题: 单选题</div>
        <span class="sub-question has-answered">1</span>
        <span class="sub-question">2</span>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
        document.querySelectorAll('.sub-question')[1].addEventListener('click', () => {
          document.querySelector('.van-popup').style.display = 'none'
        })
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await assert.rejects(
      goToNoqrAnswerCardQuestion(
        page,
        '第 1 大题: 单选题#2',
        () => false,
        { verifyBudgetMs: 100 },
      ),
      /未到达目标题/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05g3 复合题跳转必须命中指定同题型大题，不能只凭题型名通过', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div>阅读理解 1/2</div>
      <div class="question-info"><span class="question-title">第一篇材料</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 5 大题: 阅读理解</div>
        <span class="sub-question has-answered">1</span>
        <span class="sub-question has-answered">2</span>
      </div>
      <div class="question-card"><div class="question-cart-title">第 6 大题: 阅读理解</div>
        <span class="sub-question">1</span>
        <span class="sub-question">2</span>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
        document.querySelectorAll('.question-card')[1]
          .querySelectorAll('.sub-question')[1]
          .addEventListener('click', () => {
            document.querySelector('.van-popup').style.display = 'none'
          })
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await assert.rejects(
      goToNoqrAnswerCardQuestion(
        page,
        noqrAnswerCardKey('english_reading', 2, 2),
        () => false,
        { verifyBudgetMs: 100 },
      ),
      /未到达目标题/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05h 答题卡空壳无进展时关闭重开，达到完整结构后继续', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div id="card-opens">0</div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 1 大题: 语法</div>
        <div id="answer-card-items"></div>
      </div>
    </div>
    <script>
      let cardOpens = 0
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        cardOpens++
        document.querySelector('#card-opens').textContent = String(cardOpens)
        const popup = document.querySelector('.van-popup')
        popup.style.display = 'block'
        if (cardOpens >= 2) {
          document.querySelector('#answer-card-items').innerHTML = '<span class="sub-question has-answered">1</span>'
        }
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      savedKeys: new Set(['语法#1']),
      expectedKeys: new Set(['语法#1']),
      noProgressBudgetMs: 60,
      maxReopens: 2,
    }), '空答题卡没有在恢复预算内重开')
    assert.equal(audit.ok, true)
    assert.equal(audit.answered, 1)
    assert.equal(await page.locator('#card-opens').innerText(), '2')
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT10 答题启动页延迟出现骨架时不得被误判为连续空白', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <script>
        setTimeout(() => {
          document.querySelector('.content-area').insertAdjacentHTML('beforeend',
            '<div class="skeleton-area van-skeleton" style="display:block;width:240px;height:80px"></div>')
        }, 500)
        setTimeout(() => {
          document.querySelector('.skeleton-area').outerHTML =
            '<div class="question-info"><span class="question-title">骨架完成</span></div>'
        }, 900)
      </script>
    </div>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    let reentries = 0
    await technicalTimeout(waitForNoqrAnswerReady({
      page,
      stopRequested: () => false,
      reenter: async () => { reentries++ },
      blankSettleMs: 700,
      skeletonBudgetMs: 800,
    }), '骨架页没有继续等待')
    assert.equal(reentries, 0)
    assert.equal(await page.locator('.question-title').innerText(), '骨架完成')
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT10b 持续骨架且无活动请求时按重进预算收口', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await openAnswerPage(page, `<div class="content-area">
      <div class="skeleton-area van-skeleton" style="display:block;width:240px;height:80px"></div>
    </div>`, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    let reentries = 0
    await assert.rejects(
      technicalTimeout(waitForNoqrAnswerReady({
        page,
        stopRequested: () => false,
        reenter: async () => { reentries++ },
        maxReentries: 1,
        skeletonBudgetMs: 120,
      }), '持续骨架没有在有限时间内收口', 2_000),
      /答题启动页连续空白/,
    )
    assert.equal(reentries, 1)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT11 已进入答题页后标题型白屏保留页面并进入需人工处理状态', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let answerLoads = 0
  try {
    await openAnswerPage(page, `<div class="content-area">
      <div class="question-info"><span class="question-title">已显示题目</span></div>
    </div>`, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/course_work_detail/index.html') answerLoads++
    })
    await page.evaluate(() => {
      document.body.innerHTML = '<div class="van-nav-bar__title">答题页异常</div>'
    })
    const interruption = await detectNoqrAnswerPageInterruption(page)
    assert.equal(interruption?.code, 'answer_interrupted')
    assert.deepEqual(noqrFailurePolicy(interruption), {
      status: 'answer_page_interrupted',
      phase: 'needs_user',
      preservePage: true,
    })
    assert.equal(new URL(page.url()).href, ANSWER_URL)
    assert.equal(answerLoads, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT06 漏题弹窗只取消，补答后才允许 Finish；历史按完成时间取分', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    let finishRequests = 0
    const dialogHtml = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      const submit = document.querySelectorAll('.btn-item')[1]
      submit.addEventListener('click', async () => {
        document.body.insertAdjacentHTML('beforeend', '<div class="van-dialog" role="dialog"><div>提示</div><div>还有问题未完成作答, 确认交卷</div><button class="van-dialog__cancel">取消</button><button class="van-dialog__confirm">确认</button></div>')
        document.querySelector('.van-dialog__cancel').addEventListener('click', () => {
          document.querySelector('.van-dialog').remove()
        })
        document.querySelector('.van-dialog__confirm').addEventListener('click', () => {
          window.__badConfirm = true
          document.querySelector('.van-dialog').remove()
        })
      })
    </script>`
    await openAnswerPage(page, dialogHtml, async (route) => {
      if (route.request().url().endsWith('/FinishJsonAsync')) finishRequests++
      await route.fulfill(jsonResponse(successEnvelope))
    })
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer,
        stopRequested: () => false,
      }), '漏题弹窗没有取消')
      assert.equal(result.ok, false)
      assert.equal(result.incomplete, true)
      assert.equal(result.state, 'incomplete')
      assert.match(result.reason || '', /未完成题目/)
      assert.equal(finishRequests, 0)
      assert.equal(await page.evaluate(() => Boolean((window as unknown as { __badConfirm?: boolean }).__badConfirm)), false)

      await page.evaluate(() => {
        const content = document.querySelector('.content-area')
        if (!content) throw new Error('缺少补答后的答题区域')
        content.innerHTML = `
          <div class="question-info"><span class="question-title">补答完成</span></div>
          <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>`
        const submit = content.querySelectorAll('.btn-item')[1] as HTMLButtonElement
        submit.addEventListener('click', async () => {
          const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/FinishJsonAsync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workId: 'work-1',
              workType: 'onlineWork',
              homeWorkUniqueFlag: 'flag-1',
              paperStructUniqueFlag: 'paper-1',
              useTime: 0,
            }),
          })
          if ((await response.json()).success) {
            submit.classList.add('disable-btn')
            const toast = document.createElement('div')
            toast.className = 'van-toast van-toast--success'
            toast.textContent = '交卷成功!'
            document.body.appendChild(toast)
          }
        })
      })
      const supplemented = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer,
        stopRequested: () => false,
      }), '补答后的交卷没有完成')
      assert.equal(supplemented.ok, true, JSON.stringify(supplemented))
      assert.equal(supplemented.state, 'ready')
      assert.equal(supplemented.successToast, true)
      assert.equal(supplemented.buttonDisabled, true)
      assert.equal(finishRequests, 1)
      assert.equal(await page.evaluate(() => Boolean((window as unknown as { __badConfirm?: boolean }).__badConfirm)), false)
    } finally {
      observer.dispose()
    }

    await page.unroute(`${ORIGIN}/**`)
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/GetAnswerHistoryListJsonAsync')) {
        await route.fulfill(jsonResponse({
          result: {
            data: [
              { finishedTime: '2026-10-12 20:49:10', score: 97, isMarked: true, status: '已批阅', paperId: 'p1' },
              { finishedTime: '2026/10/12 20:52:16', score: 100, isMarked: true, status: '已批阅', paperId: 'p2' },
              { finishedTime: '2026-11-01 03:30:58', score: 3, isMarked: true, status: '未完成提交', paperId: 'p3' },
            ],
          },
        }))
        return
      }
      await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">作答记录</div></div>
        <div class="record-item"><div class="record-info">完成时间: 2026-10-12 20:52:16</div><div class="record-info get-score"><span class="score-num">100</span></div></div>
        <div class="record-item"><div class="record-info">完成时间: 2026-10-12 20:49:10</div><div class="record-info get-score"><span class="score-num">97</span></div></div>
        <script>fetch('/dotNet_api/api/services/app/HomeWorkStudent/GetAnswerHistoryListJsonAsync')</script>`))
    })
    const history = await technicalTimeout(readNoqrHistoryAfterOpen({
      page,
      open: async () => { await page.goto(`${ORIGIN}/course_work_record/index.html?workId=work-1`, { waitUntil: 'domcontentloaded' }) },
      stopRequested: () => false,
    }), '历史记录读取没有收口')
    assert.equal(history.ok, true)
    assert.equal(history.latest?.score, 100)
    assert.equal(history.apiCount, 2)
    assert.equal(history.domCount, 2)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT07 复合阅读题缺库时独立 AI 整组补齐，听力缺库必须零 AI 零保存', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const readingSubs = Array.from({ length: 5 }, (_, index) => `
      <div class="sub-item">
        <span class="question-title">陈述 ${index + 1}</span>
        <div class="question-options">
          ${optionHtml('A. 正确', 0, 'radio')}
          ${optionHtml('B. 错误', 1, 'radio')}
        </div>
      </div>`).join('')
    const readingHtml = `<div class="content-area"><div>阅读理解 1/2</div>
      <div class="question-info">
        <span class="question-title">合成阅读材料</span>
        <div class="sub-questions">${readingSubs}</div>
      </div>
    </div>`
    await openAnswerPage(page, readingHtml, async (route) => route.fulfill(jsonResponse([])))
    let groupCalls = 0
    const aiGroup = {
      answerQuestion: async () => ({ hash: 'unused', texts: null, failed: true, attempts: [] }),
      answerGroup: async (opts: { slots: Array<{ id: string; options: string[] }> }) => {
        groupCalls++
        return {
          selected: Object.fromEntries(opts.slots.map((slot) => [slot.id, slot.options[0]])),
          attempts: [],
        }
      },
      retryAsked: () => undefined,
    } as unknown as NoqrAiClient
    const reading = await answerNoqrGroup({
      page,
      bank: { getByHash: async () => ({ ok: true, row: null }) } as unknown as ReadOnlyBankClient,
      ai: aiGroup,
      stopRequested: () => false,
    })
    assert.equal(groupCalls, 1)
    assert.equal(reading.answerSelected, '1,1,1,1,1')
    assert.equal(await page.locator('.option-item[aria-checked="true"]').count(), 5)

    await page.unroute(`${ORIGIN}/**`)
    const listeningSubs = Array.from({ length: 5 }, (_, index) => `
      <div class="sub-item">
        <span class="question-title">听力子题 ${index + 1}</span>
        <div class="question-options">
          ${optionHtml('A. 甲', 0, 'radio')}
          ${optionHtml('B. 乙', 1, 'radio')}
        </div>
      </div>`).join('')
    const listeningHtml = `<div class="content-area"><div>听力理解 1/1</div>
      <div class="question-info">
        <span class="question-title">合成听力材料 <a data-url="/fixture-audio.mp3">播放</a></span>
        <div class="sub-questions">${listeningSubs}</div>
      </div>
    </div>`
    await openAnswerPage(page, listeningHtml, async (route) => route.fulfill(jsonResponse([])))
    let bankCursor = 0
    let listeningAiCalls = 0
    await assert.rejects(answerNoqrGroup({
      page,
      bank: {
        getByHash: async () => {
          bankCursor++
          return bankCursor <= 4
            ? { ok: true, row: {
                id: `fixture-${bankCursor}`, qtype: 'single', stem: 'fixture', options: [],
                answer_texts: ['甲'], course_names: [],
              } }
            : { ok: true, row: null }
        },
      } as unknown as ReadOnlyBankClient,
      ai: {
        answerQuestion: async () => ({ hash: 'unused', texts: null, failed: true, attempts: [] }),
        answerGroup: async () => {
          listeningAiCalls++
          return { selected: null, attempts: [], failedReason: 'must not call' }
        },
        retryAsked: () => undefined,
      } as unknown as NoqrAiClient,
      stopRequested: () => false,
    }), /听力题库缺少/)
    assert.equal(listeningAiCalls, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT08 HTTP 失败与业务失败都不能推进页面或宣称保存成功', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成失败题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 } })
        })
        const data = await response.json().catch(() => null)
        if (data && data.success) document.querySelector('.question-title').textContent = '不应出现'
      })
    </script>`
    for (const failure of [
      { name: 'HTTP 500', response: { status: 500, contentType: 'application/json', body: '{}' } },
      { name: '业务失败', response: jsonResponse({ success: false, result: { status: 'error' } }) },
    ]) {
      await openAnswerPage(page, html, async (route) => {
        if (route.request().url().endsWith('/SubmitJsonAsync')) {
          await route.fulfill(failure.response)
          return
        }
        await route.fulfill({ status: 404, body: 'not found' })
      })
      const read = await readNoqrQuestionGroup(page)
      assert.equal(read.ok, true)
      if (!read.ok) return
      await answerNoqrGroup({ page, bank: sequenceBankStub(['乙']), ai: aiStub([]), stopRequested: () => false })
      const observer = new NoqrMutationObserver(page)
      try {
        await assert.rejects(saveNoqrAnswerAndAdvance({
          page,
          observer,
          workId: 'work-1',
          group: read.group,
          answers: [{ unitId: read.group.units[0].id, ordinal: 1, qtype: 'single', source: 'bank', texts: ['乙'], indices: [1], selectionValues: [1] }],
          stopRequested: () => false,
        }), undefined, failure.name)
        assert.notEqual(await page.locator('.question-title').innerText(), '不应出现', `${failure.name} 被误判为成功`)
      } finally {
        observer.dispose()
      }
      await page.unroute(`${ORIGIN}/**`)
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT08a 保存请求已发出但网络失败时必须收口为结果不确定', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成断网题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 } })
        }).catch(() => undefined)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        await route.abort('connectionreset')
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{
          unitId: read.group.units[0].id,
          ordinal: 1,
          qtype: 'single',
          source: 'bank',
          texts: ['乙'],
          indices: [1],
          selectionValues: [1],
        }],
        stopRequested: () => false,
      }), '网络失败没有收口')
      assert.equal(result.saved, false)
      assert.equal(result.uncertain, true)
      assert.equal(result.state, 'submitted_uncertain')
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT08b 保存端点必须与题型契约一致，错误端点不得继续', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const subItems = Array.from({ length: 5 }, (_, index) => `
      <div class="sub-item">
        <span class="question-title">陈述 ${index + 1}</span>
        <div class="question-options">${optionHtml('A. 正确', 0, 'radio')}${optionHtml('B. 错误', 1, 'radio')}</div>
      </div>`).join('')
    const html = `<div class="content-area"><div>阅读理解 1/2</div><div class="question-info">
      <span class="question-title">合成共享材料</span>
      <div class="sub-questions">${subItems}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '0,0,0,0,0', answerContent: '', useTime: 0 }
          })
        })
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    const answers = read.group.units.map((unit) => ({
      unitId: unit.id,
      ordinal: unit.ordinal,
      qtype: unit.qtype,
      source: 'bank' as const,
      texts: ['正确'],
      indices: [0],
      selectionValues: [0],
    }))
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers,
        stopRequested: () => false,
      }), '错误保存端点没有收口')
      assert.equal(result.saved, false)
      assert.equal(result.uncertain, true)
      assert.equal(result.state, 'unexpected_endpoint')
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT09 停止发生在保存请求飞行中时仍不继续点击，并收口为已保存但不可推进', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    let releaseResponse!: () => void
    const gate = new Promise<void>((resolve) => { releaseResponse = resolve })
    let requests = 0
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成停止题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 } })
        })
        if ((await response.json()).success) document.querySelector('.question-title').textContent = '保存后推进'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        requests++
        await gate
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    await answerNoqrGroup({ page, bank: sequenceBankStub(['乙']), ai: aiStub([]), stopRequested: () => false })
    let stopped = false
    const observer = new NoqrMutationObserver(page)
    try {
      const pending = saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{ unitId: read.group.units[0].id, ordinal: 1, qtype: 'single', source: 'bank', texts: ['乙'], indices: [1], selectionValues: [1] }],
        stopRequested: () => stopped,
      })
      for (let poll = 0; poll < 100 && requests === 0; poll++) await page.waitForTimeout(20)
      stopped = true
      releaseResponse()
      const result = await technicalTimeout(pending, '停止中的保存请求没有收口')
      assert.equal(result.saved, true)
      assert.equal(result.advanced, false)
      assert.equal(result.uncertain, false)
      assert.equal(requests, 1)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT12 awaiting_advance 与等待保存响应使用独立可观察时间线', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>单选题 1/10</div><div class="question-info">
      <span class="question-title">合成待推进题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button><span id="clicks">0</span></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        const clicks = document.querySelector('#clicks')
        clicks.textContent = String(Number(clicks.textContent) + 1)
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 }
          })
        })
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    await answerNoqrGroup({ page, bank: sequenceBankStub(['乙']), ai: aiStub([]), stopRequested: () => false })

    let stopped = false
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    let advanceStopTimer: ReturnType<typeof setTimeout> | undefined
    const waitingStates: string[] = []
    const observer = new NoqrMutationObserver(page)
    try {
      fallbackTimer = setTimeout(() => { stopped = true }, 3_000)
      const startedAt = Date.now()
      const result = await technicalTimeout(saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{
          unitId: read.group.units[0].id,
          ordinal: 1,
          qtype: 'single',
          source: 'bank',
          texts: ['乙'],
          indices: [1],
          selectionValues: [1],
        }],
        stopRequested: () => stopped,
        onWaiting: (state) => {
          waitingStates.push(state)
          if (state === '等待页面推进' && !advanceStopTimer) {
            advanceStopTimer = setTimeout(() => { stopped = true }, 300)
          }
        },
      }), '待推进独立时间线没有按停止收口')
      const elapsedMs = Date.now() - startedAt

      assert.equal(result.saved, true)
      assert.equal(result.advanced, false)
      assert.equal(result.uncertain, false)
      assert.equal(result.state, 'awaiting_advance')
      assert.ok(waitingStates.includes('等待保存响应'), '未观察到保存响应等待阶段')
      assert.ok(waitingStates.includes('等待页面推进'), '响应成功后未进入独立页面推进等待阶段')
      assert.ok(elapsedMs >= 550, `页面推进等待过早结束：${elapsedMs}ms`)
      assert.ok(elapsedMs < 2_000, `页面推进等待未及时响应停止：${elapsedMs}ms`)
      assert.equal(await page.locator('#clicks').innerText(), '1')
    } finally {
      if (fallbackTimer) clearTimeout(fallbackTimer)
      if (advanceStopTimer) clearTimeout(advanceStopTimer)
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT13 实际慢保存超过三秒后不再叠加三秒节奏', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成慢保存节奏题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 }
          })
        })
        if ((await response.json()).success) {
          document.querySelector('.content-area').innerHTML =
            '<div>单选题 2/2</div><div class="question-info"><span class="question-title">下一题</span></div>'
        }
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitJsonAsync')) {
        await new Promise((resolve) => setTimeout(resolve, 3_250))
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return
    await answerNoqrGroup({ page, bank: sequenceBankStub(['乙']), ai: aiStub([]), stopRequested: () => false })

    const observer = new NoqrMutationObserver(page)
    try {
      const startedAt = Date.now()
      const result = await technicalTimeout(saveNoqrAnswerAndAdvance({
        page,
        observer,
        workId: 'work-1',
        group: read.group,
        answers: [{
          unitId: read.group.units[0].id,
          ordinal: 1,
          qtype: 'single',
          source: 'bank',
          texts: ['乙'],
          indices: [1],
          selectionValues: [1],
        }],
        stopRequested: () => false,
      }), '慢保存节奏场景没有完成', 8_000)
      const elapsedMs = Date.now() - startedAt
      assert.equal(result.saved, true)
      assert.equal(noqrPacingDelayMs(elapsedMs, 1), 0)
      assert.ok(elapsedMs >= 3_250, `慢保存耗时没有进入样本：${elapsedMs}ms`)
      assert.ok(elapsedMs < 5_500, `慢保存后疑似额外追加节奏：${elapsedMs}ms`)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14 Finish HTTP 失败即使页面误显示成功也必须安全失败', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      const submit = document.querySelectorAll('.btn-item')[1]
      submit.addEventListener('click', async () => {
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/FinishJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workId: 'work-1', workType: 'onlineWork', homeWorkUniqueFlag: 'flag-1',
            paperStructUniqueFlag: 'paper-1', useTime: 0
          })
        })
        submit.classList.add('disable-btn')
        const toast = document.createElement('div')
        toast.className = 'van-toast van-toast--success'
        toast.textContent = '交卷成功!'
        document.body.appendChild(toast)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/FinishJsonAsync')) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, result: { status: 'error' } }),
        })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer,
        stopRequested: () => false,
      }), 'Finish HTTP 失败没有安全收口')
      assert.equal(result.ok, false)
      assert.equal(result.state, 'failed')
      assert.equal(result.uncertain, false)
      assert.match(result.reason || '', /HTTP|业务/)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14b Finish 成功响应缺唯一标记时必须收口为结果不确定', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      const submit = document.querySelectorAll('.btn-item')[1]
      submit.addEventListener('click', async () => {
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/FinishJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', workType: 'onlineWork', useTime: 0 })
        })
        submit.classList.add('disable-btn')
        const toast = document.createElement('div')
        toast.className = 'van-toast van-toast--success'
        toast.textContent = '交卷成功!'
        document.body.appendChild(toast)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/FinishJsonAsync')) {
        await route.fulfill(jsonResponse(successEnvelope))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer,
        stopRequested: () => false,
      }), 'Finish 缺唯一标记没有安全收口')
      assert.equal(result.ok, false)
      assert.equal(result.state, 'submitted_uncertain')
      assert.equal(result.uncertain, true)
      assert.match(result.reason || '', /唯一标记/)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT15 已发出的保存请求在停止后必须有限收口为结果不确定', async () => {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const page = {
    on(event: string, listener: (value: unknown) => void) {
      const current = listeners.get(event) || new Set()
      current.add(listener)
      listeners.set(event, current)
    },
    off(event: string, listener: (value: unknown) => void) {
      listeners.get(event)?.delete(listener)
    },
  } as unknown as Page
  const emit = (event: string, value: unknown) => {
    for (const listener of listeners.get(event) || []) listener(value)
  }
  const request = {
    method: () => 'POST',
    url: () => `${ORIGIN}/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync`,
    postDataJSON: () => ({
      workId: 'work-1',
      homeWorkUniqueFlag: 'flag-1',
      answer: {
        bigQuestionId: 'bg-1',
        questionId: 'q-1',
        answerSelected: '1',
        answerContent: '',
        useTime: 0,
      },
    }),
    postData: () => '',
  } as unknown as Request

  const observer = new NoqrMutationObserver(page)
  let stopped = false
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  try {
    emit('request', request)
    const observed = observer.findRequestAfter({ after: 0, kinds: ['submit_one'] })
    assert.ok(observed, '未观察到已发出的保存请求')
    stopTimer = setTimeout(() => { stopped = true }, 40)
    const startedAt = Date.now()
    const result = await technicalTimeout(observer.waitForResult(observed, {
      stopRequested: () => stopped,
    }), '停止后未结束的保存请求没有有限收口', 1_500)
    const elapsedMs = Date.now() - startedAt

    assert.equal(result.stopped, true)
    assert.match(result.requestError || '', /停止.*不确定/)
    assert.ok(elapsedMs >= 40, `停止信号尚未生效：${elapsedMs}ms`)
    assert.ok(elapsedMs < 1_000, `停止后等待过久：${elapsedMs}ms`)
  } finally {
    if (stopTimer) clearTimeout(stopTimer)
    observer.dispose()
  }
})
