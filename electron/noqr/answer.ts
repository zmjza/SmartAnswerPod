import type { Page } from 'patchright'
import type { ReadOnlyBankClient } from './bank-readonly.ts'
import type { NoqrAiClient } from './ai-client.ts'
import {
  NOQR_ANSWER_BOOT_HARD_WAIT_MS,
  NOQR_ANSWER_PAGE_ADVANCE_HARD_WAIT_MS,
  NOQR_MUTATION_RESPONSE_HARD_WAIT_MS,
  withNoqrHardDeadline,
} from './limits.ts'
import {
  buildNoqrQuestionIdentity,
  readNoqrQuestionGroup,
  resolveNoqrAnswers,
  type NoqrAnswerCandidate,
  type NoqrQuestionGroup,
  type NoqrResolvedAnswer,
} from './question.ts'
import { NOQR_SEL } from './selectors.ts'
import {
  NoqrMutationObserver,
  type NoqrMutationKind,
  type NoqrMutationRequest,
  type NoqrMutationResult,
} from './network.ts'
import { evaluateNoqrSaveEvidence, isNoqrRequestAccepted } from './save.ts'
import { NoqrNetworkActivity, NoqrSessionError, sleepNoqr } from './session.ts'

export type NoqrAnswerProgress = {
  phase: 'bank' | 'ai' | 'waiting'
  questionNo: number | null
  questionTotal: number | null
  message: string
  bankCount?: number
  aiCount?: number
}

export type NoqrAnsweredGroup = {
  group: NoqrQuestionGroup
  answers: NoqrResolvedAnswer[]
  answerSelected: string
  bankCount: number
  aiCount: number
  saved: boolean
  lastQuestion: boolean
  homeWorkUniqueFlag: string
}

export type NoqrSaveAndAdvanceResult = {
  saved: boolean
  advanced: boolean
  lastQuestion: boolean
  uncertain: boolean
  state: string
  homeWorkUniqueFlag: string
  requestStartedAt?: number
}

type QuestionScope = ReturnType<Page['locator']>

function unitScope(page: Page, group: NoqrQuestionGroup, unitOrdinal: number): QuestionScope {
  const root = page.locator(`${NOQR_SEL.questionInfo}:visible`).first()
  if (group.kind === 'picker') {
    return root.locator(NOQR_SEL.questionOptions)
  }
  if (group.units.length > 1 || group.kind === 'english_listening' || group.kind === 'english_cloze' || group.kind === 'english_reading') {
    return root.locator(NOQR_SEL.subQuestion).nth(unitOrdinal - 1)
  }
  return root
}

async function optionState(scope: QuestionScope): Promise<Array<{ position: number; index: number; checked: boolean; role: string }>> {
  return scope.locator(NOQR_SEL.optionItem).evaluateAll((nodes) => nodes.map((node, position) => {
    return {
      position,
      index: position,
      checked: node.getAttribute('aria-checked') === 'true',
      role: node.getAttribute('role') || '',
    }
  }))
}

async function waitForOptionState(
  page: Page,
  scope: QuestionScope,
  expected: Set<number>,
  stopRequested: () => boolean,
): Promise<void> {
  for (let poll = 0; poll < 100; poll++) {
    if (stopRequested()) throw new Error('任务已停止')
    const state = await optionState(scope)
    const actual = new Set(state.filter((item) => item.checked).map((item) => item.index))
    if (actual.size === expected.size && [...expected].every((index) => actual.has(index))) return
    await sleepNoqr(page, 50)
  }
  throw new Error('选项选中状态与目标不一致')
}

async function selectOptionSet(
  page: Page,
  group: NoqrQuestionGroup,
  answer: NoqrResolvedAnswer,
  stopRequested: () => boolean,
): Promise<void> {
  const scope = unitScope(page, group, answer.ordinal)
  const expected = new Set(answer.indices)
  let state = await optionState(scope)
  if (!state.length) throw new Error('当前题目没有可点击选项')
  for (const item of state) {
    if (stopRequested()) throw new Error('任务已停止')
    const shouldCheck = expected.has(item.index)
    if (item.checked === shouldCheck) continue
    await scope.locator(NOQR_SEL.optionItem).nth(item.position).click()
  }
  state = await optionState(scope)
  const actual = new Set(state.filter((item) => item.checked).map((item) => item.index))
  if (actual.size !== expected.size || [...expected].some((index) => !actual.has(index))) {
    await waitForOptionState(page, scope, expected, stopRequested)
  }
}

