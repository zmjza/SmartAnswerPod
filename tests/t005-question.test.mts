import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { chromium } from 'patchright'
import {
  buildNoqrQuestionIdentity,
  buildNoqrSelectionPlan,
  classifyNoqrQuestion,
  mapNoqrAnswerTexts,
  readNoqrQuestionGroup,
  resolveNoqrAnswers,
  validateNoqrQuestionGroup,
  type NoqrQuestionGroup,
} from '../electron/noqr/question.ts'
import { createReadOnlyBankClient } from '../electron/noqr/bank-readonly.ts'
import { NoqrAiClient } from '../electron/noqr/ai-client.ts'

function launchFixtureBrowser() {
  return chromium.launch(existsSync(chromium.executablePath())
    ? { headless: true }
    : { headless: true, channel: 'chrome' })
}

function group(kind: NoqrQuestionGroup['kind'], units: NoqrQuestionGroup['units'], sharedStem = '共享材料'): NoqrQuestionGroup {
  return {
    kind,
    sharedStem,
    units,
    audioUrl: kind === 'english_listening' ? '/audio-fixture.mp3' : undefined,
  }
}

test('T005-Q01 题型分类覆盖普通题和英语已取证题型，未知文本 fail-closed', () => {
  assert.equal(classifyNoqrQuestion('单选题'), 'single')
  assert.equal(classifyNoqrQuestion('多选题'), 'multiple')
  assert.equal(classifyNoqrQuestion('判断题'), 'judge')
  assert.equal(classifyNoqrQuestion('语法'), 'english_grammar')
  assert.equal(classifyNoqrQuestion('听力理解'), 'english_listening')
  assert.equal(classifyNoqrQuestion('词汇匹配'), 'picker')
  assert.equal(classifyNoqrQuestion('完型填空'), 'english_cloze')
  assert.equal(classifyNoqrQuestion('阅读理解'), 'english_reading')
  assert.equal(classifyNoqrQuestion('自由文本'), 'unknown')
  assert.equal(classifyNoqrQuestion(''), 'unknown')
})

test('T005-Q02 普通题只按当前选项正文唯一映射，多选必须完整集合', () => {
  const single = group('single', [{
    id: 'u1',
    ordinal: 1,
    qtype: 'single',
    stem: '哪个选项正确？',
    options: [
      { index: 0, text: '选项甲' },
      { index: 1, text: '选项乙' },
      { index: 2, text: '选项丙' },
    ],
  }], '')
  assert.deepEqual(mapNoqrAnswerTexts(single, 'u1', ['选项丙']), [2])
  assert.equal(mapNoqrAnswerTexts(single, 'u1', ['不存在']), null)
  assert.equal(mapNoqrAnswerTexts(single, 'u1', ['选项甲', '选项乙']), null)

  const multiple = group('multiple', [{
    id: 'u1',
    ordinal: 1,
    qtype: 'multiple',
    stem: '选择所有正确项',
    options: [
      { index: 0, text: '甲' },
      { index: 1, text: '乙' },
      { index: 2, text: '重复' },
      { index: 3, text: '重复' },
    ],
  }], '')
  assert.deepEqual(mapNoqrAnswerTexts(multiple, 'u1', ['乙', '甲']), [0, 1])
  assert.equal(mapNoqrAnswerTexts(multiple, 'u1', ['重复']), null)
  assert.equal(mapNoqrAnswerTexts(multiple, 'u1', []), null)
})

test('T005-Q03 听力五子题必须完整，题库缺一题不得生成可保存计划', () => {
  const units = Array.from({ length: 5 }, (_, i) => ({
    id: `l${i + 1}`,
    ordinal: i + 1,
    qtype: 'single' as const,
    stem: `听力子题 ${i + 1}`,
    options: [
      { index: 0, text: 'A 内容' },
      { index: 1, text: 'B 内容' },
    ],
  }))
  const listening = group('english_listening', units)
  assert.equal(validateNoqrQuestionGroup(listening).ok, true)
  assert.equal(validateNoqrQuestionGroup({ ...listening, units: units.slice(0, 4) }).ok, false)

  const partial = new Map([
    ['l1', ['A 内容']],
    ['l2', ['B 内容']],
    ['l3', ['A 内容']],
    ['l4', ['B 内容']],
  ])
  assert.equal(buildNoqrSelectionPlan(listening, partial, true), null)
})

test('T005-Q04 Picker 十槽按左侧行顺序映射候选索引', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => ({ index: i, text: `候选 ${i}` }))
  const units = Array.from({ length: 10 }, (_, i) => ({
    id: `p${i + 1}`,
    ordinal: i + 1,
    qtype: 'single' as const,
    stem: `左侧 ${i + 1}`,
    options: candidates,
  }))
  const picker = group('picker', units)
  const answers = new Map(units.map((unit, i) => [unit.id, [`候选 ${9 - i}`]] as const))
  const plan = buildNoqrSelectionPlan(picker, answers, true)
  assert.ok(plan)
  assert.equal(plan.answerSelected, '9,8,7,6,5,4,3,2,1,0')
  assert.equal(plan.filledUnits, 10)
})

