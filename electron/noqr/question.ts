import {
  contentHash,
  hasReadableQuestionText,
  matchOptionText,
  normalizeOption,
  normalizeStem,
  type QType,
} from '../core/hash.ts'
import type { Page } from 'patchright'

export type NoqrQuestionKind =
  | 'single'
  | 'multiple'
  | 'judge'
  | 'picker'
  | 'english_grammar'
  | 'english_listening'
  | 'english_cloze'
  | 'english_reading'
  | 'unknown'

export type NoqrOption = {
  index: number
  text: string
}

export type NoqrQuestionUnit = {
  id: string
  ordinal: number
  qtype: QType
  stem: string
  options: NoqrOption[]
  blankIndex?: number
  currentText?: string
}

export type NoqrQuestionGroup = {
  kind: NoqrQuestionKind
  sharedStem: string
  units: NoqrQuestionUnit[]
  audioUrl?: string
  rawTypeCode?: string
  position?: number
  total?: number
}

export type NoqrValidation = {
  ok: boolean
  issues: string[]
}

export type NoqrSelectionPlan = {
  answerSelected: string
  filledUnits: number
  unitSelections: Record<string, string[]>
}

export type NoqrAnswerCandidate = {
  bankTexts?: readonly string[]
  aiTexts?: readonly string[]
}

export type NoqrResolvedAnswer = {
  unitId: string
  ordinal: number
  qtype: QType
  source: 'bank' | 'ai'
  texts: string[]
  indices: number[]
  selectionValues: number[]
}

export type NoqrAnswerPlanResult =
  | {
      ok: true
      answerSelected: string
      answers: NoqrResolvedAnswer[]
    }
  | {
      ok: false
      reason: string
      unitId?: string
    }

export type NoqrQuestionReadResult =
  | { ok: true; group: NoqrQuestionGroup }
  | { ok: false; reason: string }

const COMPOSITE_KINDS = new Set<NoqrQuestionKind>([
  'english_grammar',
  'english_listening',
  'english_cloze',
  'english_reading',
  'picker',
])

export function classifyNoqrQuestion(label: string): NoqrQuestionKind {
  const text = normalizeStem(label)
  if (!text) return 'unknown'
  if (/阅读理解/.test(text)) return 'english_reading'
  if (/听力/.test(text)) return 'english_listening'
  if (/完型|完形/.test(text)) return 'english_cloze'
  if (/词汇.*(匹配|选择)|匹配.*词汇|picker/i.test(text)) return 'picker'
  if (/语法/.test(text)) return 'english_grammar'
  if (/单选/.test(text)) return 'single'
  if (/多选/.test(text)) return 'multiple'
  if (/判断/.test(text)) return 'judge'
  return 'unknown'
}

function expectedUnitCount(kind: NoqrQuestionKind): number | null {
  if (kind === 'english_listening' || kind === 'english_reading') return 5
  if (kind === 'english_cloze' || kind === 'picker') return 10
  return null
}

function expectedQtypes(kind: NoqrQuestionKind): Set<QType> | null {
  if (kind === 'english_listening' || kind === 'english_cloze' || kind === 'picker') {
    return new Set<QType>(['single'])
  }
  if (kind === 'english_reading') return new Set<QType>(['judge'])
  if (kind === 'single' || kind === 'multiple' || kind === 'judge') {
    return new Set<QType>([kind])
  }
  return null
}

