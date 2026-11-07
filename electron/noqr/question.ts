import {
  contentHash,
  englishMatchStem,
  englishSlotStem,
  hasReadableQuestionText,
  matchOptionText,
  normalizeEnglishMatchLeft,
  normalizeEnglishMatchOption,
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
  bigQuestionId?: string
  questionId?: string
  identityCandidates?: string[]
  blankIndex?: number
  currentText?: string
}

export type NoqrQuestionGroup = {
  kind: NoqrQuestionKind
  sharedStem: string
  sharedStemCandidates?: string[]
  units: NoqrQuestionUnit[]
  audioUrl?: string
  rawTypeCode?: string
  position?: number
  total?: number
}

export type NoqrIdentityCandidateSource =
  | 'canonical'
  | 'picker_slot'
  | 'cloze_raw_type'
  | 'cloze_ordinal'
  | 'cloze_shared_evidence'
  | 'cloze_child_variant'

export type NoqrIdentityCandidate = {
  hash: string
  source: NoqrIdentityCandidateSource
  ordinal: number
  rawTypeCode: string
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
  | { ok: false; reason: string; code?: 'unsupported_non_objective' }

const COMPOSITE_KINDS = new Set<NoqrQuestionKind>([
  'english_listening',
  'english_cloze',
  'english_reading',
  'picker',
])

export const NOQR_MAX_IDENTITY_CANDIDATES = 8
const NOQR_MAX_CLOZE_SHARED_VARIANTS = 4

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

  if (COMPOSITE_KINDS.has(group.kind) && !group.sharedStem.trim()) {
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
    return contentHash(unit.qtype, englishMatchStem(group.sharedStem, unit.ordinal, unit.stem), options)
  }
  const fallbackType = ({
    english_cloze: '9',
    english_reading: '8',
    english_listening: '11',
  } as Partial<Record<NoqrQuestionKind, string>>)[group.kind]
  const rawType = group.rawTypeCode?.trim() || fallbackType
  if (!rawType) return contentHash(unit.qtype, unit.stem, options)
  return contentHash(unit.qtype, englishSlotStem(group.sharedStem, rawType, unit.ordinal, unit.stem), options)
}

// A paper can contain several question groups whose visible progress resets to
// 1/N (for example 1/2 followed later by 1/3). Position alone cannot identify
// a logical group. Keep this runtime key content-derived and hash-based so no
// page text is exposed in progress logs.
export function buildNoqrQuestionGroupSessionKey(
  group: NoqrQuestionGroup,
  occurrence = 1,
): string {
  const sharedIdentity = contentHash('single', group.sharedStem, [])
  const units = group.units.map((unit) => ({
    id: unit.id.trim(),
    ordinal: unit.ordinal,
    bigQuestionId: unit.bigQuestionId?.trim() || '',
    questionId: unit.questionId?.trim() || '',
    identity: buildNoqrQuestionIdentity(group, unit),
  }))
  const base = JSON.stringify({
    kind: group.kind,
    position: group.position || 0,
    total: group.total || 0,
    sharedIdentity,
    units,
  })
  return occurrence > 1 ? `${base}#${Math.trunc(occurrence)}` : base
}