async function selectPickerValues(
  page: Page,
  group: NoqrQuestionGroup,
  answers: NoqrResolvedAnswer[],
  stopRequested: () => boolean,
): Promise<void> {
  const rows = page.locator(`${NOQR_SEL.questionInfo}:visible`).first()
    .locator(NOQR_SEL.questionOptions)
    .locator('.van-cell.van-cell--clickable.van-field[role="button"]')
  if (await rows.count() !== group.units.length) throw new Error('词汇匹配槽位数量变化，已停止当前作业')

  for (const answer of answers) {
    if (stopRequested()) throw new Error('任务已停止')
    if (answer.indices.length !== 1) throw new Error('词汇匹配槽位答案不唯一')
    const unit = group.units.find((item) => item.id === answer.unitId)
    const target = unit?.options.find((option) => option.index === answer.indices[0])
    if (!unit || !target) throw new Error('词汇匹配答案无法映射当前候选')
    const row = rows.nth(answer.ordinal - 1)
    const input = row.locator(NOQR_SEL.pickerInput)
    if ((await input.inputValue().catch(() => '')) === target.text) continue
    if (stopRequested()) throw new Error('任务已停止')
    await row.click()
    const picker = page.locator('.van-picker').last()
    for (let poll = 0; poll < 200; poll++) {
      if (stopRequested()) throw new Error('任务已停止')
      if (await picker.isVisible().catch(() => false)) break
      await sleepNoqr(page, 50)
    }
    if (!(await picker.isVisible().catch(() => false))) throw new Error('词汇 Picker 未打开')
    if (stopRequested()) throw new Error('任务已停止')
    const indexes = await picker.locator(NOQR_SEL.pickerColumnItem).evaluateAll((nodes, expected) =>
      nodes
        .map((node, index) => ({ index, text: (node.textContent || '').replace(/\s+/g, ' ').trim() }))
        .filter((item) => item.text === expected)
        .map((item) => item.index), target.text)
    if (indexes.length !== 1) throw new Error('词汇 Picker 目标候选不唯一')
    if (stopRequested()) throw new Error('任务已停止')
    await picker.locator(NOQR_SEL.pickerColumnItem).nth(indexes[0]).click()
    if (stopRequested()) throw new Error('任务已停止')
    await page.locator(NOQR_SEL.pickerConfirm).last().click()
    for (let poll = 0; poll < 100; poll++) {
      if (stopRequested()) throw new Error('任务已停止')
      if ((await input.inputValue().catch(() => '')) === target.text) break
      await sleepNoqr(page, 50)
    }
    if ((await input.inputValue().catch(() => '')) !== target.text) throw new Error('词汇 Picker 保存到页面后的值不一致')
  }
}

function missingUnits(group: NoqrQuestionGroup, candidates: ReadonlyMap<string, NoqrAnswerCandidate>): NoqrQuestionGroup['units'] {
  return group.units.filter((unit) => !(candidates.get(unit.id)?.bankTexts?.length))
}