test('T005-Q05 完型十空与阅读两组五子题需要一一对应', () => {
  const clozeUnits = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i + 1}`,
    ordinal: i + 1,
    qtype: 'single' as const,
    blankIndex: i + 1,
    stem: '',
    options: [
      { index: 0, text: '甲' },
      { index: 1, text: '乙' },
      { index: 2, text: '丙' },
    ],
  }))
  const cloze = group('english_cloze', clozeUnits)
  assert.equal(validateNoqrQuestionGroup(cloze).ok, true)
  assert.equal(validateNoqrQuestionGroup({
    ...cloze,
    units: cloze.units.map((unit, i) => i === 9 ? { ...unit, blankIndex: 8 } : unit),
  }).ok, false)

  for (const title of ['阅读一', '阅读二']) {
    const reading = group('english_reading', Array.from({ length: 5 }, (_, i) => ({
      id: `${title}-${i + 1}`,
      ordinal: i + 1,
      qtype: 'judge' as const,
      stem: `陈述 ${i + 1}`,
      options: [
        { index: 0, text: '正确' },
        { index: 1, text: '错误' },
      ],
    })), title)
    assert.equal(validateNoqrQuestionGroup(reading).ok, true)
  }
})

test('T005-Q06 复合题身份包含共享材料、子题序号和选项正文且稳定', () => {
  const reading = group('english_reading', [{
    id: 'r1',
    ordinal: 1,
    qtype: 'judge',
    stem: '陈述一',
    options: [
      { index: 0, text: '正确' },
      { index: 1, text: '错误' },
    ],
  }], '阅读材料')
  const a = buildNoqrQuestionIdentity(reading, reading.units[0])
  const b = buildNoqrQuestionIdentity({
    ...reading,
    units: [{ ...reading.units[0], options: [...reading.units[0].options].reverse() }],
  }, {
    ...reading.units[0],
    options: [...reading.units[0].options].reverse(),
  })
  assert.match(a, /^[a-f0-9]{64}$/)
  assert.equal(a, b)
  assert.notEqual(a, buildNoqrQuestionIdentity({ ...reading, sharedStem: '另一材料' }, reading.units[0]))
})

test('T005-Q07 题库只读适配只发 GET，并用严格行结构收口', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const client = createReadOnlyBankClient({
    settings: () => ({ supabase_url: 'https://fixture.supabase.co', supabase_anon: 'fixture-public-key' }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify([{
        id: 'fixture',
        qtype: 'single',
        stem: '合成题干',
        options: ['甲', '乙'],
        answer_texts: ['甲'],
        course_names: ['合成课程'],
      }]), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await client.getByHash('a'.repeat(64))
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.row?.answer_texts[0], '甲')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/rest\/v1\/questions\?/)
  assert.equal(calls[0].init?.method, undefined)

  const bad = createReadOnlyBankClient({
    settings: () => ({ supabase_url: 'https://fixture.supabase.co', supabase_anon: 'fixture-public-key' }),
    fetchImpl: async () => new Response(JSON.stringify({ not: 'array' }), { status: 200 }),
  })
  const badResult = await bad.getByHash('b'.repeat(64))
  assert.equal(badResult.ok, false)
})

test('T005-Q08 AI 独立实例严格匹配正文，失败后实例可重试且不串状态', async () => {
  let calls = 0
  const client = new NoqrAiClient({
    apiKey: () => 'fixture-key',
    models: ['fixture-model'],
    waitSlot: async () => undefined,
    fetchImpl: async () => {
      calls++
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"option_texts":["乙"]}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const first = await client.answerQuestion({
    qtype: 'single',
    stem: '合成题',
    options: ['甲', '乙'],
  })
  assert.equal(first.texts?.[0], '乙')
  assert.equal(first.failed, false)

  const repeated = await client.answerQuestion({
    qtype: 'single',
    stem: '合成题',
    options: ['甲', '乙'],
  })
  assert.equal(repeated.failed, true)
  assert.equal(repeated.skippedAsked, true)
  assert.equal(calls, 1)

  client.retryAsked(first.hash)
  const retried = await client.answerQuestion({
    qtype: 'single',
    stem: '合成题',
    options: ['甲', '乙'],
  })
  assert.equal(retried.failed, false)
  assert.equal(calls, 2)
})

test('T005-Q09 AI 复合组返回编号必须完整、唯一并匹配当前选项正文', async () => {
  const client = new NoqrAiClient({
    apiKey: () => 'fixture-key',
    models: ['fixture-model'],
    waitSlot: async () => undefined,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"option_texts":["1 :: 甲","2 :: 乙"]}' } }],
    }), { status: 200 }),
  })
  const ok = await client.answerGroup({
    shared: '合成共享材料',
    slots: [
      { id: '1', stem: '子题一', options: ['甲', '乙'] },
      { id: '2', stem: '子题二', options: ['甲', '乙'] },
    ],
  })
  assert.deepEqual(ok.selected, { '1': '甲', '2': '乙' })

  const incomplete = new NoqrAiClient({
    apiKey: () => 'fixture-key',
    models: ['fixture-model'],
    waitSlot: async () => undefined,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"option_texts":["1 :: 甲"]}' } }],
    }), { status: 200 }),
  })
  const failed = await incomplete.answerGroup({
    shared: '合成共享材料',
    slots: [
      { id: '1', stem: '子题一', options: ['甲', '乙'] },
      { id: '2', stem: '子题二', options: ['甲', '乙'] },
    ],
  })
  assert.equal(failed.selected, null)
})

test('T005-Q10 稳定答案规划入口优先题库、严格映射并保留 fail-closed 原因', () => {
  const listening = group('english_listening', Array.from({ length: 5 }, (_, i) => ({
    id: `l${i + 1}`,
    ordinal: i + 1,
    qtype: 'single' as const,
    stem: `听力 ${i + 1}`,
    options: [
      { index: 0, text: '甲' },
      { index: 1, text: '乙' },
    ],
  })))
  const candidates = new Map(Array.from({ length: 5 }, (_, i) => [
    `l${i + 1}`,
    i === 0
      ? { bankTexts: ['乙'], aiTexts: ['甲'] }
      : { aiTexts: [i % 2 ? '乙' : '甲'] },
  ]))
  assert.deepEqual(resolveNoqrAnswers(listening, candidates), {
    ok: false,
    reason: '听力题库缺失',
    unitId: 'l2',
  })

  const allBank = new Map(Array.from({ length: 5 }, (_, i) => [
    `l${i + 1}`,
    { bankTexts: [i % 2 ? '乙' : '甲'] },
  ]))
  const plan = resolveNoqrAnswers(listening, allBank)
  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.answerSelected, '0,1,0,1,0')
    assert.equal(plan.answers.length, 5)
    assert.equal(plan.answers.every((answer) => answer.source === 'bank'), true)
  }
})

test('T005-Q11 Patchright 从真实新站 DOM 契约读取当前多选组', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <div class="content-area">
        <div>多选题 <span>2/10</span></div>
        <div class="question-info">
          <span class="question-title">合成多选题干</span>
          <div class="question-options">
            <div role="checkbox" aria-checked="false" class="option-item van-checkbox" data-index="0">
              <span class="van-checkbox__label">A. 选项甲</span>
            </div>
            <div role="checkbox" aria-checked="true" class="option-item van-checkbox" data-index="1">
              <span class="van-checkbox__label">B. 选项乙</span>
            </div>
          </div>
        </div>
      </div>
    `)
    const result = await readNoqrQuestionGroup(page)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.group.kind, 'multiple')
      assert.equal(result.group.position, 2)
      assert.equal(result.group.total, 10)
      assert.deepEqual(result.group.units[0].options, [
        { index: 0, text: '选项甲' },
        { index: 1, text: '选项乙' },
      ])
    }
  } finally {
    await browser.close()
  }
})

