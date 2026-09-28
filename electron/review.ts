import type { Page } from 'patchright'
import { deleteByHash, upsertQuestion } from './bank.ts'
import { contentHash, englishMatchStem, englishSlotStem, normalizeOption, normalizeStem, sameAnswerTexts, type QType } from './core/hash.ts'
import type { QResult } from './answer.ts'
import { SEL } from './core/selectors.ts'
import { readStableReviewedRows } from './core/review-read.ts'
import { canExtractReviewedQuestion, reviewCorrectness, reviewedTotalScore, reviewMutation, uniqueCorruptedTextMatch } from './core/review-match.ts'
import type { ExtractStats } from './core/live-view.ts'

export type ReviewedQuestion = {
  hash: string
  qtype: QType | 'unknown'
  stem: string
  options: string[]
  selected: string[]
  answerTexts: string[]
  referenceState: 'absent' | 'valid' | 'invalid'
  scoreText: string
  correct: boolean | null
}

type RawReviewedQuestion = Omit<ReviewedQuestion, 'hash' | 'correct' | 'referenceState'> & {
  referencePresent: boolean
  hasRight: boolean
  hasWrong: boolean
  englishType?: string
  ordinal?: number
  shared?: string
  transcript?: string
  childStem?: string
}

export type ReviewOutcome = {
  reviewed: number
  matched: number
  oldModeQuestions: number
  referenceQuestions: number
  graded: number
  inserted: number
  conflicts: number
  deleted: number
  wrong: number
  bankWrong: number
  aiWrong: number
  deleteFailed: number
  protectedDeletes?: number
  pendingCandidates: QResult[]
  pendingInsertHashes: string[]
  pendingDeleteHashes: string[]
  score: number | null
  referenceStats: ReferenceStats
}

export type ReferenceStats = { added: number; updated: number; merged: number; retry: number; contradictions: number }

export function contradictoryReferenceHashes(questions: ReviewedQuestion[]): Set<string> {
  const seen = new Map<string, string[]>()
  const blocked = new Set<string>()
  for (const q of questions) {
    if (!q.hash || q.referenceState !== 'valid') continue
    const prior = seen.get(q.hash)
    if (prior && !sameAnswerTexts(prior, q.answerTexts, q.qtype === 'unknown' ? undefined : q.qtype)) blocked.add(q.hash)
    else seen.set(q.hash, q.answerTexts)
  }
  return blocked
}

