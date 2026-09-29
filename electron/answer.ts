import type { Page } from 'patchright'
import { SEL } from './core/selectors'
import { contentHash, englishMatchStem, englishSlotStem, matchOptionText, normalizeOption, normalizeStem, qtypeFromPage, hasReadableQuestionText, type QType } from './core/hash'
import { lookupByHash } from './bank'
import { askAi, askAiGroup, retryAsked, type AiAttempt } from './ai'
import { aiAllFailedAction, aiFailureReason } from './core/ai-parse'
import { answerMatches, answerRepairExhaustedAction, bankAnswerDelayMs, MAX_ANSWER_REPAIR_ATTEMPTS } from './core/homework'
import { buildAnswerPlan, incompleteQuestionNos, readAnswer, waitAnswer, waitQuestionComplete, verifyAnswerSheet } from './page-tools'
import { emitProgress } from './progress'
import { appendFileSync } from 'node:fs'
import type { AccountState, SlotState } from './core/states'
import { readStableAnswerRows } from './core/review-read.ts'
import { withTimeout } from './core/timeout.ts'

export type QResult = {
  no: string
  pageNo?: string
  parentNo?: string
  slot?: number
  hash: string
  source: '题库答题' | 'AI 答题' | '空过'
  qtype: QType | 'unknown'
  stem: string
  options: string[]
  selected: string[]
}

export type EnglishSlot = {
  ordinal: number
  qtype: QType
  stem: string
  options: string[]
  indices: string[]
  hash: string
}

export type EnglishGroup = {
  no: string
  rawType: '7' | '8' | '9' | '11'
  shared: string
  reliableAudioText: boolean
  transcript: string
  slots: EnglishSlot[]
}

export class ListeningBankMissError extends Error {
  constructor(missing: number[]) {
    super(`听力题库缺少第 ${missing.join('、')} 题可靠答案，停止当前作业，未调用 AI、未提交`)
    this.name = 'ListeningBankMissError'
  }
}

export async function readEnglishGroup(page: Page, no: string, rawType: EnglishGroup['rawType']): Promise<EnglishGroup> {
  const data = await page.locator('.e-q-body[data-num="' + no + '"]').evaluate((body, type) => {
    const shared = (body.querySelector('.e-q-r > .e-q-quest > .e-q-q')?.textContent ||
      body.querySelector('form .e-q-quest .e-q-q')?.textContent || '').trim()
    const transcriptNode = body.querySelector('[data-transcript], .transcript')
    const transcript = (transcriptNode?.getAttribute('data-transcript') || transcriptNode?.textContent || '').trim()
    const reliableAudioText = Boolean(transcript)
    if (type === '7') {
      const form = body.querySelector('form')
      const group = form?.querySelector('.e-short-a')
      const left = [...(group?.querySelectorAll('.am-u-sm-5:not(.am-u-offset-1) .ErichText') || [])]
        .map((node) => (node.textContent || '').trim().replace(/^\d+\s*[、.)]\s*/, ''))
      const right = [...(group?.querySelectorAll('.am-u-offset-1.am-u-sm-5 .ErichText') || [])]
        .map((node) => (node.textContent || '').trim())
      const selects = [...(group?.querySelectorAll('select[name="answer"]') || [])] as HTMLSelectElement[]
      return { shared, transcript, reliableAudioText, slots: selects.map((select, index) => ({
        childStem: left[index] || '',
        options: right.map((text) => text.replace(/^[A-Z]\s*[、.)）．]\s*/, '')),
        indices: right.map((text) => {
          const label = text.match(/^([A-Z])\s*[、.)）．]/)?.[1]
          return [...select.options].find((option) => option.textContent?.trim() === label)?.value || ''
        }),
        subType: '',
      })) }
    }
    const forms = [...body.querySelectorAll('form')].filter((form) => form.querySelector('li.e-a'))
    return { shared, transcript, reliableAudioText, slots: forms.map((form) => {
      const lis = [...form.querySelectorAll('li.e-a')]
      return {
        childStem: (form.querySelector('.e-q-quest .e-q-q')?.textContent || '').trim(),
        options: lis.map((li) => (li.textContent || '').trim()),
        indices: lis.map((li) => li.getAttribute('data-index') || ''),
        subType: lis[0]?.getAttribute('data-subquestiontype') || '',
      }
    }) }
  }, rawType)
  if (!data.shared || !data.slots.length) throw new Error('英语复合题结构缺失，禁止猜测作答')
  const slots = data.slots.map((slot, index) => {
    const ordinal = index + 1
    const qtype: QType = rawType === '7' ? 'single' : slot.subType === '3' ? 'judge' : 'single'
    const options = slot.options.map((text) => normalizeOption(text, qtype))
    const childStem = normalizeStem(slot.childStem)
    const stem = rawType === '7' ? englishMatchStem(data.shared, ordinal, childStem) : englishSlotStem(data.shared, rawType, ordinal, childStem)
    if ((rawType !== '9' && !childStem) || !options.length || options.length !== slot.indices.length ||
        new Set(options).size !== options.length || !slot.indices.every(Boolean) ||
        !hasReadableQuestionText(stem, options)) throw new Error('英语复合题子项缺失或重复，禁止猜测作答')
    return { ordinal, qtype, stem, options, indices: slot.indices, hash: contentHash(qtype, stem, options) }
  })
  return { no, rawType, shared: normalizeStem(data.shared), transcript: normalizeStem(data.transcript), reliableAudioText: data.reliableAudioText, slots }
}