export function buildNoqrQuestionIdentityDescriptors(
  group: NoqrQuestionGroup,
  unit: NoqrQuestionUnit,
): NoqrIdentityCandidate[] {
  const candidates: NoqrIdentityCandidate[] = []
  const seen = new Set<string>()
  const add = (
    hash: string,
    source: NoqrIdentityCandidateSource,
    ordinal: number,
    rawTypeCode: string,
  ) => {
    if (seen.has(hash) || candidates.length >= NOQR_MAX_IDENTITY_CANDIDATES) return
    seen.add(hash)
    candidates.push({ hash, source, ordinal, rawTypeCode })
  }
  const options = unit.options.map((option) => option.text)
  const canonicalRawType = group.rawTypeCode?.trim()
    || ({
      english_cloze: '9',
      english_reading: '8',
      english_listening: '11',
      picker: '7',
    } as Partial<Record<NoqrQuestionKind, string>>)[group.kind]
    || ''
  add(buildNoqrQuestionIdentity(group, unit), 'canonical', unit.ordinal, canonicalRawType)

  if (group.kind === 'picker') {
    add(
      contentHash(unit.qtype, englishSlotStem(group.sharedStem, 7, unit.ordinal, unit.stem), options),
      'picker_slot',
      unit.ordinal,
      '7',
    )
    return candidates
  }

  if (group.kind === 'english_cloze') {
    const ordinals = [...new Set([unit.ordinal, unit.blankIndex].filter(
      (value): value is number => Number.isInteger(value) && Number(value) > 0,
    ))]
    const rawTypes = [...new Set([canonicalRawType, '9'].filter(Boolean))]
    const sharedVariants = [...new Set([
      group.sharedStem,
      ...(group.sharedStemCandidates || []),
    ].filter(Boolean))].slice(0, NOQR_MAX_CLOZE_SHARED_VARIANTS)
    const childVariants = [...new Set([unit.stem, ''].filter(
      (value, index, values) => index === values.indexOf(value),
    ))]
    for (const shared of sharedVariants) {
      for (const ordinal of ordinals) {
        for (const rawType of rawTypes) {
          for (const child of childVariants) {
            const source: NoqrIdentityCandidateSource = shared !== group.sharedStem
              ? 'cloze_shared_evidence'
              : ordinal !== unit.ordinal
                ? 'cloze_ordinal'
                : rawType !== canonicalRawType
                  ? 'cloze_raw_type'
                  : 'cloze_child_variant'
            add(
              contentHash(unit.qtype, englishSlotStem(shared, rawType, ordinal, child), options),
              source,
              ordinal,
              rawType,
            )
            if (candidates.length >= NOQR_MAX_IDENTITY_CANDIDATES) return candidates
          }
        }
      }
    }
  } else if (group.kind === 'english_listening') {
    add(
      contentHash(unit.qtype, englishSlotStem(group.sharedStem, 11, unit.ordinal, unit.stem), options),
      'canonical',
      unit.ordinal,
      '11',
    )
  } else if (group.kind === 'english_reading') {
    add(
      contentHash(unit.qtype, englishSlotStem(group.sharedStem, 8, unit.ordinal, unit.stem), options),
      'canonical',
      unit.ordinal,
      '8',
    )
  }
  return candidates
}

export function buildNoqrQuestionIdentityCandidates(
  group: NoqrQuestionGroup,
  unit: NoqrQuestionUnit,
): string[] {
  return buildNoqrQuestionIdentityDescriptors(group, unit).map((candidate) => candidate.hash)
}

export function noqrQuestionBankDiagnostic(group: NoqrQuestionGroup): string {
  const sharedSignature = contentHash('single', '[共享材料]', [group.sharedStem]).slice(0, 12)
  const optionSignatures = group.units.map((unit) => contentHash(
    'single',
    '[选项集合]',
    unit.options.map((option) => option.text),
  ).slice(0, 12))
  const childSignature = contentHash(
    'single',
    '[子题集合]',
    group.units.map((unit) => unit.stem),
  ).slice(0, 12)
  return [
    `kind=${group.kind}`,
    `type=${group.rawTypeCode || 'none'}`,
    `shared=${group.sharedStem.length}`,
    `sharedSig=${sharedSignature}`,
    `sharedVariants=${(group.sharedStemCandidates || []).map((value) => value.length).join('/') || 'none'}`,
    `units=${group.units.length}`,
    `child=${group.units.map((unit) => unit.stem.length).join('/')}`,
    `childSig=${childSignature}`,
    `optionSig=${optionSignatures.join('/')}`,
  ].join(' ')
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
  bigQuestionId?: string
  questionId?: string
  identityCandidates?: string[]
}