export async function answerNoqrGroup(opts: {
  page: Page
  bank: ReadOnlyBankClient
  ai: NoqrAiClient
  stopRequested: () => boolean
  onProgress?: (progress: NoqrAnswerProgress) => void
  onAiAttempt?: (message: string) => void
}): Promise<{
  group: NoqrQuestionGroup
  answers: NoqrResolvedAnswer[]
  answerSelected: string
  bankCount: number
  aiCount: number
}> {
  if (opts.stopRequested()) throw new Error('任务已停止')
  opts.onProgress?.({ phase: 'waiting', questionNo: null, questionTotal: null, message: '读取当前题目' })
  const read = await readNoqrQuestionGroup(opts.page)
  if (!read.ok) throw new Error(read.reason)
  const group = read.group
  const candidates = new Map<string, NoqrAnswerCandidate>()

  for (const unit of group.units) {
    if (opts.stopRequested()) throw new Error('任务已停止')
    const hash = buildNoqrQuestionIdentity(group, unit)
    const hit = await opts.bank.getByHash(hash)
    if (!hit.ok) {
      opts.onProgress?.({
        phase: 'waiting',
        questionNo: group.position ?? null,
        questionTotal: group.total ?? null,
        message: `题库读取失败，转为 AI · ${hit.error}`,
      })
      candidates.set(unit.id, {})
      continue
    }
    if (!hit.row) {
      candidates.set(unit.id, {})
      continue
    }
    if (hit.row.qtype !== unit.qtype) {
      throw new Error('题库命中题型与当前页面不一致，已停止当前作业')
    }
    candidates.set(unit.id, { bankTexts: hit.row.answer_texts })
  }

  const missing = missingUnits(group, candidates)
  if (opts.stopRequested()) throw new Error('任务已停止')
  if (group.kind === 'english_listening' && missing.length) {
    throw new Error(`听力题库缺少第 ${missing.map((unit) => unit.ordinal).join('、')} 题可靠答案，停止当前作业`)
  }

  if (missing.length) {
    opts.onProgress?.({
      phase: 'ai',
      questionNo: group.position ?? null,
      questionTotal: group.total ?? null,
      message: `题库缺 ${missing.length} 项，调用独立 AI`,
    })
    if (group.units.length > 1) {
      const ai = await opts.ai.answerGroup({
        shared: group.sharedStem || group.kind,
        slots: missing.map((unit) => ({
          id: unit.id,
          stem: unit.stem || `第 ${unit.ordinal} 空`,
          options: unit.options.map((option) => option.text),
        })),
        onAttempt: (attempt) => opts.onAiAttempt?.(
          attempt.status === 'requesting'
            ? `AI ${attempt.index}/${attempt.total} 请求中`
            : `AI ${attempt.index}/${attempt.total} 失败：${attempt.reason || '未知'}`,
        ),
        stopRequested: opts.stopRequested,
      })
      if (opts.stopRequested()) throw new Error('任务已停止')
      if (!ai.selected) throw new Error(ai.failedReason || '复合题 AI 答案缺项，禁止保存')
      for (const unit of missing) {
        const text = ai.selected[unit.id]
        if (!text) throw new Error('复合题 AI 答案缺项，禁止保存')
        candidates.set(unit.id, { aiTexts: [text] })
      }
    } else {
      const [unit] = missing
      const ai = await opts.ai.answerQuestion({
        qtype: unit.qtype,
        stem: unit.stem,
        options: unit.options.map((option) => option.text),
        onAttempt: (attempt) => opts.onAiAttempt?.(
          attempt.status === 'requesting'
            ? `AI ${attempt.index}/${attempt.total} 请求中`
            : `AI ${attempt.index}/${attempt.total} 失败：${attempt.reason || '未知'}`,
        ),
        stopRequested: opts.stopRequested,
      })
      if (opts.stopRequested()) throw new Error('任务已停止')
      if (!ai.texts?.length) throw new Error('AI 答案不可用，禁止保存')
      candidates.set(unit.id, { aiTexts: ai.texts })
    }
  }

  const resolved = resolveNoqrAnswers(group, candidates, { requireAll: true })
  if (!resolved.ok) throw new Error(resolved.reason)
  const answers = resolved.answers
  if (opts.stopRequested()) throw new Error('任务已停止')

  opts.onProgress?.({
    phase: 'waiting',
    questionNo: group.position ?? null,
    questionTotal: group.total ?? null,
    message: `填写答案 ${answers.length} 项`,
  })
  if (group.kind === 'picker') {
    await selectPickerValues(opts.page, group, answers, opts.stopRequested)
  } else {
    for (const answer of answers) {
      await selectOptionSet(opts.page, group, answer, opts.stopRequested)
    }
  }

  const bankCount = answers.filter((answer) => answer.source === 'bank').length
  const aiCount = answers.filter((answer) => answer.source === 'ai').length
  opts.onProgress?.({
    phase: bankCount ? 'bank' : 'ai',
    questionNo: group.position ?? null,
    questionTotal: group.total ?? null,
    message: bankCount ? `题库命中 ${bankCount} 项` : `AI 完成 ${aiCount} 项`,
    bankCount,
    aiCount,
  })
  return {
    group,
    answers,
    answerSelected: resolved.answerSelected,
    bankCount,
    aiCount,
  }
}

async function questionSignature(page: Page): Promise<string> {
  return page.locator('.content-area:visible').first().evaluate((root) => {
    const text = ((root instanceof HTMLElement ? root.innerText : root.textContent) || '')
      .replace(/\s+/g, ' ')
      .trim()
    const position = text.match(/\b(?:question\s*)?(\d+)\s*\/\s*(\d+)\b/i)
    const labels = ['听力理解', '词汇匹配', '完型填空', '阅读理解', '多选题', '单选题', '判断题', '语法']
    const label = labels.find((item) => new RegExp(item).test(text)) || ''
    const info = root.querySelector('.question-info')
    const title = (info?.querySelector('.question-title')?.textContent || '').replace(/\s+/g, ' ').trim()
    const subItems = [...(info?.querySelectorAll('.sub-questions > .sub-item') || [])]
      .map((item) => (item.textContent || '').replace(/\s+/g, ' ').trim())
      .join('|')
    return `${label}|${position?.[1] || ''}/${position?.[2] || ''}|${title}|${subItems}`
  })
}

