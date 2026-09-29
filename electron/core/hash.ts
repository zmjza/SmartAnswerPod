import { createHash } from 'node:crypto'

export type QType = 'single' | 'multiple' | 'judge'

export function hasReadableQuestionText(stem: string, options: string[]): boolean {
  return options.length > 0 && [stem, ...options].every((text) =>
    typeof text === 'string' && text.trim().length > 0 && !text.includes('\uFFFD'))
}

export function qtypeFromPage(dataQuestionType: string | number): QType | 'unknown' {
  const n = String(dataQuestionType)
  if (n === '1') return 'single'
  if (n === '2') return 'multiple'
  if (n === '3') return 'judge'
  return 'unknown'
}

export function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
}

export function collapseSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function stripStemPrefix(s: string): string {
  return s.replace(/^\d+\s*[\.、．]\s*/, '')
}

export function stripOptionPrefix(s: string): string {
  return s.replace(/^[A-Ha-h]\s*[\)）\.、．]\s*/, '')
}

export function normalizeStem(raw: string): string {
  return stripStemPrefix(collapseSpace(toHalfWidth(raw)))
}

export function englishSlotStem(shared: string, rawType: string | number, ordinal: number, child: string): string {
  return `${normalizeStem(shared)}\n[父题型 ${rawType}][子题 ${ordinal}] ${normalizeStem(child)}`
}

export function englishMatchStem(shared: string, ordinal: number, leftItem: string): string {
  return `${normalizeStem(shared)}\n[匹配槽 ${ordinal}] ${normalizeStem(leftItem)}`
}

export function normalizeOption(raw: string, qtype?: QType): string {
  let t = stripOptionPrefix(collapseSpace(toHalfWidth(raw)))
  if (qtype === 'judge' || /^(正确|错误|对|错)$/.test(t)) {
    if (t === '对' || t === '正确' || t.toLowerCase() === 'true') t = '正确'
    if (t === '错' || t === '错误' || t.toLowerCase() === 'false') t = '错误'
  }
  return t
}

// Options are normalized once when read from the page. Prefer that exact
// text so a second prefix inside the answer ("C) C.as ...") remains intact.
export function matchOptionText(raw: string, options: string[], qtype?: QType): string | null {
  const exact = collapseSpace(toHalfWidth(raw))
  if (options.includes(exact)) return exact
  const withoutOuterLabel = normalizeOption(raw, qtype)
  return options.includes(withoutOuterLabel) ? withoutOuterLabel : null
}

export function contentHash(qtype: QType, stem: string, options: string[]): string {
  const stemN = normalizeStem(stem)
  const opts = options.map((o) => normalizeOption(o, qtype)).filter(Boolean).sort()
  const identity = `${qtype}\n${stemN}\n${opts.join('\n')}`
  return createHash('sha256').update(identity, 'utf8').digest('hex')
}

export function mergeCourseNames(existing: string[] | null | undefined, name: string | null | undefined): string[] {
  const cur = Array.isArray(existing) ? [...existing] : []
  const n = (name || '').trim()
  if (!n) return cur
  if (!cur.includes(n)) cur.push(n)
  return cur
}

export function sameCourseNames(a: string[] | null | undefined, b: string[]): boolean {
  const left = Array.isArray(a) ? [...new Set(a)] : []
  const right = [...new Set(b)]
  return left.length === right.length && left.every((name) => right.includes(name))
}

export function sameAnswerTexts(a: string[], b: string[], qtype?: QType): boolean {
  const normalize = (values: string[]) => [...new Set(values.map((s) => {
    const text = collapseSpace(toHalfWidth(s))
    return qtype === 'judge' ? normalizeOption(text, qtype) : text
  }))].sort()
  const left = normalize(a)
  const right = normalize(b)
  return left.length > 0 && left.length === right.length && left.every((text, i) => text === right[i])
}