export function validateNoqrQuestionGroup(group: NoqrQuestionGroup): NoqrValidation {
  const issues: string[] = []
  if (group.kind === 'unknown') issues.push('未知题型')
  if (!Array.isArray(group.units) || !group.units.length) {
    issues.push('题目单元为空')
    return { ok: false, issues }
  }

  const expectedCount = expectedUnitCount(group.kind)
  if (expectedCount != null && group.units.length !== expectedCount) {
    issues.push(`题目单元数量应为 ${expectedCount}，实际 ${group.units.length}`)
  }

  const ids = new Set<string>()
  const ordinals = new Set<number>()
  const qtypes = expectedQtypes(group.kind)
  for (const unit of group.units) {
    if (!unit.id.trim()) issues.push('题目单元缺少身份')
    if (!Number.isInteger(unit.ordinal) || unit.ordinal <= 0) issues.push(`题目单元 ${unit.id || '?'} 序号无效`)
    if (ids.has(unit.id)) issues.push(`题目单元身份重复：${unit.id}`)
    if (ordinals.has(unit.ordinal)) issues.push(`题目单元序号重复：${unit.ordinal}`)
    ids.add(unit.id)
    ordinals.add(unit.ordinal)
    if (qtypes && !qtypes.has(unit.qtype)) issues.push(`题目单元 ${unit.id} 题型不匹配`)
    if (group.kind === 'english_cloze' && !Number.isInteger(unit.blankIndex)) {
      issues.push(`完型题目单元 ${unit.id} 缺少空位编号`)
    }

    const optionTexts = Array.isArray(unit.options) ? unit.options.map((option) => option.text.trim()) : []
    if (!optionTexts.length || optionTexts.some((text) => !text || text.includes('\uFFFD'))) {
      issues.push(`题目单元 ${unit.id} 选项缺失或损坏`)
    }
    if (new Set(optionTexts).size !== optionTexts.length) issues.push(`题目单元 ${unit.id} 选项正文重复`)
    if (new Set(unit.options.map((option) => option.index)).size !== unit.options.length) {
      issues.push(`题目单元 ${unit.id} 选项索引重复`)
    }

    const stemAllowedEmpty = group.kind === 'english_cloze'
    if (!stemAllowedEmpty && !hasReadableQuestionText(unit.stem, optionTexts)) {
      issues.push(`题目单元 ${unit.id} 题干或选项不可读`)
    }
  }

  if (COMPOSITE_KINDS.has(group.kind) && group.kind !== 'english_grammar' && !group.sharedStem.trim()) {
    issues.push('复合题缺少共享材料')
  }
  if (group.kind === 'english_cloze') {
    const blankIndexes = group.units.map((unit) => unit.blankIndex).sort((a, b) => Number(a) - Number(b))
    if (blankIndexes.length !== 10 || blankIndexes.some((value, index) => value !== index + 1)) {
      issues.push('完型空位编号必须完整且唯一覆盖 1–10')
    }
  }
  if (group.kind === 'english_listening' && !group.audioUrl?.trim()) {
    issues.push('听力题缺少已取证的音频入口')
  }
  return { ok: issues.length === 0, issues }
}

export function buildNoqrQuestionIdentity(group: NoqrQuestionGroup, unit: NoqrQuestionUnit): string {
  const options = unit.options.map((option) => option.text)
  if (!COMPOSITE_KINDS.has(group.kind)) return contentHash(unit.qtype, unit.stem, options)
  if (group.kind === 'picker') {
    return contentHash(unit.qtype, `${normalizeStem(group.sharedStem)}\n[匹配槽 ${unit.ordinal}] ${normalizeStem(unit.stem)}`, options)
  }
  const rawType = group.rawTypeCode || ({
    english_grammar: '8',
    english_cloze: '8',
    english_reading: '9',
    english_listening: '11',
  } as Partial<Record<NoqrQuestionKind, string>>)[group.kind] || group.kind
  const stem = `${normalizeStem(group.sharedStem)}\n[父题型 ${rawType}][子题 ${unit.ordinal}] ${normalizeStem(unit.stem)}`
  return contentHash(unit.qtype, stem, options)
}

export function mapNoqrAnswerTexts(
  group: NoqrQuestionGroup,
  unitId: string,
  answerTexts: string[],
): number[] | null {
  const unit = group.units.find((item) => item.id === unitId)
  if (!unit || !Array.isArray(answerTexts) || !answerTexts.length) return null
  const options = unit.options.map((option) => option.text)

  const selected = new Set<number>()
  for (const raw of answerTexts) {
    const matched = matchOptionText(raw, options, unit.qtype)
    if (!matched) return null
    const matches = unit.options.filter((option) => option.text === matched)
    if (matches.length !== 1 || selected.has(matches[0].index)) return null
    const index = matches[0].index
    selected.add(index)
  }
  if (unit.qtype !== 'multiple' && selected.size !== 1) return null
  return unit.options.filter((option) => selected.has(option.index)).map((option) => option.index)
}