async function lastQuestionNotice(page: Page): Promise<boolean> {
  const nodes = page.locator(NOQR_SEL.textToast)
  for (let index = 0; index < await nodes.count(); index++) {
    const item = nodes.nth(index)
    if (await item.isVisible().catch(() => false) && /已是最后一题/.test((await item.textContent().catch(() => '')) || '')) {
      return true
    }
  }
  return false
}

function expectedUnitSelections(answers: NoqrResolvedAnswer[]): Map<number, string> {
  return new Map(answers.map((answer) => [answer.ordinal, answer.selectionValues.map(String).join(',')]))
}

function requestIdentityMismatch(
  answer: Record<string, unknown> | null | undefined,
  unit: NoqrQuestionGroup['units'][number],
): string {
  if (!answer) return '保存请求缺少当前题目身份'
  if (unit.bigQuestionId && String(answer.bigQuestionId || '') !== unit.bigQuestionId) {
    return '保存请求 bigQuestionId 与当前题目不一致'
  }
  if (unit.questionId && String(answer.questionId || '') !== unit.questionId) {
    return '保存请求 questionId 与当前题目不一致'
  }
  return ''
}

export function selectionMismatchCode(expected: string, actual: string): string {
  const expectedRaw = String(expected || '').trim()
  const actualRaw = String(actual || '').trim()
  if (expectedRaw === actualRaw) return ''
  const parse = (value: string): number[] | null => {
    if (!value) return []
    const parts = value.split(/[,，;\s]+/).filter(Boolean)
    if (!parts.length || parts.some((part) => !/^-?\d+$/.test(part))) return null
    return parts.map(Number)
  }
  const expectedValues = parse(expectedRaw)
  const actualValues = parse(actualRaw)
  if (!expectedValues || !actualValues) return 'selection_format_mismatch'
  if (expectedValues.length !== actualValues.length) return 'selection_count_mismatch'
  const expectedSorted = [...expectedValues].sort((left, right) => left - right)
  const actualSorted = [...actualValues].sort((left, right) => left - right)
  if (expectedSorted.every((value, index) => value === actualSorted[index])) {
    return 'selection_order_mismatch'
  }
  if (expectedSorted.every((value, index) => actualSorted[index] === value + 1)) {
    return 'selection_offset_plus_one'
  }
  if (expectedSorted.every((value, index) => actualSorted[index] === value - 1)) {
    return 'selection_offset_minus_one'
  }
  return 'selection_values_mismatch'
}

export function selectionMismatchDetailCode(expected: string, actual: string): string {
  const safePart = (value: string) => {
    const parts = String(value || '').trim().split(/[,，;\s]+/).filter(Boolean)
    if (!parts.length || parts.some((part) => !/^-?\d+$/.test(part))) return 'format'
    return parts.map((part) => part.startsWith('-') ? `minus${part.slice(1)}` : part).join('_')
  }
  return `selection_mismatch_expected_${safePart(expected)}_actual_${safePart(actual)}`
}

function mismatchSuffix(expected: string, actual: string, code: string): string {
  return process.env.KAIDA_T005_DEBUG_DIAGNOSTICS === '1'
    ? `${code} [${selectionMismatchDetailCode(expected, actual)}]`
    : code
}

export function noqrSaveRequestKinds(group: NoqrQuestionGroup): NoqrMutationKind[] {
  return group.kind === 'english_listening' ||
    group.kind === 'english_cloze' ||
    group.kind === 'english_reading'
    ? ['submit_all']
    : ['submit_one']
}

