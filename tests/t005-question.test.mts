import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { chromium } from 'patchright'
import {
  buildNoqrQuestionIdentity,
  buildNoqrQuestionIdentityCandidates,
  buildNoqrSelectionPlan,
  classifyNoqrQuestion,
  mapNoqrAnswerTexts,
  readNoqrQuestionGroup,
  resolveNoqrAnswers,
  validateNoqrQuestionGroup,
  type NoqrQuestionGroup,
} from '../electron/noqr/question.ts'
import { answerNoqrGroup } from '../electron/noqr/answer.ts'
import { createReadOnlyBankClient, type ReadOnlyBankClient } from '../electron/noqr/bank-readonly.ts'
import { NoqrAiClient } from '../electron/noqr/ai-client.ts'
import { contentHash, englishMatchStem, englishSlotStem } from '../electron/core/hash.ts'

function frozenLegacyHash(qtype: 'single' | 'multiple' | 'judge', stem: string, options: string[]): string {
  return createHash('sha256')
    .update(`${qtype}\n${stem}\n${[...options].sort().join('\n')}`, 'utf8')
    .digest('hex')
}

function launchFixtureBrowser() {
  return chromium.launch(existsSync(chromium.executablePath())
    ? { headless: true }
    : { headless: true, channel: 'chrome' })
}

async function closeFixtureBrowser(browser: Awaited<ReturnType<typeof launchFixtureBrowser>>) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) await page.close().catch(() => {})
    await context.close().catch(() => {})
  }
  await browser.close().catch(() => {})
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

test('T007-Q01 语法/完型/阅读身份与旧题库构造兼容且普通题哈希不变', () => {
  const options = [
    { index: 0, text: '甲' },
    { index: 1, text: '乙' },
  ]
  const grammarUnit = {
    id: 'g1',
    ordinal: 1,
    qtype: 'single' as const,
    stem: '语法子题',
    options,
  }
  const grammar = {
    ...group('english_grammar', [grammarUnit], '语法材料'),
    rawTypeCode: '1',
  }
  assert.equal(
    buildNoqrQuestionIdentity(grammar, grammarUnit),
    contentHash('single', grammarUnit.stem, options.map((option) => option.text)),
  )
  assert.notEqual(
    buildNoqrQuestionIdentity(grammar, grammarUnit),
    contentHash('single', englishSlotStem('语法材料', 8, 1, grammarUnit.stem), options.map((option) => option.text)),
  )

  const clozeUnit = {
    id: 'c1',
    ordinal: 1,
    qtype: 'single' as const,
    stem: '第 1 空',
    blankIndex: 1,
    options,
  }
  const cloze = {
    ...group('english_cloze', [clozeUnit], '完型材料'),
    rawTypeCode: '9',
  }
  assert.equal(
    buildNoqrQuestionIdentity(cloze, clozeUnit),
    contentHash('single', englishSlotStem('完型材料', 9, 1, clozeUnit.stem), options.map((option) => option.text)),
  )

  const readingUnit = {
    id: 'r1',
    ordinal: 1,
    qtype: 'judge' as const,
    stem: '阅读子题',
    options: [
      { index: 0, text: '正确' },
      { index: 1, text: '错误' },
    ],
  }
  const reading = {
    ...group('english_reading', [readingUnit], '阅读材料'),
    rawTypeCode: '8',
  }
  assert.equal(
    buildNoqrQuestionIdentity(reading, readingUnit),
    contentHash('judge', englishSlotStem('阅读材料', 8, 1, readingUnit.stem),
      readingUnit.options.map((option) => option.text)),
  )

  const ordinaryUnit = {
    id: 's1',
    ordinal: 1,
    qtype: 'single' as const,
    stem: '普通题干',
    options,
  }
  const ordinary = group('single', [ordinaryUnit], '')
  assert.equal(
    buildNoqrQuestionIdentity(ordinary, ordinaryUnit),
    contentHash('single', ordinaryUnit.stem, options.map((option) => option.text)),
  )
})