export async function readReviewedQuestions(page: Page): Promise<ReviewedQuestion[]> {
  const raw = await readStableReviewedRows(page, () => page.evaluate((optionSelector) => {
    return [...document.querySelectorAll('.e-q-body')].flatMap((body): RawReviewedQuestion[] => {
      const q = body.querySelector('.e-q')
      const rawType = body.getAttribute('data-questiontype') || ''
      if (rawType === '7') {
        const shared = (body.querySelector('form .e-q-r > .e-q-quest > .e-q-q')?.textContent || '').trim()
        const group = body.querySelector('form .e-short-a')
        const left = [...(group?.querySelectorAll('.am-u-sm-5:not(.am-u-offset-1) .ErichText') || [])]
          .map(node => (node.textContent || '').trim().replace(/^\d+\s*[、.)]\s*/, ''))
        const right = [...(group?.querySelectorAll('.am-u-offset-1.am-u-sm-5 .ErichText') || [])]
          .map(node => (node.textContent || '').trim().replace(/^[A-Z]\s*[、.)）．]\s*/, ''))
        const references = [...(group?.querySelectorAll('.e-ans-ref span.e-ans-r') || [])]
          .map(node => (node.textContent || '').trim())
        if (shared && left.length > 0 && right.length > 0 && references.length === left.length) {
          return left.map((childStem, index) => ({
            qtype: 'single' as const, stem: childStem, childStem, shared, englishType: rawType, ordinal: index + 1,
            options: right, selected: [], answerTexts: [references[index]], referencePresent: true,
            scoreText: '', hasRight: false, hasWrong: false,
          }))
        }
      }
      if (['8', '9', '11'].includes(rawType)) {
        const shared = (body.querySelector('.e-q-r > .e-q-quest > .e-q-q')?.textContent || '').trim()
        const transcriptNode = body.querySelector('[data-transcript], .transcript')
        const transcript = (transcriptNode?.getAttribute('data-transcript') || transcriptNode?.textContent || '').trim()
        const forms = [...body.querySelectorAll('form')].filter(form => form.querySelector('li.e-a'))
        return forms.map((form, index) => {
          const options = [...form.querySelectorAll('li.e-a')]
          const subType = options[0]?.getAttribute('data-subquestiontype') || ''
          const qtype: QType | 'unknown' = subType === '3' ? 'judge' : subType === '2' ? 'multiple' : subType === '1' ? 'single' : 'unknown'
          const childStem = (form.querySelector('.e-q-quest .e-q-q')?.textContent || '').trim()
          const reference = form.querySelector('.e-a-ans .e-ans-ref')
          const answerTexts = [...(reference?.querySelectorAll(qtype === 'judge' ? 'div.e-ans-r > .e-a-g p.checked' : 'span.e-ans-r') || [])]
            .map(node => (node.textContent || '').trim())
          return { qtype, stem: childStem || shared, childStem, shared, transcript, englishType: rawType, ordinal: index + 1,
            options: options.map(li => (li.textContent || '').trim()),
            selected: options.filter(li => li.classList.contains('checked')).map(li => (li.textContent || '').trim()),
            answerTexts, referencePresent: Boolean(reference),
            scoreText: (form.querySelector('input[name=GiveScore]') as HTMLInputElement | null)?.value || '',
            hasRight: Boolean(form.querySelector('.e-q-l .e-q-right')),
            hasWrong: Boolean(form.querySelector('.e-q-l .e-q-wrong')) }
        })
      }
      const qtype: QType | 'unknown' = rawType === '1' ? 'single' : rawType === '2' ? 'multiple' : rawType === '3' ? 'judge' : 'unknown'
      const options = [...body.querySelectorAll(rawType === '7'
        ? '.e-short-a .am-u-offset-1.am-u-sm-5 .ErichText' : optionSelector)]
        .map((li) => ((li as HTMLElement).innerText || li.textContent || '').replace(/\s+/g, ' ').trim())
      const selected = [...body.querySelectorAll(optionSelector + '.checked')]
        .map((li) => ((li as HTMLElement).innerText || li.textContent || '').replace(/\s+/g, ' ').trim())
      const reference = q?.querySelector('.e-a-ans .e-ans-ref')
      const answerTexts = [...(reference?.querySelectorAll(qtype === 'judge' ? 'div.e-ans-r > .e-a-g p.checked' : 'span.e-ans-r') || [])]
        .map((node) => ((node as HTMLElement).innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
      const scoreInput = q?.querySelector('input[name=GiveScore]') as HTMLInputElement | null
      return [{
        qtype,
        stem: ((q?.querySelector('.e-q-q') as HTMLElement | null)?.innerText || q?.querySelector('.e-q-q')?.textContent || '').replace(/\s+/g, ' ').trim(),
        options,
        selected,
        answerTexts,
        referencePresent: rawType === '7' || Boolean(q?.querySelector('.e-a-ans')),
        scoreText: scoreInput?.value || scoreInput?.getAttribute('value') || '',
        hasRight: Boolean(q?.querySelector('.e-q-l .e-q-right')),
        hasWrong: Boolean(q?.querySelector('.e-q-l .e-q-wrong')),
      }]
    })
  }, SEL.reviewedOptions))
  return raw.map(({ hasRight, hasWrong, referencePresent, ...q }) => {
    const qtype = q.qtype
    const normalizedOptions = qtype === 'unknown' ? q.options : q.options.map((x) => normalizeOption(x, qtype))
    const reliableIdentity = !q.englishType || Boolean(q.shared && q.ordinal)
    const shared = q.shared || ''
    const stem = q.englishType === '7' ? englishMatchStem(shared, q.ordinal || 0, q.childStem || '')
      : q.englishType ? englishSlotStem(shared, q.englishType, q.ordinal || 0, q.childStem || '') : normalizeStem(q.stem)
    let answerTexts: string[] = []
    let referenceState: ReviewedQuestion['referenceState'] = !reliableIdentity || (q.englishType && qtype === 'unknown')
      ? 'invalid' : referencePresent ? 'invalid' : 'absent'
    if (referencePresent && qtype !== 'unknown' && reliableIdentity) {
      const mapped = qtype === 'judge'
        ? q.answerTexts.map((text) => normalizeOption(text, qtype))
        : q.answerTexts.map((text) => {
          const match = text.trim().toUpperCase().match(/^([A-Z])\s*[.)、．]?$/)
          return match ? normalizedOptions[match[1].charCodeAt(0) - 65] : undefined
        })
      const expected = qtype === 'multiple' ? mapped.length > 0 : mapped.length === 1
      if (expected && mapped.every((text): text is string =>
        typeof text === 'string' && Boolean(text) && normalizedOptions.filter((option) => option === text).length === 1) &&
        new Set(mapped).size === mapped.length) {
        answerTexts = mapped as string[]
        referenceState = 'valid'
      }
    }
    if (q.englishType === '11' && qtype === 'single' && hasRight) {
      const selected = q.selected.map((text) => normalizeOption(text, qtype))
      if (selected.length === 1 && normalizedOptions.filter((option) => option === selected[0]).length === 1) {
        answerTexts = selected
        referenceState = 'valid'
      }
    }
    return {
      ...q,
      stem,
      options: normalizedOptions,
      selected: qtype === 'unknown' ? q.selected : q.selected.map((x) => normalizeOption(x, qtype)),
      answerTexts,
      referenceState,
      correct: reviewCorrectness(hasRight, hasWrong),
      hash: qtype === 'unknown' || !reliableIdentity ? '' : contentHash(qtype, stem, normalizedOptions),
    }
  })
}