function requestMatchesAnswer(result: Pick<NoqrMutationResult | NoqrMutationRequest, 'body'>, group: NoqrQuestionGroup, answers: NoqrResolvedAnswer[], workId: string): {
  ok: boolean
  reason?: string
  homeWorkUniqueFlag: string
} {
  if (String(result.body.workId || '') !== workId) return { ok: false, reason: '保存请求 workId 与当前作业不一致', homeWorkUniqueFlag: '' }
  const flag = typeof result.body.homeWorkUniqueFlag === 'string' ? result.body.homeWorkUniqueFlag : ''
  if (!flag) return { ok: false, reason: '保存请求缺少作答唯一标记', homeWorkUniqueFlag: '' }
  const expected = expectedUnitSelections(answers)
  if (Array.isArray(result.body.answers)) {
    if (result.body.answers.length !== group.units.length) {
      return { ok: false, reason: '整组保存答案数量与当前题组不一致', homeWorkUniqueFlag: flag }
    }
    const actual = result.body.answers as unknown[]
    for (const unit of [...group.units].sort((a, b) => a.ordinal - b.ordinal)) {
      const answer = actual[unit.ordinal - 1] as Record<string, unknown> | null
      const expectedSelected = expected.get(unit.ordinal) || ''
      const actualSelected = String(answer?.answerSelected || '')
      const identityMismatch = requestIdentityMismatch(answer, unit)
      if (identityMismatch) {
        return {
          ok: false,
          reason: identityMismatch,
          homeWorkUniqueFlag: flag,
        }
      }
      const mismatch = selectionMismatchCode(expectedSelected, actualSelected)
      if (!answer || mismatch) {
        return {
          ok: false,
          reason: `整组保存答案与当前页面目标不一致 [${mismatchSuffix(expectedSelected, actualSelected, mismatch || 'selection_shape_mismatch')}]`,
          homeWorkUniqueFlag: flag,
        }
      }
    }
    return { ok: true, homeWorkUniqueFlag: flag }
  }
  const answer = result.body.answer && typeof result.body.answer === 'object'
    ? result.body.answer as Record<string, unknown>
    : result.body
  const actualSelected = String(answer.answerSelected || '')
  const expectedAll = answers.flatMap((item) => item.selectionValues).map(String).join(',')
  const singleUnit = group.units[0]
  if (singleUnit) {
    const identityMismatch = requestIdentityMismatch(answer, singleUnit)
    if (identityMismatch) {
      return {
        ok: false,
        reason: identityMismatch,
        homeWorkUniqueFlag: flag,
      }
    }
  }
  const mismatch = selectionMismatchCode(expectedAll, actualSelected)
  if (mismatch) {
    return {
      ok: false,
      reason: `单题保存 answerSelected 与当前页面目标不一致 [${mismatchSuffix(expectedAll, actualSelected, mismatch)}]`,
      homeWorkUniqueFlag: flag,
    }
  }
  if (!answer.bigQuestionId && !answer.questionId) {
    return { ok: false, reason: '保存请求缺少题目身份，结果不确定', homeWorkUniqueFlag: flag }
  }
  return { ok: true, homeWorkUniqueFlag: flag }
}

