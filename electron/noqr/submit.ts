import type { Page } from 'patchright'
import { NoqrBlankRecoveryGate } from './blank-recovery.ts'
import {
  NOQR_ANSWER_CARD_HARD_WAIT_MS,
  NOQR_RETURN_HARD_WAIT_MS,
  NOQR_SUBMIT_HARD_WAIT_MS,
  withNoqrHardDeadline,
} from './limits.ts'
import { NOQR_PATH, NOQR_SEL } from './selectors.ts'
import { NoqrMutationObserver } from './network.ts'
import { isNoqrRequestAccepted } from './save.ts'
import {
  classifyNoqrPage,
  isNoqrAnswerPath,
  NoqrNetworkActivity,
  NoqrSessionError,
  reloadNoqrPage,
  sleepNoqr,
} from './session.ts'
import {
  readNoqrQuestionGroup,
  type NoqrQuestionGroup,
  type NoqrQuestionKind,
} from './question.ts'
import { NoqrUnsupportedNonObjectiveError } from './workflow-errors.ts'

export type NoqrAnswerCardAudit = {
  ok: boolean
  answered: number
  current: number
  unanswered: number
  missingKeys: string[]
}

export type NoqrExpectedAnswerCardSlot = {
  groupOrdinal: number
  section: string
  key: string
  numbers: string[]
}

export type NoqrExpectedAnswerCardGroup = {
  groupOrdinal: number
  kind: NoqrQuestionKind
  section: string
  position: number
  kindOccurrence: number
  unitCount: number
  plans: Array<{
    form: 'parent' | 'children'
    slotNumbers: string[]
    cardOrdinal: number | null
    cardOccurrence: number | null
  }>
}

export type NoqrSubmitResult = {
  ok: boolean
  uncertain: boolean
  incomplete: boolean
  state: 'ready' | 'incomplete' | 'submitted_uncertain' | 'failed'
  reason?: string
  homeWorkUniqueFlag: string
  paperStructUniqueFlag: string
  successToast: boolean
  buttonDisabled: boolean
}

export type NoqrObjectivePreflightResult =
  | { ok: true; titles: string[] }
  | {
      ok: false
      code: 'unsupported_non_objective' | 'answer_interrupted' | 'page_error'
      reason: string
      titles: string[]
    }

type NoqrObjectivePreflightTarget = {
  title: string
  titleOccurrence: number
  sectionOccurrence: number
  cardIndex: number
  number: string
  numberOccurrence: number
  numberCount: number
  rowIndex: number
  cardRowCount: number
}

type NoqrAnswerCardRowEvidence = {
  numberOccurrence: number
  numberCount: number
  rowIndex: number
  cardRowCount: number
}

type NoqrAnswerCardTargetState = NoqrAnswerCardRowEvidence & {
  found: boolean
  current: boolean
}

const ANSWER_CARD_SECTIONS: Partial<Record<NoqrQuestionKind, string>> = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  picker: '词汇匹配',
  english_grammar: '语法',
  english_listening: '听力理解',
  english_cloze: '完型填空',
  english_reading: '阅读理解',
}

// Composite kinds can be represented by one answer-card node for the whole
// major question. That form is accepted only when this session has already
// received an accepted save response for the matching logical group.
const PARENT_ANSWER_CARD_KINDS = new Set<NoqrQuestionKind>([
  'english_listening',
  'picker',
  'english_cloze',
  'english_reading',
])

const ANSWER_CARD_CLICK_MAX_ATTEMPTS = 3
const ANSWER_CARD_CLICK_GRACE_MS = 1_000

export const ANSWER_CARD_TITLE_SECTIONS = [
  { section: '听力理解', aliases: ['听力理解'] },
  { section: '词汇匹配', aliases: ['词汇匹配'] },
  { section: '完型填空', aliases: ['完型填空', '完形填空'] },
  { section: '阅读理解', aliases: ['阅读理解'] },
  { section: '多选题', aliases: ['多选题', '多项选择题'] },
  { section: '单选题', aliases: ['单选题', '单项选择题'] },
  { section: '判断题', aliases: ['判断题'] },
  { section: '语法', aliases: ['语法'] },
] as const

const AMBIGUOUS_CHOICE_FILL_TITLE = '选择填空题'

function isAmbiguousChoiceFillTitle(title: string): boolean {
  return title.replace(/\s+/g, ' ').trim().includes(AMBIGUOUS_CHOICE_FILL_TITLE)
}

function answerCardTitleAliases(section: string): string[] {
  const displaySection = answerCardDisplaySection(section)
  const entry = ANSWER_CARD_TITLE_SECTIONS.find((item) => item.section === displaySection)
  return entry ? [...entry.aliases] : displaySection ? [displaySection] : []
}

function answerCardTitleMatchesSection(title: string, section: string): boolean {
  const normalized = title.replace(/\s+/g, ' ').trim()
  const displaySection = answerCardDisplaySection(section)
  if (!normalized || !displaySection) return false
  if (isAmbiguousChoiceFillTitle(normalized)) {
    return displaySection === '单选题' || displaySection === '多选题'
  }
  return answerCardTitleAliases(displaySection).some((alias) => normalized.includes(alias))
}

export function answerCardSectionFromTitle(title: string): string {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim()
  if (isAmbiguousChoiceFillTitle(normalized)) return ''
  return ANSWER_CARD_TITLE_SECTIONS.find((entry) =>
    entry.aliases.some((alias) => normalized.includes(alias)))?.section || ''
}

const SUPPORTED_OBJECTIVE_TITLE = /单选题|单项选择题|多选题|多项选择题|判断题|语法|听力理解|词汇匹配|完型填空|完形填空|阅读理解|选择填空题/
const UNSUPPORTED_NON_OBJECTIVE_TITLE = /简答|问答|论述|主观|文本|文件|上传|名词解释|案例分析|材料分析/
function isCompositeObjectiveShellTitle(title: string): boolean {
  return answerCardDisplaySection(title) === '综合题'
}

export function noqrAnswerCardObjectiveOnlyIssue(title: string): string | null {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return '答题卡题组标题为空'
  if (UNSUPPORTED_NON_OBJECTIVE_TITLE.test(normalized)) {
    return `答题卡包含非客观题组：${normalized}`
  }
  if (/填空题/.test(normalized) && !/完型填空|完形填空|选择填空题/.test(normalized)) {
    return `答题卡包含非客观题组：${normalized}`
  }
  if (/完型填空|完形填空|选择填空题/.test(normalized)) return null
  // A generic composite shell is safe only after the structural pass below
  // reads its actual controls. The title alone cannot prove either direction.
  if (isCompositeObjectiveShellTitle(normalized)) return null
  if (SUPPORTED_OBJECTIVE_TITLE.test(normalized)) return null
  return `答题卡包含未支持的题组：${normalized}`
}

