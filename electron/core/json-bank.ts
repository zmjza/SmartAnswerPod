import { contentHash, hasReadableQuestionText, matchOptionText, mergeCourseNames, normalizeOption, type QType } from './hash.ts'

export type BankItem = {
  qtype: QType
  stem: string
  options: string[]
  answer_texts: string[]
  course_name?: string
  source?: 'import' | 'extract' | 'ai_verified'
}

export type BankRow = BankItem & {
  content_hash: string
  course_names: string[]
  verified: boolean
  conflict: boolean
}

export function parseBankJson(raw: string): { items: BankItem[]; skipped: number } {
  const data = JSON.parse(raw) as unknown
  const arr = Array.isArray(data) ? data : (data as { items?: unknown }).items
  if (!Array.isArray(arr)) throw new Error('JSON 需为题目数组')
  const items: BankItem[] = []
  let skipped = 0
  for (const value of arr) {
    const o = value as Partial<BankItem>
    const qtype = o.qtype
    const validType = qtype === 'single' || qtype === 'multiple' || qtype === 'judge'
    const validText = validType && typeof o.stem === 'string' && Array.isArray(o.options) && Array.isArray(o.answer_texts) &&
      hasReadableQuestionText(o.stem, o.options) && hasReadableQuestionText(o.stem, o.answer_texts)
    const available = validText ? o.options!.map((option) => normalizeOption(option, qtype)) : []
    const answersMatch = validText && o.answer_texts!.every((answer) =>
      matchOptionText(answer, available, qtype) !== null)
    const validCount = validText && (qtype === 'multiple' ? o.answer_texts!.length > 0 : o.answer_texts!.length === 1)
    if (!validText || !answersMatch || !validCount) {
      skipped++
      continue
    }
    items.push(o as BankItem)
  }
  return { items, skipped }
}

export function upsertBank(existing: BankRow[], item: BankItem): { rows: BankRow[]; kind: 'added' | 'merged' | 'conflict' } {
  const hash = contentHash(item.qtype, item.stem, item.options)
  const idx = existing.findIndex((r) => r.content_hash === hash)
  const course_names = mergeCourseNames(idx >= 0 ? existing[idx].course_names : [], item.course_name)
  if (idx < 0) {
    existing.push({
      ...item,
      content_hash: hash,
      course_names,
      verified: item.source === 'ai_verified' || item.source === 'extract',
      conflict: false,
    })
    return { rows: existing, kind: 'added' }
  }
  const old = existing[idx]
  const sameAns =
    JSON.stringify([...old.answer_texts].sort()) === JSON.stringify([...item.answer_texts].sort())
  if (!sameAns && old.verified) {
    existing[idx] = { ...old, course_names, conflict: true }
    return { rows: existing, kind: 'conflict' }
  }
  if (item.source === 'ai_verified' || item.source === 'extract') {
    existing[idx] = {
      ...old,
      answer_texts: item.answer_texts,
      source: item.source,
      verified: true,
      conflict: sameAns ? old.conflict : false,
      course_names,
    }
  } else {
    existing[idx] = { ...old, course_names }
  }
  return { rows: existing, kind: 'merged' }
}