async function saveNoqrAnswerAndAdvanceInner(opts: {
  page: Page
  observer: NoqrMutationObserver
  workId: string
  group: NoqrQuestionGroup
  answers: NoqrResolvedAnswer[]
  stopRequested: () => boolean
  onWaiting?: (state: string, elapsedMs: number) => void
  onClickAttempt?: (attempt: number) => void
  noRequestRetryBudgetMs?: number
  pageChangeRequestWaitMs?: number
  requestMatchWindowMs?: number
  pageAdvanceBudgetMs?: number
  requestHardDeadlineMs?: number
  pageAdvanceHardDeadlineMs?: number
}): Promise<NoqrSaveAndAdvanceResult> {
  if (opts.stopRequested()) throw new Error('任务已停止')
  const beforeSignature = await questionSignature(opts.page)
  const marker = opts.observer.marker()
  const next = opts.page.locator(NOQR_SEL.next).first()
  const network = new NoqrNetworkActivity(opts.page)
  const expectedKinds = noqrSaveRequestKinds(opts.group)
  const findExactRequest = () => opts.observer.findRequest({
    after: marker,
    kinds: expectedKinds,
    workId: opts.workId,
    matches: (request) =>
      requestMatchesAnswer(request, opts.group, opts.answers, opts.workId).ok,
  })
  const findCandidateRequest = () => opts.observer.findRequestAfter({
    after: marker,
    kinds: ['submit_one', 'submit_all'],
  })
  const requestWaitStartedAt = Date.now()
  const requestHardDeadlineMs = Math.max(
    50,
    Number(opts.requestHardDeadlineMs) || NOQR_MUTATION_RESPONSE_HARD_WAIT_MS,
  )
  let clickAttempts = 1
  let noRequestSince = 0
  const noRequestRetryBudgetMs = Math.max(50, Number(opts.noRequestRetryBudgetMs) || 120_000)
  const pageChangeRequestWaitMs = Math.max(
    50,
    Number(opts.pageChangeRequestWaitMs) || 15_000,
  )
  const requestMatchWindowMs = Math.max(50, Number(opts.requestMatchWindowMs) || 2_000)
  let pageChangedSince = 0
  let candidateSince = 0
  let request: ReturnType<NoqrMutationObserver['findRequest']> = null
  try {
    if (opts.stopRequested()) throw new Error('任务已停止')
    if (Date.now() - requestWaitStartedAt >= requestHardDeadlineMs) {
      return {
        saved: false,
        advanced: false,
        lastQuestion: false,
        uncertain: true,
        state: 'submitted_uncertain',
        homeWorkUniqueFlag: '',
      }
    }
    await next.evaluate((node) => {
      if (!(node instanceof HTMLElement)) throw new Error('下一题按钮不可点击')
      setTimeout(() => node.click(), 0)
    })
    opts.onClickAttempt?.(clickAttempts)
    request = findExactRequest()
    while (!request && !opts.stopRequested()) {
      if (Date.now() - requestWaitStartedAt >= requestHardDeadlineMs) {
        return {
          saved: false,
          advanced: false,
          lastQuestion: false,
          uncertain: true,
          state: 'submitted_uncertain',
          homeWorkUniqueFlag: '',
        }
      }
      opts.onWaiting?.('等待保存请求', Date.now() - requestWaitStartedAt)
      request = findExactRequest()
      if (request) break
      const candidate = findCandidateRequest()
      if (candidate) {
        candidateSince ||= Date.now()
        if (Date.now() - candidateSince >= requestMatchWindowMs) {
          opts.onWaiting?.(
            '等待匹配当前答案的保存请求',
            Date.now() - requestWaitStartedAt,
          )
        }
      }
      const loading = await opts.page.locator(NOQR_SEL.loadingToast).first().isVisible().catch(() => false)
      const signature = await questionSignature(opts.page).catch(() => '')
      if (signature && signature !== beforeSignature) {
        pageChangedSince ||= Date.now()
      }
      if (candidateSince && Date.now() - candidateSince >= noRequestRetryBudgetMs) {
        return {
          saved: false,
          advanced: false,
          lastQuestion: false,
          uncertain: true,
          state: 'submitted_uncertain',
          homeWorkUniqueFlag: '',
        }
      }
      if (
        pageChangedSince &&
        !candidateSince &&
        !loading &&
        !network.isBusinessActive() &&
        Date.now() - pageChangedSince >= pageChangeRequestWaitMs
      ) {
        return {
          saved: false,
          advanced: false,
          lastQuestion: false,
          uncertain: true,
          state: 'unconfirmed_page_change',
          homeWorkUniqueFlag: '',
        }
      }
      if (network.isBusinessActive() || loading) {
        noRequestSince = 0
      } else {
        noRequestSince ||= Date.now()
      }
      if (
        !candidateSince &&
        !pageChangedSince &&
        noRequestSince &&
        Date.now() - noRequestSince >= noRequestRetryBudgetMs
      ) {
        if (clickAttempts >= 3 || !(await next.isVisible().catch(() => false))) {
          return {
            saved: false,
            advanced: false,
            lastQuestion: false,
            uncertain: true,
            state: 'submitted_uncertain',
            homeWorkUniqueFlag: '',
          }
        }
        if (opts.stopRequested()) throw new Error('任务已停止')
        opts.onWaiting?.(`未观察到保存请求，重新点击 ${clickAttempts + 1}/3`, Date.now() - requestWaitStartedAt)
        try {
          await next.evaluate((node) => {
            if (!(node instanceof HTMLElement)) throw new Error('下一题按钮不可点击')
            setTimeout(() => node.click(), 0)
          })
        } catch {
          return {
            saved: false,
            advanced: false,
            lastQuestion: false,
            uncertain: true,
            state: 'submitted_uncertain',
            homeWorkUniqueFlag: '',
          }
        }
        clickAttempts++
        opts.onClickAttempt?.(clickAttempts)
        noRequestSince = 0
      }
      await sleepNoqr(opts.page, 100)
      request = findExactRequest()
    }
  } finally {
    network.dispose()
  }
  if (!request) {
    return {
      saved: false,
      advanced: false,
      lastQuestion: false,
      uncertain: true,
      state: pageChangedSince ? 'unconfirmed_page_change' : 'submitted_uncertain',
      homeWorkUniqueFlag: '',
    }
  }
  if (!expectedKinds.includes(request.kind)) {
    return {
      saved: false,
      advanced: false,
      lastQuestion: false,
      uncertain: true,
      state: 'unexpected_endpoint',
      homeWorkUniqueFlag: '',
    }
  }
  const startedAt = Date.now()
  const result = await opts.observer.waitForResult(request, {
    stopRequested: opts.stopRequested,
    onWaiting: (elapsed) => opts.onWaiting?.('等待保存响应', elapsed),
    hardDeadlineMs: NOQR_MUTATION_RESPONSE_HARD_WAIT_MS,
  })
  if (result.requestError || !Number.isInteger(Number(result.httpStatus))) {
    return {
      saved: false,
      advanced: false,
      lastQuestion: false,
      uncertain: true,
      state: 'submitted_uncertain',
      homeWorkUniqueFlag: '',
    }
  }
  const accepted = isNoqrRequestAccepted(Number(result.httpStatus) || 0, result.payload as never)
  const match = requestMatchesAnswer(result, opts.group, opts.answers, opts.workId)
  if (!accepted || !match.ok) {
    const reason = !match.ok ? match.reason : result.requestError || '保存响应未通过 HTTP 与业务校验'
    throw new Error(reason || '答案保存失败')
  }

  const pageAdvanceBudgetMs = Math.max(
    50,
    Number(opts.pageAdvanceBudgetMs) || 120_000,
  )
  const pageAdvanceHardDeadlineMs = Math.max(
    pageAdvanceBudgetMs,
    Number(opts.pageAdvanceHardDeadlineMs) || NOQR_ANSWER_PAGE_ADVANCE_HARD_WAIT_MS,
  )
  const advanceNetwork = new NoqrNetworkActivity(opts.page)
  let advanced = false
  let lastQuestion = false
  let lastAdvanceProgressAt = Date.now()
  const finalQuestionPosition = Number(opts.group.position) || 0
  const finalQuestionTotal = Number(opts.group.total) || 0
  const finalQuestionByPosition = finalQuestionTotal > 0 &&
    finalQuestionPosition > 0 &&
    finalQuestionPosition >= finalQuestionTotal
  try {
    while (true) {
      lastQuestion = await lastQuestionNotice(opts.page)
      if (lastQuestion) {
        advanced = true
        break
      }
      const analysisVisible = finalQuestionByPosition &&
        await opts.page.locator('.analysis:visible').first().isVisible().catch(() => false)
      if (analysisVisible) {
        // The site uses an analysis panel as the visible end marker when the
        // final-question toast is absent. A local counter alone is not enough.
        advanced = true
        lastQuestion = true
        break
      }
      const signature = await questionSignature(opts.page).catch(() => beforeSignature)
      if (signature && signature !== beforeSignature) {
        advanced = true
        break
      }
      if (Date.now() - startedAt >= pageAdvanceHardDeadlineMs) {
        break
      }
      const loading = await opts.page.locator(NOQR_SEL.loadingToast).first().isVisible().catch(() => false)
      const networkActive = advanceNetwork.isBusinessActive()
      if (loading || networkActive) {
        lastAdvanceProgressAt = Date.now()
      } else if (Date.now() - lastAdvanceProgressAt >= pageAdvanceBudgetMs) {
        // L2 succeeded, but the page never exposed L3. Keep the saved answer
        // and stop instead of guessing that a local counter means paper end.
        break
      }
      if (opts.stopRequested()) break
      opts.onWaiting?.('等待页面推进', Date.now() - startedAt)
      await sleepNoqr(opts.page, 100)
    }
  } finally {
    advanceNetwork.dispose()
  }
  const evidence = evaluateNoqrSaveEvidence({
    requestObserved: true,
    responseObserved: Boolean(result.endedAt),
    responseAccepted: accepted,
    pageAdvanced: advanced,
    lastQuestionNotice: lastQuestion,
    stopRequested: opts.stopRequested(),
  })
  return {
    saved: evidence.saved,
    advanced: evidence.canAdvance && !opts.stopRequested(),
    lastQuestion,
    uncertain: evidence.state === 'submitted_uncertain',
    state: evidence.state,
    homeWorkUniqueFlag: match.homeWorkUniqueFlag,
    requestStartedAt: request.startedAt,
  }
}