export async function reviewResults(
  page: Page, results: QResult[], courseName: string,
  options: { blockedHashes?: ReadonlySet<string> } = {},
): Promise<ReviewOutcome> {
  await page.locator('.e-q-body').first().waitFor({ timeout: 15000 })
  let reviewed: ReviewedQuestion[] = []
  let byHash = new Map<string, ReviewedQuestion>()
  const deadline = Date.now() + 8000
  do {
    reviewed = await readReviewedQuestions(page)
    byHash = new Map(reviewed.filter((q) => q.hash).map((q) => [q.hash, q]))
    const ready = results.filter((r) => r.hash && r.source !== '空过').every((result) => {
      const q = byHash.get(result.hash) || uniqueCorruptedTextMatch(result as QResult & { qtype: QType }, reviewed.filter((row): row is ReviewedQuestion & { qtype: QType } => row.qtype !== 'unknown'))
      return q && (q.referenceState !== 'absent' || (q.correct !== null &&
        sameAnswerTexts(q.selected, result.selected, q.qtype === 'unknown' ? undefined : q.qtype)))
    })
    if (ready) break
    await page.waitForTimeout(300)
  } while (Date.now() < deadline)
  const outcome: ReviewOutcome = {
   reviewed: reviewed.length,
   matched: 0,
    oldModeQuestions: 0,
    referenceQuestions: 0,
   graded: 0,
    inserted: 0,
    conflicts: 0,
    deleted: 0,
    wrong: 0,
    bankWrong: 0,
    aiWrong: 0,
    deleteFailed: 0,
    protectedDeletes: 0,
    pendingCandidates: [],
    pendingInsertHashes: [],
    pendingDeleteHashes: [],
    score: reviewedTotalScore(reviewed.map((question) => question.scoreText)),
    referenceStats: { added: 0, updated: 0, merged: 0, retry: 0, contradictions: 0 },
  }
  const blockedHashes = new Set([...contradictoryReferenceHashes(reviewed), ...(options.blockedHashes || [])])
  for (const result of results) {
    if (!result.hash || result.qtype === 'unknown' || result.source === '空过') continue
   const q = byHash.get(result.hash) || uniqueCorruptedTextMatch(result as QResult & { qtype: QType }, reviewed.filter((row): row is ReviewedQuestion & { qtype: QType } => row.qtype !== 'unknown'))
    if (q) {
      outcome.matched++
      if (q.referenceState === 'absent') outcome.oldModeQuestions++
      else outcome.referenceQuestions++
    }
   if (q?.correct !== null && q?.correct !== undefined) outcome.graded++
    if (blockedHashes.has(result.hash) || (q?.hash && blockedHashes.has(q.hash))) {
      outcome.referenceStats.contradictions++
      continue
    }
    if (q?.referenceState === 'invalid') {
      outcome.referenceStats.retry++
      outcome.pendingCandidates.push(result)
      continue
    }
    if (q?.referenceState === 'valid') {
      const status = await upsertQuestion({
        qtype: result.qtype, stem: q.stem, options: q.options, answer_texts: q.answerTexts,
        course_name: courseName, source: result.source === 'AI 答题' ? 'ai_verified' : 'extract', verified: true, referenceAnswer: true,
      })
      if (status === 'added') outcome.referenceStats.added++
      else if (status === 'updated') outcome.referenceStats.updated++
      else if (status === 'merged') outcome.referenceStats.merged++
      else {
        outcome.referenceStats.retry++
        outcome.pendingCandidates.push(result)
        outcome.pendingInsertHashes.push(result.hash)
      }
      continue
    }
    if (!q || q.correct === null || !sameAnswerTexts(q.selected, result.selected, result.qtype)) {
      outcome.pendingCandidates.push(result)
      continue
    }
    if (!q.correct) {
      outcome.wrong++
      if (result.source === '题库答题') outcome.bankWrong++
      if (result.source === 'AI 答题') outcome.aiWrong++
    }
    const mutation = reviewMutation(result.source, q.correct)
    if (mutation === 'upsert') {
      const answerTexts = q.answerTexts.length ? q.answerTexts : q.selected
      if (!answerTexts.length) {
        outcome.pendingCandidates.push(result)
        continue
      }
      const status = await upsertQuestion({
        qtype: result.qtype,
        stem: q.stem || result.stem,
        options: q.options.length ? q.options : result.options,
        answer_texts: answerTexts,
        course_name: courseName,
        source: result.source === 'AI 答题' ? 'ai_verified' : 'extract',
        verified: true,
      })
      if (status === 'failed') {
        outcome.pendingCandidates.push(result)
        outcome.pendingInsertHashes.push(result.hash)
      } else {
        if (status === 'added') outcome.inserted++
        if (status === 'conflict') outcome.conflicts++
      }
      continue
    }
    if (mutation === 'delete') {
      const deletion = await deleteByHash(result.hash, result.selected)
      if (deletion === 'deleted') outcome.deleted++
      else if (deletion === 'protected') outcome.protectedDeletes = (outcome.protectedDeletes || 0) + 1
      else {
        outcome.deleteFailed++
        outcome.pendingCandidates.push(result)
        outcome.pendingDeleteHashes.push(result.hash)
      }
    }
  }
  return outcome
}