export function requestSelectionValues(unit: NoqrQuestionUnit, positions: number[]): number[] {
  return positions.map((position) => {
    const option = unit.options.find((item) => item.index === position)
    if (!option) return position
    if (unit.qtype !== 'judge') return position
    const text = normalizeOption(option.text, 'judge')
    if (text === '正确') return 1
    if (text === '错误') return 0
    return position
  })
}

export function buildNoqrSelectionPlan(
  group: NoqrQuestionGroup,
  answersByUnit: ReadonlyMap<string, readonly string[]>,
  requireAll = true,
): NoqrSelectionPlan | null {
  const validation = validateNoqrQuestionGroup(group)
  if (!validation.ok) return null

  const selections: string[] = []
  const unitSelections: Record<string, string[]> = {}
  let filledUnits = 0
  for (const unit of [...group.units].sort((a, b) => a.ordinal - b.ordinal)) {
    const texts = answersByUnit.get(unit.id)
    if (!texts?.length) {
      if (requireAll) return null
      continue
    }
    const mapped = mapNoqrAnswerTexts(group, unit.id, [...texts])
    if (!mapped?.length) return null
    if (group.kind !== 'multiple' && mapped.length !== 1) return null
    const requestValues = requestSelectionValues(unit, mapped)
    unitSelections[unit.id] = requestValues.map(String)
    selections.push(...requestValues.map(String))
    filledUnits++
  }
  if (!filledUnits && requireAll) return null
  return {
    answerSelected: selections.join(','),
    filledUnits,
    unitSelections,
  }
}

export function resolveNoqrAnswers(
  group: NoqrQuestionGroup,
  candidates: ReadonlyMap<string, NoqrAnswerCandidate>,
  options: { requireAll?: boolean; allowAiForListening?: boolean } = {},
): NoqrAnswerPlanResult {
  const validation = validateNoqrQuestionGroup(group)
  if (!validation.ok) return { ok: false, reason: validation.issues.join('；') }
  const requireAll = options.requireAll !== false
  const allowAiForListening = options.allowAiForListening === true
  const resolved: NoqrResolvedAnswer[] = []

  for (const unit of [...group.units].sort((a, b) => a.ordinal - b.ordinal)) {
    const candidate = candidates.get(unit.id)
    const bankTexts = candidate?.bankTexts?.filter((text) => text.trim()) || []
    const aiTexts = candidate?.aiTexts?.filter((text) => text.trim()) || []
    if (!bankTexts.length && !aiTexts.length) {
      if (requireAll) return { ok: false, reason: '题目缺少题库或 AI 答案', unitId: unit.id }
      continue
    }
    if (!bankTexts.length && group.kind === 'english_listening' && !allowAiForListening) {
      return { ok: false, reason: '听力题库缺失', unitId: unit.id }
    }

    const source: 'bank' | 'ai' = bankTexts.length ? 'bank' : 'ai'
    const texts = source === 'bank' ? bankTexts : aiTexts
    const indices = mapNoqrAnswerTexts(group, unit.id, texts)
    if (!indices?.length) {
      return {
        ok: false,
        reason: source === 'bank' ? '题库答案无法唯一映射当前选项' : 'AI 答案无法唯一映射当前选项',
        unitId: unit.id,
      }
    }
    resolved.push({
      unitId: unit.id,
      ordinal: unit.ordinal,
      qtype: unit.qtype,
      source,
      texts: [...texts],
      indices,
      selectionValues: requestSelectionValues(unit, indices),
    })
  }

  if (requireAll && resolved.length !== group.units.length) {
    const found = new Set(resolved.map((answer) => answer.unitId))
    const missing = group.units.find((unit) => !found.has(unit.id))
    return { ok: false, reason: '复合题答案不完整', unitId: missing?.id }
  }
  return {
    ok: true,
    answerSelected: resolved.flatMap((answer) => answer.selectionValues).map(String).join(','),
    answers: resolved,
  }
}