type EnglishSave = { parentNo: string; slot: number; index: string; matching: boolean }

async function saveEnglishSlot(page: Page, group: EnglishGroup, slot: EnglishSlot, text: string): Promise<EnglishSave> {
  const index = slot.indices[slot.options.indexOf(text)]
  if (!index) throw new Error('英语答案无法唯一映射当前选项，禁止提交')
  const body = page.locator('.e-q-body[data-num="' + group.no + '"]')
  const form = body.locator('form').nth(group.rawType === '7' ? 0 : slot.ordinal - 1)
  const matching = group.rawType === '7'
  const current = matching
    ? await form.locator('select[name="answer"]').nth(slot.ordinal - 1).inputValue()
    : await form.locator('input[name="answer"]').inputValue()
  const route = matching ? '/study/ajax-assignment-online_homework_match' : '/study/ajax-assignment-online_homework_subanswer'
  const saved = page.waitForResponse((response) =>
    response.url().includes(route) && response.request().method() === 'POST', { timeout: 8000 })
  if (matching) {
    const select = form.locator('select[name="answer"]').nth(slot.ordinal - 1)
    if (current === index) await select.evaluate((element) =>
      element.dispatchEvent(new Event('change', { bubbles: true })))
    else await select.selectOption(index)
  } else {
    await form.locator('li.e-a[data-index="' + index + '"]').evaluate((element) => (element as HTMLElement).click())
  }
  const response = await saved
  await response.finished()
  if (!response.ok()) throw new Error('英语子项保存失败，禁止提交')
  if (!matching) {
    const result = await response.json().catch(() => null)
    if (Number(result?.code) !== 1) throw new Error('英语子项保存失败，禁止提交')
  }
  const input = matching ? form.locator('select[name="answer"]').nth(slot.ordinal - 1) : form.locator('input[name="answer"]')
  await input.evaluate((element, expected) => {
    if ((element as HTMLInputElement).value !== expected) throw new Error('保存后页面答案不一致')
  }, index)
  return { parentNo: group.no, slot: slot.ordinal, index, matching }
}

async function verifyEnglishSaves(page: Page, saved: EnglishSave[]): Promise<void> {
  for (const item of saved) {
    const body = page.locator('.e-q-body[data-num="' + item.parentNo + '"]')
    const form = body.locator('form').nth(item.matching ? 0 : item.slot - 1)
    const input = item.matching ? form.locator('select[name="answer"]').nth(item.slot - 1) : form.locator('input[name="answer"]')
    const start = Date.now()
    let actual = await input.inputValue().catch(() => '')
    while (actual !== item.index) {
      if (Date.now() - start >= 8000) throw new Error(`父题 ${item.parentNo} 子题 ${item.slot} 保存后答案不一致（预期 index ${item.index}，实际 ${actual || '空'}），禁止提交`)
      await page.waitForTimeout(200)
      actual = await input.inputValue().catch(() => '')
    }
  }
}

