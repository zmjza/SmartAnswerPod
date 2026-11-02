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
  answerCardSectionFromTitle,
  goToNoqrAnswerCardQuestion,
  noqrAnswerCardGroupKeys,
  noqrAnswerCardExpectedGroups,
  noqrAnswerCardExpectedSlots,
  noqrAnswerCardExpectedKeyGroups,
  noqrAnswerCardKey,
  returnToNoqrCourseWork,
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

test('T005-RT00c 答题卡真实题型标题别名归一为标准组键', () => {
  assert.equal(answerCardSectionFromTitle('第 2 大题: 多项选择题'), '多选题')
  assert.equal(answerCardSectionFromTitle('第 1 大题: 单项选择题'), '单选题')
  assert.equal(answerCardSectionFromTitle('第 3 大题: 完型填空'), '完型填空')
  assert.equal(answerCardSectionFromTitle('第 3 大题: 完形填空'), '完型填空')
  assert.equal(answerCardSectionFromTitle('第 4 大题: 未知题型'), '')
})

test('T005-RT00d 复合题答题卡接受父题、局部题号和合并题号三种结构', () => {
  const group = {
    kind: 'english_listening' as const,
    sharedStem: '',
    units: Array.from({ length: 5 }, (_, index) => ({
      id: String(index + 1),
      ordinal: index + 1,
      qtype: 'single' as const,
      stem: '',
      options: [],
    })),
    position: 3,
    total: 10,
  }
  const groups = noqrAnswerCardExpectedKeyGroups(group)
  assert.ok(groups.some((keys) => keys.length === 1 && keys[0] === '听力理解@1#3'))
  assert.ok(groups.some((keys) => keys.join('|') === [
    '听力理解@3#1', '听力理解@3#2', '听力理解@3#3', '听力理解@3#4', '听力理解@3#5',
  ].join('|')))
  assert.ok(groups.some((keys) => keys.join('|') === [
    '听力理解@1#11', '听力理解@1#12', '听力理解@1#13', '听力理解@1#14', '听力理解@1#15',
  ].join('|')))
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
      assert.ok(Number(saved.requestStartedAt) > 0)
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
        noRequestRetryBudgetMs: 100,
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
        noRequestRetryBudgetMs: 300,
      }), '错 workId 请求没有安全失败', 3_000)
      assert.equal(result.saved, false)
      assert.equal(result.uncertain, true)
      assert.equal(result.state, 'submitted_uncertain')
      assert.equal(await page.locator('#next-clicks').innerText(), '1')
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT04h 同 workId 的旧答案请求先到时必须等待当前答案请求', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div id="clicks">0</div><div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">旧答案错请求</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        document.querySelector('#clicks').textContent =
          String(Number(document.querySelector('#clicks').textContent) + 1)
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 } })
        })
        setTimeout(async () => {
          const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
              answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '0', answerContent: '', useTime: 0 } })
          })
          if ((await response.json()).success) {
            document.querySelector('.content-area').innerHTML =
              '<div>单选题 2/2</div><div class="question-info"><span class="question-title">下一题</span></div>'
          }
        }, 500)
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
          texts: ['甲'],
          indices: [0],
          selectionValues: [0],
        }],
        stopRequested: () => false,
        requestMatchWindowMs: 200,
      }), '旧答案请求没有被忽略', 6_000)
      assert.equal(result.saved, true)
      assert.equal(result.state, 'ready')
      assert.equal(await page.locator('#clicks').innerText(), '1')
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT04i 错误 workId 请求先到且正确请求超过匹配窗口时仍必须采用正确请求', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div id="clicks">0</div><div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">错误 workId 请求</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        document.querySelector('#clicks').textContent =
          String(Number(document.querySelector('#clicks').textContent) + 1)
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'old-work', homeWorkUniqueFlag: 'flag-old',
            answer: { bigQuestionId: 'bg-old', questionId: 'q-old', answerSelected: '1', answerContent: '', useTime: 0 } })
        })
        setTimeout(async () => {
          const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
              answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '0', answerContent: '', useTime: 0 } })
          })
          if ((await response.json()).success) {
            document.querySelector('.content-area').innerHTML =
              '<div>单选题 2/2</div><div class="question-info"><span class="question-title">下一题</span></div>'
          }
        }, 2_500)
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
          texts: ['甲'],
          indices: [0],
          selectionValues: [0],
        }],
        stopRequested: () => false,
        requestMatchWindowMs: 200,
      }), '正确 workId 请求没有被等待到', 8_000)
      assert.equal(result.saved, true)
      assert.equal(result.state, 'ready')
      assert.equal(await page.locator('#clicks').innerText(), '1')
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT04j 错误保存端点先到时不得拒绝稍后的正确端点请求', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div id="clicks">0</div><div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">错误端点请求</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        document.querySelector('#clicks').textContent =
          String(Number(document.querySelector('#clicks').textContent) + 1)
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitAllJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1', answers: [] })
        })
        setTimeout(async () => {
          const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
              answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '0', answerContent: '', useTime: 0 } })
          })
          if ((await response.json()).success) {
            document.querySelector('.content-area').innerHTML =
              '<div>单选题 2/2</div><div class="question-info"><span class="question-title">下一题</span></div>'
          }
        }, 500)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/SubmitAllJsonAsync') ||
        route.request().url().endsWith('/SubmitJsonAsync')) {
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
        answers: [{
          unitId: read.group.units[0].id,
          ordinal: 1,
          qtype: 'single',
          source: 'bank',
          texts: ['甲'],
          indices: [0],
          selectionValues: [0],
        }],
        stopRequested: () => false,
        requestMatchWindowMs: 200,
      }), '错误端点请求被错误收口', 6_000)
      assert.equal(result.saved, true)
      assert.equal(result.state, 'ready')
      assert.equal(await page.locator('#clicks').innerText(), '1')
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

