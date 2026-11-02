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
import type { NoqrQuestionGroup, NoqrQuestionKind } from './question.ts'

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

export function answerCardSectionFromTitle(title: string): string {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim()
  return ANSWER_CARD_TITLE_SECTIONS.find((entry) =>
    entry.aliases.some((alias) => normalized.includes(alias)))?.section || ''
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

async function openAnswerCard(
  page: Page,
  stopRequested: () => boolean,
  opts: {
    noProgressBudgetMs?: number
    network?: NoqrNetworkActivity
    deadlineAt?: number
  } = {},
): Promise<void> {
  const button = page.locator(NOQR_SEL.answerCardButton).first()
  if (!(await button.count())) throw new Error('答题页缺少答题卡入口')
  if (stopRequested()) throw new Error('任务已停止')
  const ownNetwork = opts.network ? null : new NoqrNetworkActivity(page)
  const network = opts.network || ownNetwork
  const requestedBudgetMs = Math.max(50, Number(opts.noProgressBudgetMs) || 120_000)
  const noProgressBudgetMs = opts.deadlineAt
    ? Math.max(50, Math.min(requestedBudgetMs, opts.deadlineAt - Date.now()))
    : requestedBudgetMs
  let idleSince = Date.now()
  try {
    try {
      await button.evaluate((node) => {
        if (!(node instanceof HTMLElement)) throw new Error('答题卡入口不可点击')
        setTimeout(() => node.click(), 0)
      })
    } catch (error) {
      if (opts.deadlineAt && Date.now() >= opts.deadlineAt) {
        throw new Error('答题卡打开超过总时限，已安全停止当前作业')
      }
      throw error
    }
    for (;;) {
      if (stopRequested()) throw new Error('任务已停止')
      const loading = await page.locator(NOQR_SEL.loadingToast).first().isVisible().catch(() => false)
      const skeleton = await page.locator('.van-skeleton').first().isVisible().catch(() => false)
      const activeRequest = Boolean(network?.isBusinessActive())
      const card = page.locator(NOQR_SEL.answerCardGroup)
      for (let index = 0; index < await card.count(); index++) {
        if (await card.nth(index).isVisible().catch(() => false)) return
      }
      if (opts.deadlineAt && Date.now() >= opts.deadlineAt) {
        throw new Error('答题卡打开超过总时限，已安全停止当前作业')
      }
      if (activeRequest || loading || skeleton) {
        idleSince = Date.now()
      } else if (Date.now() - idleSince >= noProgressBudgetMs) {
        throw new Error('答题卡点击后无请求且未出现可见结构，已到总时限')
      }
      await sleepNoqr(page, 100)
    }
  } finally {
    ownNetwork?.dispose()
  }
}

async function closeAnswerCard(page: Page, deadlineAt?: number): Promise<void> {
  const closeDeadline = deadlineAt ?? Date.now() + 5_000
  const answerCardState = async (): Promise<{ popup: boolean; overlay: boolean }> => {
    const popup = page.locator(`${NOQR_SEL.answerCardPopup}:visible`)
    const overlay = page.locator('.van-overlay:visible')
    return {
      popup: (await popup.count().catch(() => 0)) > 0,
      overlay: (await overlay.count().catch(() => 0)) > 0,
    }
  }
  const backdrop = page.locator('.van-overlay').last()
  let attemptedKeyboard = false
  for (;;) {
    const state = await answerCardState()
    if (!state.popup && !state.overlay) return
    // The site's modal answer card pairs the popup with an overlay. A popup
    // without an overlay is a non-modal panel (also used by lightweight
    // fixtures); it must not hold the answer flow hostage waiting for an
    // Escape handler that the page does not provide.
    if (state.popup && !state.overlay) {
      return
    }
    const remaining = Math.max(1, closeDeadline - Date.now())
    if (Date.now() >= closeDeadline) {
      throw new NoqrSessionError('page_error', '答题卡弹层关闭失败，已安全停止当前作业')
    }
    if (await backdrop.isVisible().catch(() => false)) {
      await backdrop.click({
        position: { x: 5, y: 5 },
        timeout: remaining,
      }).catch(() => {})
    } else if (!attemptedKeyboard) {
      attemptedKeyboard = true
      await page.keyboard.press('Escape').catch(() => {})
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
}

function answerCardDisplaySection(section: string): string {
  return section.replace(/^第\s*\d+\s*大题\s*[:：]\s*/, '').trim()
}

function isCompositeAnswerCardSection(section: string): boolean {
  return /听力理解|词汇匹配|完型填空|完形填空|阅读理解/.test(answerCardDisplaySection(section))
}

function answerCardLocator(sectionKey: string): { section: string, occurrence: number } {
  const matched = sectionKey.trim().match(/^(.*)@(\d+)$/)
  return matched
    ? { section: matched[1].trim(), occurrence: Math.max(1, Number(matched[2])) }
    : { section: sectionKey.trim(), occurrence: 1 }
}

async function answerPageNavigationSignature(page: Page): Promise<string> {
  return page.locator(`${NOQR_SEL.questionInfo}:visible`).first().innerText()
    .then((text) => text.replace(/\s+/g, ' ').trim())
    .catch(() => '')
}

async function targetQuestionVisible(page: Page, section: string, number: string): Promise<boolean> {
  const text = await page.locator('.content-area:visible').first().innerText()
    .then((value) => value
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
      .replace(/你还未交卷[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .catch(() => '')
  const displaySection = answerCardDisplaySection(answerCardLocator(section).section)
  if (!displaySection) return false
  const knownSections = ['听力理解', '词汇匹配', '完型填空', '完形填空', '阅读理解', '多选题', '单选题', '判断题', '语法']
  if (!knownSections.includes(displaySection)) return true
  if (!text.includes(displaySection)) return false
  if (isCompositeAnswerCardSection(section)) return true
  const position = text.match(/\b(?:question\s*)?(\d+)\s*\/\s*(\d+)\b/i)
  return Boolean(position && Number(position[1]) === Number(number))
}

async function targetCardState(page: Page, sectionKey: string, number: string): Promise<{
  found: boolean
  current: boolean
}> {
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
      if (title !== expected.section && !title.includes(expected.section)) continue
      occurrence++
      if (occurrence !== expected.occurrence) continue
      const target = [...node.querySelectorAll(expected.questionSelector)]
        .find((item) => visible(item) && clean(item.textContent) === expected.number)
      if (target instanceof HTMLElement) {
        return { found: true, current: target.classList.contains('is-current') }
      }
    }
    return { found: false, current: false }
  }, {
    section: locator.section,
    occurrence: locator.occurrence,
    number,
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
        if (title !== expected.section && !title.includes(expected.section)) continue
        occurrence++
        if (occurrence !== expected.occurrence) continue
        const target = [...node.querySelectorAll(expected.questionSelector)]
          .find((item) => visible(item) && clean(item.textContent) === expected.number)
        if (target instanceof HTMLElement) {
          const wasCurrent = target.classList.contains('is-current')
          target.click()
          return { clicked: true, wasCurrent }
        }
      }
      return { clicked: false, wasCurrent: false }
    }, {
      section: locator.section,
      occurrence: locator.occurrence,
      number,
      titleSelector: NOQR_SEL.answerCardGroupTitle,
      questionSelector: NOQR_SEL.answerCardQuestion,
    })
    if (!clicked.clicked) throw new Error('答题卡中找不到漏题题号')
    const verifyStartedAt = Date.now()
    let cardState = clicked.wasCurrent
      ? { found: true, current: true }
      : await targetCardState(page, sectionKey, number)
    for (;;) {
      if (stopRequested()) throw new Error('任务已停止')
      cardState = await targetCardState(page, sectionKey, number).catch(() => cardState)
      const pageReached = await targetQuestionVisible(page, sectionKey, number)
      const navigated = await answerPageNavigationSignature(page) !== beforeSignature
      if (cardState.current || (pageReached && (clicked.wasCurrent || navigated))) return
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked') throw new NoqrSessionError('auth_blocked', '答题卡跳转后进入人工认证')
      if (surface === 'error') throw new NoqrSessionError('page_error', '答题卡跳转后页面显示明确错误')
      if (Date.now() - verifyStartedAt >= Math.max(50, opts.verifyBudgetMs ?? 5_000) ||
        Date.now() >= actionDeadline) {
        throw new Error(`答题卡跳转后未到达目标题：${sectionKey}#${number}`)
      }
      await sleepNoqr(page, 100)
    }
  } finally {
    await closeAnswerCard(page, actionDeadline)
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
      Number(opts.noProgressBudgetMs) || 120_000,
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
      })
      opened = true
      break
    } catch (error) {
      if (openAttempt >= maxReopens || opts.stopRequested()) throw error
      opts.onRecovery?.('答题卡未出现结构，关闭重开', openAttempt + 1)
      await closeAnswerCard(page, deadlineAt)
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
          const section = titleSections.find((entry) =>
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
      // A matched answer-card group only exists after its save request was
      // accepted. Treat the whole group as saved when every visible card row
      // maps to the expected structure, even if the site lags on one
      // `has-answered` class. Extra/unmapped rows still require direct
      // per-row evidence below, so this cannot hide an unexpected blank slot.
      const matchedRowsHaveSavedGroupEvidence = Boolean(
        groupMatch &&
        groupMatch.matchedGroupCount === expectedGroups.length &&
        groupMatch.matchedRows.size === rows.length &&
        expectedGroups.every((group) => savedGroupOrdinals.has(group.groupOrdinal)),
      )
      const loading = await page.locator(NOQR_SEL.loadingToast).first().isVisible().catch(() => false)
      const skeleton = await page.locator('.van-skeleton').first().isVisible().catch(() => false)
      const networkActive = network.isBusinessActive()
      const activityActive = loading || skeleton || networkActive
      const matchedGroupCount = groupMatch?.matchedGroupCount || 0
      const matchedRowCount = groupMatch?.matchedRows.size || 0
      const savedExpectedGroupCount = expectedGroups
        .filter((group) => savedGroupOrdinals.has(group.groupOrdinal)).length
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
      if ((!expectedCount && !hasExpectedEvidence) || expectedLoaded) {
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
        await closeAnswerCard(page, deadlineAt)
        await openAnswerCard(page, opts.stopRequested, {
          noProgressBudgetMs,
          network,
          deadlineAt,
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
    await closeAnswerCard(page, deadlineAt)
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
    auditDeadlineMs: hardDeadlineMs,
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