async function answerEnglishGroup(page: Page, group: EnglishGroup, firstNo: number,
  onAttempt?: (attempt: AiAttempt) => void): Promise<{
  results: QResult[]; saves: EnglishSave[]; bankCount: number; aiCount: number
}> {
  const chosen = new Map<number, { text: string; source: QResult['source'] }>()
  for (const slot of group.slots) {
    const hit = await lookupByHash(slot.hash)
    const text = hit?.answer_texts?.length === 1
      ? matchOptionText(hit.answer_texts[0], slot.options, slot.qtype)
      : null
    if (hit?.answer_texts?.length && !text)
      throw new Error(`英语第 ${group.no} 题子题 ${slot.ordinal} 题库答案无法匹配当前页面选项，停止本份作业`)
    if (text) chosen.set(slot.ordinal, { text, source: '题库答题' })
  }
  const missing = group.slots.filter((slot) => !chosen.has(slot.ordinal))
  if (group.rawType === '11' && missing.length)
    throw new ListeningBankMissError(missing.map((slot) => slot.ordinal))
  if (missing.length) {
    const ai = await askAiGroup({
      hash: contentHash('multiple', group.shared, group.slots.map((slot) => slot.hash)),
      shared: group.transcript ? `${group.shared}\n听力转写：${group.transcript}` : group.shared,
      slots: missing.map((slot) => ({ id: String(slot.ordinal),
        stem: slot.stem.startsWith(group.shared + '\n') ? slot.stem.slice(group.shared.length + 1) : slot.stem,
        options: slot.options })),
      onAttempt,
    })
    if (!ai.selected) throw new Error(ai.model
      ? '英语整组答案编号或选项不匹配，禁止提交'
      : '英语整组 AI 答题失败 · ' + aiFailureReason(ai.attempts.at(-1)))
    for (const slot of missing) {
      const text = ai.selected[String(slot.ordinal)]
      if (!text || !slot.options.includes(text)) throw new Error('英语整组答案缺项，禁止提交')
      chosen.set(slot.ordinal, { text, source: 'AI 答题' })
    }
  }
  const results: QResult[] = []
  const saves: EnglishSave[] = []
  for (const slot of group.slots) {
    const answer = chosen.get(slot.ordinal)!
    saves.push(await saveEnglishSlot(page, group, slot, answer.text))
    results.push({
      no: String(firstNo + slot.ordinal - 1), parentNo: group.no, slot: slot.ordinal,
      hash: slot.hash, source: answer.source, qtype: slot.qtype, stem: slot.stem,
      options: slot.options, selected: [answer.text],
    })
  }
  return { results, saves,
    bankCount: results.filter((result) => result.source === '题库答题').length,
    aiCount: results.filter((result) => result.source === 'AI 答题').length }
}

function aiAttemptAction(prefix: string, questionNo: number | string, total: number, attempt: AiAttempt): string {
  if (attempt.status === 'requesting') return `${prefix}第 ${questionNo}/${total} 题 · AI ${attempt.index}/${attempt.total} 请求中`
  const reason = attempt.reason === 'timeout' ? '超时'
    : attempt.reason === 'network' ? '网络失败'
      : attempt.reason === 'http' ? `接口 ${attempt.httpStatus || '失败'}`
        : attempt.reason === 'invalid_json' ? '格式错误'
          : attempt.reason === 'option_mismatch' ? '答案正文不匹配'
            : '答案数量不符'
  return `${prefix}第 ${questionNo}/${total} 题 · AI ${attempt.index}/${attempt.total} ${reason}`
}