async function readNoqrAnswerCardStructure(page: Page): Promise<{
  titles: string[]
  targets: NoqrObjectivePreflightTarget[]
  cardRowCounts: number[]
}> {
  return page.locator(NOQR_SEL.answerCardGroup).evaluateAll((nodes, selectors) => {
    const visible = (node: Element): boolean => {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const clean = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim()
    const titles: string[] = []
    const targets: NoqrObjectivePreflightTarget[] = []
    const cardRowCounts: number[] = []
    const titleOccurrences = new Map<string, number>()
    const sectionOccurrences = new Map<string, number>()
    let cardIndex = 0
    for (const card of nodes) {
      if (!visible(card)) continue
      cardIndex++
      const title = clean(card.querySelector(selectors.titleSelector)?.textContent)
      const titleOccurrence = (titleOccurrences.get(title) || 0) + 1
      titleOccurrences.set(title, titleOccurrence)
      const section = title.includes(selectors.ambiguousChoiceFillTitle)
        ? ''
        : selectors.titleSections.find((entry) =>
          entry.aliases.some((alias) => title.includes(alias)))?.section || ''
      const sectionOccurrence = section
        ? (sectionOccurrences.get(section) || 0) + 1
        : 0
      if (section) sectionOccurrences.set(section, sectionOccurrence)
      titles.push(title)
      const rows = [...card.querySelectorAll(selectors.questionSelector)].filter(visible)
      cardRowCounts.push(rows.length)
      const rowNumbers = rows.map((row) => clean(row.textContent))
      const numberCounts = new Map<string, number>()
      for (const number of rowNumbers) {
        numberCounts.set(number, (numberCounts.get(number) || 0) + 1)
      }
      const numberOccurrences = new Map<string, number>()
      for (const [rowIndex, number] of rowNumbers.entries()) {
        const numberOccurrence = (numberOccurrences.get(number) || 0) + 1
        numberOccurrences.set(number, numberOccurrence)
        targets.push({
          title,
          titleOccurrence,
          sectionOccurrence,
          cardIndex,
          number,
          numberOccurrence,
          numberCount: numberCounts.get(number) || 1,
          rowIndex: rowIndex + 1,
          cardRowCount: rowNumbers.length,
        })
      }
    }
    return { titles, targets, cardRowCounts }
  }, {
    titleSelector: NOQR_SEL.answerCardGroupTitle,
    questionSelector: NOQR_SEL.answerCardQuestion,
    titleSections: ANSWER_CARD_TITLE_SECTIONS,
    ambiguousChoiceFillTitle: AMBIGUOUS_CHOICE_FILL_TITLE,
  })
}

function noqrPreflightTargetKind(title: string): NoqrQuestionKind | null {
  const section = answerCardSectionFromTitle(title)
  if (section === '单选题') return 'single'
  if (section === '多选题') return 'multiple'
  if (section === '判断题') return 'judge'
  if (section === '语法') return 'english_grammar'
  if (section === '听力理解') return 'english_listening'
  if (section === '词汇匹配') return 'picker'
  if (section === '完型填空' || section === '完形填空') return 'english_cloze'
  if (section === '阅读理解') return 'english_reading'
  return null
}

function noqrPreflightTargetMatches(
  target: NoqrObjectivePreflightTarget,
  group: NoqrQuestionGroup,
): boolean {
  const expectedKind = noqrPreflightTargetKind(target.title)
  if (expectedKind) {
    if (group.kind !== expectedKind) return false
  } else if (target.title.includes(AMBIGUOUS_CHOICE_FILL_TITLE)) {
    // Choice-fill cards are an objective-shell title; the actual control
    // determines whether each slot is single, multiple or judge.
    if (!['single', 'multiple', 'judge'].includes(group.kind)) return false
  } else if (isCompositeObjectiveShellTitle(target.title)) {
    // The generic composite title is accepted only when the current question
    // surface is one of the known objective kinds. Text/file structures are
    // rejected by readNoqrQuestionGroup before this check.
    if (!['single', 'multiple', 'judge', 'picker', 'english_grammar',
      'english_listening', 'english_cloze', 'english_reading'].includes(group.kind)) {
      return false
    }
  } else {
    return false
  }
  const targetNumber = Number(target.number)
  if (!Number.isInteger(targetNumber)) return false
  if (isCompositeAnswerCardSection(target.title)) {
    if (target.sectionOccurrence < 1) return false
    return noqrCompositeTargetNumberMatches(
      group,
      targetNumber,
      target.sectionOccurrence,
      {
        numberOccurrence: target.numberOccurrence,
        numberCount: target.numberCount,
        rowIndex: target.rowIndex,
        cardRowCount: target.cardRowCount,
      },
    )
  }
  return group.position != null && Number(group.position) === targetNumber
}

async function hasNoqrObjectiveProgress(page: Page): Promise<boolean> {
  return page.evaluate((selectors) => {
    const visible = (node: Element | null): boolean => {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const answered = [...document.querySelectorAll(selectors.answerCardAnswered)]
      .some((node) => visible(node) && Boolean(node.closest(selectors.answerCardGroup)))
    if (answered) return true
    if ([...document.querySelectorAll(
      '.question-options .option-item[aria-checked="true"], ' +
      '.question-options .option-item.checked, .question-options .e-a.checked',
    )].some(visible)) return true
    return [...document.querySelectorAll('input[name="answer"]')].some((node) => {
      if (!(node instanceof HTMLInputElement) || node.type !== 'hidden') return false
      const contentArea = node.closest('.content-area')
      return node.value.trim().length > 0 &&
        visible(contentArea) &&
        !node.closest(selectors.answerCardGroup)
    })
  }, NOQR_SEL).catch(() => true)
}

async function clickNoqrAnswerCardTarget(
  page: Page,
  target: NoqrObjectivePreflightTarget,
): Promise<boolean> {
  return page.locator(NOQR_SEL.answerCardGroup).evaluateAll((nodes, expected) => {
    const visible = (node: Element): boolean => {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const clean = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim()
    const cards = nodes.filter(visible)
    const sameTitleCards = cards.filter((card) =>
      clean(card.querySelector(expected.titleSelector)?.textContent) === expected.title)
    const card = sameTitleCards[expected.titleOccurrence - 1]
    if (!card) return false
    const rows = [...card.querySelectorAll(expected.questionSelector)].filter(visible)
    if (rows.length !== expected.cardRowCount) return false
    const row = rows[expected.rowIndex - 1]
    if (!(row instanceof HTMLElement)) return false
    if (clean(row.textContent) !== expected.number) return false
    row.click()
    return true
  }, {
    ...target,
    titleSelector: NOQR_SEL.answerCardGroupTitle,
    questionSelector: NOQR_SEL.answerCardQuestion,
  })
}

async function waitForNoqrPreflightQuestion(
  page: Page,
  target: NoqrObjectivePreflightTarget,
  stopRequested: () => boolean,
  deadlineAt: number,
): Promise<NoqrQuestionGroup> {
  let lastReason = '答题卡跳转后未加载可识别题目'
  for (;;) {
    if (stopRequested()) throw new Error('任务已停止')
    const read = await readNoqrQuestionGroup(page)
    if (read.ok) {
      if (noqrPreflightTargetMatches(target, read.group)) return read.group
      lastReason = '答题卡跳转后未到达目标题位'
    } else if (read.code === 'unsupported_non_objective') {
      throw new NoqrUnsupportedNonObjectiveError(read.reason)
    } else {
      lastReason = read.reason
    }
    if (Date.now() >= deadlineAt) {
      if (
        /未知|结构|题型|选项|题干|题目单元|字段/.test(lastReason) ||
        (lastReason === '答题卡跳转后未到达目标题位' &&
          isCompositeAnswerCardSection(target.title))
      ) {
        throw new NoqrUnsupportedNonObjectiveError(`整卷客观题预检无法证明当前题位：${lastReason}`)
      }
      throw new NoqrSessionError('page_error', `整卷客观题预检超时：${lastReason}`)
    }
    await sleepNoqr(page, 100)
  }
}

export async function preflightNoqrObjectiveOnlyAnswerCard(
  page: Page,
  stopRequested: () => boolean,
  opts: {
    deadlineAt?: number
    onWaiting?: (elapsedMs: number) => void
  } = {},
): Promise<NoqrObjectivePreflightResult> {
  const startedAt = Date.now()
  const deadlineAt = opts.deadlineAt ?? startedAt + NOQR_ANSWER_CARD_HARD_WAIT_MS
  let result: NoqrObjectivePreflightResult | null = null
  let failure: unknown = null
  let titles: string[] = []
  try {
    await openAnswerCard(page, stopRequested, {
      deadlineAt,
      onDiagnostic: (message) => opts.onWaiting?.(Date.now() - startedAt),
    })
    const structure = await readNoqrAnswerCardStructure(page)
    titles = structure.titles
    const diagnostic = await readNoqrAnswerCardDiagnostic(page)
    if (
      !titles.length ||
      titles.length !== diagnostic.cards ||
      !structure.targets.length ||
      structure.cardRowCounts.some((count) => count <= 0) ||
      diagnostic.rows <= 0 ||
      titles.some((title) => !title.trim())
    ) {
      result = {
        ok: false,
        code: 'page_error',
        reason: '答题卡题组标题缺失，无法证明整卷仅含客观题',
        titles,
      }
    } else if (diagnostic.answered > 0 || await hasNoqrObjectiveProgress(page)) {
      result = {
        ok: false,
        code: 'answer_interrupted',
        reason: '答题卡已存在作答进度，禁止自动开始新一轮作答',
        titles,
      }
    } else {
      const issues = titles
        .map((title) => noqrAnswerCardObjectiveOnlyIssue(title))
        .filter((issue): issue is string => Boolean(issue))
      result = issues.length
        ? { ok: false, code: 'unsupported_non_objective', reason: issues[0], titles }
        : null
      if (!result) {
        for (const target of structure.targets) {
          if (!(await answerCardSurfaceState(page)).card) {
            await openAnswerCard(page, stopRequested, {
              deadlineAt,
              onDiagnostic: (message) => opts.onWaiting?.(Date.now() - startedAt),
            })
          }
          if (!(await clickNoqrAnswerCardTarget(page, target))) {
            throw new NoqrSessionError('page_error', `答题卡题位无法点击：${target.title}`)
          }
          try {
            await waitForNoqrPreflightQuestion(page, target, stopRequested, deadlineAt)
          } catch (error) {
            if (error instanceof NoqrUnsupportedNonObjectiveError) {
              result = {
                ok: false,
                code: 'unsupported_non_objective',
                reason: error.message,
                titles,
              }
              break
            }
            throw error
          }
        }
        if (!result) {
          // Structural inspection navigates through every card slot. Restore
          // the first slot before the real answer flow starts; this is a
          // navigation-only click and never selects or saves an option.
          const firstTarget = structure.targets[0]
          if (!(await answerCardSurfaceState(page)).card) {
            await openAnswerCard(page, stopRequested, {
              deadlineAt,
              onDiagnostic: (message) => opts.onWaiting?.(Date.now() - startedAt),
            })
          }
          if (!(await clickNoqrAnswerCardTarget(page, firstTarget))) {
            throw new NoqrSessionError('page_error', '客观题预检后无法返回首题')
          }
          await waitForNoqrPreflightQuestion(page, firstTarget, stopRequested, deadlineAt)
        }
        if (!result) result = { ok: true, titles }
      }
    }
  } catch (error) {
    failure = error
  }
  let closeFailure: unknown = null
  try {
    await closeAnswerCard(page, deadlineAt, stopRequested)
  } catch (error) {
    closeFailure = error
  }
  if (failure) throw failure
  if (closeFailure && result?.ok) {
    return {
      ok: false,
      code: 'page_error',
      reason: '答题卡预检后无法关闭，已隔离当前作业',
      titles: result.titles,
    }
  }
  return result!
}

export function noqrAnswerCardSection(kind: NoqrQuestionKind): string {
  return ANSWER_CARD_SECTIONS[kind] || ''
}

export function noqrAnswerCardKey(
  kind: NoqrQuestionKind,
  number: string | number,
  occurrence?: number,
): string {
  const section = noqrAnswerCardSection(kind)
  if (!section) return ''
  const scoped = Number.isInteger(occurrence) && Number(occurrence) > 0
    ? `${section}@${Number(occurrence)}`
    : section
  return `${scoped}#${String(number).trim()}`
}

export function noqrAnswerCardGroupKeys(group: NoqrQuestionGroup): string[] {
  const number = group.position || 1
  const composite = ['english_listening', 'picker', 'english_cloze', 'english_reading']
    .includes(group.kind)
  const keys = composite
    ? [
        noqrAnswerCardKey(group.kind, number, 1),
        noqrAnswerCardKey(group.kind, 1, number),
      ]
    : [noqrAnswerCardKey(group.kind, number, 1)]
  return [...new Set(keys.filter(Boolean))]
}

export function noqrAnswerCardExpectedKeyGroups(group: NoqrQuestionGroup): string[][] {
  const number = group.position || 1
  const composite = ['english_listening', 'picker', 'english_cloze', 'english_reading']
    .includes(group.kind)
  const parentSets = PARENT_ANSWER_CARD_KINDS.has(group.kind)
    ? noqrAnswerCardGroupKeys(group).map((key) => [key])
    : []
  if (!composite || group.units.length <= 1) return parentSets

  const ordinals = group.units.map((_, index) => index + 1)
  const local = ordinals
    .map((ordinal) => noqrAnswerCardKey(group.kind, ordinal, number))
  const merged = ordinals
    .map((ordinal) => noqrAnswerCardKey(group.kind, (number - 1) * group.units.length + ordinal, 1))
  const legacyLocal = ordinals
    .map((ordinal) => noqrAnswerCardKey(group.kind, ordinal))
  const legacySequence = ordinals
    .map((ordinal) => noqrAnswerCardKey(group.kind, (number - 1) * group.units.length + ordinal))
  const unique = new Map<string, string[]>()
  for (const keys of [...parentSets, local, merged, legacyLocal, legacySequence]) {
    const filtered = keys.filter(Boolean)
    if (filtered.length) unique.set(filtered.join('\n'), filtered)
  }
  return [...unique.values()]
}

export function noqrAnswerCardExpectedSlots(
  group: NoqrQuestionGroup,
  opts: {
    groupOrdinal: number
    kindOccurrence: number
    slotOffset: number
  },
): NoqrExpectedAnswerCardSlot[] {
  const section = noqrAnswerCardSection(group.kind)
  const position = Math.max(1, Number(group.position) || opts.groupOrdinal)
  const unitCount = Math.max(1, group.units.length)
  return group.units.map((unit, index) => {
    const local = String(unit.ordinal || index + 1).trim()
    const global = String(opts.slotOffset + index + 1)
    const merged = String((position - 1) * unitCount + Number(local || index + 1))
    return {
      groupOrdinal: opts.groupOrdinal,
      section,
      key: noqrAnswerCardKey(group.kind, local, opts.kindOccurrence),
      numbers: [...new Set([local, global, merged].filter(Boolean))],
    }
  })
}

export async function readNoqrAnswerCardDiagnostic(page: Page): Promise<{
  cards: number
  rows: number
  answered: number
  current: number
  sections: string[]
  cardOrdinals: Array<number | null>
  numbers: string[]
}> {
  return page.locator(NOQR_SEL.answerCardGroup).evaluateAll((nodes, titleSections) => {
    const visible = (node: Element): boolean => {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const sections: string[] = []
    const cardOrdinals: Array<number | null> = []
    const numbers: string[] = []
    let rows = 0
    let answered = 0
    let current = 0
    for (const card of nodes) {
      if (!visible(card)) continue
      const title = (card.querySelector('.question-cart-title')?.textContent || '')
        .replace(/\s+/g, ' ').trim()
      const ordinal = title.match(/第\s*(\d+)\s*大题/)
      const section = title.includes('选择填空题')
        ? ''
        : titleSections.find((entry) =>
          entry.aliases.some((alias) => title.includes(alias)))?.section || ''
      sections.push(section)
      cardOrdinals.push(ordinal ? Number(ordinal[1]) : null)
      for (const node of card.querySelectorAll('.sub-question')) {
        if (!visible(node)) continue
        rows++
        numbers.push((node.textContent || '').replace(/\s+/g, ' ').trim())
        if (node.classList.contains('has-answered')) answered++
        if (node.classList.contains('is-current')) current++
      }
    }
    return {
      cards: sections.length,
      rows,
      answered,
      current,
      sections,
      cardOrdinals,
      numbers,
    }
  }, ANSWER_CARD_TITLE_SECTIONS)
}

export function noqrAnswerCardExpectedGroups(
  group: NoqrQuestionGroup,
  opts: {
    groupOrdinal: number
    kindOccurrence: number
    slotOffset: number
  },
): NoqrExpectedAnswerCardGroup {
  const section = noqrAnswerCardSection(group.kind)
  const position = Math.max(1, Number(group.position) || opts.groupOrdinal)
  const unitCount = Math.max(1, group.units.length)
  const local = group.units.map((unit, index) => String(unit.ordinal || index + 1).trim())
  const merged = local.map((number) =>
    String((position - 1) * unitCount + Number(number || 1)))
  const global = local.map((_, index) => String(opts.slotOffset + index + 1))
  const kindSequence = local.map((_, index) =>
    String((opts.kindOccurrence - 1) * unitCount + index + 1))
  const plans = new Map<string, NoqrExpectedAnswerCardGroup['plans'][number]>()
  const addPlan = (
    form: 'parent' | 'children',
    slotNumbers: string[],
    cardOrdinal: number | null,
    cardOccurrence: number | null,
  ) => {
    const key = `${form}|${cardOrdinal ?? '*'}|${cardOccurrence ?? '*'}|${slotNumbers.join(',')}`
    if (!plans.has(key)) plans.set(key, { form, slotNumbers, cardOrdinal, cardOccurrence })
  }
  addPlan('children', local, position, null)
  addPlan('children', local, null, opts.kindOccurrence)
  addPlan('children', merged, null, null)
  addPlan('children', global, null, null)
  addPlan('children', kindSequence, null, null)
  if (unitCount > 1 && PARENT_ANSWER_CARD_KINDS.has(group.kind)) {
    addPlan('parent', [String(position)], position, opts.kindOccurrence)
    addPlan('parent', [String(position)], null, opts.kindOccurrence)
    addPlan('parent', [String(position)], null, null)
  }
  return {
    groupOrdinal: opts.groupOrdinal,
    kind: group.kind,
    section,
    position,
    kindOccurrence: opts.kindOccurrence,
    unitCount,
    plans: [...plans.values()],
  }
}

type NoqrObservedAnswerCardRow = {
  key: string
  legacyKey: string
  section: string
  number: string
  answered: boolean
  current: boolean
  cardIndex: number
  cardOrdinal: number | null
  sectionOccurrence: number
}

function matchNoqrAnswerCardSlots(
  slots: NoqrExpectedAnswerCardSlot[],
  rows: NoqrObservedAnswerCardRow[],
): {
  matchedSlotCount: number
  unmatchedSlots: number[]
  matchedRows: Set<number>
} {
  const rowToSlot = new Array<number>(rows.length).fill(-1)
  const slotOrder = slots
    .map((slot, index) => ({
      index,
      candidates: rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(({ row }) =>
          (!slot.section || !row.section || slot.section === row.section) &&
          slot.numbers.includes(row.number))
        .map(({ rowIndex }) => rowIndex),
    }))
    .sort((left, right) => left.candidates.length - right.candidates.length)

  const assign = (slotIndex: number, seen: Set<number>): boolean => {
    const entry = slotOrder.find((item) => item.index === slotIndex)
    if (!entry) return false
    for (const rowIndex of entry.candidates) {
      if (seen.has(rowIndex)) continue
      seen.add(rowIndex)
      if (rowToSlot[rowIndex] < 0 || assign(rowToSlot[rowIndex], seen)) {
        rowToSlot[rowIndex] = slotIndex
        return true
      }
    }
    return false
  }

  const unmatchedSlots: number[] = []
  for (const entry of slotOrder) {
    if (!assign(entry.index, new Set())) unmatchedSlots.push(entry.index)
  }
  const matchedRows = new Set(
    rowToSlot.flatMap((slotIndex, rowIndex) => slotIndex >= 0 ? [rowIndex] : []),
  )
  return {
    matchedSlotCount: slots.length - unmatchedSlots.length,
    unmatchedSlots,
    matchedRows,
  }
}

function observedRowMatchesGroup(
  row: NoqrObservedAnswerCardRow,
  group: NoqrExpectedAnswerCardGroup,
  plan: NoqrExpectedAnswerCardGroup['plans'][number],
  number: string,
): boolean {
  if (group.section && row.section && group.section !== row.section) return false
  if (plan.cardOrdinal != null && row.cardOrdinal !== plan.cardOrdinal) return false
  if (plan.cardOccurrence != null && row.sectionOccurrence !== plan.cardOccurrence) return false
  return row.number === number
}

function matchChildrenPlanInCard(
  rows: NoqrObservedAnswerCardRow[],
  group: NoqrExpectedAnswerCardGroup,
  plan: NoqrExpectedAnswerCardGroup['plans'][number],
): number[] | null {
  const candidates = plan.slotNumbers.map((number) =>
    rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => observedRowMatchesGroup(row, group, plan, number))
      .map(({ index }) => index))
  if (candidates.some((indices) => !indices.length)) return null
  const used = new Set<number>()
  const selected: number[] = []
  const assign = (slot: number): boolean => {
    if (slot >= candidates.length) return true
    for (const index of candidates[slot]) {
      if (used.has(index)) continue
      used.add(index)
      selected.push(index)
      if (assign(slot + 1)) return true
      selected.pop()
      used.delete(index)
    }
    return false
  }
  return assign(0) ? selected : null
}

function groupAssignments(
  rows: NoqrObservedAnswerCardRow[],
  group: NoqrExpectedAnswerCardGroup,
): Array<{
  rows: number[]
  cardOrdinal: number | null
  form: 'parent' | 'children'
}> {
  const byCard = new Map<number, Array<{ row: NoqrObservedAnswerCardRow; index: number }>>()
  for (const [index, row] of rows.entries()) {
    const entries = byCard.get(row.cardIndex) || []
    entries.push({ row, index })
    byCard.set(row.cardIndex, entries)
  }
  const assignments = new Map<string, {
    rows: number[]
    cardOrdinal: number | null
    form: 'parent' | 'children'
  }>()
  for (const entries of byCard.values()) {
    const cardRows = entries.map((entry) => entry.row)
    for (const plan of group.plans) {
      const local = plan.form === 'parent'
        ? (() => {
            const foundIndex = entries.findIndex(({ row }) => {
              if (group.section && row.section && group.section !== row.section) return false
              if (plan.cardOrdinal != null && row.cardOrdinal !== plan.cardOrdinal) return false
              if (plan.cardOccurrence != null && row.sectionOccurrence !== plan.cardOccurrence) return false
              return String(row.number || '').trim() === plan.slotNumbers[0]
            })
            return foundIndex >= 0 ? [foundIndex] : null
          })()
        : matchChildrenPlanInCard(cardRows, group, plan)
      if (!local) continue
      const assignment = local.map((index) => entries[index].index).sort((left, right) => left - right)
      assignments.set(assignment.join(','), {
        rows: assignment,
        cardOrdinal: entries[0]?.row.cardOrdinal ?? null,
        form: plan.form,
      })
    }
  }
  const values = [...assignments.values()]
  const childAssignments = values.filter((assignment) => assignment.form === 'children')
  // Prefer an explicit full child-row representation whenever the site
  // renders it. Parent-node aliases are only a fallback for the confirmed
  // collapsed English answer-card layout.
  return childAssignments.length ? childAssignments : values
}

function answerCardOrdinalsAreUnique(
  pairs: Array<{
    group: NoqrExpectedAnswerCardGroup
    assignment: {
      rows: number[]
      cardOrdinal: number | null
      form: 'parent' | 'children'
    }
  }>,
): boolean {
  const seen = new Map<string, Set<number>>()
  for (const { group, assignment } of pairs) {
    if (assignment.form === 'parent') continue
    if (assignment.cardOrdinal == null) continue
    const ordinals = seen.get(group.section) || new Set<number>()
    if (ordinals.has(assignment.cardOrdinal)) return false
    ordinals.add(assignment.cardOrdinal)
    seen.set(group.section, ordinals)
  }
  return true
}

function matchNoqrAnswerCardGroups(
  groups: NoqrExpectedAnswerCardGroup[],
  rows: NoqrObservedAnswerCardRow[],
): {
  matchedGroupCount: number
  matchedRows: Set<number>
  unmatchedGroups: number[]
  parentOnlyGroupOrdinals: Set<number>
} {
  const multi = groups
    .filter((group) => group.unitCount > 1)
    .map((group) => ({ group, assignments: groupAssignments(rows, group) }))
    .sort((left, right) => left.assignments.length - right.assignments.length)
  const singles = groups.filter((group) => group.unitCount <= 1)
  const used = new Set<number>()
  const matchedGroups = new Set<number>()
  const chosenMulti: Array<{
    group: NoqrExpectedAnswerCardGroup
    assignment: {
      rows: number[]
      cardOrdinal: number | null
      form: 'parent' | 'children'
    }
  }> = []
  const parentOnlyGroupOrdinals = new Set<number>()

  const assignMulti = (index: number): boolean => {
    if (index >= multi.length) return answerCardOrdinalsAreUnique(chosenMulti)
    for (const assignment of multi[index].assignments) {
      if (assignment.rows.some((rowIndex) => used.has(rowIndex))) continue
      for (const rowIndex of assignment.rows) used.add(rowIndex)
      matchedGroups.add(multi[index].group.groupOrdinal)
      if (assignment.form === 'parent') {
        parentOnlyGroupOrdinals.add(multi[index].group.groupOrdinal)
      }
      chosenMulti[index] = { group: multi[index].group, assignment }
      if (assignMulti(index + 1)) return true
      parentOnlyGroupOrdinals.delete(multi[index].group.groupOrdinal)
      matchedGroups.delete(multi[index].group.groupOrdinal)
      chosenMulti.splice(index)
      for (const rowIndex of assignment.rows) used.delete(rowIndex)
    }
    return false
  }

  const multiComplete = assignMulti(0)
  if (multiComplete) {
    const rowToGroup = new Map<number, number>()
    const singleOrder = singles
      .map((group) => ({
        group,
        candidates: rows
          .map((row, index) => ({
            index,
            matches: group.plans.some((plan) =>
              (plan.form === 'children' ? plan.slotNumbers : plan.slotNumbers).length > 0 &&
              plan.slotNumbers.some((number) => observedRowMatchesGroup(row, group, plan, number))),
          }))
          .filter(({ index, matches }) => matches && !used.has(index))
          .map(({ index }) => index),
      }))
      .sort((left, right) => left.candidates.length - right.candidates.length)
    const assignSingle = (groupIndex: number, seen: Set<number>): boolean => {
      const entry = singleOrder[groupIndex]
      for (const rowIndex of entry?.candidates || []) {
        if (seen.has(rowIndex)) continue
        seen.add(rowIndex)
        const previous = rowToGroup.get(rowIndex)
        if (previous == null || assignSingle(previous, seen)) {
          rowToGroup.set(rowIndex, groupIndex)
          matchedGroups.add(entry.group.groupOrdinal)
          return true
        }
      }
      return false
    }
    for (let index = 0; index < singleOrder.length; index++) assignSingle(index, new Set())
    for (const rowIndex of rowToGroup.keys()) used.add(rowIndex)
  }

  const unmatchedGroups = groups
    .filter((group) => !matchedGroups.has(group.groupOrdinal))
    .map((group) => group.groupOrdinal)
  return {
    matchedGroupCount: groups.length - unmatchedGroups.length,
    matchedRows: new Set(used),
    unmatchedGroups,
    parentOnlyGroupOrdinals,
  }
}

async function visibleText(page: Page, selector: string): Promise<string> {
  const nodes = page.locator(selector)
  const values: string[] = []
  for (let index = 0; index < await nodes.count(); index++) {
    const node = nodes.nth(index)
    if (await node.isVisible().catch(() => false)) values.push((await node.textContent().catch(() => '')) || '')
  }
  return values.join('\n').replace(/\s+/g, ' ').trim()
}

async function visibleAnswerCardButtonIndex(page: Page): Promise<number | null> {
  return page.locator('.btn-item').evaluateAll((nodes) => {
    const candidates = nodes
      .map((node, index) => {
        if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return null
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden') return null
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
        if (!text.startsWith('答题卡')) return null
        return {
          index,
          exact: text === '答题卡',
          inContentArea: Boolean(node.closest('.content-area')),
        }
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
    return candidates.find((candidate) => candidate.exact && candidate.inContentArea)?.index ??
      candidates.find((candidate) => candidate.inContentArea)?.index ??
      candidates.find((candidate) => candidate.exact)?.index ??
      candidates[0]?.index ??
      null
  })
}

export async function hasVisibleNoqrAnswerCardButton(page: Page): Promise<boolean> {
  return (await visibleAnswerCardButtonIndex(page)) != null
}

async function answerCardSurfaceState(page: Page): Promise<{
  card: boolean
  popup: boolean
  rows: number
}> {
  const cardState = await page.locator(NOQR_SEL.answerCardGroup).evaluateAll((nodes, questionSelector) => {
    const visible = (node: Element): boolean => {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const cards = nodes.filter(visible)
    return {
      card: cards.length > 0,
      rows: cards.reduce((count, card) =>
        count + [...card.querySelectorAll(questionSelector)].filter(visible).length, 0),
    }
  }, NOQR_SEL.answerCardQuestion)
  return {
    card: cardState.card,
    // Picker and other Vant panels also use `.van-popup--bottom`. Only a
    // visible answer-card group proves that the answer-card panel is present.
    popup: cardState.card,
    rows: cardState.rows,
  }
}

async function answerCardModalState(page: Page): Promise<{
  popup: boolean
  overlay: boolean
  overlayIndex: number | null
}> {
  return page.locator(NOQR_SEL.answerCardGroup).evaluateAll((cards) => {
    const visible = (node: Element): boolean => {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const card = cards.find(visible)
    const popup = card?.closest('.van-popup')
    if (!(popup instanceof HTMLElement) || !visible(popup)) {
      return { popup: false, overlay: false, overlayIndex: null }
    }
    // Vant renders the modal overlay immediately before its popup. Do not
    // search global overlays or later siblings; either can belong to a Picker
    // or unrelated dialog.
    const siblings = [popup.previousElementSibling]
    const overlay = siblings.find((node) =>
      node instanceof HTMLElement &&
      node.classList.contains('van-overlay') &&
      visible(node))
    if (!(overlay instanceof HTMLElement)) {
      return { popup: true, overlay: false, overlayIndex: null }
    }
    return {
      popup: true,
      overlay: true,
      overlayIndex: [...document.querySelectorAll('.van-overlay')].indexOf(overlay),
    }
  })
}

async function openAnswerCard(
  page: Page,
  stopRequested: () => boolean,
  opts: {
    noProgressBudgetMs?: number
    network?: NoqrNetworkActivity
    deadlineAt?: number
    onDiagnostic?: (message: string) => void
  } = {},
): Promise<void> {
  if (stopRequested()) throw new Error('任务已停止')
  const ownNetwork = opts.network ? null : new NoqrNetworkActivity(page)
  const network = opts.network || ownNetwork
  const requestedBudgetMs = Math.max(
    50,
    Number(opts.noProgressBudgetMs) || NOQR_ANSWER_CARD_HARD_WAIT_MS,
  )
  const noProgressBudgetMs = opts.deadlineAt
    ? Math.max(50, Math.min(requestedBudgetMs, opts.deadlineAt - Date.now()))
    : requestedBudgetMs
  let quietSince = Date.now()
  let lastClickAt = 0
  let clickAttempts = 0
  let lastOpenDiagnosticAt = 0
  let obstructionSince = 0
  try {
    for (;;) {
      if (stopRequested()) throw new Error('任务已停止')
      const loading = await page.locator(NOQR_SEL.loadingToast).first().isVisible().catch(() => false)
      const skeleton = await page.locator('.van-skeleton').first().isVisible().catch(() => false)
      const activeRequest = Boolean(network?.isBusinessActive())
      const surface = await answerCardSurfaceState(page)
      if (surface.card && surface.rows > 0) return
      if (opts.deadlineAt && Date.now() >= opts.deadlineAt) {
        throw new Error(
          `答题卡打开超过总时限，已安全停止当前作业（` +
          `请求=${activeRequest ? '活动' : '静默'}，加载=${loading ? '有' : '无'}，` +
          `骨架=${skeleton ? '有' : '无'}，弹层=${surface.popup ? '有' : '无'}，` +
          `卡片行=${surface.rows}，点击=${clickAttempts}）`,
        )
      }
      if (activeRequest || loading || skeleton) {
        quietSince = 0
        obstructionSince = 0
      } else if (!quietSince) {
        quietSince = Date.now()
      }

      // A client-side answer-card click normally produces no network request.
      // Retry only after a short period with no request, loading toast or
      // skeleton. An empty popup is also retried because it has no usable card
      // structure. Real slow requests keep the unbounded response wait and are
      // never mistaken for a swallowed click.
      if (
        !activeRequest &&
        !loading &&
        !skeleton &&
        clickAttempts < ANSWER_CARD_CLICK_MAX_ATTEMPTS &&
        (clickAttempts === 0 || Date.now() - lastClickAt >= ANSWER_CARD_CLICK_GRACE_MS)
      ) {
        const buttonIndex = await visibleAnswerCardButtonIndex(page)
        if (buttonIndex == null) throw new Error('答题页缺少可见答题卡入口')
        const button = page.locator('.btn-item').nth(buttonIndex)
        try {
          await button.evaluate((node) => {
            if (!(node instanceof HTMLElement)) throw new Error('答题卡入口不可点击')
            const rect = node.getBoundingClientRect()
            const left = Math.max(0, rect.left)
            const right = Math.min(window.innerWidth, rect.right)
            const top = Math.max(0, rect.top)
            const bottom = Math.min(window.innerHeight, rect.bottom)
            if (right <= left || bottom <= top) throw new Error('答题卡入口不在可见区域')
            const hit = document.elementFromPoint(
              (left + right) / 2,
              (top + bottom) / 2,
            )
            if (!(hit && (hit === node || node.contains(hit)))) {
              throw new Error('答题卡入口被遮挡')
            }
            setTimeout(() => node.click(), 0)
          })
          obstructionSince = 0
        } catch (error) {
          if (opts.deadlineAt && Date.now() >= opts.deadlineAt) {
            throw new Error(
              `答题卡打开超过总时限，已安全停止当前作业（` +
              `请求=${activeRequest ? '活动' : '静默'}，加载=${loading ? '有' : '无'}，` +
              `骨架=${skeleton ? '有' : '无'}，弹层=${surface.popup ? '有' : '无'}，` +
              `卡片行=${surface.rows}，点击=${clickAttempts}）`,
            )
          }
          // The answer-card entry can be covered by a transient animation
          // overlay or skeleton immediately after the answer surface appears.
          // Keep the page untouched and retry until the bounded deadline; a
          // permanent blocker still closes out with an explicit error.
          if (/答题卡入口被遮挡/.test(
            String(error instanceof Error ? error.message : error),
          )) {
            obstructionSince ||= Date.now()
            if (Date.now() - obstructionSince >= noProgressBudgetMs) {
              throw new Error(
                `答题卡入口被遮挡，已到有限等待上限（` +
                `请求=${activeRequest ? '活动' : '静默'}，加载=${loading ? '有' : '无'}，` +
                `骨架=${skeleton ? '有' : '无'}，弹层=${surface.popup ? '有' : '无'}，` +
                `卡片行=${surface.rows}，点击=${clickAttempts}）`,
              )
            }
          } else {
            throw error
          }
        }
        if (!obstructionSince) {
          clickAttempts++
          lastClickAt = Date.now()
          quietSince = lastClickAt
          continue
        }
      }

      if (
        !surface.popup &&
        !activeRequest &&
        !loading &&
        !skeleton &&
        clickAttempts >= ANSWER_CARD_CLICK_MAX_ATTEMPTS &&
        quietSince &&
        Date.now() - quietSince >= ANSWER_CARD_CLICK_GRACE_MS
      ) {
        throw new Error(
          `答题卡点击后无请求且未出现可见结构，已到有限重试上限（` +
          `请求=${activeRequest ? '活动' : '静默'}，加载=${loading ? '有' : '无'}，` +
          `骨架=${skeleton ? '有' : '无'}，点击=${clickAttempts}）`,
        )
      }
      if (
        surface.popup &&
        !activeRequest &&
        !loading &&
        !skeleton &&
        clickAttempts >= ANSWER_CARD_CLICK_MAX_ATTEMPTS &&
        quietSince &&
        Date.now() - quietSince >= noProgressBudgetMs
      ) {
        throw new Error(
          `答题卡弹层已打开但题目结构未加载（` +
          `请求=${activeRequest ? '活动' : '静默'}，加载=${loading ? '有' : '无'}，` +
          `骨架=${skeleton ? '有' : '无'}，卡片行=${surface.rows}，点击=${clickAttempts}）`,
        )
      }
      if (Date.now() - lastOpenDiagnosticAt >= 5_000) {
        lastOpenDiagnosticAt = Date.now()
        opts.onDiagnostic?.(
          `答题卡打开状态：请求${activeRequest ? '活动' : '静默'}，` +
          `加载${loading ? '有' : '无'}，骨架${skeleton ? '有' : '无'}，` +
          `弹层${surface.popup ? '有' : '无'}，卡片行${surface.rows}，点击${clickAttempts}`,
        )
      }
      await sleepNoqr(page, 100)
    }
  } finally {
    ownNetwork?.dispose()
  }
}

async function closeAnswerCard(
  page: Page,
  deadlineAt?: number,
  stopRequested?: () => boolean,
): Promise<void> {
  const closeDeadline = deadlineAt ?? Date.now() + 5_000
  let attemptedKeyboard = false
  let overlayClickAttempts = 0
  for (;;) {
    if (stopRequested?.()) throw new Error('任务已停止')
    const state = await answerCardModalState(page)
    if (!state.popup && !state.overlay) return
    // The site's modal answer card pairs the popup with an overlay. A popup
    // without an overlay is a non-modal panel (also used by lightweight
    // fixtures); it must not hold the answer flow hostage waiting for an
    // Escape handler that the page does not provide.
    if (!state.overlay || state.overlayIndex == null) {
      return
    }
    if (Date.now() >= closeDeadline) {
      throw new NoqrSessionError('page_error', '答题卡弹层关闭失败，已安全停止当前作业')
    }
    if (overlayClickAttempts < 3) {
      overlayClickAttempts++
      // The overlay can be a zero-size fixture or a fully transparent portal.
      // This is a close action, not a user-facing hit test.
      await page.locator('.van-overlay').nth(state.overlayIndex).evaluate((node) => {
        if (node instanceof HTMLElement) node.click()
      }).catch(() => {})
    } else if (!attemptedKeyboard) {
      attemptedKeyboard = true
      await page.keyboard.press('Escape').catch(() => {})
    }
    if (stopRequested?.()) throw new Error('任务已停止')
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
}

function answerCardDisplaySection(section: string): string {
  return section.replace(/^第\s*\d+\s*大题\s*[:：]\s*/, '').trim()
}

function isCompositeAnswerCardSection(section: string): boolean {
  return /听力理解|词汇匹配|完型填空|完形填空|阅读理解/.test(answerCardDisplaySection(section))
}

function noqrCompositeTargetNumberMatches(
  group: NoqrQuestionGroup,
  targetNumber: number,
  cardOccurrence: number,
  row?: NoqrAnswerCardRowEvidence,
): boolean {
  if (!Number.isInteger(targetNumber) || !Number.isInteger(cardOccurrence) || cardOccurrence <= 0) {
    return false
  }
  const position = group.position == null ? null : Number(group.position)
  if (
    position == null ||
    !Number.isInteger(position) ||
    position <= 0
  ) return false
  const total = group.total == null ? null : Number(group.total)
  const unitCount = Math.max(1, group.units.length)
  const local = group.units.map((unit, index) => Number(unit.ordinal || index + 1))
  const merged = local.map((number) =>
    (position - 1) * unitCount + number)
  const numberMatches = local.includes(targetNumber) || merged.includes(targetNumber)
  if (
    row &&
    total != null &&
    Number.isInteger(total) &&
    total > 0 &&
    row.cardRowCount === total &&
    row.cardRowCount > 1
  ) {
    // With one card holding several logical groups, row order is the group
    // identity. Do not let a local/merged number from another row pass when
    // the page is still showing a different group.
    if (cardOccurrence > 1 && position !== cardOccurrence) return false
    return row.rowIndex === position
  }
  if (row && total != null && Number.isInteger(total) && total > 1 && row.cardRowCount === 1) {
    // A single-row card can still represent a later logical group only by
    // its page position or a globally merged number for that position.
    if (cardOccurrence > 1 && position !== cardOccurrence) return false
    const mergedStart = (position - 1) * unitCount + 1
    const mergedEnd = position * unitCount
    return targetNumber === position ||
      (position > 1 && targetNumber >= mergedStart && targetNumber <= mergedEnd)
  }
  if (row && row.numberCount > 1) {
    // A single card can carry multiple logical composite groups with the same
    // local row numbers. The page position is the only safe group ordinal;
    // a duplicated row occurrence must match it before local/merged matching
    // is allowed.
    if (
      !Number.isInteger(row.numberOccurrence) ||
      row.numberOccurrence <= 0 ||
      row.numberOccurrence !== position
    ) return false
  }
  // A merged answer-card form can number a later composite group globally
  // (for example 6..10) while the visible question header is 2/2. There is
  // still only one composite card, so allow its local/merged row numbers
  // without requiring the header's group position to equal the card
  // occurrence. Multi-card forms still require the occurrence to match.
  if (cardOccurrence === 1) return numberMatches
  return position === cardOccurrence && (numberMatches || targetNumber === cardOccurrence)
}

function answerCardLocator(sectionKey: string): { section: string, occurrence: number } {
  const matched = sectionKey.trim().match(/^(.*)@(\d+)$/)
  return matched
    ? { section: matched[1].trim(), occurrence: Math.max(1, Number(matched[2])) }
    : { section: sectionKey.trim(), occurrence: 1 }
}

async function answerPageNavigationSignature(page: Page): Promise<string> {
  const questionInfo = page.locator(`${NOQR_SEL.questionInfo}:visible`).first()
  if (!(await questionInfo.isVisible().catch(() => false))) return ''
  return questionInfo.innerText({ timeout: 1_000 })
    .then((text) => text.replace(/\s+/g, ' ').trim())
    .catch(() => '')
}

async function compositeQuestionSurfaceReady(
  page: Page,
  section: string,
): Promise<boolean> {
  const questionInfo = page.locator(`${NOQR_SEL.questionInfo}:visible`).first()
  if (!(await questionInfo.isVisible().catch(() => false))) return false
  return questionInfo.evaluate((root, expectedSection) => {
    const visible = (node: Element): boolean => {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const visibleCount = (selector: string): number =>
      [...root.querySelectorAll(selector)].filter(visible).length
    const subItems = visibleCount('.sub-questions > .sub-item')
    const options = visibleCount(
      '.question-options .option-item[role="radio"], .question-options .option-item[role="checkbox"]',
    )
    if (expectedSection === '听力理解') {
      const audio = visibleCount('a[data-url], audio[src], video[src], iframe[src]')
      return audio > 0 && (subItems > 0 || options > 0)
    }
    if (expectedSection === '词汇匹配') {
      return visibleCount(
        '.question-options .van-cell.van-cell--clickable.van-field[role="button"]',
      ) > 0
    }
    if (expectedSection === '完型填空' || expectedSection === '完形填空') {
      return visibleCount('.spaceIndex[index]') > 0 && (subItems > 0 || options > 0)
    }
    if (expectedSection === '阅读理解') {
      return subItems > 0 && options > 0
    }
    return false
  }, section).catch(() => false)
}

async function compositeTargetNumberReached(
  page: Page,
  section: string,
  number: string,
  row?: NoqrAnswerCardRowEvidence,
): Promise<boolean> {
  const locator = answerCardLocator(section)
  const visibleText = await page.locator('.content-area:visible').first().innerText()
    .then((text) => text
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
      .replace(/你还未交卷[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .catch(() => '')
  const position = visibleText.match(/\b(?:question\s*)?(\d+)\s*\/\s*(\d+)\b/i)
  if (!position) return false
  const pagePosition = Number(position[1])
  const targetNumber = Number(number)
  if (!Number.isInteger(pagePosition) || !Number.isInteger(targetNumber)) return false
  if (
    locator.occurrence === 1 &&
    row?.cardRowCount === 1 &&
    pagePosition === targetNumber
  ) return true
  const read = await readNoqrQuestionGroup(page).catch(() => null)
  if (!read || !read.ok) {
    // Keep the navigation check usable on minimal/legacy fixtures that only
    // expose one composite row. Structural preflight still fails closed when
    // the full question group cannot be read.
    return locator.occurrence === 1 &&
      row?.cardRowCount === 1 &&
      pagePosition === targetNumber
  }
  if (!['english_listening', 'picker', 'english_cloze', 'english_reading']
    .includes(read.group.kind)) return false
  return noqrCompositeTargetNumberMatches(
    read.group,
    targetNumber,
    locator.occurrence,
    row,
  )
}

async function targetQuestionVisible(
  page: Page,
  section: string,
  number: string,
  row?: NoqrAnswerCardRowEvidence,
): Promise<boolean> {
  const questionInfo = page.locator(`${NOQR_SEL.questionInfo}:visible`).first()
  if (!(await questionInfo.isVisible().catch(() => false))) return false
  const text = await page.locator('.content-area:visible').first().innerText()
    .then((value) => value
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
      .replace(/你还未交卷[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .catch(() => '')
  const displaySection = answerCardDisplaySection(answerCardLocator(section).section)
  if (!displaySection) return false
  const position = text.match(/\b(?:question\s*)?(\d+)\s*\/\s*(\d+)\b/i)
  const positionReached = Boolean(position && Number(position[1]) === Number(number))
  if (isCompositeAnswerCardSection(section)) {
    return text.includes(displaySection) &&
      await compositeQuestionSurfaceReady(page, displaySection) &&
      await compositeTargetNumberReached(page, section, number, row)
  }
  const knownObjectiveSections = ['多选题', '单选题', '判断题', '语法']
  if (knownObjectiveSections.includes(displaySection)) {
    const expectedRole = displaySection === '单选题'
      ? 'radio'
      : displaySection === '多选题'
        ? 'checkbox'
        : ''
    const options = await questionInfo.locator(
      expectedRole
        ? `.question-options .option-item[role="${expectedRole}"]`
        : '.question-options .option-item[role="radio"], .question-options .option-item[role="checkbox"]',
    ).evaluateAll((nodes) => nodes.filter((node) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
    }).length).catch(() => 0)
    return answerCardTitleMatchesSection(text, displaySection) &&
      options > 0 &&
      (!position || positionReached)
  }
  // Generic answer-card sections such as 综合题 do not necessarily appear in
  // the answer header. Require the question body to have a matching position
  // instead of treating any non-empty content area as a successful jump.
  return positionReached || text.includes(displaySection)
}

async function targetCardState(
  page: Page,
  sectionKey: string,
  number: string,
  expectedRow?: Pick<NoqrAnswerCardRowEvidence, 'rowIndex' | 'cardRowCount'>,
): Promise<NoqrAnswerCardTargetState> {
  const locator = answerCardLocator(sectionKey)
  return page.locator(NOQR_SEL.answerCardGroup).evaluateAll((nodes, expected) => {
    const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
    const visible = (node: Element) => {
      if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    let occurrence = 0
    for (const node of nodes) {
      if (!visible(node)) continue
      const title = clean(node.querySelector(expected.titleSelector)?.textContent)
      const ambiguousChoice = title.includes(expected.ambiguousChoiceFillTitle) &&
        (expected.section === '单选题' || expected.section === '多选题')
      if (!ambiguousChoice && title !== expected.section && !title.includes(expected.section)) continue
      occurrence++
      if (occurrence !== expected.occurrence) continue
      const rows = [...node.querySelectorAll(expected.questionSelector)].filter(visible)
      if (expected.row?.cardRowCount != null && rows.length !== expected.row.cardRowCount) {
        return {
          found: false,
          current: false,
          numberOccurrence: 0,
          numberCount: 0,
          rowIndex: 0,
          cardRowCount: rows.length,
        }
      }
      const rowIndex = expected.row?.rowIndex != null
        ? expected.row.rowIndex
        : rows.findIndex((item) => clean(item.textContent) === expected.number) + 1
      const target = rows[rowIndex - 1]
      if (!(target instanceof HTMLElement) || clean(target.textContent) !== expected.number) {
        return {
          found: false,
          current: false,
          numberOccurrence: 0,
          numberCount: 0,
          rowIndex,
          cardRowCount: rows.length,
        }
      }
      const numbers = rows.map((item) => clean(item.textContent))
      return {
        found: true,
        current: target.classList.contains('is-current'),
        numberOccurrence: numbers.slice(0, rowIndex).filter((value) => value === expected.number).length,
        numberCount: numbers.filter((value) => value === expected.number).length,
        rowIndex,
        cardRowCount: rows.length,
      }
    }
    return {
      found: false,
      current: false,
      numberOccurrence: 0,
      numberCount: 0,
      rowIndex: 0,
      cardRowCount: 0,
    }
  }, {
    section: locator.section,
    occurrence: locator.occurrence,
    number,
    row: expectedRow || null,
    aliases: answerCardTitleAliases(locator.section),
    ambiguousChoiceFillTitle: AMBIGUOUS_CHOICE_FILL_TITLE,
    titleSelector: NOQR_SEL.answerCardGroupTitle,
    questionSelector: NOQR_SEL.answerCardQuestion,
  })
}

export async function goToNoqrAnswerCardQuestion(
  page: Page,
  key: string,
  stopRequested: () => boolean,
  opts: { verifyBudgetMs?: number; deadlineAt?: number } = {},
): Promise<void> {
  const separator = key.lastIndexOf('#')
  if (separator <= 0 || separator === key.length - 1) throw new Error('答题卡漏题键格式无效')
  const sectionKey = key.slice(0, separator).trim()
  const locator = answerCardLocator(sectionKey)
  const number = key.slice(separator + 1).trim()
  const beforeSignature = await answerPageNavigationSignature(page)
  const actionDeadline = opts.deadlineAt ?? Date.now() + 30_000
  try {
    await openAnswerCard(page, stopRequested, { deadlineAt: actionDeadline })
    const clicked = await page.locator(NOQR_SEL.answerCardGroup).evaluateAll((nodes, expected) => {
      const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      const visible = (node: Element) => {
        if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
        const style = getComputedStyle(node)
        return style.display !== 'none' && style.visibility !== 'hidden'
      }
      let occurrence = 0
      for (const node of nodes) {
        if (!visible(node)) continue
        const title = clean(node.querySelector(expected.titleSelector)?.textContent)
        const ambiguousChoice = title.includes(expected.ambiguousChoiceFillTitle) &&
          (expected.section === '单选题' || expected.section === '多选题')
        if (!ambiguousChoice && !expected.aliases.some((alias) => title.includes(alias))) continue
        occurrence++
        if (occurrence !== expected.occurrence) continue
        const rows = [...node.querySelectorAll(expected.questionSelector)].filter(visible)
        const rowIndex = rows.findIndex((item) => clean(item.textContent) === expected.number) + 1
        const target = rows[rowIndex - 1]
        if (target instanceof HTMLElement) {
          const wasCurrent = target.classList.contains('is-current')
          const numbers = rows.map((item) => clean(item.textContent))
          target.click()
          return {
            clicked: true,
            wasCurrent,
            rowIndex,
            cardRowCount: rows.length,
            numberOccurrence: numbers.slice(0, rowIndex)
              .filter((value) => value === expected.number).length,
            numberCount: numbers.filter((value) => value === expected.number).length,
          }
        }
      }
      return {
        clicked: false,
        wasCurrent: false,
        rowIndex: 0,
        cardRowCount: 0,
        numberOccurrence: 0,
        numberCount: 0,
      }
    }, {
      section: locator.section,
      occurrence: locator.occurrence,
      number,
      aliases: answerCardTitleAliases(locator.section),
      ambiguousChoiceFillTitle: AMBIGUOUS_CHOICE_FILL_TITLE,
      titleSelector: NOQR_SEL.answerCardGroupTitle,
      questionSelector: NOQR_SEL.answerCardQuestion,
    })
    if (!clicked.clicked) throw new Error('答题卡中找不到漏题题号')
    const rowEvidence: NoqrAnswerCardRowEvidence = {
      rowIndex: clicked.rowIndex,
      cardRowCount: clicked.cardRowCount,
      numberOccurrence: clicked.numberOccurrence,
      numberCount: clicked.numberCount,
    }
    const verifyStartedAt = Date.now()
    let cardState = clicked.wasCurrent
      ? { found: true, current: true, ...rowEvidence }
      : await targetCardState(page, sectionKey, number, rowEvidence)
    for (;;) {
      if (stopRequested()) throw new Error('任务已停止')
      cardState = await targetCardState(page, sectionKey, number, rowEvidence)
        .catch(() => cardState)
      const pageReached = await targetQuestionVisible(page, sectionKey, number, rowEvidence)
      const navigated = await answerPageNavigationSignature(page) !== beforeSignature
      // An answer-card row can become `is-current` before the question body
      // finishes rendering. Never treat the card marker alone as a completed
      // jump; the target question surface must also be readable.
      if (pageReached && (cardState.current || clicked.wasCurrent || navigated)) return
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked') throw new NoqrSessionError('auth_blocked', '答题卡跳转后进入人工认证')
      if (surface === 'error') throw new NoqrSessionError('page_error', '答题卡跳转后页面显示明确错误')
      if (Date.now() - verifyStartedAt >= Math.max(
        50,
        opts.verifyBudgetMs ?? 5_000,
      ) ||
        Date.now() >= actionDeadline) {
        throw new Error(`答题卡跳转后未到达目标题：${sectionKey}#${number}`)
      }
      await sleepNoqr(page, 100)
    }
  } finally {
    await closeAnswerCard(page, actionDeadline, stopRequested)
  }
}

async function auditNoqrAnswerCardInner(page: Page, opts: {
  stopRequested: () => boolean
  savedKeys?: ReadonlySet<string>
  expectedKeys?: ReadonlySet<string>
  expectedKeyGroups?: string[][][]
  expectedSlots?: NoqrExpectedAnswerCardSlot[]
  expectedGroups?: NoqrExpectedAnswerCardGroup[]
  savedGroupOrdinals?: ReadonlySet<number>
  expectedCount?: number
  onWaiting?: (elapsedMs: number) => void
  onRecovery?: (message: string, attempt: number) => void
  onDiagnostic?: (message: string) => void
  noProgressBudgetMs?: number
  auditDeadlineMs?: number
  maxReopens?: number
}): Promise<NoqrAnswerCardAudit> {
  const auditDeadlineMs = Math.max(
    50,
    Number(opts.auditDeadlineMs) || NOQR_ANSWER_CARD_HARD_WAIT_MS,
  )
  const noProgressBudgetMs = Math.max(
    50,
    Math.min(
      Number(opts.noProgressBudgetMs) || NOQR_ANSWER_CARD_HARD_WAIT_MS,
      auditDeadlineMs,
    ),
  )
  const maxReopens = Math.max(0, opts.maxReopens ?? 1)
  const startedAt = Date.now()
  const deadlineAt = startedAt + auditDeadlineMs
  const network = new NoqrNetworkActivity(page)
  let opened = false
  for (let openAttempt = 0; openAttempt <= maxReopens; openAttempt++) {
    try {
      await openAnswerCard(page, opts.stopRequested, {
        noProgressBudgetMs,
        network,
        deadlineAt,
        onDiagnostic: opts.onDiagnostic,
      })
      opened = true
      break
    } catch (error) {
      if (openAttempt >= maxReopens || opts.stopRequested()) throw error
      opts.onRecovery?.('答题卡未出现结构，关闭重开', openAttempt + 1)
      await closeAnswerCard(page, deadlineAt, opts.stopRequested)
    }
  }
  if (!opened) throw new Error('答题卡连续打开失败')
  let lastProgressAt = startedAt
  let reopens = 0
  const expectedKeys = new Set([...(opts.expectedKeys || [])].filter((key) => key.includes('#')))
  const expectedKeyGroups = (opts.expectedKeyGroups || [])
    .map((group) => group
      .map((keys) => keys.filter((key) => key.includes('#')))
      .filter((keys) => keys.length > 0))
    .filter((group) => group.length > 0)
  const expectedSlots = Array.isArray(opts.expectedSlots) ? opts.expectedSlots : []
  const expectedGroups = Array.isArray(opts.expectedGroups) ? opts.expectedGroups : []
  const savedGroupOrdinals = opts.savedGroupOrdinals instanceof Set
    ? opts.savedGroupOrdinals
    : new Set<number>()
  const expectedCount = Math.max(0, Math.trunc(Number(opts.expectedCount) || 0))
  let structureVersion = ''
  let slowDiagnosticVersion = ''
  const maximumStructureCounts = new Map<string, number>()
  try {
    for (;;) {
      const rows = await page.locator(NOQR_SEL.answerCardGroup).evaluateAll((cards, titleSections) => {
        const occurrences = new Map<string, number>()
        const visible = (node: Element) => {
          if (!(node instanceof HTMLElement) || node.getClientRects().length === 0) return false
          const style = getComputedStyle(node)
          return style.display !== 'none' && style.visibility !== 'hidden'
        }
        const rows: Array<{
          key: string
          legacyKey: string
          section: string
          number: string
          answered: boolean
          current: boolean
          cardIndex: number
          cardOrdinal: number | null
          sectionOccurrence: number
        }> = []
        for (const [cardIndex, card] of cards.entries()) {
          if (!visible(card)) continue
          const title = (card.querySelector('.question-cart-title')?.textContent || '')
            .replace(/\s+/g, ' ').trim()
          const ordinalMatch = title.match(/第\s*(\d+)\s*大题/)
          const cardOrdinal = ordinalMatch ? Math.max(1, Number(ordinalMatch[1])) : null
          const section = title.includes('选择填空题')
            ? ''
            : titleSections.find((entry) =>
              entry.aliases.some((alias) => title.includes(alias)))?.section || ''
          const occurrence = section ? (occurrences.get(section) || 0) + 1 : 0
          if (section) occurrences.set(section, occurrence)
          for (const node of card.querySelectorAll('.sub-question')) {
            if (!visible(node)) continue
            const number = (node.textContent || '').replace(/\s+/g, ' ').trim()
            const legacyKey = section ? `${section}#${number}` : ''
            const scopedKey = section ? `${section}@${occurrence}#${number}` : ''
            rows.push({
              key: scopedKey || `${title}#${number}`,
              legacyKey,
              section,
              number,
              answered: node.classList.contains('has-answered'),
              current: node.classList.contains('is-current'),
              cardIndex,
              cardOrdinal,
              sectionOccurrence: occurrence,
            })
          }
        }
        return rows
      }, ANSWER_CARD_TITLE_SECTIONS)
      const observedKeys = new Set(rows.flatMap((row) => [row.key, row.legacyKey, row.number]))
      const expectedNumbers = new Map<string, number>()
      for (const key of expectedKeys) {
        const number = key.slice(key.lastIndexOf('#') + 1)
        expectedNumbers.set(number, (expectedNumbers.get(number) || 0) + 1)
      }
      const observedNumbers = new Map<string, number>()
      for (const row of rows) {
        observedNumbers.set(row.number, (observedNumbers.get(row.number) || 0) + 1)
      }
      const mappedRows = rows.some((row) => Boolean(row.legacyKey))
      const legacyKeyEvidenceLoaded = mappedRows
        ? expectedKeyGroups.length > 0
          ? expectedKeyGroups.every((group) =>
              group.some((keys) => keys.every((key) => observedKeys.has(key))))
          : [...expectedKeys].every((key) => observedKeys.has(key))
        : [...expectedNumbers].every(([number, count]) => (observedNumbers.get(number) || 0) >= count)
      const structuredMatch = expectedSlots.length
        ? matchNoqrAnswerCardSlots(expectedSlots, rows)
        : null
      const groupMatch = expectedGroups.length
        ? matchNoqrAnswerCardGroups(expectedGroups, rows)
        : null
      const sectionGroupCounts = new Map<string, number>()
      for (const group of expectedGroups) {
        if (group.section) {
          sectionGroupCounts.set(group.section, (sectionGroupCounts.get(group.section) || 0) + 1)
        }
      }
      const hasSavedEvidence = (row: NoqrObservedAnswerCardRow): boolean => {
        if (opts.savedKeys?.has(row.key)) return true
        const sectionIsUnique = !row.section || (sectionGroupCounts.get(row.section) || 1) <= 1
        return sectionIsUnique &&
          Boolean(opts.savedKeys?.has(row.legacyKey) || opts.savedKeys?.has(row.number))
      }
      const loading = await page.locator(NOQR_SEL.loadingToast).first().isVisible().catch(() => false)
      const skeleton = await page.locator('.van-skeleton').first().isVisible().catch(() => false)
      const networkActive = network.isBusinessActive()
      const activityActive = loading || skeleton || networkActive
      const savedExpectedGroupCount = expectedGroups
        .filter((group) => savedGroupOrdinals.has(group.groupOrdinal)).length
      const allExpectedGroupsSaved = expectedGroups.length > 0 &&
        savedExpectedGroupCount === expectedGroups.length
      const allVisibleRowsHaveProgress = rows.length > 0 &&
        rows.every((row) => row.answered || row.current || hasSavedEvidence(row))
      // Some school answer-card layouts virtualize or truncate mixed reading
      // groups even after every logical group has an accepted save request.
      // Permit only the exact-cardinality, all-saved, all-progress case; any
      // missing group, active request, skeleton, loading toast or unaccounted
      // row remains blocked below.
      const savedGroupsFallback = Boolean(
        groupMatch &&
        allExpectedGroupsSaved &&
        rows.length === expectedGroups.length &&
        allVisibleRowsHaveProgress &&
        !activityActive,
      )
      const parentOnlyGroupsSaved = Boolean(
        groupMatch &&
        [...groupMatch.parentOnlyGroupOrdinals]
          .every((groupOrdinal) => savedGroupOrdinals.has(groupOrdinal)),
      )
      const keyEvidenceLoaded = groupMatch
        ? groupMatch.matchedGroupCount === expectedGroups.length && parentOnlyGroupsSaved
        : structuredMatch
          ? structuredMatch.matchedSlotCount === expectedSlots.length
          : legacyKeyEvidenceLoaded
      const hasExpectedEvidence = expectedGroups.length > 0 ||
        expectedSlots.length > 0 ||
        expectedKeyGroups.length > 0 ||
        expectedKeys.size > 0
      const expectedLoaded = groupMatch
        ? groupMatch.matchedGroupCount === expectedGroups.length && parentOnlyGroupsSaved
        : structuredMatch
          ? structuredMatch.matchedSlotCount === expectedSlots.length
          : expectedCount > 0
            ? rows.length >= expectedCount && (!hasExpectedEvidence || keyEvidenceLoaded)
            : keyEvidenceLoaded
      const answerCardReady = expectedLoaded || savedGroupsFallback
      // A matched answer-card group only exists after its save request was
      // accepted. Treat the whole group as saved when every visible card row
      // maps to the expected structure, even if the site lags on one
      // `has-answered` class. Extra/unmapped rows still require direct
      // per-row evidence below, so this cannot hide an unexpected blank slot.
      const matchedRowsHaveSavedGroupEvidence = Boolean(
        savedGroupsFallback ||
        (
          groupMatch &&
          groupMatch.matchedGroupCount === expectedGroups.length &&
          groupMatch.matchedRows.size === rows.length &&
          expectedGroups.every((group) => savedGroupOrdinals.has(group.groupOrdinal))
        ),
      )
      const matchedGroupCount = groupMatch?.matchedGroupCount || 0
      const matchedRowCount = groupMatch?.matchedRows.size || 0
      const parentOnlyGroupCount = groupMatch?.parentOnlyGroupOrdinals.size || 0
      const unmatchedVisibleRowCount = Math.max(0, rows.length - matchedRowCount)
      const structuralEntries = rows
        .map((row) => JSON.stringify([row.key, row.legacyKey, row.section, row.number]))
        .sort()
      const structureCounts = new Map<string, number>()
      for (const entry of structuralEntries) {
        structureCounts.set(entry, (structureCounts.get(entry) || 0) + 1)
      }
      let structureAdvanced = false
      for (const [entry, count] of structureCounts) {
        if (count > (maximumStructureCounts.get(entry) || 0)) {
          maximumStructureCounts.set(entry, count)
          structureAdvanced = true
        }
      }
      const nextStructureVersion = JSON.stringify(structuralEntries)
      if (structureAdvanced) {
        lastProgressAt = Date.now()
      }
      if (activityActive) {
        lastProgressAt = Date.now()
      }
      if (
        !expectedLoaded &&
        slowDiagnosticVersion !== nextStructureVersion &&
        Date.now() - startedAt >= 10_000
      ) {
        slowDiagnosticVersion = nextStructureVersion
        opts.onDiagnostic?.(
          `答题卡等待诊断：可见 ${rows.length}/${expectedCount || expectedKeys.size}，` +
          `已答 ${rows.filter((row) => row.answered).length}，` +
          `题型映射 ${mappedRows ? '有' : '无'}，` +
          `键证据 ${keyEvidenceLoaded ? '完整' : '不足'}，` +
          `结构化答题组 ${matchedGroupCount}/${expectedGroups.length}，` +
          `匹配行 ${matchedRowCount}/${rows.length}，` +
          `保存组 ${savedExpectedGroupCount}/${expectedGroups.length}，` +
          `父题组 ${parentOnlyGroupCount}，` +
          `未映射行 ${unmatchedVisibleRowCount}，` +
          (groupMatch
            ? `未匹配组 ${JSON.stringify(groupMatch.unmatchedGroups)}，`
            : structuredMatch
              ? `结构化题位 ${structuredMatch.matchedSlotCount}/${expectedSlots.length}，` +
              `未匹配组 ${JSON.stringify([...new Set(
                structuredMatch.unmatchedSlots.map((index) => expectedSlots[index]?.groupOrdinal),
              )])}，`
              : '') +
          `期望题号 ${JSON.stringify(Object.fromEntries(expectedNumbers))}，` +
          `实际题号 ${JSON.stringify(Object.fromEntries(observedNumbers))}，` +
          `网络 ${networkActive ? '活动' : '静默'}，` +
          `骨架 ${skeleton ? '有' : '无'}`,
        )
      }
      if ((!expectedCount && !hasExpectedEvidence) || answerCardReady) {
        const missing = rows.filter((row) =>
          !row.answered &&
          !hasSavedEvidence(row) &&
          !matchedRowsHaveSavedGroupEvidence)
        return {
          ok: rows.length > 0 && missing.length === 0,
          answered: rows.filter((row) => row.answered).length,
          current: rows.filter((row) => row.current).length,
          unanswered: missing.length,
          missingKeys: missing.map((row) => row.key),
        }
      }
      if (opts.stopRequested()) throw new Error('任务已停止')
      if (Date.now() - startedAt >= auditDeadlineMs) {
        throw new Error('答题卡自动恢复超过总时限，已安全停止当前作业')
      }
      if (!activityActive && Date.now() - lastProgressAt >= noProgressBudgetMs) {
        const recognizedSections = new Set(
          rows.map((row) => row.legacyKey.split('#')[0]).filter(Boolean),
        )
        opts.onDiagnostic?.(
          `答题卡结构不足：已加载 ${rows.length}/${expectedCount || expectedKeys.size}，` +
          `已答 ${rows.filter((row) => row.answered).length}，` +
          `识别题型 ${recognizedSections.size}，` +
          `结构化组 ${matchedGroupCount}/${expectedGroups.length}，` +
          `匹配行 ${matchedRowCount}/${rows.length}，` +
          `保存组 ${savedExpectedGroupCount}/${expectedGroups.length}，` +
          `父题组 ${parentOnlyGroupCount}，` +
          `未映射行 ${unmatchedVisibleRowCount}`,
        )
        opts.onDiagnostic?.(
          `答题卡观测签名：c=${rows.map((row) => row.cardOrdinal ?? '?').join(',')};` +
          `o=${rows.map((row) => row.sectionOccurrence).join(',')};` +
          `n=${rows.map((row) => row.number).join(',')}`,
        )
        opts.onDiagnostic?.(
          `答题卡期望签名：p=${expectedGroups.map((group) => group.position).join(',')};` +
          `o=${expectedGroups.map((group) => group.kindOccurrence).join(',')};` +
          `u=${expectedGroups.map((group) => group.unitCount).join(',')}`,
        )
        if (reopens >= maxReopens) {
          throw new Error(`答题卡连续 ${maxReopens + 1} 次无进展，已安全停止当前作业`)
        }
        reopens++
        opts.onRecovery?.('答题卡加载无进展，关闭重开', reopens)
        await closeAnswerCard(page, deadlineAt, opts.stopRequested)
        await openAnswerCard(page, opts.stopRequested, {
          noProgressBudgetMs,
          network,
          deadlineAt,
          onDiagnostic: opts.onDiagnostic,
        })
        structureVersion = ''
        lastProgressAt = Date.now()
        continue
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(page, 100)
    }
  } finally {
    network.dispose()
    await closeAnswerCard(page, deadlineAt, opts.stopRequested)
  }
}

export function auditNoqrAnswerCard(
  page: Page,
  opts: Parameters<typeof auditNoqrAnswerCardInner>[1],
): Promise<NoqrAnswerCardAudit> {
  const hardDeadlineMs = Math.max(
    50,
    Number(opts.auditDeadlineMs) || NOQR_ANSWER_CARD_HARD_WAIT_MS,
  )
  let hardStopped = false
  const wrappedOpts = {
    ...opts,
    auditDeadlineMs: hardDeadlineMs > 5_000 ? hardDeadlineMs - 2_000 : hardDeadlineMs,
    stopRequested: () => hardStopped || opts.stopRequested(),
  }
  return withNoqrHardDeadline(
    auditNoqrAnswerCardInner(page, wrappedOpts),
    hardDeadlineMs,
    () => {
      hardStopped = true
      throw new NoqrSessionError(
        'answer_interrupted',
        '答题卡审计超过总时限，已保留当前页面并停止当前作业',
      )
    },
  )
}

async function dialogText(page: Page): Promise<string> {
  return page.locator(NOQR_SEL.dialog).first().innerText().catch(() => '')
}

async function cancelIncompleteDialog(page: Page, stopRequested: () => boolean): Promise<string | null> {
  const dialog = page.locator(NOQR_SEL.dialog).first()
  if (!(await dialog.isVisible().catch(() => false))) return null
  if (stopRequested()) return '任务已停止'
  const text = await dialogText(page)
  if (/还有问题未完成作答|未完成作答|部分题目没有作答|仍有.*未答/.test(text)) {
    if (stopRequested()) return '任务已停止'
    await page.locator(NOQR_SEL.dialogCancel).first().click()
    return text
  }
  if (/确认交卷|确定交卷/.test(text) && !/验证码|登录|失败|错误|异常|未完成|还有问题/.test(text)) {
    if (stopRequested()) return '任务已停止'
    await page.locator(NOQR_SEL.dialogConfirm).first().click()
    return null
  }
  return text
}

async function submitUiState(page: Page): Promise<{ successToast: boolean; buttonDisabled: boolean }> {
  const toastText = await visibleText(page, NOQR_SEL.successToast)
  const button = page.locator(NOQR_SEL.submitButton).first()
  return {
    successToast: /交卷成功/.test(toastText),
    buttonDisabled: await button.evaluate((node) => node.classList.contains('disable-btn')).catch(() => false),
  }
}

async function submitNoqrHomeworkInner(opts: {
  page: Page
  workId: string
  observer: NoqrMutationObserver
  stopRequested: () => boolean
  expectedHomeWorkUniqueFlag?: string
  onWaiting?: (state: string, elapsedMs: number) => void
  noRequestRetryBudgetMs?: number
  successUiBudgetMs?: number
  submitHardDeadlineMs?: number
}): Promise<NoqrSubmitResult> {
  if (opts.stopRequested()) throw new Error('任务已停止')
  const submit = opts.page.locator(NOQR_SEL.submitButton).first()
  if (!(await submit.count())) throw new Error('答题页缺少交卷按钮')
  if (await submit.evaluate((node) => node.classList.contains('disable-btn')).catch(() => false)) {
    throw new Error('交卷按钮已处于禁用状态，未重复交卷')
  }
  if (opts.stopRequested()) throw new Error('任务已停止')
  const marker = opts.observer.marker()
  if (opts.stopRequested()) throw new Error('任务已停止')
  const startedAt = Date.now()
  const submitHardDeadlineMs = Math.max(
    50,
    Number(opts.submitHardDeadlineMs) || NOQR_SUBMIT_HARD_WAIT_MS,
  )
  const network = new NoqrNetworkActivity(opts.page)
  try {
    if (opts.stopRequested()) throw new Error('任务已停止')
    await submit.evaluate((node) => {
      if (!(node instanceof HTMLElement)) throw new Error('交卷按钮不可点击')
      setTimeout(() => node.click(), 0)
    })
  } catch (error) {
    network.dispose()
    if (opts.stopRequested()) throw error
    return {
      ok: false,
      uncertain: true,
      incomplete: false,
      state: 'submitted_uncertain',
      reason: '交卷点击未在安全上限内完成，结果不确定',
      homeWorkUniqueFlag: '',
      paperStructUniqueFlag: '',
      successToast: false,
      buttonDisabled: false,
    }
  }
  let clickAttempts = 1
  let noRequestSince = 0
  let successUiSince = 0
  const noRequestRetryBudgetMs = Math.max(50, Number(opts.noRequestRetryBudgetMs) || 120_000)
  const successUiBudgetMs = Math.max(50, Number(opts.successUiBudgetMs) || 120_000)
  let requestFailureReason = ''
  let successToast = false
  let buttonDisabled = false
  let dialogCancelReason: string | null = null
  let monitoring = true
  const uiMonitor = (async () => {
    try {
      while (monitoring) {
        if (!dialogCancelReason) dialogCancelReason = await cancelIncompleteDialog(opts.page, opts.stopRequested)
        const ui = await submitUiState(opts.page)
        successToast ||= ui.successToast
        buttonDisabled ||= ui.buttonDisabled
        if (successToast && buttonDisabled) return
        if (opts.stopRequested()) return
        await sleepNoqr(opts.page, 100)
      }
    } catch {
      // Hard timeout or page close wins; the caller receives an uncertain
      // result instead of an unhandled background UI-monitor rejection.
    }
  })()

  let finish: ReturnType<NoqrMutationObserver['findRequest']> = null
  for (;;) {
    if (dialogCancelReason) break
    finish = opts.observer.findRequest({ after: marker, kinds: ['finish'], workId: opts.workId })
    if (finish) break
    if (opts.stopRequested()) {
      requestFailureReason = '任务已停止'
      break
    }
    if (Date.now() - startedAt >= submitHardDeadlineMs) {
      requestFailureReason = '交卷等待超过安全上限，结果不确定'
      break
    }
    if (!opts.stopRequested() && !successToast && !buttonDisabled && !network.isBusinessActive()) {
      noRequestSince ||= Date.now()
    } else {
      noRequestSince = 0
    }
    if (successToast || buttonDisabled) {
      successUiSince ||= Date.now()
      if (Date.now() - successUiSince >= successUiBudgetMs) {
        requestFailureReason = '交卷结果 UI 已出现部分证据，但未捕获最终交卷请求'
        break
      }
    } else {
      successUiSince = 0
    }
    if (noRequestSince && Date.now() - noRequestSince >= noRequestRetryBudgetMs) {
      if (clickAttempts >= 3 || !(await submit.isVisible().catch(() => false))) {
        requestFailureReason = `未捕获到最终交卷请求（已点击 ${clickAttempts} 次）`
        break
      }
      if (opts.stopRequested()) {
        requestFailureReason = '任务已停止'
        break
      }
      opts.onWaiting?.(`未观察到交卷请求，重新点击 ${clickAttempts + 1}/3`, Date.now() - startedAt)
      try {
        await submit.evaluate((node) => {
          if (!(node instanceof HTMLElement)) throw new Error('交卷按钮不可点击')
          setTimeout(() => node.click(), 0)
        })
      } catch {
        requestFailureReason = '交卷重试点击未在安全上限内完成，结果不确定'
        break
      }
      clickAttempts++
      noRequestSince = 0
    }
    opts.onWaiting?.('等待最终交卷请求', Date.now() - startedAt)
    await sleepNoqr(opts.page, 100)
  }
  network.dispose()
  if (!finish) {
    finish = opts.observer.findRequest({ after: marker, kinds: ['finish'], workId: opts.workId })
  }

  if (!finish) {
    monitoring = false
    await uiMonitor
    return {
      ok: false,
      uncertain: !dialogCancelReason,
      incomplete: Boolean(dialogCancelReason),
      state: dialogCancelReason ? 'incomplete' : 'submitted_uncertain',
      reason: dialogCancelReason
        ? '页面提示仍有未完成题目，已取消交卷并等待补答'
        : requestFailureReason || '交卷请求未确认',
      homeWorkUniqueFlag: '',
      paperStructUniqueFlag: '',
      successToast,
      buttonDisabled,
    }
  }

  const result = await opts.observer.waitForResult(finish, {
    stopRequested: opts.stopRequested,
    onWaiting: (elapsed) => opts.onWaiting?.('等待最终交卷响应', elapsed),
    hardDeadlineMs: Math.max(50, submitHardDeadlineMs - (Date.now() - startedAt)),
  })
  const accepted = isNoqrRequestAccepted(Number(result.httpStatus) || 0, result.payload as never)
  const homeWorkUniqueFlag = typeof result.body.homeWorkUniqueFlag === 'string' ? result.body.homeWorkUniqueFlag : ''
  const paperStructUniqueFlag = typeof result.body.paperStructUniqueFlag === 'string' ? result.body.paperStructUniqueFlag : ''
  if (!accepted) {
    monitoring = false
    await uiMonitor
    const transportUncertain = Boolean(result.requestError) || !Number.isInteger(Number(result.httpStatus))
    return {
      ok: false,
      uncertain: transportUncertain,
      incomplete: false,
      state: transportUncertain ? 'submitted_uncertain' : 'failed',
      reason: result.requestError
        ? `最终交卷请求失败，结果不确定：${result.requestError}`
        : '最终交卷响应未通过 HTTP 与业务校验',
      homeWorkUniqueFlag,
      paperStructUniqueFlag,
      successToast,
      buttonDisabled,
    }
  }
  if (
    !homeWorkUniqueFlag ||
    !paperStructUniqueFlag ||
    (opts.expectedHomeWorkUniqueFlag && homeWorkUniqueFlag !== opts.expectedHomeWorkUniqueFlag)
  ) {
    monitoring = false
    await uiMonitor
    return {
      ok: false,
      uncertain: true,
      incomplete: false,
      state: 'submitted_uncertain',
      reason: opts.expectedHomeWorkUniqueFlag && homeWorkUniqueFlag !== opts.expectedHomeWorkUniqueFlag
        ? '交卷请求的作业唯一标记与本次保存不一致，结果不确定'
        : '交卷请求缺少作业或试卷唯一标记，结果不确定',
      homeWorkUniqueFlag,
      paperStructUniqueFlag,
      successToast,
      buttonDisabled,
    }
  }

  const successUiStartedAt = Date.now()
  while (!opts.stopRequested()) {
    if (dialogCancelReason) break
    if (successToast && buttonDisabled) break
    if (Date.now() - successUiStartedAt >= successUiBudgetMs) break
    opts.onWaiting?.('等待交卷成功页面证据', Date.now() - startedAt)
    await sleepNoqr(opts.page, 100)
  }
  monitoring = false
  await uiMonitor

  return {
    ok: successToast && buttonDisabled,
    uncertain: !successToast || !buttonDisabled,
    incomplete: false,
    state: successToast && buttonDisabled ? 'ready' : 'submitted_uncertain',
    reason: successToast && buttonDisabled
      ? undefined
      : dialogCancelReason || '交卷响应成功，但成功提示或按钮禁用证据不完整',
    homeWorkUniqueFlag,
    paperStructUniqueFlag,
    successToast,
    buttonDisabled,
  }
}

export function submitNoqrHomework(
  opts: Parameters<typeof submitNoqrHomeworkInner>[0],
): Promise<NoqrSubmitResult> {
  const hardDeadlineMs = Math.max(
    50,
    Number(opts.submitHardDeadlineMs) || NOQR_SUBMIT_HARD_WAIT_MS,
  )
  let hardStopped = false
  const wrappedOpts = {
    ...opts,
    stopRequested: () => hardStopped || opts.stopRequested(),
  }
  return withNoqrHardDeadline(
    submitNoqrHomeworkInner(wrappedOpts),
    hardDeadlineMs,
    () => {
      hardStopped = true
      return {
        ok: false,
        uncertain: true,
        incomplete: false,
        state: 'submitted_uncertain',
        reason: '交卷流程超过安全上限，结果不确定',
        homeWorkUniqueFlag: '',
        paperStructUniqueFlag: '',
        successToast: false,
        buttonDisabled: false,
      }
    },
  )
}

async function returnToNoqrCourseWorkInner(
  page: Page,
  stopRequested: () => boolean,
  opts: {
    blankGraceMs?: number
    refreshBudget?: number
    backRetryQuietMs?: number
    maxBackAttempts?: number
    hardDeadlineMs?: number
    submitConfirmedEvidence?: boolean
  } = {},
): Promise<void> {
  const back = page.locator(`${NOQR_SEL.navBack}:visible`).first()
  if (!(await back.count())) throw new Error('交卷成功后缺少返回按钮')
  if (stopRequested()) throw new Error('任务已停止')
  if (isNoqrAnswerPath(page.url()) && opts.submitConfirmedEvidence !== true) {
    // The real success page keeps the answer URL and exposes the complete
    // Finish evidence until the user presses the top-left back control.
    const evidence = await submitUiState(page)
    if (!evidence.successToast || !evidence.buttonDisabled) {
      throw new NoqrSessionError('answer_interrupted', '未确认交卷的答题页不允许进入返回流程')
    }
  }
  const network = new NoqrNetworkActivity(page)
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    refreshBudget: opts.refreshBudget ?? 3,
  })
  const backRetryQuietMs = Math.max(50, opts.backRetryQuietMs ?? 120_000)
  const maxBackAttempts = Math.max(1, Math.trunc(opts.maxBackAttempts ?? 3))
  const hardDeadlineMs = Math.max(
    50,
    Number(opts.hardDeadlineMs) || NOQR_RETURN_HARD_WAIT_MS,
  )
  const startedAt = Date.now()
  let backAttempts = 0
  let homeEntryAttempts = 0
  let lastReturnObservation = ''
  let lastReturnProgressAt = Date.now()
  let lastHomeObservation = ''
  let lastHomeProgressAt = Date.now()
  const clickBack = async () => {
    if (stopRequested()) throw new Error('任务已停止')
    try {
      await back.evaluate((node) => {
        if (!(node instanceof HTMLElement)) throw new Error('返回按钮不可点击')
        setTimeout(() => node.click(), 0)
      })
    } catch {
      throw new NoqrSessionError(
        'answer_interrupted',
        '交卷后返回按钮点击未在安全上限内完成，已保留当前页面',
      )
    }
    backAttempts++
    lastReturnProgressAt = Date.now()
  }
  const clickHomeEntry = async (entry: ReturnType<Page['locator']>) => {
    if (stopRequested()) throw new Error('任务已停止')
    try {
      await entry.evaluate((node) => {
        if (!(node instanceof HTMLElement)) throw new Error('形考作业入口不可点击')
        setTimeout(() => node.click(), 0)
      })
    } catch {
      throw new NoqrSessionError(
        'page_error',
        '交卷返回首页后“形考作业”入口点击未在安全上限内完成',
      )
    }
  }
  try {
    // Observe the return navigation before clicking the back button.
    await clickBack()
    for (;;) {
      if (stopRequested()) throw new Error('任务已停止')
      if (Date.now() - startedAt >= hardDeadlineMs) {
        throw new NoqrSessionError(
          isNoqrAnswerPath(page.url()) ? 'answer_interrupted' : 'page_error',
          '交卷后返回作业区超过安全上限，已保留当前页面并停止当前学生',
        )
      }
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked' || surface === 'login') {
        throw new NoqrSessionError('auth_blocked', '交卷返回后进入登录或人工认证页面')
      }
      if (surface === 'error') throw new NoqrSessionError('page_error', '交卷返回后页面显示明确错误')
      if (isNoqrAnswerPath(page.url())) {
        // A successful Finish leaves the URL unchanged. After the back click,
        // keep waiting for that same-page navigation and never reload here.
        const observation = `${page.url()}|${surface}|${network.businessActivityVersion}|${network.isBusinessActive()}`
        if (observation !== lastReturnObservation) {
          lastReturnObservation = observation
          lastReturnProgressAt = Date.now()
        }
        if (network.isBusinessActive() || Date.now() - lastReturnProgressAt < backRetryQuietMs) {
          await sleepNoqr(page, 100)
          continue
        }
        if (backAttempts >= maxBackAttempts || !(await back.isVisible().catch(() => false))) {
          throw new NoqrSessionError(
            'page_error',
            '交卷成功页连续点击返回仍停留在答题页，已保留当前页面且未刷新',
          )
        }
        await clickBack()
        continue
      }
      const currentPath = (() => {
        try { return new URL(page.url()).pathname.replace(/\/+$/, '') || '/' } catch { return '' }
      })()
      if (currentPath === NOQR_PATH.home) {
        // Some school responses send the back action to the home page. Re-enter
        // only through the visible 形考作业 entry, never by a direct URL.
        const entry = page.locator(NOQR_SEL.homeMenuItems)
          .getByText('形考作业', { exact: true })
          .first()
        if (!(await entry.count())) {
          throw new NoqrSessionError('page_error', '交卷返回首页后缺少“形考作业”入口')
        }
        if (homeEntryAttempts === 0) {
          await clickHomeEntry(entry)
          homeEntryAttempts++
          lastHomeProgressAt = Date.now()
          continue
        }
        const observation = `${page.url()}|${network.businessActivityVersion}|${network.isBusinessActive()}`
        if (observation !== lastHomeObservation) {
          lastHomeObservation = observation
          lastHomeProgressAt = Date.now()
        }
        if (network.isBusinessActive() || Date.now() - lastHomeProgressAt < backRetryQuietMs) {
          await sleepNoqr(page, 100)
          continue
        }
        if (homeEntryAttempts >= maxBackAttempts) {
          throw new NoqrSessionError(
            'page_error',
            '交卷返回首页后形考作业入口持续无响应，已安全停止当前学生',
          )
        }
        await clickHomeEntry(entry)
        homeEntryAttempts++
        lastHomeProgressAt = Date.now()
        continue
      }
      if (currentPath === NOQR_PATH.courseWork) {
        const state = await page.evaluate((selectors) => ({
          items: document.querySelectorAll(selectors.courseWorkItem).length,
          empty: Boolean(document.querySelector('.van-empty')) ||
            /暂无作业|没有作业|暂无数据/.test(document.body?.innerText || ''),
          skeleton: Boolean(document.querySelector('.skeleton-area.van-skeleton')),
        }), NOQR_SEL)
        if (state.items > 0 || state.empty) return
        const decision = recovery.observe({
          now: Date.now(),
          activityVersion: network.businessActivityVersion,
          empty: true,
          active: network.isBusinessActive(),
          stopRequested: stopRequested(),
        })
        if (decision.action === 'refresh') {
          await reloadNoqrPage(page, { stopRequested })
          continue
        }
        if (decision.action === 'stop') {
          throw new NoqrSessionError('blank_page', '交卷返回后作业区持续无响应，已安全停止当前学生')
        }
      } else {
        const decision = recovery.observe({
          now: Date.now(),
          activityVersion: network.businessActivityVersion,
          empty: true,
          active: network.isBusinessActive(),
          stopRequested: stopRequested(),
        })
        if (decision.action === 'refresh') {
          await reloadNoqrPage(page, { stopRequested })
          continue
        }
        if (decision.action === 'stop') {
          throw new NoqrSessionError('blank_page', '交卷返回后页面持续无响应，已安全停止当前学生')
        }
      }
      await sleepNoqr(page, 100)
    }
  } finally {
    network.dispose()
  }
}

export function returnToNoqrCourseWork(
  page: Page,
  stopRequested: () => boolean,
  opts: Parameters<typeof returnToNoqrCourseWorkInner>[2] = {},
): Promise<void> {
  const hardDeadlineMs = Math.max(
    50,
    Number(opts.hardDeadlineMs) || NOQR_RETURN_HARD_WAIT_MS,
  )
  let hardStopped = false
  const wrappedOpts = {
    ...opts,
    hardDeadlineMs,
  }
  return withNoqrHardDeadline(
    returnToNoqrCourseWorkInner(page, () => hardStopped || stopRequested(), wrappedOpts),
    hardDeadlineMs,
    () => {
      hardStopped = true
      throw new NoqrSessionError(
        isNoqrAnswerPath(page.url()) ? 'answer_interrupted' : 'page_error',
        '交卷后返回作业区超过安全上限，已保留当前页面并停止当前学生',
      )
    },
  )
}