export async function extractReviewedQuestions(
  page: Page,
  courseName: string,
  onProgress?: (stats: ExtractStats, current: number, total: number) => void,
  shouldStop: () => boolean = () => false,
  options: { questions?: ReviewedQuestion[]; blockedHashes?: ReadonlySet<string> } = {},
) {
  const questions = options.questions ?? await readReviewedQuestions(page)
  const stats: ExtractStats = { added: 0, merged: 0, skipped: 0, conflict: 0, failed: 0 }
  const referenceStats: ReferenceStats = { added: 0, updated: 0, merged: 0, retry: 0, contradictions: 0 }
  const blockedHashes = new Set([...contradictoryReferenceHashes(questions), ...(options.blockedHashes || [])])
  const pendingReferenceHashes: string[] = []
  const failedCandidates: { qtype: QType; stem: string; options: string[]; answer_texts: string[] }[] = []
  let current = 0
  for (const q of questions) {
    if (shouldStop()) break
    current++
    if (q.hash && blockedHashes.has(q.hash)) {
      referenceStats.contradictions++
      onProgress?.(stats, current, questions.length)
      continue
    }
    if (q.referenceState === 'invalid') {
      referenceStats.retry++
      if (q.hash) pendingReferenceHashes.push(q.hash)
      onProgress?.(stats, current, questions.length)
      continue
    }
    if (q.referenceState === 'valid') {
      if (!q.hash || q.qtype === 'unknown') {
        referenceStats.retry++
        onProgress?.(stats, current, questions.length)
        continue
      }
      const status = await upsertQuestion({
        qtype: q.qtype, stem: q.stem, options: q.options, answer_texts: q.answerTexts,
        course_name: courseName, source: 'extract', verified: true, referenceAnswer: true,
      })
      if (status === 'added') referenceStats.added++
      else if (status === 'updated') referenceStats.updated++
      else if (status === 'merged') referenceStats.merged++
      else {
        referenceStats.retry++
        pendingReferenceHashes.push(q.hash)
      }
      onProgress?.(stats, current, questions.length)
      continue
    }
    const answerTexts = q.answerTexts.length ? q.answerTexts : q.selected
    if (!canExtractReviewedQuestion(q, answerTexts)) {
      stats.skipped++
      onProgress?.(stats, current, questions.length)
      continue
    }
    if (!q.hash) {
      stats.skipped++
      onProgress?.(stats, current, questions.length)
      continue
    }
    const status = await upsertQuestion({
      qtype: q.qtype,
      stem: q.stem,
      options: q.options,
      answer_texts: answerTexts,
      course_name: courseName,
      source: 'extract',
      verified: true,
    })
    if (status === 'added') stats.added++
    else if (status === 'merged') stats.merged++
    else if (status === 'conflict') stats.conflict++
    else {
      stats.failed++
      failedCandidates.push({ qtype: q.qtype, stem: q.stem, options: q.options, answer_texts: answerTexts })
    }
    onProgress?.(stats, current, questions.length)
  }
  return { questions: questions.length, failedCandidates, pendingReferenceHashes, referenceStats, ...stats }
}