type RawDomOption = {
  index: number
  text: string
  role: 'radio' | 'checkbox'
}

type RawDomUnit = {
  stem: string
  options: RawDomOption[]
  pickerValue?: string
}

type RawDomQuestion = {
  label: string
  sharedStem: string
  units: RawDomUnit[]
  pickerCandidates: string[]
  blankIndexes: number[]
  audioUrl: string
  position: number | null
  total: number | null
  hasPicker: boolean
}

function inferReadKind(raw: RawDomQuestion): NoqrQuestionKind {
  const byLabel = classifyNoqrQuestion(raw.label)
  if (byLabel !== 'unknown') return byLabel
  if (raw.hasPicker) return 'picker'
  if (raw.audioUrl) return 'english_listening'
  if (raw.blankIndexes.length === 10) return 'english_cloze'
  if (raw.units.length === 1) {
    const role = raw.units[0].options[0]?.role
    const options = raw.units[0].options.map((option) => normalizeOption(option.text, role === 'checkbox' ? 'multiple' : undefined))
    if (options.length === 2 && options.every((text) => text === '正确' || text === '错误')) return 'judge'
    return role === 'checkbox' ? 'multiple' : 'single'
  }
  if (raw.units.length === 5 && raw.units.every((unit) => unit.options.every((option) => option.role === 'radio'))) {
    const judge = raw.units.every((unit) => unit.options.length === 2 &&
      unit.options.every((option) => /^(正确|错误|对|错|true|false)$/i.test(normalizeOption(option.text))))
    return judge ? 'english_reading' : 'english_listening'
  }
  if (raw.units.length === 10 && raw.units.every((unit) => unit.options.length > 1)) return 'english_cloze'
  return 'unknown'
}