test('T005-RT04e 页面先变化但保存请求晚到时会继续等待而不是提前判不确定', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成先跳页题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', () => {
        window.__clicks = (window.__clicks || 0) + 1
        document.querySelector('.content-area').innerHTML =
          '<div>单选题 2/2</div><div class="question-info"><span class="question-title">已提前切换</span></div>'
        setTimeout(async () => {
          const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
              answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 }
            })
          })
          await response.json()
        }, 80)
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
      const waitingStates: string[] = []
      const clickAttempts: number[] = []
      let result: Awaited<ReturnType<typeof saveNoqrAnswerAndAdvance>>
      try {
        result = await technicalTimeout(saveNoqrAnswerAndAdvance({
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
          pageChangeRequestWaitMs: 1_000,
          onWaiting: (state) => waitingStates.push(state),
          onClickAttempt: (attempt) => clickAttempts.push(attempt),
        }), '页面先变化且请求晚到没有正确收口', 5_000)
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；` +
          `requests=${requests}；last=${waitingStates.at(-1) || 'none'}`,
        )
      }
      assert.equal(requests, 1)
      assert.deepEqual(clickAttempts, [1])
      assert.equal(result.saved, true)
      assert.equal(result.advanced, true)
      assert.ok(Number(result.requestStartedAt) > 0)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT04g 先到错误 workId 自动保存时仍等待并采用稍后的正确保存请求', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    let requests = 0
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">合成错请求后正确请求</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workId: 'old-work', homeWorkUniqueFlag: 'old-flag',
            answer: { bigQuestionId: 'bg-old', questionId: 'q-old', answerSelected: '0', answerContent: '', useTime: 0 }
          })
        }).catch(() => undefined)
        setTimeout(async () => {
          const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
              answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '1', answerContent: '', useTime: 0 }
            })
          })
          if ((await response.json()).success) {
            document.querySelector('.content-area').innerHTML =
              '<div>单选题 2/2</div><div class="question-info"><span class="question-title">正确题</span></div>'
          }
        }, 80)
      })
    </script>`
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
      const clickAttempts: number[] = []
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
        requestMatchWindowMs: 1_000,
        onClickAttempt: (attempt) => clickAttempts.push(attempt),
      }), '错误自动保存阻塞了稍后的正确保存', 5_000)
      assert.equal(requests, 2)
      assert.deepEqual(clickAttempts, [1])
      assert.equal(result.saved, true)
      assert.equal(result.advanced, true)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT04h2 相同 workId 但题目 ID 不一致的旧保存请求不得冒充当前题', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    let requests = 0
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info" data-big-question-id="bg-1" data-question-id="q-1">
      <span class="question-title">合成题目身份校验</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workId: 'work-1', homeWorkUniqueFlag: 'flag-old',
            answer: { bigQuestionId: 'bg-old', questionId: 'q-old', answerSelected: '1', answerContent: '', useTime: 0 }
          })
        }).catch(() => undefined)
        setTimeout(async () => {
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
        }, 80)
      })
    </script>`
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
        requestMatchWindowMs: 1_000,
      }), '同 workId 的错误题目身份没有被拒绝', 5_000)
      assert.equal(requests, 2)
      assert.equal(result.saved, true)
      assert.equal(result.advanced, true)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
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

test('T005-RT05a3 本地题号到末尾但页面未推进时必须安全等待，不得伪造最后一题', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>语法 10/10</div><div class="question-info">
      <span class="question-title">语法最后一题</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-10', questionId: 'q-10', answerSelected: '0', answerContent: '', useTime: 0 } })
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
          ordinal: 1,
          qtype: 'single',
          source: 'bank',
          texts: ['甲'],
          indices: [0],
          selectionValues: [0],
        }],
        stopRequested: () => false,
        pageAdvanceBudgetMs: 250,
      }), '页面未推进时没有在有界静默窗口内收口', 3_000)
      assert.equal(saved.saved, true)
      assert.equal(saved.advanced, false)
      assert.equal(saved.lastQuestion, false)
      assert.equal(saved.uncertain, false)
      assert.equal(saved.state, 'awaiting_advance')
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05a4 永久加载状态不能绕过保存后页面推进安全上限', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">保存后永久加载</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', async () => {
        const response = await fetch('/dotNet_api/api/services/app/HomeWorkStudent/SubmitJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workId: 'work-1', homeWorkUniqueFlag: 'flag-1',
            answer: { bigQuestionId: 'bg-1', questionId: 'q-1', answerSelected: '0', answerContent: '', useTime: 0 } })
        })
        if ((await response.json()).success) {
          const loading = document.createElement('div')
          loading.className = 'van-toast van-toast--loading'
          loading.textContent = '保存中'
          document.body.appendChild(loading)
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
          ordinal: 1,
          qtype: 'single',
          source: 'bank',
          texts: ['甲'],
          indices: [0],
          selectionValues: [0],
        }],
        stopRequested: () => false,
        pageAdvanceBudgetMs: 100,
        pageAdvanceHardDeadlineMs: 300,
      }), '永久加载状态越过了页面推进安全上限', 1_500)
      assert.equal(saved.saved, true)
      assert.equal(saved.advanced, false)
      assert.equal(saved.lastQuestion, false)
      assert.equal(saved.uncertain, false)
      assert.equal(saved.state, 'awaiting_advance')
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05a5 下一题点击触发永久导航时也必须有限收口', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area"><div>单选题 1/2</div><div class="question-info">
      <span class="question-title">导航挂起测试</span>
      <div class="question-options">${optionHtml('A. 甲', 0, 'radio')}${optionHtml('B. 乙', 1, 'radio')}</div>
    </div><button class="next-btn">下一题</button></div>
    <script>
      document.querySelector('.next-btn').addEventListener('click', () => {
        location.href = '/nav-hang'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (new URL(route.request().url()).pathname === '/nav-hang') return
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
          ordinal: 1,
          qtype: 'single',
          source: 'bank',
          texts: ['甲'],
          indices: [0],
          selectionValues: [0],
        }],
        stopRequested: () => false,
        requestHardDeadlineMs: 300,
      }), '下一题点击永久导航越过了安全上限', 1_500)
      assert.equal(saved.saved, false)
      assert.equal(saved.uncertain, true)
      assert.equal(saved.state, 'submitted_uncertain')
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

test('T005-RT05b2 历史 DOM 永久不更新时必须有限收口', async () => {
  const result = await technicalTimeout(waitForNoqrHistoryDomMatch({
    matches: () => false,
    readDom: async () => [],
    stopRequested: () => false,
    sleep: async () => new Promise((resolveWait) => setTimeout(resolveWait, 20)),
    hardDeadlineMs: 80,
  }), '历史 DOM 永久不更新时没有收口', 1_000)

  assert.equal(result.ok, false)
  assert.match(result.error || '', /安全上限/)
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
      blankGraceMs: 30,
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
      blankGraceMs: 30,
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

test('T005-RT05d2 交卷后必须等到新记录，旧记录和旧 workId 都不能冒充本次分数', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  const apiUrls: string[] = []
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/GetAnswerHistoryListJsonAsync')) {
        apiUrls.push(url.href)
        await route.fulfill(jsonResponse({
          result: {
            data: [{
              finishedTime: '2026-11-01 12:00:00',
              score: 91,
              isMarked: true,
              status: '已批阅',
              paperId: 'paper-old',
            }],
          },
        }))
        return
      }
      if (url.pathname === '/course_work_record/index.html') {
        await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">作答记录</div></div>
          <div class="record-item"><div class="record-info">完成时间: 2026-11-01 12:00:00</div><div class="record-info get-score"><span class="score-num">91</span></div></div>
          <script>fetch('/dotNet_api/api/services/app/HomeWorkStudent/GetAnswerHistoryListJsonAsync?workId=work-new')</script>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    const history = await technicalTimeout(readNoqrHistoryAfterOpen({
      page,
      workId: 'work-old',
      refreshBudget: 1,
      blankGraceMs: 30,
      requireFreshRecord: true,
      baseline: [{
        finishedTime: '2026-11-01 12:00:00',
        score: 91,
        isMarked: true,
        status: '已批阅',
        paperId: 'paper-old',
      }],
      open: async () => {
        await page.goto(`${ORIGIN}/course_work_record/index.html?workId=work-new`, { waitUntil: 'domcontentloaded' })
      },
      stopRequested: () => false,
    }), '旧记录被错误当作交卷后的新分数')

    assert.equal(history.ok, false)
    assert.equal(history.latest, null)
    assert.match(history.error || '', /尚未出现新的有效分数/)
    assert.ok(apiUrls.some((url) => url.includes('workId=work-new')))
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05d2b 旧记录卡存在但本次历史请求未发出时有限收口', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/GetAnswerHistoryListJsonAsync')) {
        await route.fulfill(jsonResponse({ result: { data: [] } }))
        return
      }
      if (url.pathname === '/course_work_record/index.html') {
        await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">作答记录</div></div>
          <div class="record-item"><div class="record-info">完成时间: 2026-11-01 12:00:00</div><div class="record-info get-score"><span class="score-num">100</span></div></div>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const startedAt = Date.now()
    await assert.rejects(
      technicalTimeout(readNoqrHistoryAfterOpen({
        page,
        workId: 'work-old',
        refreshBudget: 1,
        blankGraceMs: 30,
        requireFreshRecord: true,
        open: async () => {
          await page.goto(`${ORIGIN}/course_work_record/index.html?workId=work-old`, { waitUntil: 'domcontentloaded' })
        },
        stopRequested: () => false,
      }), '旧记录卡无本次请求时没有有限收口', 4_000),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'blank_page',
    )
    assert.ok(Date.now() - startedAt < 4_000)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05d3 基线不可靠时旧满分记录不能冒充本次交卷分数', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
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
              paperId: 'paper-old',
              homeWorkUniqueFlag: 'attempt-old',
            }],
          },
        }))
        return
      }
      if (url.pathname === '/course_work_record/index.html') {
        await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">作答记录</div></div>
          <div class="record-item"><div class="record-info">完成时间: 2026-11-01 12:00:00</div><div class="record-info get-score"><span class="score-num">100</span></div></div>
          <script>fetch('/dotNet_api/api/services/app/HomeWorkStudent/GetAnswerHistoryListJsonAsync')</script>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    const history = await technicalTimeout(readNoqrHistoryAfterOpen({
      page,
      refreshBudget: 1,
      blankGraceMs: 30,
      requireFreshRecord: true,
      baseline: [],
      freshEvidence: {
        baselineReliable: false,
        submittedAt: Date.parse('2026-11-01 12:05:00'),
        homeWorkUniqueFlag: 'attempt-new',
      },
      open: async () => {
        await page.goto(`${ORIGIN}/course_work_record/index.html?workId=work-new`, { waitUntil: 'domcontentloaded' })
      },
      stopRequested: () => false,
    }), '旧满分记录被基线不可靠路径误判为本次新分数')

    assert.equal(history.ok, false)
    assert.equal(history.latest, null)
    assert.match(history.error || '', /尚未出现新的有效分数/)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05d4 基线不可靠时可用本次唯一标记与完成时间确认新分数', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/GetAnswerHistoryListJsonAsync')) {
        await route.fulfill(jsonResponse({
          result: {
            data: [
              {
                finishedTime: '2026-11-01 12:00:00',
                score: 100,
                isMarked: true,
                status: '已批阅',
                paperId: 'paper-old',
                homeWorkUniqueFlag: 'attempt-old',
              },
              {
                finishedTime: '2026-11-01 12:06:00',
                score: 91,
                isMarked: true,
                status: '已批阅',
                paperId: 'paper-new',
                homeWorkUniqueFlag: 'attempt-new',
              },
            ],
          },
        }))
        return
      }
      if (url.pathname === '/course_work_record/index.html') {
        await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">作答记录</div></div>
          <div class="record-item"><div class="record-info">完成时间: 2026-11-01 12:00:00</div><div class="record-info get-score"><span class="score-num">100</span></div></div>
          <div class="record-item"><div class="record-info">完成时间: 2026-11-01 12:06:00</div><div class="record-info get-score"><span class="score-num">91</span></div></div>
          <script>fetch('/dotNet_api/api/services/app/HomeWorkStudent/GetAnswerHistoryListJsonAsync')</script>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    const history = await technicalTimeout(readNoqrHistoryAfterOpen({
      page,
      refreshBudget: 1,
      blankGraceMs: 30,
      requireFreshRecord: true,
      baseline: [],
      freshEvidence: {
        baselineReliable: false,
        submittedAt: Date.parse('2026-11-01 12:05:00'),
        homeWorkUniqueFlag: 'attempt-new',
      },
      open: async () => {
        await page.goto(`${ORIGIN}/course_work_record/index.html?workId=work-new`, { waitUntil: 'domcontentloaded' })
      },
      stopRequested: () => false,
    }), '本次唯一标记未确认新分数')

    assert.equal(history.ok, true)
    assert.equal(history.latest?.score, 91)
    assert.equal(history.latest?.homeWorkUniqueFlag, 'attempt-new')
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

test('T005-RT05e2 多项选择题标题不能用已保存的多选题组键误判漏题', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 2 大题: 多项选择题</div>
        <span class="sub-question">1</span>
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
    const audit = await auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      savedKeys: new Set([noqrAnswerCardKey('multiple', 1)]),
      expectedCount: 1,
    })
    assert.equal(audit.ok, true)
    assert.equal(audit.unanswered, 0)
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

test('T005-RT05i 隐藏的预渲染答题卡不能被当成已打开', async () => {
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
    </div>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    let stopped = false
    const timer = setTimeout(() => { stopped = true }, 250)
    try {
      await assert.rejects(
        technicalTimeout(auditNoqrAnswerCard(page, {
          stopRequested: () => stopped,
        }), '隐藏答题卡没有等待到停止', 4_000),
        /任务已停止/,
      )
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05i2 隐藏答题卡不能补齐可见答题卡的遗漏题位', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:block">
      <div class="question-card" style="display:none">
        <div class="question-cart-title">第 1 大题: 单选题</div>
        <span class="sub-question has-answered">1</span>
        <span class="sub-question has-answered">2</span>
      </div>
      <div class="question-card">
        <div class="question-cart-title">第 1 大题: 单选题</div>
        <span class="sub-question has-answered">1</span>
      </div>
    </div>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const expectedKeys = new Set([
      noqrAnswerCardKey('single', 1, 1),
      noqrAnswerCardKey('single', 2, 1),
    ])
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        savedKeys: expectedKeys,
        expectedKeys,
        expectedCount: 2,
        noProgressBudgetMs: 80,
        maxReopens: 1,
      }), '隐藏答题卡补齐了可见答题卡的遗漏题位', 5_000),
      /答题卡连续/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05j 有预期键时不能用少量已加载行按大题组数提前交卷', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 1 大题: 语法</div>
        ${Array.from({ length: 5 }, (_, index) =>
          `<span class="sub-question has-answered">${index + 1}</span>`).join('')}
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
    const expectedKeys = new Set(Array.from({ length: 10 }, (_, index) =>
      noqrAnswerCardKey('english_grammar', index + 1)))
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        savedKeys: expectedKeys,
        expectedKeys,
        expectedCount: 5,
        noProgressBudgetMs: 100,
        maxReopens: 1,
      }), '答题卡少量行被错误当成完整', 5_000),
      /答题卡连续/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05l 综合题标题按真实逻辑题位一对一匹配，不被 scoped/legacy 别名重复计数', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 1 大题: 综合题</div>
        ${Array.from({ length: 4 }, (_, index) =>
          `<span class="sub-question has-answered">${index + 1}</span>`).join('')}
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

    const kinds = ['single', 'single', 'multiple', 'single'] as const
    const expectedSlots = kinds.flatMap((kind, index) => noqrAnswerCardExpectedSlots({
      kind,
      sharedStem: '',
      units: [{ id: `unit-${index + 1}`, ordinal: 1, qtype: kind, stem: '', options: [] }],
      position: index + 1,
      total: 4,
    }, {
      groupOrdinal: index + 1,
      kindOccurrence: kind === 'single' ? [1, 2, 4].indexOf(index + 1) + 1 : 1,
      slotOffset: index,
    }))
    const savedKeys = new Set(kinds.flatMap((kind, index) => [
      noqrAnswerCardKey(kind, index + 1, 1),
      noqrAnswerCardKey(kind, index + 1),
      String(index + 1),
    ]))
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      savedKeys,
      expectedKeys: savedKeys,
      expectedSlots,
      expectedCount: 4,
      noProgressBudgetMs: 100,
      maxReopens: 1,
    }), '综合题答题卡按别名重复计数后无法完整', 3_000)
    assert.equal(audit.ok, true)
    assert.equal(audit.answered, 4)
    assert.equal(audit.unanswered, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05l2 两篇复合题只加载第一篇时不能用全局别名借用第二篇题位', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 5 大题: 阅读理解</div>
        ${Array.from({ length: 5 }, (_, index) =>
          `<span class="sub-question has-answered">${index + 1}</span>`).join('')}
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
    const expectedSlots = [1, 2].flatMap((groupOrdinal) => noqrAnswerCardExpectedSlots({
      kind: 'english_reading',
      sharedStem: '',
      units: Array.from({ length: 5 }, (_, index) => ({
        id: `reading-${groupOrdinal}-${index + 1}`,
        ordinal: index + 1,
        qtype: 'judge',
        stem: '',
        options: [],
      })),
      position: groupOrdinal + 4,
      total: 6,
    }, {
      groupOrdinal,
      kindOccurrence: groupOrdinal,
      slotOffset: (groupOrdinal - 1) * 5,
    }))
    const expectedKeys = new Set([1, 2].flatMap((groupOrdinal) =>
      Array.from({ length: 5 }, (_, index) => [
        noqrAnswerCardKey('english_reading', index + 1, groupOrdinal),
        noqrAnswerCardKey('english_reading', (groupOrdinal - 1) * 5 + index + 1),
        String((groupOrdinal - 1) * 5 + index + 1),
      ]).flat()))
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        savedKeys: expectedKeys,
        expectedKeys,
        expectedSlots,
        expectedCount: 10,
        noProgressBudgetMs: 80,
        maxReopens: 1,
      }), '第二篇未加载却被第一组别名补齐', 5_000),
      /答题卡连续/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o 复合题父题单节点可以证明整组已加载', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 3 大题: 听力理解</div>
        <span class="sub-question has-answered">3</span>
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
    const expectedGroup = noqrAnswerCardExpectedGroups({
      kind: 'english_listening',
      sharedStem: '',
      units: Array.from({ length: 5 }, (_, index) => ({
        id: `listening-${index + 1}`,
        ordinal: index + 1,
        qtype: 'single',
        stem: '',
        options: [],
      })),
      position: 3,
      total: 6,
    }, {
      groupOrdinal: 1,
      kindOccurrence: 1,
      slotOffset: 0,
    })
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      savedKeys: new Set([noqrAnswerCardKey('english_listening', 3)]),
      expectedKeys: new Set([noqrAnswerCardKey('english_listening', 3)]),
      expectedGroups: [expectedGroup],
      savedGroupOrdinals: new Set([1]),
      expectedCount: 5,
      noProgressBudgetMs: 100,
      maxReopens: 1,
    }), '父题单节点没有证明复合组完整', 3_000)
    assert.equal(audit.ok, true)
    assert.equal(audit.answered, 1)
    assert.equal(audit.unanswered, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o4 阅读理解只渲染一个子题时不能被父题单节点误判整组完整', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成阅读题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 5 大题: 阅读理解</div>
        <span class="sub-question has-answered">1</span>
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
    const expectedGroup = noqrAnswerCardExpectedGroups({
      kind: 'english_reading',
      sharedStem: '',
      units: Array.from({ length: 5 }, (_, index) => ({
        id: `reading-${index + 1}`,
        ordinal: index + 1,
        qtype: 'judge',
        stem: '',
        options: [],
      })),
      position: 5,
      total: 6,
    }, {
      groupOrdinal: 1,
      kindOccurrence: 1,
      slotOffset: 0,
    })
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        expectedGroups: [expectedGroup],
        expectedCount: 5,
        noProgressBudgetMs: 80,
        maxReopens: 1,
      }), '阅读理解部分加载被父题规则误判', 5_000),
      /答题卡(连续|自动恢复)/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o5 答题卡入口被遮挡时仍必须在统一总时限内失败', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
      <div style="position:fixed;inset:0;z-index:9999;background:transparent"></div>
    </div>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        expectedCount: 1,
        noProgressBudgetMs: 100,
        auditDeadlineMs: 300,
        maxReopens: 1,
      }), '答题卡入口遮挡未在截止时间收口', 1_500),
      /答题卡.*总时限|答题卡入口/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o6 答题卡结构完整但仍有未答子题时不得判可交卷', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成阅读题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 1 大题: 阅读理解</div>
        <span class="sub-question has-answered">1</span>
        <span class="sub-question">2</span>
        <span class="sub-question">3</span>
        <span class="sub-question">4</span>
        <span class="sub-question">5</span>
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
    const expectedGroup = noqrAnswerCardExpectedGroups({
      kind: 'english_reading',
      sharedStem: '',
      units: Array.from({ length: 5 }, (_, index) => ({
        id: `reading-partial-${index + 1}`,
        ordinal: index + 1,
        qtype: 'judge',
        stem: '',
        options: [],
      })),
      position: 1,
      total: 2,
    }, {
      groupOrdinal: 1,
      kindOccurrence: 1,
      slotOffset: 0,
    })
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      savedKeys: new Set([noqrAnswerCardKey('english_reading', 1, 1)]),
      expectedGroups: [expectedGroup],
      expectedCount: 5,
      noProgressBudgetMs: 100,
      maxReopens: 1,
    }), '部分未答子题没有被答题卡审计拦下', 3_000)
    assert.equal(audit.ok, false)
    assert.equal(audit.unanswered, 4)
    assert.deepEqual(audit.missingKeys, ['阅读理解@1#2', '阅读理解@1#3', '阅读理解@1#4', '阅读理解@1#5'])
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o7 两张同题型阅读卡中第二张未答时必须禁止交卷', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成阅读题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 5 大题: 阅读理解</div>
        ${Array.from({ length: 5 }, (_, index) =>
          `<span class="sub-question has-answered">${index + 1}</span>`).join('')}
      </div>
      <div class="question-card">
        <div class="question-cart-title">第 6 大题: 阅读理解</div>
        ${Array.from({ length: 5 }, (_, index) =>
          `<span class="sub-question">${index + 1}</span>`).join('')}
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
    const expectedGroups = [1, 2].map((groupOrdinal) => noqrAnswerCardExpectedGroups({
      kind: 'english_reading',
      sharedStem: '',
      units: Array.from({ length: 5 }, (_, index) => ({
        id: `reading-card-${groupOrdinal}-${index + 1}`,
        ordinal: index + 1,
        qtype: 'judge',
        stem: '',
        options: [],
      })),
      position: groupOrdinal,
      total: 2,
    }, {
      groupOrdinal,
      kindOccurrence: groupOrdinal,
      slotOffset: (groupOrdinal - 1) * 5,
    }))
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      savedKeys: new Set(Array.from({ length: 5 }, (_, index) =>
        noqrAnswerCardKey('english_reading', index + 1, 1))),
      expectedGroups,
      expectedCount: 10,
      noProgressBudgetMs: 100,
      maxReopens: 1,
    }), '第二张阅读卡未答仍被判可交卷', 3_000)
    assert.equal(audit.ok, false)
    assert.equal(audit.unanswered, 5)
    assert.deepEqual(audit.missingKeys, Array.from({ length: 5 }, (_, index) =>
      `阅读理解@2#${index + 1}`))
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o8 同题型独立大题按卡片 occurrence 匹配局部题号', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成阅读题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      ${[5, 6].map((ordinal) => `
        <div class="question-card">
          <div class="question-cart-title">第 ${ordinal} 大题: 阅读理解</div>
          ${Array.from({ length: 5 }, (_, index) =>
            `<span class="sub-question has-answered">${index + 1}</span>`).join('')}
        </div>`).join('')}
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const expectedGroups = [1, 2].map((groupOrdinal) => noqrAnswerCardExpectedGroups({
      kind: 'english_reading',
      sharedStem: '',
      units: Array.from({ length: 5 }, (_, index) => ({
        id: `reading-local-${groupOrdinal}-${index + 1}`,
        ordinal: index + 1,
        qtype: 'judge',
        stem: '',
        options: [],
      })),
      position: groupOrdinal,
      total: 2,
    }, {
      groupOrdinal,
      kindOccurrence: groupOrdinal,
      slotOffset: (groupOrdinal - 1) * 5,
    }))
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      expectedGroups,
      expectedCount: 10,
      noProgressBudgetMs: 100,
      maxReopens: 1,
    }), '同题型独立大题局部题号没有匹配', 3_000)
    assert.equal(audit.ok, true)
    assert.equal(audit.answered, 10)
    assert.equal(audit.unanswered, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o10 已成功保存的逻辑组可覆盖答题卡单个 has-answered 延迟', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成阅读题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 5 大题: 阅读理解</div>
        ${Array.from({ length: 5 }, (_, index) =>
          `<span class="sub-question${index < 4 ? ' has-answered' : ''}">${index + 1}</span>`).join('')}
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
    const expectedGroup = noqrAnswerCardExpectedGroups({
      kind: 'english_reading',
      sharedStem: '',
      units: Array.from({ length: 5 }, (_, index) => ({
        id: `reading-saved-group-${index + 1}`,
        ordinal: index + 1,
        qtype: 'judge',
        stem: '',
        options: [],
      })),
      position: 5,
      total: 6,
    }, {
      groupOrdinal: 1,
      kindOccurrence: 1,
      slotOffset: 0,
    })
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      expectedGroups: [expectedGroup],
      expectedCount: 5,
      savedGroupOrdinals: new Set([1]),
      noProgressBudgetMs: 100,
      maxReopens: 1,
    }), '已保存逻辑组被单个答题卡状态延迟误判为未答', 3_000)
    assert.equal(audit.ok, true)
    assert.equal(audit.answered, 4)
    assert.equal(audit.unanswered, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o11 已保存的复合题可用单个大题节点证明整组完整', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成阅读题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 5 大题: 阅读理解</div>
        <span class="sub-question is-current">5</span>
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
    const expectedGroup = noqrAnswerCardExpectedGroups({
      kind: 'english_reading',
      sharedStem: '',
      units: Array.from({ length: 5 }, (_, index) => ({
        id: `reading-parent-${index + 1}`,
        ordinal: index + 1,
        qtype: 'judge',
        stem: '',
        options: [],
      })),
      position: 5,
      total: 6,
    }, {
      groupOrdinal: 1,
      kindOccurrence: 1,
      slotOffset: 0,
    })
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      expectedGroups: [expectedGroup],
      savedGroupOrdinals: new Set([1]),
      expectedCount: 5,
      noProgressBudgetMs: 100,
      maxReopens: 1,
    }), '已保存复合题的大题节点没有证明整组完整', 3_000)
    assert.equal(audit.ok, true)
    assert.equal(audit.answered, 0)
    assert.equal(audit.unanswered, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o12 同一答题卡内两篇阅读父节点可分别匹配两个已保存逻辑组', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成阅读题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 5 大题: 阅读理解</div>
        <span class="sub-question has-answered">1</span>
        <span class="sub-question has-answered">2</span>
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
    const expectedGroups = [1, 2].map((position) => noqrAnswerCardExpectedGroups({
      kind: 'english_reading',
      sharedStem: `合成阅读材料 ${position}`,
      units: Array.from({ length: 5 }, (_, index) => ({
        id: `reading-parent-${position}-${index + 1}`,
        ordinal: index + 1,
        qtype: 'judge',
        stem: `陈述 ${index + 1}`,
        options: [{ index: 0, text: '正确' }, { index: 1, text: '错误' }],
      })),
      position,
      total: 2,
    }, {
      groupOrdinal: position,
      kindOccurrence: position,
      slotOffset: (position - 1) * 5,
    }))
    const audit = await technicalTimeout(auditNoqrAnswerCard(page, {
      stopRequested: () => false,
      expectedGroups,
      savedGroupOrdinals: new Set([1, 2]),
      expectedCount: 2,
      noProgressBudgetMs: 100,
      maxReopens: 1,
    }), '同卡片内两篇阅读父节点没有分别匹配逻辑组', 3_000)
    assert.equal(audit.ok, true)
    assert.equal(audit.unanswered, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o9 答题卡弹层关闭失败时不得返回可交卷', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-overlay" style="display:none;position:fixed;inset:0;z-index:1"></div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 1 大题: 单选题</div>
        <span class="sub-question has-answered">1</span>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-overlay').style.display = 'block'
        document.querySelector('.van-popup').style.display = 'block'
      })
      document.querySelector('.van-overlay').addEventListener('click', () => {})
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        expectedCount: 1,
        noProgressBudgetMs: 100,
        auditDeadlineMs: 300,
        maxReopens: 1,
      }), '答题卡关闭失败没有收口', 2_000),
      /答题卡弹层关闭失败|总时限/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o9b 无遮罩答题卡弹层按非模态处理且不阻塞', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:block">
      <div class="question-card"><div class="question-cart-title">第 1 大题: 单选题</div>
        <span class="sub-question has-answered">1</span>
      </div>
    </div>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await assert.doesNotReject(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        auditDeadlineMs: 300,
        noProgressBudgetMs: 100,
        maxReopens: 0,
      }), '无遮罩弹层被误当成阻塞模态层', 1_500),
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o2 错误分布的同题型同数量答题卡不能补齐缺失逻辑组', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      ${[1, 2].map(() => `
        <div class="question-card">
          <div class="question-cart-title">第 5 大题: 阅读理解</div>
          ${Array.from({ length: 5 }, (_, index) =>
            `<span class="sub-question has-answered">${index + 1}</span>`).join('')}
        </div>`).join('')}
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const expectedGroups = [5, 6].map((position, index) => noqrAnswerCardExpectedGroups({
      kind: 'english_reading',
      sharedStem: '',
      units: Array.from({ length: 5 }, (_, unitIndex) => ({
        id: `reading-tree-${position}-${unitIndex + 1}`,
        ordinal: unitIndex + 1,
        qtype: 'judge',
        stem: '',
        options: [],
      })),
      position,
      total: 6,
    }, {
      groupOrdinal: index + 1,
      kindOccurrence: index + 1,
      slotOffset: index * 5,
    }))
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        savedKeys: new Set(expectedGroups.flatMap((group) =>
          group.plans.flatMap((plan) => plan.slotNumbers))),
        expectedGroups,
        expectedCount: 10,
        noProgressBudgetMs: 80,
        maxReopens: 1,
      }), '错误分布的同题型答题卡被当成完整', 5_000),
      /答题卡连续/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05o3 通用综合题标题点击后只换题号不更新 is-current 仍可确认到达', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">第一题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-overlay" style="display:none"></div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card">
        <div class="question-cart-title">第 1 大题: 综合题</div>
        <span class="sub-question">1</span>
        <span class="sub-question">2</span>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-overlay').style.display = 'block'
        document.querySelector('.van-popup').style.display = 'block'
      })
      document.querySelector('.van-overlay').addEventListener('click', () => {
        document.querySelector('.van-overlay').style.display = 'none'
        document.querySelector('.van-popup').style.display = 'none'
      })
      document.querySelectorAll('.sub-question')[1].addEventListener('click', () => {
        document.querySelector('.content-area').innerHTML =
          '<div>单选题 2/2</div><div class="question-info"><span class="question-title">第二题</span></div>'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await technicalTimeout(
      goToNoqrAnswerCardQuestion(page, '第 1 大题: 综合题#2', () => false),
      '通用综合题没有识别题号推进',
      3_000,
    )
    assert.match(await page.locator('.content-area').innerText(), /2\s*\/\s*2/)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05p 答题卡打开阶段也必须受统一总时限约束', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        fetch('/hang').catch(() => undefined)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (route.request().url().endsWith('/hang')) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 800))
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        noProgressBudgetMs: 100,
        auditDeadlineMs: 300,
        maxReopens: 3,
      }), '答题卡打开阶段的永久业务请求越过总时限', 2_000),
      /总时限/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05p2 永久加载提示不能绕过答题卡统一总时限', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        const loading = document.createElement('div')
        loading.className = 'van-toast van-toast--loading'
        loading.textContent = '加载中'
        document.body.appendChild(loading)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        noProgressBudgetMs: 100,
        auditDeadlineMs: 300,
        maxReopens: 3,
      }), '永久加载提示越过了答题卡总时限', 1_500),
      /总时限/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05p3 答题卡入口触发永久导航时也必须有限收口', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        location.href = '/answer-card-nav-hang'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (new URL(route.request().url()).pathname === '/answer-card-nav-hang') return
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        noProgressBudgetMs: 100,
        auditDeadlineMs: 300,
        maxReopens: 0,
      }), '答题卡入口永久导航越过了安全上限', 1_500),
      /安全上限|总时限/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05m 已答状态抖动不能无限推迟答题卡无进展收口', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 1 大题: 语法</div>
        <span class="sub-question">1</span>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
        let answered = false
        setInterval(() => {
          answered = !answered
          document.querySelector('.sub-question').classList.toggle('has-answered', answered)
        }, 20)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const expectedSlots = noqrAnswerCardExpectedSlots({
      kind: 'english_grammar',
      sharedStem: '',
      units: [1, 2].map((ordinal) => ({
        id: `grammar-${ordinal}`,
        ordinal,
        qtype: 'single',
        stem: '',
        options: [],
      })),
    }, {
      groupOrdinal: 1,
      kindOccurrence: 1,
      slotOffset: 0,
    })
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        savedKeys: new Set(expectedSlots.map((slot) => slot.key)),
        expectedKeys: new Set(expectedSlots.map((slot) => slot.key)),
        expectedSlots,
        expectedCount: 2,
        noProgressBudgetMs: 100,
        maxReopens: 1,
      }), '已答状态抖动让答题卡审计永久等待', 4_000),
      /答题卡连续/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05n 持续新增但不完整的答题卡仍受统一总时限约束', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 1 大题: 语法</div>
        <div id="items"></div>
      </div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
        let number = 0
        setInterval(() => {
          number++
          document.querySelector('#items').insertAdjacentHTML('beforeend',
            '<span class="sub-question has-answered">' + number + '</span>')
        }, 40)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const expectedSlots = noqrAnswerCardExpectedSlots({
      kind: 'english_grammar',
      sharedStem: '',
      units: Array.from({ length: 20 }, (_, index) => ({
        id: `grammar-deadline-${index + 1}`,
        ordinal: index + 1,
        qtype: 'single',
        stem: '',
        options: [],
      })),
    }, {
      groupOrdinal: 1,
      kindOccurrence: 1,
      slotOffset: 0,
    })
    await assert.rejects(
      technicalTimeout(auditNoqrAnswerCard(page, {
        stopRequested: () => false,
        savedKeys: new Set(expectedSlots.map((slot) => slot.key)),
        expectedKeys: new Set(expectedSlots.map((slot) => slot.key)),
        expectedSlots,
        expectedCount: 20,
        noProgressBudgetMs: 100,
        auditDeadlineMs: 250,
        maxReopens: 3,
      }), '持续增长的不完整答题卡超过总时限仍未收口', 4_000),
      /总时限/,
    )
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT05k 复合题跳转不能用倒计时等动态文本冒充已到达第二篇', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info">
        <span class="question-title">第一篇阅读材料</span>
        <div class="sub-questions"><div class="sub-item">
          <span class="question-title">陈述 1</span>
        </div></div>
      </div>
      <span id="countdown">1:00</span>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <div class="van-popup van-popup--bottom" style="display:none">
      <div class="question-card"><div class="question-cart-title">第 5 大题: 阅读理解</div>
        <span class="sub-question is-current">1</span>
        <span class="sub-question">2</span>
      </div>
      <div class="question-card"><div class="question-cart-title">第 6 大题: 阅读理解</div>
        <span class="sub-question">1</span>
        <span class="sub-question">2</span>
      </div>
    </div>
    <script>
      let seconds = 60
      setInterval(() => {
        seconds = Math.max(0, seconds - 1)
        document.querySelector('#countdown').textContent =
          Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
      }, 40)
      document.querySelectorAll('.btn-item')[0].addEventListener('click', () => {
        document.querySelector('.van-popup').style.display = 'block'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    await assert.rejects(
      goToNoqrAnswerCardQuestion(
        page,
        noqrAnswerCardKey('english_reading', 1, 2),
        () => false,
        { verifyBudgetMs: 250 },
      ),
      /未到达目标题/,
    )
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

test('T005-RT10c 隐藏题目模板在前时仍以可见题目完成启动判定', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await openAnswerPage(page, `<div class="content-area">
      <div class="question-info" style="display:none">
        <span class="question-title">隐藏模板</span>
      </div>
      <div class="question-info">
        <span class="question-title">可见题目</span>
      </div>
    </div>`, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    let reentries = 0
    await technicalTimeout(waitForNoqrAnswerReady({
      page,
      stopRequested: () => false,
      reenter: async () => { reentries++ },
      blankSettleMs: 80,
      skeletonBudgetMs: 80,
    }), '隐藏题目模板导致可见答题页未就绪')
    assert.equal(reentries, 0)
    assert.equal(await page.locator('.question-info:visible .question-title').innerText(), '可见题目')
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

test('T005-RT10d 永久活动骨架不能绕过答题启动安全上限', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await openAnswerPage(page, `<div class="content-area">
      <div class="skeleton-area van-skeleton" style="display:block;width:240px;height:80px"></div>
      <script>fetch('/boot-hang').catch(() => undefined)</script>
    </div>`, async (route) => {
      if (new URL(route.request().url()).pathname === '/boot-hang') return
      await route.fulfill({ status: 404, body: 'not found' })
    })
    let reentries = 0
    await assert.rejects(
      technicalTimeout(waitForNoqrAnswerReady({
        page,
        stopRequested: () => false,
        reenter: async () => { reentries++ },
        maxReentries: 10,
        skeletonBudgetMs: 5_000,
        startupHardDeadlineMs: 300,
      }), '永久活动骨架越过了答题启动安全上限', 1_500),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'answer_interrupted',
    )
    assert.equal(reentries, 0)
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
        noRequestRetryBudgetMs: 300,
      }), '错误保存端点没有收口')
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

test('T005-RT14h Finish 成功但成功页面证据永不出现时必须有限收口', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[1].addEventListener('click', async () => {
        await fetch('/dotNet_api/api/services/app/HomeWorkStudent/FinishJsonAsync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workId: 'work-1', workType: 'onlineWork', homeWorkUniqueFlag: 'flag-1',
            paperStructUniqueFlag: 'paper-1', useTime: 0
          })
        })
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
        successUiBudgetMs: 300,
      }), '成功页面证据等待没有有限收口', 2_000)
      assert.equal(result.ok, false)
      assert.equal(result.state, 'submitted_uncertain')
      assert.equal(result.uncertain, true)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14i 只有交卷成功 UI、没有 Finish 请求时必须有限收口为不确定', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      const submit = document.querySelectorAll('.btn-item')[1]
      submit.addEventListener('click', () => {
        submit.classList.add('disable-btn')
        const toast = document.createElement('div')
        toast.className = 'van-toast van-toast--success'
        toast.textContent = '交卷成功!'
        document.body.appendChild(toast)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer,
        stopRequested: () => false,
        successUiBudgetMs: 250,
        noRequestRetryBudgetMs: 5_000,
      }), '成功 UI 没有最终请求时仍发生死循环', 2_000)
      assert.equal(result.ok, false)
      assert.equal(result.state, 'submitted_uncertain')
      assert.equal(result.uncertain, true)
      assert.match(result.reason || '', /未捕获最终交卷请求/)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14j 只有交卷按钮禁用态也不能无限等待最终请求', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      const submit = document.querySelectorAll('.btn-item')[1]
      submit.addEventListener('click', () => submit.classList.add('disable-btn'))
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer,
        stopRequested: () => false,
        noRequestRetryBudgetMs: 5_000,
        successUiBudgetMs: 250,
        submitHardDeadlineMs: 5_000,
      }), '部分交卷成功态没有有限收口', 1_500)
      assert.equal(result.ok, false)
      assert.equal(result.state, 'submitted_uncertain')
      assert.equal(result.uncertain, true)
      assert.match(result.reason || '', /安全上限|最终交卷请求/)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14j2 只有交卷成功提示态也不能无限等待最终请求', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[1].addEventListener('click', () => {
        const toast = document.createElement('div')
        toast.className = 'van-toast van-toast--success'
        toast.textContent = '交卷成功!'
        document.body.appendChild(toast)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer,
        stopRequested: () => false,
        noRequestRetryBudgetMs: 5_000,
        successUiBudgetMs: 250,
        submitHardDeadlineMs: 5_000,
      }), '部分交卷成功提示没有有限收口', 1_500)
      assert.equal(result.ok, false)
      assert.equal(result.state, 'submitted_uncertain')
      assert.equal(result.uncertain, true)
      assert.match(result.reason || '', /部分证据|最终交卷请求/)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14j3 交卷点击触发永久导航时必须有限收口', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[1].addEventListener('click', () => {
        location.href = '/submit-nav-hang'
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (new URL(route.request().url()).pathname === '/submit-nav-hang') return
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const observer = new NoqrMutationObserver(page)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer,
        stopRequested: () => false,
        submitHardDeadlineMs: 300,
      }), '交卷点击永久导航越过了安全上限', 1_500)
      assert.equal(result.ok, false)
      assert.equal(result.state, 'submitted_uncertain')
      assert.equal(result.uncertain, true)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14c 交卷成功后 URL 不变时返回按钮必须等待导航而不是刷新答题页', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let answerLoads = 0
  let courseWorkLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_detail/index.html') {
        answerLoads++
        await route.fulfill(htmlResponse(`<div class="van-nav-bar">
          <div class="van-nav-bar__left" id="back" style="padding:12px" onclick="document.body.dataset.backClicks=String((Number(document.body.dataset.backClicks)||0)+1)">返回</div>
          <div class="van-nav-bar__title">记分作业一</div>
        </div>
        <div class="content-area">
          <div class="question-info"><span class="question-title">合成题</span></div>
          <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item disable-btn">交卷</button></div>
        </div>
        <div class="van-toast--success">交卷成功!</div>
        <script>
          document.querySelector('#back').addEventListener('click', () => {
            setTimeout(() => location.href = '/course_work/index.html?courseId=course-1', 300)
          })
        </script>`))
        return
      }
      if (url.pathname === '/course_work/index.html') {
        courseWorkLoads++
        await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">课程作业</div></div>
          <div class="work-item">记分作业一</div>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
    await technicalTimeout(returnToNoqrCourseWork(
      page,
      () => false,
      { backRetryQuietMs: 500, maxBackAttempts: 2 },
    ), '交卷成功页返回按钮没有等待站点导航')

    assert.equal(new URL(page.url()).pathname, '/course_work/index.html')
    assert.equal(answerLoads, 1)
    assert.equal(courseWorkLoads, 1)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14c2 交卷返回必须点击可见导航按钮而不是隐藏旧节点', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let answerLoads = 0
  let courseWorkLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_detail/index.html') {
        answerLoads++
        await route.fulfill(htmlResponse(`<div class="van-nav-bar">
          <div class="van-nav-bar__left" id="stale-back" style="display:none">旧返回</div>
          <div class="van-nav-bar__left" id="visible-back" style="padding:12px">返回</div>
          <div class="van-nav-bar__title">记分作业一</div>
        </div>
        <div class="content-area">
          <div class="question-info"><span class="question-title">合成题</span></div>
          <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item disable-btn">交卷</button></div>
        </div>
        <div class="van-toast--success">交卷成功!</div>
        <script>
          document.querySelector('#stale-back').addEventListener('click', () => {
            document.body.dataset.staleBackClicks =
              String((Number(document.body.dataset.staleBackClicks) || 0) + 1)
          })
          document.querySelector('#visible-back').addEventListener('click', () => {
            location.href = '/course_work/index.html?courseId=course-1'
          })
        </script>`))
        return
      }
      if (url.pathname === '/course_work/index.html') {
        courseWorkLoads++
        await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">课程作业</div></div>
          <div class="work-item">记分作业一</div>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
    await technicalTimeout(returnToNoqrCourseWork(
      page,
      () => false,
      { submitConfirmedEvidence: true, backRetryQuietMs: 100, maxBackAttempts: 2 },
    ), '交卷成功页错误点击隐藏返回按钮')

    assert.equal(new URL(page.url()).pathname, '/course_work/index.html')
    assert.equal(answerLoads, 1)
    assert.equal(courseWorkLoads, 1)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14c 交卷点击后只有无关挂起请求时停止必须收口并释放', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let stopped = false
  try {
    const html = `<div class="content-area">
      <div class="question-info"><span class="question-title">合成题</span></div>
      <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
    </div>
    <script>
      document.querySelectorAll('.btn-item')[1].addEventListener('click', () => {
        fetch('/api/hang', { method: 'GET' }).catch(() => undefined)
      })
    </script>`
    await openAnswerPage(page, html, async (route) => {
      if (new URL(route.request().url()).pathname === '/api/hang') return
      await route.fulfill({ status: 404, body: 'not found' })
    })
    const observer = new NoqrMutationObserver(page)
    setTimeout(() => { stopped = true }, 180)
    try {
      const result = await technicalTimeout(submitNoqrHomework({
        page,
        workId: 'work-1',
        observer,
        stopRequested: () => stopped,
      }), '停止后交卷仍被无关请求挂住', 2_000)
      assert.equal(result.ok, false)
      assert.equal(result.state, 'submitted_uncertain')
      assert.equal(result.uncertain, true)
    } finally {
      observer.dispose()
    }
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14d 答题启动页检测到已答进度时禁止自动返回重进', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let answerLoads = 0
  let reentries = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_detail/index.html') {
        answerLoads++
        await route.fulfill(htmlResponse(`<div class="van-nav-bar"><div class="van-nav-bar__title">记分作业一</div></div>
          <div class="content-area"><div class="skeleton-area van-skeleton">加载中</div></div>
          <div class="van-popup van-popup--bottom"><span class="sub-question has-answered">1</span></div>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      technicalTimeout(waitForNoqrAnswerReady({
        page,
        stopRequested: () => false,
        reenter: async () => {
          reentries++
          await page.reload({ waitUntil: 'domcontentloaded' })
        },
        blankSettleMs: 50,
        skeletonBudgetMs: 50,
      }), '已答进度启动页没有安全停止'),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'answer_interrupted',
    )
    assert.equal(answerLoads, 1)
    assert.equal(reentries, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14e 交卷成功页返回停滞时只重试返回且绝不刷新', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let answerLoads = 0
  let backClicks = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_detail/index.html') {
        answerLoads++
        await route.fulfill(htmlResponse(`<div class="van-nav-bar">
          <div class="van-nav-bar__left" id="back" style="padding:12px" onclick="document.body.dataset.backClicks=String((Number(document.body.dataset.backClicks)||0)+1)">返回</div>
          <div class="van-nav-bar__title">记分作业一</div>
        </div>
        <div class="content-area">
          <div class="question-info"><span class="question-title">合成题</span></div>
          <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item disable-btn">交卷</button></div>
          <div id="countdown">1:59:30</div>
        </div>
        <div class="van-toast--success">交卷成功!</div>
        <script>
          let seconds = 59 * 60 + 30
          setInterval(() => {
            seconds = Math.max(0, seconds - 1)
            const hours = Math.floor(seconds / 3600)
            const minutes = Math.floor((seconds % 3600) / 60)
            const rest = seconds % 60
            document.querySelector('#countdown').textContent =
              hours + ':' + String(minutes).padStart(2, '0') + ':' + String(rest).padStart(2, '0')
          }, 20)
        </script>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      technicalTimeout(returnToNoqrCourseWork(
        page,
        () => false,
        { backRetryQuietMs: 100, maxBackAttempts: 2 },
      ), '返回停滞没有安全收口'),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'page_error',
    )
    backClicks = await page.evaluate(() => Number(document.body.dataset.backClicks) || 0)
    assert.equal(answerLoads, 1)
    assert.equal(backClicks, 2)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14e2 返回期间永久活动请求不能绕过安全上限', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let answerLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_detail/index.html') {
        answerLoads++
        await route.fulfill(htmlResponse(`<div class="van-nav-bar">
          <div class="van-nav-bar__left" id="back" style="padding:12px">返回</div>
          <div class="van-nav-bar__title">记分作业一</div>
        </div>
        <div class="content-area">
          <div class="question-info"><span class="question-title">合成题</span></div>
          <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item disable-btn">交卷</button></div>
        </div>
        <div class="van-toast--success">交卷成功!</div>
        <script>
          document.querySelector('#back').addEventListener('click', () => {
            fetch('/return-hang').catch(() => undefined)
          })
        </script>`))
        return
      }
      if (url.pathname === '/return-hang') return
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      technicalTimeout(returnToNoqrCourseWork(
        page,
        () => false,
        { backRetryQuietMs: 5_000, maxBackAttempts: 3, hardDeadlineMs: 300 },
      ), '永久返回请求没有在安全上限内收口', 1_500),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'answer_interrupted',
    )
    assert.equal(answerLoads, 1)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14e3 返回点击触发永久导航时必须有限收口', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let answerLoads = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_detail/index.html') {
        answerLoads++
        await route.fulfill(htmlResponse(`<div class="van-nav-bar">
          <div class="van-nav-bar__left" id="back" style="padding:12px">返回</div>
          <div class="van-nav-bar__title">记分作业一</div>
        </div>
        <div class="content-area">
          <div class="question-info"><span class="question-title">合成题</span></div>
          <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item disable-btn">交卷</button></div>
        </div>
        <div class="van-toast--success">交卷成功!</div>
        <script>
          document.querySelector('#back').addEventListener('click', () => {
            location.href = '/return-nav-hang'
          })
        </script>`))
        return
      }
      if (url.pathname === '/return-nav-hang') return
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      technicalTimeout(returnToNoqrCourseWork(
        page,
        () => false,
        { backRetryQuietMs: 5_000, maxBackAttempts: 3, hardDeadlineMs: 300 },
      ), '返回点击永久导航没有安全上限', 1_500),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'answer_interrupted',
    )
    assert.equal(answerLoads, 1)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14f 未确认交卷的答题页不允许进入返回流程', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let backClicks = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_detail/index.html') {
        await route.fulfill(htmlResponse(`<div class="van-nav-bar">
          <div class="van-nav-bar__left" id="back">返回</div>
          <div class="van-nav-bar__title">记分作业一</div>
        </div>
        <div class="content-area">
          <div class="question-info"><span class="question-title">合成题</span></div>
          <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item">交卷</button></div>
        </div>
        <script>
          document.querySelector('#back').addEventListener('click', () => {
            window.__backClicks = (window.__backClicks || 0) + 1
          })
        </script>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      returnToNoqrCourseWork(page, () => false),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'answer_interrupted',
    )
    backClicks = await page.evaluate(() => Number((window as { __backClicks?: number }).__backClicks) || 0)
    assert.equal(backClicks, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14f2 只有单一交卷 UI 证据时不允许进入返回流程', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  let backClicks = 0
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_detail/index.html') {
        await route.fulfill(htmlResponse(`<div class="van-nav-bar">
          <div class="van-nav-bar__left" id="back">返回</div>
          <div class="van-nav-bar__title">记分作业一</div>
        </div>
        <div class="content-area">
          <div class="question-info"><span class="question-title">合成题</span></div>
          <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item disable-btn">交卷</button></div>
        </div>
        <script>
          document.querySelector('#back').addEventListener('click', () => {
            window.__backClicks = (window.__backClicks || 0) + 1
          })
        </script>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      returnToNoqrCourseWork(page, () => false),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'answer_interrupted',
    )
    backClicks = await page.evaluate(() => Number((window as { __backClicks?: number }).__backClicks) || 0)
    assert.equal(backClicks, 0)
  } finally {
    await page.close()
    await browser.close()
  }
})

test('T005-RT14g 交卷返回首页后形考入口无响应时必须有界重试', async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage()
  try {
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/course_work_detail/index.html') {
        await route.fulfill(htmlResponse(`<div class="van-nav-bar">
          <div class="van-nav-bar__left" id="back" style="padding:12px">返回</div>
          <div class="van-nav-bar__title">记分作业一</div>
        </div>
        <div class="content-area">
          <div class="question-info"><span class="question-title">合成题</span></div>
          <div class="actions"><button class="btn-item">答题卡</button><button class="btn-item disable-btn">交卷</button></div>
        </div>
        <div class="van-toast--success">交卷成功!</div>
        <script>
          document.querySelector('#back').addEventListener('click', () => {
            location.href = '/index.html'
          })
        </script>`))
        return
      }
      if (url.pathname === '/index.html') {
        await route.fulfill(htmlResponse(`<div class="menu-items">
          <div id="course-work" style="padding:12px"
            onclick="document.body.dataset.entryClicks=String((Number(document.body.dataset.entryClicks)||0)+1)">
            形考作业
          </div>
        </div>`))
        return
      }
      await route.fulfill({ status: 404, body: 'not found' })
    })

    await page.goto(ANSWER_URL, { waitUntil: 'domcontentloaded' })
    await assert.rejects(
      technicalTimeout(returnToNoqrCourseWork(
        page,
        () => false,
        { backRetryQuietMs: 100, maxBackAttempts: 2 },
      ), '首页形考入口无响应时没有有界收口', 2_000),
      (error: unknown) => error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'page_error',
    )
    const entryClicks = await page.evaluate(() => Number(document.body.dataset.entryClicks) || 0)
    assert.equal(entryClicks, 2)
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

test('T005-RT15b 响应体永不结束时必须受安全上限收口', async () => {
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
  const response = {
    request: () => request,
    finished: () => new Promise<void>(() => {}),
    text: async () => '',
    status: () => 200,
  } as unknown as Response

  const observer = new NoqrMutationObserver(page)
  try {
    emit('request', request)
    const observed = observer.findRequestAfter({ after: 0, kinds: ['submit_one'] })
    assert.ok(observed, '未观察到已发出的保存请求')
    emit('response', response)
    const startedAt = Date.now()
    const result = await technicalTimeout(observer.waitForResult(observed, {
      stopRequested: () => false,
      hardDeadlineMs: 200,
    }), '响应体挂起时没有安全上限', 1_500)
    assert.match(result.requestError || '', /安全上限|结果不确定/)
    assert.ok(Date.now() - startedAt < 1_000)
  } finally {
    observer.dispose()
  }
})