export function saveNoqrAnswerAndAdvance(
  opts: Parameters<typeof saveNoqrAnswerAndAdvanceInner>[0],
): Promise<NoqrSaveAndAdvanceResult> {
  const hardDeadlineMs = Math.max(
    50,
    Number(opts.requestHardDeadlineMs) || NOQR_MUTATION_RESPONSE_HARD_WAIT_MS,
  )
  let hardStopped = false
  const wrappedOpts = {
    ...opts,
    stopRequested: () => hardStopped || opts.stopRequested(),
  }
  return withNoqrHardDeadline(
    saveNoqrAnswerAndAdvanceInner(wrappedOpts),
    hardDeadlineMs,
    () => {
      hardStopped = true
      return {
        saved: false,
        advanced: false,
        lastQuestion: false,
        uncertain: true,
        state: 'submitted_uncertain',
        homeWorkUniqueFlag: '',
      }
    },
  )
}

export async function waitForNoqrAnswerReady(opts: {
  page: Page
  stopRequested: () => boolean
  network?: NoqrNetworkActivity
  reenter: () => Promise<void>
  maxReentries?: number
  onWaiting?: (elapsedMs: number) => void
  blankSettleMs?: number
  skeletonBudgetMs?: number
  startupHardDeadlineMs?: number
}): Promise<void> {
  const network = opts.network || new NoqrNetworkActivity(opts.page)
  const startedAt = Date.now()
  const blankSettleMs = Math.max(50, Number(opts.blankSettleMs) || 120_000)
  const skeletonBudgetMs = Math.max(50, Number(opts.skeletonBudgetMs) || 120_000)
  const startupHardDeadlineMs = Math.max(
    50,
    Number(opts.startupHardDeadlineMs) || NOQR_ANSWER_BOOT_HARD_WAIT_MS,
  )
  let reentries = 0
  let emptySince = 0
  let skeletonSince = 0
  const hasPersistedAnswerProgress = async (): Promise<boolean> =>
    opts.page.evaluate((selectors) => {
      const answeredCard = document.querySelector(selectors.answerCardAnswered)
      if (answeredCard) return true
      const selectedOption = document.querySelector(
        '.option-item[aria-checked="true"], .option-item.checked, .e-a.checked',
      )
      if (selectedOption) return true
      return [...document.querySelectorAll('input[name="answer"], textarea[name="answer"]')]
        .some((node) => {
          if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) return false
          return node.value.trim().length > 0
        })
    }, NOQR_SEL).catch(() => true)
  const guardBeforeReenter = async (): Promise<void> => {
    if (await hasPersistedAnswerProgress()) {
      throw new NoqrSessionError(
        'answer_interrupted',
        '答题启动页检测到已有作答进度，已保留页面且禁止自动返回重进',
      )
    }
  }
  try {
    for (;;) {
      if (opts.stopRequested()) throw new Error('任务已停止')
      const ready = await opts.page.locator(`${NOQR_SEL.questionInfo}:visible`).first().isVisible().catch(() => false)
      if (ready) return
      if (Date.now() - startedAt >= startupHardDeadlineMs) {
        throw new NoqrSessionError(
          'answer_interrupted',
          '答题启动页长时间未就绪，已保留当前页面并停止当前作业',
        )
      }
      const skeleton = await opts.page.locator('.skeleton-area.van-skeleton').first().isVisible().catch(() => false)
      if (skeleton) {
        emptySince = 0
        if (network.isBusinessActive()) skeletonSince = 0
        else skeletonSince ||= Date.now()
        if (skeletonSince && Date.now() - skeletonSince >= skeletonBudgetMs) {
          if (reentries >= (opts.maxReentries ?? 3)) throw new Error('答题启动页连续空白，已停止当前作业')
          await guardBeforeReenter()
          reentries++
          skeletonSince = 0
          await opts.reenter()
          continue
        }
      } else {
        skeletonSince = 0
        const text = await opts.page.locator('body').innerText().catch(() => '')
        if (/企业微信|验证码|人脸识别|扫码登录/.test(text)) {
          throw new NoqrSessionError('auth_blocked', '页面要求人工认证，已暂停当前作业')
        }
        if (/加载失败|请求失败|发生错误|系统异常/.test(text)) throw new Error('答题页显示明确错误')
        if (network.isBusinessActive()) {
          emptySince = 0
        } else {
          emptySince ||= Date.now()
          if (Date.now() - emptySince >= blankSettleMs) {
            if (reentries >= (opts.maxReentries ?? 3)) throw new Error('答题启动页连续空白，已停止当前作业')
            await guardBeforeReenter()
            reentries++
            emptySince = 0
            await opts.reenter()
            continue
          }
        }
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(opts.page, 100)
    }
  } finally {
    if (!opts.network) network.dispose()
  }
}