type RawDomQuestion = {
  label: string
  rawTypeCode: string
  sharedStem: string
  sharedStemVariants: string[]
  units: RawDomUnit[]
  pickerCandidates: string[]
  blankIndexes: number[]
  audioUrl: string
  position: number | null
  total: number | null
  hasPicker: boolean
  hasTextControls: boolean
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
    raw = await page.locator('.content-area:visible').first().evaluate((root) => {
      const visible = (node: Element) => {
        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }
      const questionInfo = [...root.querySelectorAll('.question-info')].find(visible)
      if (!questionInfo) return null
      const englishTypeCodes = new Set(['7', '8', '9', '11'])
      let questionTypeNode = questionInfo.closest('[data-questiontype]')
      while (questionTypeNode && !englishTypeCodes.has(
        questionTypeNode.getAttribute('data-questiontype')?.trim() || '',
      )) {
        questionTypeNode = questionTypeNode.parentElement?.closest('[data-questiontype]') || null
      }
      if (!questionTypeNode) {
        questionTypeNode = [...root.querySelectorAll('[data-questiontype]')]
          .find((node) => visible(node) && englishTypeCodes.has(
            node.getAttribute('data-questiontype')?.trim() || '',
          )) || questionInfo.closest('[data-questiontype]') ||
          [...root.querySelectorAll('[data-questiontype]')].find(visible) || null
      }
      const rawTypeCode = questionTypeNode?.getAttribute('data-questiontype')?.trim() || ''
      const visibleTextParts: string[] = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
        if (parent && text && !parent.closest('.question-card') && visible(parent)) {
          visibleTextParts.push(text)
        }
      }
      const rootText = visibleTextParts.join(' ').replace(/\s+/g, ' ').trim()
      const labels = [
        '听力理解', '词汇匹配', '完型填空', '阅读理解', '多选题', '单选题', '判断题', '语法',
      ]
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
      const attrId = (node: Element | null | undefined, names: string[]): string => {
        for (const name of names) {
          const value = node?.getAttribute(name) || ''
          if (value) return value
        }
        return ''
      }
      const hiddenId = (container: Element, names: string[]): string => {
        for (const name of names) {
          const node = container.querySelector(`input[name="${name}"], [data-${name}]`)
          if (node) {
            if (node instanceof HTMLInputElement && node.value) return node.value
            const value = node.getAttribute(`data-${name}`) || ''
            if (value) return value
          }
        }
        return ''
      }
      const identityFor = (container: Element | null | undefined): {
        bigQuestionId: string
        questionId: string
      } => ({
        bigQuestionId: attrId(container, [
          'data-big-question-id',
          'data-bigquestionid',
          'data-big-question',
        ]) || (container ? hiddenId(container, ['bigQuestionId', 'bigquestionid']) : ''),
        questionId: attrId(container, [
          'data-question-id',
          'data-questionid',
          'data-id',
        ]) || (container
          ? hiddenId(container, ['questionId', 'questionid', 'subQuestionId', 'subquestionid'])
          : ''),
      })
      const identityCandidatesFor = (container: Element | null | undefined): string[] => {
        const values = new Set<string>()
        const addValue = (value: string | null | undefined) => {
          const text = String(value || '').trim()
          if (text && text.length <= 160 && !/[\s{}<>]/.test(text)) values.add(text)
        }
        const addNode = (node: Element | null | undefined) => {
          if (!node) return
          const questionLike = node.matches(
            '.question-info, .sub-item, .question-item, .question-options, ' +
            '.paper-content, .exam-content, [class*="question"], [class*="paper"]',
          )
          for (const name of node.getAttributeNames()) {
            const explicitQuestionIdentity =
              /(?:question.*(?:id|unique)|(?:big|sub)?questionid|paper.*(?:id|unique)|homework.*unique)/i.test(name)
            if (name === 'id' && questionLike) {
              addValue(node.getAttribute(name))
              continue
            }
            if (!explicitQuestionIdentity) continue
            addValue(node.getAttribute(name))
          }
          if (node instanceof HTMLInputElement && node.value &&
              /(?:question.*(?:id|unique)|(?:big|sub)?questionid|paper.*(?:id|unique)|homework.*unique)/i.test(node.name || '')) {
            addValue(node.value)
          }
        }
        addNode(container)
        let ancestor = container?.parentElement || null
        for (let depth = 0; ancestor && depth < 5; depth++, ancestor = ancestor.parentElement) {
          addNode(ancestor)
        }
        for (const node of container?.querySelectorAll(
          '[id], [data-id], [data-question-id], [data-questionid], ' +
          '[data-big-question-id], [data-bigquestionid], [data-sub-question-id], ' +
          'input[name*="question" i], input[name*="unique" i], input[name*="paper" i]',
        ) || []) addNode(node)
        return [...values].slice(0, 64)
      }
      const hasTextControls = [...root.querySelectorAll(
        'textarea, select, input:not([type]), input[type="text"], input[type="search"], ' +
        'input[type="password"], input[type="email"], input[type="url"], input[type="tel"], ' +
        'input[type="number"], input[type="file"], ' +
        '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
      )].some((node) => {
        if (!(node instanceof HTMLElement)) return false
        if (node instanceof HTMLInputElement &&
            (node.readOnly || node.disabled || node.name === 'picker' || node.type === 'hidden')) {
          return false
        }
        if (node instanceof HTMLTextAreaElement && (node.readOnly || node.disabled)) return false
        if (node instanceof HTMLInputElement && node.type === 'file') {
          const uploader = node.closest('.van-uploader')
          return visible(node) || Boolean(uploader && visible(uploader))
        }
        return visible(node)
      })
      const directTitle = [...questionInfo.children].find((node) => node.classList.contains('question-title'))
      const sharedStem = (directTitle?.textContent || '').replace(/\s+/g, ' ').trim()
      const textWithoutBlankMarkers = (node: Element) => {
        const clone = node.cloneNode(true) as Element
        for (const marker of clone.querySelectorAll('.spaceIndex')) marker.remove()
        return (clone.textContent || '').replace(/\s+/g, ' ').trim()
      }
      const markerParagraphs = directTitle
        ? [...directTitle.querySelectorAll('p')]
          .filter((node) => Boolean(node.querySelector('.spaceIndex')))
        : []
      const hasBlankMarkers = Boolean(directTitle?.querySelector('.spaceIndex'))
      const sharedWithoutBlankMarkers = hasBlankMarkers && directTitle
        ? textWithoutBlankMarkers(directTitle)
        : ''
      const markerParagraphTexts = markerParagraphs
        .map((node) => textWithoutBlankMarkers(node))
        .filter(Boolean)
      const markerSuffixTexts = markerParagraphTexts.length > 1
        ? markerParagraphTexts
          .slice(0, -1)
          .map((_, index) => markerParagraphTexts.slice(index).join(''))
        : []
      const markerChildTexts = directTitle
        ? [...directTitle.children]
          .filter((node) => Boolean(node.querySelector('.spaceIndex')))
          .map((node) => textWithoutBlankMarkers(node))
          .filter(Boolean)
        : []
      const sharedStemVariants = [...new Set([
        sharedWithoutBlankMarkers,
        ...markerParagraphTexts,
        ...markerSuffixTexts,
        ...markerChildTexts,
      ])].filter((value) => value && value !== sharedStem).slice(0, 4)
      const subItems = [...questionInfo.querySelectorAll('.sub-questions > .sub-item')]
      const pickerRows = [...questionInfo.querySelectorAll('.question-options .van-cell.van-cell--clickable.van-field[role="button"]')]
      const directIdentity = identityFor(questionInfo)
      const directIdentityCandidates = identityCandidatesFor(questionInfo)
      const units: RawDomUnit[] = pickerRows.length
        ? pickerRows.map((row) => {
            const identity = identityFor(row)
            return {
              stem: (row.querySelector('.van-field__label')?.textContent || '').replace(/\s+/g, ' ').trim(),
              options: [],
              pickerValue: (row.querySelector('input[name="picker"]') as HTMLInputElement | null)?.value || '',
              bigQuestionId: identity.bigQuestionId || directIdentity.bigQuestionId,
              questionId: identity.questionId || directIdentity.questionId,
              identityCandidates: [...new Set([
                ...identityCandidatesFor(row),
                ...directIdentityCandidates,
              ])],
            }
          })
        : subItems.length
            ? subItems.map((item, index) => {
              const identity = identityFor(item)
              return {
                stem: (item.querySelector('.question-title')?.textContent || '').replace(/\s+/g, ' ').trim(),
                options: optionsIn(item),
                bigQuestionId: identity.bigQuestionId || directIdentity.bigQuestionId,
                questionId: identity.questionId || directIdentity.questionId,
                identityCandidates: [...new Set([
                  ...identityCandidatesFor(item),
                  ...directIdentityCandidates,
                ])],
              }
            })
            : [{
                stem: sharedStem,
                options: optionsIn(questionInfo),
                ...directIdentity,
                identityCandidates: directIdentityCandidates,
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
        rawTypeCode,
        sharedStem,
        sharedStemVariants,
        units,
        pickerCandidates,
        blankIndexes,
        audioUrl: audio?.getAttribute('data-url') || '',
        position: positionMatch ? Number(positionMatch[1]) : null,
        total: positionMatch ? Number(positionMatch[2]) : null,
        hasPicker: pickerRows.length > 0,
        hasTextControls,
      }
    })
  } catch {
    return { ok: false, reason: '当前答题页题组读取失败' }
  }
  if (!raw) {
    const hasVisibleTextControls = await page.locator('.content-area:visible').first().evaluate((root) => {
      const visible = (node: Element) => {
        if (!(node instanceof HTMLElement)) return false
        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          rect.width > 0 && rect.height > 0
      }
      return [...root.querySelectorAll(
        'textarea, select, input:not([type]), input[type="text"], input[type="search"], ' +
        'input[type="email"], input[type="url"], input[type="tel"], input[type="number"], ' +
        'input[type="file"], [contenteditable="true"], [contenteditable=""], ' +
        '[contenteditable="plaintext-only"]',
      )].some((node) => {
        if (!(node instanceof HTMLElement)) return false
        if (node instanceof HTMLInputElement &&
            (node.readOnly || node.disabled || node.name === 'picker' || node.type === 'hidden')) {
          return false
        }
        if (node instanceof HTMLTextAreaElement && (node.readOnly || node.disabled)) return false
        if (node instanceof HTMLInputElement && node.type === 'file') {
          const uploader = node.closest('.van-uploader')
          return visible(node) || Boolean(uploader && visible(uploader))
        }
        return visible(node)
      })
    }).catch(() => false)
    if (hasVisibleTextControls) {
      return {
        ok: false,
        reason: '当前作业含主观题或文件题，本模式仅支持客观题',
        code: 'unsupported_non_objective',
      }
    }
    return { ok: false, reason: '当前答题页没有可识别题目' }
  }

  if (raw.hasTextControls) return {
    ok: false,
    reason: '当前作业含主观题或文件题，本模式仅支持客观题',
    code: 'unsupported_non_objective',
  }
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

  const qtypeFor = (unit: RawDomUnit): QType | null => {
    const roles = new Set(unit.options.map((option) => option.role))
    if (kind === 'english_reading') {
      if (roles.size !== 1) return null
      const role = unit.options[0]?.role
      if (!role) return null
      if (role === 'checkbox') return 'multiple'
      const normalized = unit.options.map((option) => normalizeOption(option.text, 'judge')).sort()
      return normalized.length === 2 && normalized[0] === '正确' && normalized[1] === '错误' ? 'judge' : 'single'
    }
    if (kind === 'judge') return 'judge'
    if (roles.size !== 1) return null
    const role = unit.options[0]?.role
    if (!role) return null
    if (role === 'checkbox') return 'multiple'
    const isJudge = unit.options.length === 2 &&
      unit.options.every((option) => /^(正确|错误)$/.test(normalizeOption(option.text, 'judge')))
    return isJudge ? 'judge' : 'single'
  }

  const qtypes = raw.units.map((unit) => qtypeFor(unit))
  if (qtypes.some((qtype) => qtype === null)) {
    return { ok: false, reason: '题目子题题型无法确定，已停止当前作业' }
  }
  const units: NoqrQuestionUnit[] = raw.units.map((unit, index) => {
    const ordinal = index + 1
    const qtype = qtypes[index]!
    return {
      id: `${kind}-${ordinal}`,
      ordinal,
      qtype,
      stem: kind === 'picker'
        ? normalizeEnglishMatchLeft(unit.stem)
        : normalizeStem(unit.stem),
      options: unit.options.map((option) => ({
        index: option.index,
        text: kind === 'picker'
          ? normalizeEnglishMatchOption(option.text)
          : normalizeOption(option.text, qtype),
      })),
      bigQuestionId: unit.bigQuestionId || undefined,
      questionId: unit.questionId || undefined,
      identityCandidates: unit.identityCandidates?.length
        ? [...new Set(unit.identityCandidates)].slice(0, 64)
        : undefined,
      blankIndex: kind === 'english_cloze' ? raw.blankIndexes[index] : undefined,
      currentText: unit.pickerValue,
    }
  })
  const group: NoqrQuestionGroup = {
    kind,
    sharedStem: normalizeStem(raw.sharedStem),
    sharedStemCandidates: [...new Set(raw.sharedStemVariants.map(normalizeStem).filter(
      (value) => value && value !== normalizeStem(raw.sharedStem),
    ))].slice(0, 4),
    units,
    audioUrl: raw.audioUrl || undefined,
    position: raw.position || undefined,
    total: raw.total || undefined,
    rawTypeCode: raw.rawTypeCode || (kind === 'english_listening' ? '11'
      : kind === 'english_cloze' ? '9'
        : kind === 'english_reading' ? '8'
          : kind === 'english_grammar' ? '1'
            : kind === 'picker' ? '7'
              : kind === 'single' ? '1'
                : kind === 'multiple' ? '2'
                  : kind === 'judge' ? '3'
                    : undefined),
  }
  const validation = validateNoqrQuestionGroup(group)
  if (validation.ok) return { ok: true, group }
  return { ok: false, reason: validation.issues.join('；') }
}