test('T007-Q02 听力 11 与 Picker 7 的现有兼容身份保持不变', () => {
  const options = [
    { index: 0, text: '甲' },
    { index: 1, text: '乙' },
  ]
  const listeningUnit = {
    id: 'l1',
    ordinal: 1,
    qtype: 'single' as const,
    stem: '听力子题',
    options,
  }
  const listening = {
    ...group('english_listening', [listeningUnit], '听力材料'),
    rawTypeCode: '11',
  }
  assert.equal(
    buildNoqrQuestionIdentity(listening, listeningUnit),
    contentHash('single', englishSlotStem('听力材料', 11, 1, listeningUnit.stem),
      options.map((option) => option.text)),
  )

  const pickerUnit = {
    id: 'p1',
    ordinal: 1,
    qtype: 'single' as const,
    stem: '左侧词条',
    options,
  }
  const picker = {
    ...group('picker', [pickerUnit], '共享词表'),
    rawTypeCode: '7',
  }
  assert.equal(
    buildNoqrQuestionIdentity(picker, pickerUnit),
    contentHash('single', englishMatchStem('共享词表', 1, pickerUnit.stem),
      options.map((option) => option.text)),
  )
})

test('T007-Q02b 复合题兼容身份候选有界且不改变主身份顺序', () => {
  const options = [
    { index: 0, text: '甲' },
    { index: 1, text: '乙' },
  ]
  const pickerUnit = {
    id: 'p1',
    ordinal: 1,
    qtype: 'single' as const,
    stem: '左侧词条',
    options,
  }
  const picker = {
    ...group('picker', [pickerUnit], '共享词表'),
    rawTypeCode: '7',
  }
  const pickerCandidates = buildNoqrQuestionIdentityCandidates(picker, pickerUnit)
  assert.equal(pickerCandidates[0], buildNoqrQuestionIdentity(picker, pickerUnit))
  assert.equal(new Set(pickerCandidates).size, pickerCandidates.length)
  assert.equal(
    pickerCandidates.includes(contentHash('single', pickerUnit.stem, options.map((option) => option.text))),
    false,
    'Picker 不得使用丢弃共享词表和槽位的普通题 alias',
  )
  assert.ok(pickerCandidates.length <= 8, 'Picker 候选必须有硬上限')

  const clozeUnit = {
    id: 'c1',
    ordinal: 3,
    blankIndex: 4,
    qtype: 'single' as const,
    stem: '',
    options,
  }
  const cloze = {
    ...group('english_cloze', [clozeUnit], '完型材料'),
    sharedStemCandidates: Array.from({ length: 8 }, (_, index) => `仅正文材料-${index + 1}`),
    rawTypeCode: '1',
  }
  const clozeCandidates = buildNoqrQuestionIdentityCandidates(cloze, clozeUnit)
  assert.equal(clozeCandidates[0], buildNoqrQuestionIdentity(cloze, clozeUnit))
  assert.equal(new Set(clozeCandidates).size, clozeCandidates.length)
  assert.ok(clozeCandidates.length <= 8, 'Cloze 候选必须有硬上限')
  assert.equal(
    clozeCandidates.includes(contentHash(
      'single',
      englishSlotStem('仅正文材料-1', 9, 4, ''),
      options.map((option) => option.text),
    )),
    true,
  )
  assert.equal(
    clozeCandidates.includes(contentHash(
      'single',
      englishSlotStem('完型材料', 8, 3, ''),
      options.map((option) => option.text),
    )),
    false,
    'Cloze 不得无条件生成阅读题 8 的身份候选',
  )
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
        conflict: false,
      }]), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await client.getByHash('a'.repeat(64))
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.row?.answer_texts[0], '甲')
  assert.equal(result.ok && result.row?.conflict, false)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/rest\/v1\/questions\?/)
  assert.equal(new URL(calls[0].url).searchParams.get('select')?.split(',').includes('conflict'), true)
  assert.equal(calls[0].init?.method, undefined)

  const bad = createReadOnlyBankClient({
    settings: () => ({ supabase_url: 'https://fixture.supabase.co', supabase_anon: 'fixture-public-key' }),
    fetchImpl: async () => new Response(JSON.stringify({ not: 'array' }), { status: 200 }),
  })
  const badResult = await bad.getByHash('b'.repeat(64))
  assert.equal(badResult.ok, false)
})