export async function readNoqrQuestionGroup(page: Page): Promise<NoqrQuestionReadResult> {
  let raw: RawDomQuestion | null
  try {
    raw = await page.locator('.content-area').evaluate((root) => {
      const visible = (node: Element) => {
        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }
      const questionInfo = [...root.querySelectorAll('.question-info')].find(visible)
      if (!questionInfo) return null
      const visibleTextParts: string[] = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
        if (parent && text && visible(parent)) visibleTextParts.push(text)
      }
      const rootText = visibleTextParts.join(' ').replace(/\s+/g, ' ').trim()
      const labels = ['听力理解', '词汇匹配', '完型填空', '阅读理解', '多选题', '单选题', '判断题', '语法']
      const label = labels.find((item) => rootText.includes(item)) || ''
      const positionMatch = rootText.match(/\b(?:question\s*)?(\d+)\s*\/\s*(\d+)\b/i)

      const optionText = (node: Element) =>
        (node.querySelector('.van-radio__label, .van-checkbox__label, .van-field__control')?.textContent || node.textContent || '')
          .replace(/\s+/g, ' ').trim()
      const optionsIn = (container: Element): RawDomOption[] => {
        const nodes = [...container.querySelectorAll('.question-options .option-item[role="radio"], .question-options .option-item[role="checkbox"]')]
        return nodes.map((node, fallbackIndex) => {
          return {
            index: fallbackIndex,
            text: optionText(node),
            role: node.getAttribute('role') === 'checkbox' ? 'checkbox' : 'radio',
          }
        })
      }
      const directTitle = [...questionInfo.children].find((node) => node.classList.contains('question-title'))
      const sharedStem = (directTitle?.textContent || '').replace(/\s+/g, ' ').trim()
      const subItems = [...questionInfo.querySelectorAll('.sub-questions > .sub-item')]
      const pickerRows = [...questionInfo.querySelectorAll('.question-options .van-cell.van-cell--clickable.van-field[role="button"]')]
      const units: RawDomUnit[] = pickerRows.length
        ? pickerRows.map((row) => ({
            stem: (row.querySelector('.van-field__label')?.textContent || '').replace(/\s+/g, ' ').trim(),
            options: [],
            pickerValue: (row.querySelector('input[name="picker"]') as HTMLInputElement | null)?.value || '',
          }))
        : subItems.length
          ? subItems.map((item) => ({
              stem: (item.querySelector('.question-title')?.textContent || '').replace(/\s+/g, ' ').trim(),
              options: optionsIn(item),
            }))
          : [{
              stem: sharedStem,
              options: optionsIn(questionInfo),
            }]

      const pickerCandidates = [...root.querySelectorAll('.van-picker-column__item')]
        .filter(visible)
        .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      const blankIndexes = [...questionInfo.querySelectorAll('.spaceIndex[index]')]
        .map((node) => Number(node.getAttribute('index')))
        .filter((value) => Number.isInteger(value) && value > 0)
      const audio = questionInfo.querySelector('a[data-url]')
      return {
        label,
        sharedStem,
        units,
        pickerCandidates,
        blankIndexes,
        audioUrl: audio?.getAttribute('data-url') || '',
        position: positionMatch ? Number(positionMatch[1]) : null,
        total: positionMatch ? Number(positionMatch[2]) : null,
        hasPicker: pickerRows.length > 0,
      }
    })
  } catch {
    return { ok: false, reason: '当前答题页题组读取失败' }
  }
  if (!raw) return { ok: false, reason: '当前答题页没有可识别题目' }

  const kind = inferReadKind(raw)
  if (kind === 'unknown') return { ok: false, reason: '未知题型或控件，已停止当前作业' }

  if (kind === 'picker') {
    let candidates = raw.pickerCandidates
    if (!candidates.length) {
      try {
        await page.locator('.question-options .van-cell.van-cell--clickable.van-field[role="button"]').first().click()
        await page.locator('.van-picker').waitFor({ state: 'visible' })
        candidates = await page.locator('.van-picker-column__item').evaluateAll((nodes) =>
          nodes.filter((node) => {
            const style = window.getComputedStyle(node)
            return style.display !== 'none' && style.visibility !== 'hidden'
          }).map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))
        await page.locator('.van-picker__cancel').click()
      } catch {
        return { ok: false, reason: '词汇 Picker 候选读取失败' }
      }
    }
    if (!candidates.length || new Set(candidates).size !== candidates.length) {
      return { ok: false, reason: '词汇 Picker 候选缺失或正文重复' }
    }
    raw = {
      ...raw,
      units: raw.units.map((unit) => ({
        ...unit,
        options: candidates.map((text, index) => ({ index, text, role: 'radio' })),
      })),
    }
  }

  const qtypeFor = (role: 'radio' | 'checkbox' | undefined, idx: number): QType => {
    if (kind === 'judge' || kind === 'english_reading') return 'judge'
    if (role === 'checkbox') return 'multiple'
    const isJudge = raw!.units[idx]?.options.length === 2 &&
      raw!.units[idx].options.every((option) => /^(正确|错误)$/.test(normalizeOption(option.text)))
    return isJudge ? 'judge' : 'single'
  }

  const units: NoqrQuestionUnit[] = raw.units.map((unit, index) => {
    const ordinal = index + 1
    const role = unit.options[0]?.role
    return {
      id: `${kind}-${ordinal}`,
      ordinal,
      qtype: qtypeFor(role, index),
      stem: normalizeStem(unit.stem),
      options: unit.options.map((option) => ({
        index: option.index,
        text: normalizeOption(option.text, qtypeFor(option.role, index)),
      })),
      blankIndex: kind === 'english_cloze' ? raw.blankIndexes[index] : undefined,
      currentText: unit.pickerValue,
    }
  })
  const group: NoqrQuestionGroup = {
    kind,
    sharedStem: normalizeStem(raw.sharedStem),
    units,
    audioUrl: raw.audioUrl || undefined,
    position: raw.position || undefined,
    total: raw.total || undefined,
    rawTypeCode: kind === 'english_listening' ? '11'
      : kind === 'english_cloze' || kind === 'english_grammar' ? '8'
        : kind === 'english_reading' ? '9'
          : kind === 'picker' ? '7'
            : undefined,
  }
  const validation = validateNoqrQuestionGroup(group)
  return validation.ok ? { ok: true, group } : { ok: false, reason: validation.issues.join('；') }
}