export async function clickByTexts(page: Page, dataNum: string, qtype: QType, texts: string[]): Promise<boolean> {
  const body = page.locator('.e-q-body[data-num="' + dataNum + '"]')
  const lis = body.locator('li.e-a')
  const n = await lis.count()
  const entries: { index: string; text: string }[] = []
  for (let i = 0; i < n; i++) {
    const li = lis.nth(i)
    entries.push({ index: (await li.getAttribute('data-index')) || '', text: normalizeOption(await li.innerText(), qtype) })
  }
  const available = entries.map((entry) => entry.text)
  const want = new Set(texts.map((text) => matchOptionText(text, available, qtype)))
  const targets = entries.filter((entry) => want.has(entry.text))
  if (want.has(null) || !want.size || want.size !== texts.length || targets.length !== want.size || targets.some((entry) => !entry.index) ||
      (qtype !== 'multiple' && targets.length !== 1)) return false
  if (qtype === 'multiple') {
    const expected = targets.map((entry) => entry.index)
    for (let method = 0; method < 2; method++) {
      let failed = false
      let timedOut = false
      let current = new Set(method
        ? await lis.evaluateAll((items) => items.filter((li) => li.classList.contains('checked')).map((li) => li.getAttribute('data-index') || ''))
        : (await readAnswer(page, dataNum)).split(',').filter(Boolean))
      const clicks = entries.map((entry, i) => ({ ...entry, i }))
        .filter((entry) => current.has(entry.index) !== want.has(entry.text))
      if (method && !clicks.length) {
        const target = entries.find((entry) => want.has(entry.text))!
        clicks.push({ ...target, i: entries.indexOf(target) }, { ...target, i: entries.indexOf(target) })
      }
      for (const entry of clicks) {
        try {
          await waitNoClick(page, dataNum)
          const next = new Set(current)
          if (next.has(entry.index)) next.delete(entry.index)
          else next.add(entry.index)
          const saved = page.waitForResponse((response) => response.url().includes('/study/ajax-assignment-online_homework_answer') && response.request().method() === 'POST', { timeout: 8000 }).catch(() => null)
          if (method) await lis.nth(entry.i).evaluate((li) => (li as HTMLElement).click())
          else await lis.nth(entry.i).click({ timeout: 8000 })
          const response = await saved
          if (!response) { timedOut = true; break }
          await response.finished()
          if (!response.ok()) { await page.waitForTimeout(150); failed = true; break }
          if (next.size && !await waitAnswer(page, dataNum, 8000, [...next])) { failed = true; break }
          current = next
        } catch { failed = true; break }
      }
      if (timedOut) throw new Error('多选保存请求超时，停止当前作业')
      if (!failed && await waitQuestionComplete(page, dataNum, expected, 8000)) {
        const checked = await lis.evaluateAll((items) => items
          .filter((li) => li.classList.contains('checked'))
          .map((li) => li.getAttribute('data-index') || ''))
        if (answerMatches(checked.join(','), expected)) return true
      }
    }
    throw new Error('多选答案与目标不一致，停止当前作业')
  }
  const clicked: string[] = []
  for (let i = 0; i < n; i++) {
    const li = lis.nth(i)
    const raw = ((await li.innerText()) || '').trim()
    const text = normalizeOption(raw, qtype)
    if (!want.has(text)) continue
    const idx = (await li.getAttribute('data-index')) || ''
    await waitNoClick(page, dataNum)
    await withTimeout(page.evaluate(({ dataNum, idx }) => {
      const b = document.querySelector('.e-q-body[data-num="' + dataNum + '"]')
      const el = b && b.querySelector('li.e-a[data-index="' + idx + '"]')
      if (el) (el as HTMLElement).click()
    }, { dataNum, idx }), 8000)
    clicked.push(idx)
    break
  }
  if (!clicked.length) return false
    const val = await waitQuestionComplete(page, dataNum, clicked, 8000)
    const ok = val.trim() !== ''
    try {
      appendFileSync('/tmp/kaida-answer-cdp.jsonl', JSON.stringify({ t: Date.now(), dataNum, qtype, ok, n: val.length }) + '\n')
    } catch { /* ignore */ }
    if (!ok) throw new Error('答案尚未正确写入，停止当前作业')
    return true
}