test('T005-Q12 Picker 读取通过真实弹层读取候选并取消，不改变答案', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    const rows = Array.from({ length: 10 }, (_, i) => `
      <div role="button" class="van-cell van-cell--clickable van-field">
        <div class="van-field__label"><span>左侧 ${i + 1}</span></div>
        <input type="text" name="picker" readonly value="">
      </div>
    `).join('')
    const candidates = Array.from({ length: 10 }, (_, i) =>
      `<div class="van-picker-column__item">候选 ${i + 1}</div>`).join('')
    await page.setContent(`
      <div class="content-area">
        <div>词汇匹配 1/1</div>
        <div class="question-info">
          <span class="question-title">合成词汇匹配</span>
          <div class="question-options"><div class="van-cell-group">${rows}</div></div>
        </div>
      </div>
      <div class="van-picker" style="display:none">
        <div class="van-picker__columns">${candidates}</div>
        <button class="van-picker__cancel">取消</button>
        <button class="van-picker__confirm">确认</button>
      </div>
      <script>
        document.querySelector('.van-field').addEventListener('click', () => {
          document.querySelector('.van-picker').style.display = 'block'
        })
        document.querySelector('.van-picker__cancel').addEventListener('click', () => {
          document.querySelector('.van-picker').style.display = 'none'
        })
      </script>
    `)
    const result = await readNoqrQuestionGroup(page)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.group.kind, 'picker')
      assert.equal(result.group.units.length, 10)
      assert.equal(result.group.units[0].options[9].text, '候选 10')
      assert.equal(await page.locator('input[name="picker"]').first().inputValue(), '')
      assert.equal(await page.locator('.van-picker').isVisible(), false)
    }
  } finally {
    await browser.close()
  }
})