test('T007-Q03d getByHash 查询至少两行，发现同 hash 多行后 fail-closed', async () => {
  const hash = 'e'.repeat(64)
  const calls: string[] = []
  const base = {
    qtype: 'single' as const,
    stem: '合成重复身份题',
    options: ['甲', '乙'],
    answer_texts: ['甲'],
    course_names: ['合成课程'],
    conflict: false,
  }
  const client = createReadOnlyBankClient({
    settings: () => ({ supabase_url: 'https://fixture.supabase.co', supabase_anon: 'fixture-public-key' }),
    fetchImpl: async (url) => {
      calls.push(String(url))
      const limit = Number(new URL(String(url)).searchParams.get('limit') || 0)
      return new Response(JSON.stringify([
        { id: 'fixture-row-1', ...base },
        { id: 'fixture-row-2', ...base },
      ].slice(0, Math.max(0, limit))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const result = await client.getByHash(hash)
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /不唯一/)
  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0]).searchParams.get('limit'), '2')
})

test('T007-Q03a 多候选题库查询批量、去重、缓存并记录脱敏统计', async () => {
  const rows = [
    { qtype: 'single' as const, stem: '合成批量题一', options: ['甲', '乙'], answer_texts: ['甲'] },
    { qtype: 'single' as const, stem: '合成批量题二', options: ['丙', '丁'], answer_texts: ['丁'] },
    { qtype: 'single' as const, stem: '合成批量题三', options: ['戊', '己'], answer_texts: ['戊'] },
  ]
  const hashes = rows.map((row) => contentHash(row.qtype, row.stem, row.options))
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = createReadOnlyBankClient({
    maxRequests: 2,
    settings: () => ({ supabase_url: 'https://fixture.supabase.co', supabase_anon: 'fixture-public-key' }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(rows.map((row, index) => ({
        id: `fixture-${index}`,
        ...row,
        course_names: [],
        conflict: false,
        content_hash: hashes[index],
      }))), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const first = await client.getByHashes([...hashes, hashes[0]])
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.rows.length, 3)
  assert.equal(first.conflicts, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init?.method, undefined)
  assert.equal(
    new URL(calls[0].url).searchParams.get('content_hash'),
    `in.(${hashes.join(',')})`,
  )

  const cached = await client.getByHashes(hashes)
  assert.equal(cached.ok, true)
  assert.equal(calls.length, 1, '重复候选必须命中本地缓存，不产生额外 GET')
  const stats = client.queryStats()
  assert.equal(stats.requests, 1)
  assert.equal(stats.hashLookups, 6)
  assert.equal(stats.cacheHits, 3)
  assert.equal(stats.hitHashes, 3)
  assert.equal(stats.conflictHashes, 0)
})

test('T007-Q03b 题库实例强制执行作业级只读查询预算', async () => {
  let calls = 0
  const client = createReadOnlyBankClient({
    maxRequests: 1,
    settings: () => ({ supabase_url: 'https://fixture.supabase.co', supabase_anon: 'fixture-public-key' }),
    fetchImpl: async () => {
      calls++
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const first = await client.getByHashes(['a'.repeat(64)])
  assert.equal(first.ok, true)
  const second = await client.getByHashes(['b'.repeat(64)])
  assert.equal(second.ok, false)
  if (!second.ok) assert.match(second.error, /查询预算/)
  assert.equal(calls, 1)
  assert.equal(client.queryStats().budgetExceeded, 1)
})

test('T007-Q03 conflict=true 不提供可靠命中，由上层转 AI', async () => {
  let calls = 0
  const client = createReadOnlyBankClient({
    settings: () => ({ supabase_url: 'https://fixture.supabase.co', supabase_anon: 'fixture-public-key' }),
    fetchImpl: async (_url, init) => {
      calls++
      assert.equal(init?.method, undefined)
      return new Response(JSON.stringify([{
        id: 'fixture-conflict',
        qtype: 'single',
        stem: '合成题干',
        options: ['甲', '乙'],
        answer_texts: ['甲'],
        course_names: ['合成课程'],
        conflict: true,
      }]), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  assert.deepEqual(await client.getByHash('c'.repeat(64)), { ok: true, row: null })
  assert.equal(calls, 1)
})

test('T007-Q03c 普通题冲突候选由上层安全转 AI，不使用冲突答案', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    const selectRadio = "onclick=\"this.closest('[role=radiogroup]').querySelectorAll('.option-item').forEach(n=>n.setAttribute('aria-checked','false'));this.setAttribute('aria-checked','true')\""
    await page.setContent(`
      <div class="content-area">
        <div>单选题 1/1</div>
        <div class="question-info" data-question-id="q-fixture" data-big-question-id="b-fixture">
          <span class="question-title">合成冲突题</span>
          <div class="question-options">
            <div role="radiogroup">
              <div role="radio" class="option-item" aria-checked="false" ${selectRadio}><span>A. 甲</span></div>
              <div role="radio" class="option-item" aria-checked="false" ${selectRadio}><span>B. 乙</span></div>
            </div>
          </div>
        </div>
      </div>
    `)
    const bank = {
      getByHashes: async () => ({ ok: true as const, rows: [], conflicts: 1 }),
    } as unknown as ReadOnlyBankClient
    let aiCalls = 0
    const ai = {
      answerQuestion: async () => {
        aiCalls++
        return { hash: 'fixture', texts: ['乙'], failed: false, attempts: [] }
      },
      answerGroup: async () => ({ selected: null, attempts: [], failedReason: 'not used' }),
      retryAsked: () => undefined,
    } as unknown as NoqrAiClient

    const result = await answerNoqrGroup({
      page,
      bank,
      ai,
      stopRequested: () => false,
    })
    assert.equal(aiCalls, 1)
    assert.equal(result.bankCount, 0)
    assert.equal(result.aiCount, 1)
    assert.equal(
      await page.locator('.option-item[aria-checked="true"]').first().textContent(),
      'B. 乙',
    )
  } finally {
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q03c2 客观题库行缺少选项时不得冒充命中，必须安全转 AI', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    const selectRadio = "onclick=\"this.closest('[role=radiogroup]').querySelectorAll('.option-item').forEach(n=>n.setAttribute('aria-checked','false'));this.setAttribute('aria-checked','true')\""
    await page.setContent(`
      <div class="content-area">
        <div>单选题 1/1</div>
        <div class="question-info" data-question-id="q-missing-options" data-big-question-id="b-missing-options">
          <span class="question-title">合成缺选项题库行</span>
          <div class="question-options">
            <div role="radiogroup">
              <div role="radio" class="option-item" aria-checked="false" ${selectRadio}><span>A. 甲</span></div>
              <div role="radio" class="option-item" aria-checked="false" ${selectRadio}><span>B. 乙</span></div>
            </div>
          </div>
        </div>
      </div>
    `)
    const bank = {
      getByHashes: async () => ({
        ok: true as const,
        rows: [{
          qtype: 'single' as const,
          options: [],
          answer_texts: ['甲'],
        }],
        conflicts: 0,
      }),
    } as unknown as ReadOnlyBankClient
    let aiCalls = 0
    const ai = {
      answerQuestion: async () => {
        aiCalls++
        return { hash: 'fixture', texts: ['乙'], failed: false, attempts: [] }
      },
      answerGroup: async () => ({ selected: null, attempts: [], failedReason: 'not used' }),
      retryAsked: () => undefined,
    } as unknown as NoqrAiClient

    const result = await answerNoqrGroup({
      page,
      bank,
      ai,
      stopRequested: () => false,
    })
    assert.equal(result.bankCount, 0)
    assert.equal(result.aiCount, 1)
    assert.equal(aiCalls, 1)
    assert.equal(
      await page.locator('.option-item[aria-checked="true"]').first().textContent(),
      'B. 乙',
    )
  } finally {
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q03b conflict 缺失或非法时 fail-closed，多行结果也不得采纳', async () => {
  const base = {
    id: 'fixture-row',
    qtype: 'single',
    stem: '合成题干',
    options: ['甲', '乙'],
    answer_texts: ['甲'],
    course_names: ['合成课程'],
  }
  for (const payload of [
    [base],
    [{ ...base, conflict: 'false' }],
    [{ ...base, conflict: false }, { ...base, id: 'fixture-row-2', conflict: false }],
  ]) {
    const client = createReadOnlyBankClient({
      settings: () => ({ supabase_url: 'https://fixture.supabase.co', supabase_anon: 'fixture-public-key' }),
      fetchImpl: async (_url, init) => {
        assert.equal(init?.method, undefined)
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const result = await client.getByHash('d'.repeat(64))
    assert.equal(result.ok, false)
  }
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
    await closeFixtureBrowser(browser)
  }
})

test('T005-Q11b 复合子题缺少独立 ID 时继承父题可校验身份', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <div class="content-area">
        <div>阅读理解 1/2</div>
        <div class="question-info" data-big-question-id="bg-parent" data-question-id="q-parent">
          <span class="question-title">共享材料</span>
          <div class="sub-questions">
            <div class="sub-item" data-question-id="q-child-1">
              <span class="question-title">子题一</span>
              <div class="question-options">
                <div role="radio" aria-checked="false" class="option-item" data-index="1"><span>A. 正确</span></div>
                <div role="radio" aria-checked="false" class="option-item" data-index="0"><span>B. 错误</span></div>
              </div>
            </div>
            <div class="sub-item">
              <span class="question-title">子题二</span>
              <div class="question-options">
                <div role="radio" aria-checked="false" class="option-item" data-index="1"><span>A. 正确</span></div>
                <div role="radio" aria-checked="false" class="option-item" data-index="0"><span>B. 错误</span></div>
              </div>
            </div>
            <div class="sub-item">
              <span class="question-title">子题三</span>
              <div class="question-options">
                <div role="radio" aria-checked="false" class="option-item" data-index="1"><span>A. 正确</span></div>
                <div role="radio" aria-checked="false" class="option-item" data-index="0"><span>B. 错误</span></div>
              </div>
            </div>
            <div class="sub-item">
              <span class="question-title">子题四</span>
              <div class="question-options">
                <div role="radio" aria-checked="false" class="option-item" data-index="1"><span>A. 正确</span></div>
                <div role="radio" aria-checked="false" class="option-item" data-index="0"><span>B. 错误</span></div>
              </div>
            </div>
            <div class="sub-item">
              <span class="question-title">子题五</span>
              <div class="question-options">
                <div role="radio" aria-checked="false" class="option-item" data-index="1"><span>A. 正确</span></div>
                <div role="radio" aria-checked="false" class="option-item" data-index="0"><span>B. 错误</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `)
    const result = await readNoqrQuestionGroup(page)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.group.units[0]?.bigQuestionId, 'bg-parent')
    assert.equal(result.group.units[0]?.questionId, 'q-child-1')
    assert.equal(result.group.units[1]?.bigQuestionId, 'bg-parent')
    assert.equal(result.group.units[1]?.questionId, 'q-parent')
    assert.equal(result.group.units.length, 5)
  } finally {
    await closeFixtureBrowser(browser)
  }
})

function readingSubItem(
  ordinal: number,
  options: { role: 'radio' | 'checkbox'; text: string }[],
): string {
  return `<div class="sub-item">
    <span class="question-title">阅读子题 ${ordinal}</span>
    <div class="question-options">
      ${options.map((option, index) =>
        `<div role="${option.role}" aria-checked="false" class="option-item" data-index="${index}">
          <span>${String.fromCharCode(65 + index)}. ${option.text}</span>
        </div>`).join('')}
    </div>
  </div>`
}

test('T007-Q04 阅读子题按实际控件与选项判型，阅读单选不强制 judge', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    const subItems = [
      readingSubItem(1, [{ role: 'radio', text: '甲' }, { role: 'radio', text: '乙' }]),
      readingSubItem(2, [{ role: 'checkbox', text: '甲' }, { role: 'checkbox', text: '乙' }]),
      readingSubItem(3, [{ role: 'radio', text: '正确' }, { role: 'radio', text: '错误' }]),
      readingSubItem(4, [{ role: 'checkbox', text: '正确' }, { role: 'checkbox', text: '错误' }]),
      readingSubItem(5, [{ role: 'radio', text: '丙' }, { role: 'radio', text: '丁' }]),
    ].join('')
    await page.setContent(`
      <div class="content-area">
        <div>阅读理解 1/2</div>
        <div data-questiontype="8">
          <div class="question-info">
            <span class="question-title">共享阅读材料</span>
            <div class="sub-questions">${subItems}</div>
          </div>
        </div>
      </div>
    `)
    const result = await readNoqrQuestionGroup(page)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.group.kind, 'english_reading')
    assert.equal(result.group.rawTypeCode, '8')
    assert.deepEqual(result.group.units.map((unit) => unit.qtype), [
      'single',
      'multiple',
      'judge',
      'multiple',
      'single',
    ])
  } finally {
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q05 阅读子题控件角色不一致时 fail-closed', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    const subItems = [
      readingSubItem(1, [{ role: 'radio', text: '甲' }, { role: 'checkbox', text: '乙' }]),
      ...Array.from({ length: 4 }, (_, index) =>
        readingSubItem(index + 2, [{ role: 'radio', text: '甲' }, { role: 'radio', text: '乙' }])),
    ].join('')
    await page.setContent(`
      <div class="content-area">
        <div>阅读理解 1/2</div>
        <div class="question-info" data-questiontype="8">
          <span class="question-title">共享阅读材料</span>
          <div class="sub-questions">${subItems}</div>
        </div>
      </div>
    `)
    const result = await readNoqrQuestionGroup(page)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /题型无法确定/)
  } finally {
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q05b 任何主观文本或文件控件都必须整份作业 fail-closed', async () => {
  const browser = await launchFixtureBrowser()
  const controls = [
    ['textarea', '<textarea>文本</textarea>'],
    ['contenteditable', '<div contenteditable="true">文本</div>'],
    ['text input', '<input type="text" value="文本">'],
    ['file input', '<input type="file">'],
  ] as const
  try {
    const page = await browser.newPage()
    for (const [label, control] of controls) {
      await page.setContent(`
        <div class="content-area">
          <div>单选题 1/1</div>
          <div class="question-info">
            <span class="question-title">客观题外壳</span>
            <div class="question-options">
              <div role="radio" aria-checked="false" class="option-item" data-index="0">
                <span>A. 选项甲</span>
              </div>
              <div role="radio" aria-checked="false" class="option-item" data-index="1">
                <span>B. 选项乙</span>
              </div>
            </div>
            <div class="van-uploader">${control}</div>
          </div>
        </div>
      `)
      const result = await readNoqrQuestionGroup(page)
      assert.equal(result.ok, false, `${label} 未被隔离`)
      if (!result.ok) assert.match(result.reason, /主观|仅支持客观题/, `${label} 隔离原因不明确`)
    }
  } finally {
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q05b-file 独立可见文件输入也必须整份作业 fail-closed', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <div class="content-area">
        <div>单选题 1/1</div>
        <div class="question-info">
          <span class="question-title">客观题外壳</span>
          <div class="question-options">
            <div role="radio" aria-checked="false" class="option-item"><span>A. 甲</span></div>
            <div role="radio" aria-checked="false" class="option-item"><span>B. 乙</span></div>
          </div>
          <input type="file">
        </div>
      </div>
    `)
    const result = await readNoqrQuestionGroup(page)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'unsupported_non_objective')
      assert.match(result.reason, /主观|仅支持客观题/)
    }
  } finally {
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q05b-outer 题面容器内的主观控件不能因位于 question-info 外而漏检', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <div class="content-area">
        <div class="question-info">
          <span class="question-title">客观题外壳</span>
          <div class="question-options">
            <div role="radio" aria-checked="false" class="option-item"><span>A. 甲</span></div>
            <div role="radio" aria-checked="false" class="option-item"><span>B. 乙</span></div>
          </div>
        </div>
        <input type="text" value="题面外的文本控件">
      </div>
    `)
    const result = await readNoqrQuestionGroup(page)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'unsupported_non_objective')
      assert.match(result.reason, /主观|仅支持客观题/)
    }
  } finally {
    await closeFixtureBrowser(browser)
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
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q01a Picker DOM 前缀按旧题库口径规范化，I/J 候选也可命中', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    const leftItems = Array.from({ length: 10 }, (_, index) => {
      const label = index === 0 ? '1) chess' : `${index + 1}. item-${index + 1}`
      return `
        <div role="button" class="van-cell van-cell--clickable van-field">
          <div class="van-field__label"><span>${label}</span></div>
          <input type="text" name="picker" readonly value="">
        </div>`
    }).join('')
    const candidateTexts = Array.from({ length: 10 }, (_, index) =>
      `${String.fromCharCode(65 + index)}. value-${index + 1}`)
    const candidates = candidateTexts
      .map((text) => `<div class="van-picker-column__item">${text}</div>`)
      .join('')
    await page.setContent(`
      <div class="content-area">
        <div>词汇匹配 1/1</div>
        <div class="question-info">
          <span class="question-title">Legacy shared vocabulary</span>
          <div class="question-options"><div class="van-cell-group">${leftItems}</div></div>
        </div>
      </div>
      <div class="van-picker" style="display:none">
        <div class="van-picker-column__columns">${candidates}</div>
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
    if (!result.ok) return
    assert.equal(result.group.units[0].stem, 'chess')
    assert.deepEqual(
      result.group.units[0].options.map((option) => option.text),
      candidateTexts.map((_, index) => `value-${index + 1}`),
    )
    const expectedStem = 'Legacy shared vocabulary [匹配槽 1] chess'
    assert.equal(
      buildNoqrQuestionIdentity(result.group, result.group.units[0]),
      frozenLegacyHash(
        'single',
        expectedStem,
        Array.from({ length: 10 }, (_, index) => `value-${index + 1}`),
      ),
    )
    assert.equal(await page.locator('.van-picker').isVisible(), false)
  } finally {
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q01a2 Picker 规范化候选可通过带字母前缀的弹层完成真实选择', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    const leftItems = Array.from({ length: 10 }, (_, index) => `
      <div role="button" class="van-cell van-cell--clickable van-field">
        <div class="van-field__label"><span>left-${index + 1}</span></div>
        <input type="text" name="picker" readonly value="">
      </div>`).join('')
    const candidateTexts = Array.from({ length: 10 }, (_, index) =>
      `${String.fromCharCode(65 + index)}. value-${index + 1}`)
    const candidates = candidateTexts
      .map((text) => `<div class="van-picker-column__item">${text}</div>`)
      .join('')
    await page.setContent(`
      <div class="content-area">
        <div>词汇匹配 1/1</div>
        <div class="question-info">
          <span class="question-title">Synthetic vocabulary bank</span>
          <div class="question-options"><div class="van-cell-group">${leftItems}</div></div>
        </div>
      </div>
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
        document.querySelectorAll('.van-picker-column__item').forEach((item) => {
          item.addEventListener('click', () => {
            document.querySelectorAll('.van-picker-column__item').forEach((node) =>
              node.classList.remove('van-picker-column__item--selected'))
            item.classList.add('van-picker-column__item--selected')
            pendingValue = item.textContent.trim()
          })
        })
        document.querySelector('.van-picker__confirm').addEventListener('click', () => {
          if (activeRow) activeRow.querySelector('input').value = pendingValue
          document.querySelector('.van-picker').style.display = 'none'
        })
        document.querySelector('.van-picker__cancel').addEventListener('click', () => {
          document.querySelector('.van-picker').style.display = 'none'
        })
      </script>
    `)
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return

    const selectedText = read.group.units[0].options[9].text
    const hashToAnswer = new Map(read.group.units.map((unit) => [
      buildNoqrQuestionIdentity(read.group, unit),
      [selectedText],
    ]))
    const rowForHash = (hash: string) => hashToAnswer.has(hash)
      ? {
          id: 'fixture',
          qtype: 'single' as const,
          stem: 'fixture',
          options: candidateTexts,
          answer_texts: hashToAnswer.get(hash)!,
          course_names: [],
          conflict: false,
          content_hash: hash,
        }
      : null
    const batchSizes: number[] = []
    const bank = {
      getByHashes: async (hashes: string[]) => {
        batchSizes.push(hashes.length)
        return {
          ok: true as const,
          rows: hashes.map(rowForHash).filter((row) => row !== null),
          conflicts: 0,
        }
      },
      getByHash: async (hash: string) => ({ ok: true as const, row: rowForHash(hash) }),
      queryStats: () => ({
        requests: batchSizes.length,
        hashLookups: batchSizes.reduce((sum, count) => sum + count, 0),
        cacheHits: 0,
        hitHashes: 10,
        missHashes: 0,
        conflictHashes: 0,
        budgetExceeded: 0,
      }),
    } as unknown as ReadOnlyBankClient
    const ai = {
      answerQuestion: async () => ({ hash: 'fixture', texts: null, failed: true, attempts: [] }),
      answerGroup: async () => ({ selected: null, attempts: [], failedReason: 'not used' }),
      retryAsked: () => undefined,
    } as unknown as NoqrAiClient

    const progressMessages: string[] = []
    const answered = await answerNoqrGroup({
      page,
      bank,
      ai,
      stopRequested: () => false,
      onProgress: (progress) => progressMessages.push(progress.message),
    })
    assert.equal(answered.answerSelected, Array.from({ length: 10 }, () => '9').join(','))
    assert.deepEqual(
      await page.locator('input[name="picker"]').evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLInputElement).value)),
      Array.from({ length: 10 }, () => candidateTexts[9]),
    )
    assert.equal(batchSizes.length, 10, 'Picker 每个槽位应只发出一次批量只读查询')
    assert.ok(batchSizes.every((count) => count <= 8), '单题候选查询必须受硬上限约束')
    assert.equal(progressMessages.some((message) => message.includes('GET 10')), true)
  } finally {
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q01a3 同一题位候选答案冲突时转 AI，AI 失败仍 fail-closed', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    const spaces = Array.from({ length: 10 }, (_, index) =>
      `<span class="spaceIndex" index="${index + 1}">blank-${index + 1}</span>`).join('')
    const subItems = Array.from({ length: 10 }, (_, index) => `
      <div class="sub-item">
        <span class="question-title"></span>
        <div class="question-options">
          <div role="radiogroup">
            <div role="radio" class="option-item"><span>A. 甲</span></div>
            <div role="radio" class="option-item"><span>B. 乙</span></div>
            <div role="radio" class="option-item"><span>C. 丙</span></div>
          </div>
        </div>
      </div>`).join('')
    await page.setContent(`
      <div class="content-area">
        <div>完型填空 1/1</div>
        <div data-questiontype="9">
          <div class="question-info">
            <span class="question-title"><p>Synthetic cloze passage ${spaces}</p></span>
            <div class="sub-questions">${subItems}</div>
          </div>
        </div>
      </div>
    `)
    const read = await readNoqrQuestionGroup(page)
    assert.equal(read.ok, true)
    if (!read.ok) return

    const hashToAnswer = new Map<string, string[]>()
    for (const unit of read.group.units) {
      buildNoqrQuestionIdentityCandidates(read.group, unit).forEach((hash, index) => {
        hashToAnswer.set(hash, [index % 2 === 0 ? '甲' : '乙'])
      })
    }
    const rowForHash = (hash: string) => hashToAnswer.has(hash)
      ? {
          id: 'fixture',
          qtype: 'single' as const,
          stem: 'fixture',
          options: [],
          answer_texts: hashToAnswer.get(hash)!,
          course_names: [],
          conflict: false,
          content_hash: hash,
        }
      : null
    const bank = {
      getByHashes: async (hashes: string[]) => ({
        ok: true as const,
        rows: hashes.map(rowForHash).filter((row) => row !== null),
        conflicts: 0,
      }),
      getByHash: async (hash: string) => ({ ok: true as const, row: rowForHash(hash) }),
    } as unknown as ReadOnlyBankClient
    let aiCalls = 0
    const ai = {
      answerQuestion: async () => ({ hash: 'fixture', texts: null, failed: true, attempts: [] }),
      answerGroup: async () => {
        aiCalls++
        throw new Error('fixture AI fallback')
      },
      retryAsked: () => undefined,
    } as unknown as NoqrAiClient

    await assert.rejects(
      answerNoqrGroup({ page, bank, ai, stopRequested: () => false }),
      /fixture AI fallback/,
    )
    assert.equal(aiCalls, 1, 'conflict candidates must be handed to AI fallback')
  } finally {
    await closeFixtureBrowser(browser)
  }
})

test('T007-Q01b Cloze 优先采用外层真实 9，不被内层普通题型码覆盖', async () => {
  const browser = await launchFixtureBrowser()
  try {
    const page = await browser.newPage()
    const spaces = Array.from({ length: 10 }, (_, index) =>
      `<span class="spaceIndex" index="${index + 1}">blank-${index + 1}</span>`).join('')
    const subItems = Array.from({ length: 10 }, (_, index) => `
      <div class="sub-item">
        <span class="question-title"></span>
        <div class="question-options">
          <div role="radiogroup">
            <div role="radio" class="option-item"><span>A. opt-a-${index + 1}</span></div>
            <div role="radio" class="option-item"><span>B. opt-b-${index + 1}</span></div>
            <div role="radio" class="option-item"><span>C. opt-c-${index + 1}</span></div>
          </div>
        </div>
      </div>`).join('')
    await page.setContent(`
      <div class="content-area">
        <div>完型填空 1/1</div>
        <div data-questiontype="9">
          <div data-questiontype="1">
            <div class="question-info">
              <span class="question-title">
                <p>Legacy instruction paragraph</p>
                <p>Legacy cloze passage ${spaces}</p>
              </span>
              <div class="sub-questions">${subItems}</div>
            </div>
          </div>
        </div>
      </div>
    `)
    const result = await readNoqrQuestionGroup(page)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.group.kind, 'english_cloze')
    assert.equal(result.group.rawTypeCode, '9')
    assert.equal(
      result.group.sharedStemCandidates?.some((value) => value.startsWith('Legacy cloze passage')),
      true,
    )
    assert.equal(
      result.group.sharedStemCandidates?.some((value) =>
        value.includes('Legacy cloze passage') && !value.includes('blank-')),
      true,
      '完型题库身份必须能使用移除 spaceIndex 占位符后的共享正文',
    )
    assert.equal(
      result.group.sharedStemCandidates?.some((value) => value === 'Legacy instruction paragraph'),
      false,
      '不含空位标记的说明段不能作为 Cloze 身份候选',
    )
    const unit = result.group.units[0]
    const expectedStem = `${result.group.sharedStem} [父题型 9][子题 1]`
    assert.equal(
      buildNoqrQuestionIdentity(result.group, unit),
      frozenLegacyHash('single', expectedStem, unit.options.map((option) => option.text)),
    )
  } finally {
    await closeFixtureBrowser(browser)
  }
})