async function waitNoClick(page: Page, dataNum: string) {
  const start = Date.now()
  while (Date.now() - start < 8000) {
    const blocked = await page.evaluate((num) => {
      const b = document.querySelector('.e-q-body[data-num="' + num + '"]')
      return !!b?.querySelector('li.e-a.no-click')
    }, dataNum)
    if (!blocked) return
    await page.waitForTimeout(120)
  }
  throw new Error('题目仍在保存中，等待超时，停止当前作业')
}

export async function answerPage(opts: {
  page: Page
  local_id: string
  slot: SlotState
  account: AccountState
  courseName: string
  homeworkName: string
  onQuestion?: (result: QResult, total: number, bank: number, ai: number) => void
}): Promise<{ results: QResult[]; bankCount: number; aiCount: number; compositeVerified: boolean }> {
  const { page, local_id, slot, account, courseName, homeworkName } = opts
  try {
    await page.locator(SEL.questionBody).first().waitFor({ timeout: 20000 })
  } catch {
    emitProgress({
      local_id, slot, account, action: '作答页无题目', courseName, homeworkName, homework: 'answering',
      bankCount: 0, aiCount: 0,
    })
    throw new Error('作答页无题目，禁止提交')
  }
  const ordinaryCount = await page.locator(SEL.questionBody).evaluateAll((bodies) => bodies
    .filter((body) => !['7', '8', '9', '11'].includes(body.getAttribute('data-questiontype') || '')).length)
  if (ordinaryCount) await readStableAnswerRows(page, async () => page.locator(SEL.questionBody).evaluateAll((bodies) => bodies
    .filter((body) => !['7', '8', '9', '11'].includes(body.getAttribute('data-questiontype') || ''))
    .map((body) => ({
      stem: body.querySelector('.e-q-q')?.textContent || '',
      options: [...body.querySelectorAll('li.e-a')].map((li) => li.textContent || ''),
    }))))
  const bodies = page.locator(SEL.questionBody)
  const total = await bodies.count()
  const answerSlotTotal = await bodies.evaluateAll((items) => items.reduce((count, body) => {
    const type = body.getAttribute('data-questiontype')
    if (type === '7') return count + body.querySelectorAll('select[name="answer"]').length
    if (type === '8' || type === '9' || type === '11')
      return count + [...body.querySelectorAll('form')].filter((form) => form.querySelector('li.e-a')).length
    return count + 1
  }, 0))
  const results: QResult[] = []
  const englishSaves: EnglishSave[] = []
  let bankCount = 0
  let aiCount = 0
  for (let i = 0; i < total; i++) {
    const body = bodies.nth(i)
    const dataNum = (await body.getAttribute('data-num')) || String(i + 1)
    const typeRaw = (await body.getAttribute('data-questiontype')) || ''
    if (typeRaw === '7' || typeRaw === '8' || typeRaw === '9' || typeRaw === '11') {
      const group = await readEnglishGroup(page, dataNum, typeRaw)
      const english = await answerEnglishGroup(page, group, results.length + 1, (attempt) => {
        emitProgress({ local_id, slot, account,
          action: aiAttemptAction('英语整组 · ', results.length + 1, answerSlotTotal, attempt),
          courseName, homeworkName, homework: 'answering', bankCount, aiCount })
      })
      let groupBank = 0
      let groupAi = 0
      for (const result of english.results) {
        results.push(result)
        if (result.source === '题库答题') groupBank++
        if (result.source === 'AI 答题') groupAi++
        opts.onQuestion?.(result, answerSlotTotal, bankCount + groupBank, aiCount + groupAi)
      }
      englishSaves.push(...english.saves)
      bankCount += english.bankCount
      aiCount += english.aiCount
      continue
    }
    const qtype = qtypeFromPage(typeRaw)
    const stemRaw = ((await body.locator('.e-q-q').first().innerText({ timeout: 2000 }).catch(() => '')) ||
      (await body.innerText())).trim()
    const lis = body.locator('li.e-a')
    const oc = await lis.count()
    const options: { text: string; index: string }[] = []
    for (let k = 0; k < oc; k++) {
      const li = lis.nth(k)
      options.push({
        text: normalizeOption((await li.innerText({ timeout: 3000 }).catch(() => '')) || '', qtype === 'unknown' ? undefined : qtype),
        index: (await li.getAttribute('data-index')) || String(k),
      })
    }
    const stem = normalizeStem(stemRaw)
    if (qtype === 'unknown') {
      results.push({ no: String(results.length + 1), pageNo: dataNum, hash: '', source: '空过', qtype, stem, options: options.map((o) => o.text), selected: [] })
      opts.onQuestion?.(results[results.length - 1], answerSlotTotal, bankCount, aiCount)
      emitProgress({
        local_id, slot, account, action: '未知题型空过', courseName, homeworkName, homework: 'answering',
        questionNo: i + 1, questionTotal: total, source: '空过', bankCount, aiCount,
      })
      continue
    }
    if (!hasReadableQuestionText(stem, options.map((o) => o.text))) {
      emitProgress({ local_id, slot, account, courseName, homeworkName, homework: 'answering',
        action: '题干或选项缺失/损坏，停止当前作业', questionNo: i + 1, questionTotal: total, bankCount, aiCount })
      throw new Error('题干或选项缺失/损坏，禁止猜测作答')
    }
    const hash = contentHash(qtype, stem, options.map((o) => o.text))
    emitProgress({
      local_id, slot, account, action: '读取题目', courseName, homeworkName, homework: 'answering',
      questionNo: i + 1, questionTotal: total, bankCount, aiCount,
    })
    const hit = await lookupByHash(hash)
    if (hit && hit.answer_texts?.length) {
      const ok = await clickByTexts(page, dataNum, qtype, hit.answer_texts)
      if (ok) {
        bankCount++
        results.push({ no: String(results.length + 1), pageNo: dataNum, hash, source: '题库答题', qtype, stem, options: options.map((o) => o.text), selected: hit.answer_texts })
        opts.onQuestion?.(results[results.length - 1], answerSlotTotal, bankCount, aiCount)
        emitProgress({
          local_id, slot, account, action: '题库命中回填', courseName, homeworkName, homework: 'answering',
          questionNo: i + 1, questionTotal: total, source: '题库答题', bankCount, aiCount, click: 'li.e-a',
        })
        await page.waitForTimeout(bankAnswerDelayMs())
        continue
      }
      throw new Error(`第 ${i + 1} 题题库答案无法匹配当前页面选项，停止本份作业`)
    }
    const ai = await askAi({
      hash, qtype, stem, options: options.map((o) => o.text),
      onAttempt: (attempt) => emitProgress({
        local_id, slot, account, action: aiAttemptAction('', i + 1, total, attempt), courseName, homeworkName,
        homework: 'answering', questionNo: i + 1, questionTotal: total, bankCount, aiCount, aiModel: attempt.model,
      }),
    })
    if (ai.texts) {
      const ok = await clickByTexts(page, dataNum, qtype, ai.texts)
      if (ok) {
        aiCount++
        results.push({ no: String(results.length + 1), pageNo: dataNum, hash, source: 'AI 答题', qtype, stem, options: options.map((o) => o.text), selected: ai.texts })
        opts.onQuestion?.(results[results.length - 1], answerSlotTotal, bankCount, aiCount)
        emitProgress({
          local_id, slot, account, action: 'AI 回填', courseName, homeworkName, homework: 'answering',
          questionNo: i + 1, questionTotal: total, source: 'AI 答题', aiModel: ai.model, bankCount, aiCount, click: 'li.e-a',
        })
        continue
      }
      emitProgress({
        local_id, slot, account, action: 'AI 点选未写入', courseName, homeworkName, homework: 'answering',
        questionNo: i + 1, questionTotal: total, source: '空过', bankCount, aiCount, click: 'li.e-a',
      })
    }
    const allFailed = !ai.texts ? aiAllFailedAction(i + 1, total, ai.attempts) : 'AI 点选未写入'
    results.push({ no: String(results.length + 1), pageNo: dataNum, hash, source: '空过', qtype, stem, options: options.map((o) => o.text), selected: [] })
    opts.onQuestion?.(results[results.length - 1], answerSlotTotal, bankCount, aiCount)
      emitProgress({
        local_id, slot, account, action: allFailed, courseName, homeworkName, homework: 'answering',
        questionNo: i + 1, questionTotal: total, source: '空过', bankCount, aiCount,
      })
  }
  await verifyEnglishSaves(page, englishSaves)
  let plan = await buildAnswerPlan(page, results.filter((result) => !result.parentNo))
  const repairFailures = new Map<string, string>()
  for (let repair = 1; repair <= MAX_ANSWER_REPAIR_ATTEMPTS; repair++) {
    const missing = await incompleteQuestionNos(page, plan.map((question) => question.no))
    if (!missing.length) break
    emitProgress({ local_id, slot, account, courseName, homeworkName, homework: 'answering',
      action: `提交前发现未作答 ${missing.length} 题 · 补答第 ${repair}/${MAX_ANSWER_REPAIR_ATTEMPTS} 轮`, bankCount, aiCount })
    for (const result of results.filter((item) => item.pageNo && missing.includes(item.pageNo))) {
      if (result.qtype === 'unknown') continue
      const qtype = result.qtype
      emitProgress({ local_id, slot, account, courseName, homeworkName, homework: 'answering',
        action: `补答第 ${result.no}/${total} 题`, questionNo: Number(result.no) || undefined, questionTotal: total, bankCount, aiCount })
      let texts = result.selected
      let source = result.source
      if (!texts.length) {
        const hit = await lookupByHash(result.hash)
        if (hit?.answer_texts?.length) {
          if (!await clickByTexts(page, result.pageNo!, qtype, hit.answer_texts))
            throw new Error(`第 ${result.no} 题题库答案无法匹配当前页面选项，停止本份作业`)
          texts = hit.answer_texts
          source = '题库答题'
          bankCount++
        } else {
          retryAsked(result.hash)
          const ai = await askAi({
            hash: result.hash, qtype, stem: result.stem, options: result.options,
            onAttempt: (attempt) => emitProgress({
              local_id, slot, account, action: aiAttemptAction('补答 · ', result.no, total, attempt), courseName, homeworkName,
              homework: 'answering', questionNo: Number(result.no) || undefined, questionTotal: total, bankCount, aiCount, aiModel: attempt.model,
            }),
          })
          if (ai.texts && await clickByTexts(page, result.pageNo!, qtype, ai.texts)) {
            texts = ai.texts
            source = 'AI 答题'
            aiCount++
            repairFailures.delete(result.pageNo!)
          } else if (!ai.texts) {
            const failed = aiAllFailedAction(result.no, total, ai.attempts)
            repairFailures.set(result.pageNo!, failed)
            emitProgress({ local_id, slot, account, courseName, homeworkName, homework: 'answering',
              action: `补答第 ${repair}/${MAX_ANSWER_REPAIR_ATTEMPTS} 轮 · ${failed}`,
              questionNo: Number(result.no) || undefined, questionTotal: total, bankCount, aiCount })
          }
        }
      } else {
        await clickByTexts(page, result.pageNo!, qtype, texts)
      }
      if (source === '题库答题') await page.waitForTimeout(bankAnswerDelayMs())
      result.selected = texts
      result.source = source
      opts.onQuestion?.(result, answerSlotTotal, bankCount, aiCount)
    }
    await page.waitForTimeout(400)
    plan = await buildAnswerPlan(page, results.filter((result) => !result.parentNo))
  }
  const remaining = await incompleteQuestionNos(page, plan.map((question) => question.no))
  if (remaining.length) {
    const action = answerRepairExhaustedAction(remaining, remaining.map((no) => repairFailures.get(no) || ''))
    emitProgress({ local_id, slot, account, courseName, homeworkName, homework: 'answering',
      action, bankCount, aiCount })
    throw new Error(action)
  }
  if (plan.length) await verifyAnswerSheet(page, plan)
  emitProgress({ local_id, slot, account, courseName, homeworkName, homework: 'answering',
    action: '整卷复核通过 · ' + results.length + ' 题，明确空过 ' + results.filter((r) => r.source === '空过').length + ' 题', bankCount, aiCount })
  return { results, bankCount, aiCount, compositeVerified: englishSaves.length > 0 }
}
