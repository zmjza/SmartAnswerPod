import type { Page } from 'patchright'
import { SEL } from './core/selectors.ts'
import { qrDialogLooksOpen } from './core/qr.ts'
import { answerMatches, questionCompletionConfirmed } from './core/homework.ts'
import { matchOptionText, normalizeOption, type QType } from './core/hash.ts'
import { withTimeout } from './core/timeout.ts'

export { qrDialogLooksOpen } from './core/qr.ts'

export async function cdpEval<T>(page: Page, expression: string): Promise<T | null> {
  try {
    const cdp = await page.context().newCDPSession(page)
    try {
      const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
      return (res.result?.value as T) ?? null
    } finally {
      await cdp.detach().catch(() => {})
    }
  } catch {
    return null
  }
}

export async function readAnswer(page: Page, dataNum: string): Promise<string> {
  try {
    const dom = await withTimeout(page.evaluate((num) => {
      const b = document.querySelector('.e-q-body[data-num="' + num + '"]')
      const i = b && (b.querySelector('[name=answer]') as HTMLInputElement | null)
      return i ? (i.value || '') : ''
    }, dataNum), 3000)
    if (dom) return dom
  } catch {
    /* CDP 兜底 */
  }
  const selector = '.e-q-body[data-num=' + JSON.stringify(dataNum) + ']'
  const expr = `(() => { const b = document.querySelector(${JSON.stringify(selector)}); const i = b && b.querySelector('[name=answer]'); return i ? i.value || '' : ''; })()`
  return (await withTimeout(cdpEval<string>(page, expr), 3000)) || ''
}

async function questionNavActive(page: Page, dataNum: string): Promise<boolean> {
  try {
    return await withTimeout(page.evaluate((num) => {
      const item = document.querySelector('.e-selects-g a.e-item[data-num="' + num + '"]')
      return Boolean(item?.classList.contains('active'))
    }, dataNum), 3000)
  } catch {
    const selector = '.e-selects-g a.e-item[data-num=' + JSON.stringify(dataNum) + ']'
    const expr = `(() => { const item = document.querySelector(${JSON.stringify(selector)}); return !!item && item.classList.contains('active'); })()`
    return Boolean(await withTimeout(cdpEval<boolean>(page, expr), 3000))
  }
}

export async function waitAnswer(page: Page, dataNum: string, timeout = 8000, expected?: string[]): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = await readAnswer(page, dataNum)
    if (expected ? answerMatches(v, expected) : Boolean(v)) return v
    await page.waitForTimeout(200)
  }
  return ''
}

export async function waitQuestionComplete(page: Page, dataNum: string, expected: string[], timeout = 8000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await readAnswer(page, dataNum)
    if (questionCompletionConfirmed(value, expected, await questionNavActive(page, dataNum))) return value
    await page.waitForTimeout(200)
  }
  return ''
}

export async function verifyAnswerSheet(page: Page, plan: { no: string; expected: string[] }[]): Promise<void> {
  const numbers = await page.locator(SEL.questionBody).evaluateAll((bodies) => bodies
    .filter((body) => !['7', '8', '9', '11'].includes(body.getAttribute('data-questiontype') || ''))
    .map((body) => body.getAttribute('data-num') || ''))
  if (!numbers.length || numbers.length !== plan.length || new Set(numbers).size !== numbers.length ||
      new Set(plan.map((q) => q.no)).size !== plan.length || numbers.some((no) => !plan.some((q) => q.no === no))) {
    throw new Error('整卷复核失败：题目数量或题号不一致，禁止提交')
  }
  const incomplete = await incompleteQuestionNos(page, plan.map((question) => question.no))
  if (incomplete.length) throw new Error('整卷复核失败：第 ' + incomplete.join('、') + ' 题未完成或右侧未提亮，禁止提交')
  for (const question of plan) {
    const actual = await readAnswer(page, question.no)
    if (question.expected.length ? !answerMatches(actual, question.expected) : actual.trim() !== '') {
      throw new Error('整卷复核失败：第 ' + question.no + ' 题实际答案不一致，禁止提交')
    }
  }
}

export async function incompleteQuestionNos(page: Page, questionNos: string[]): Promise<string[]> {
  const incomplete: string[] = []
  for (const no of questionNos) {
    if (!(await readAnswer(page, no)).trim() || !await questionNavActive(page, no)) incomplete.push(no)
  }
  return incomplete
}

export async function buildAnswerPlan(
  page: Page,
  results: { no: string; pageNo?: string; source: string; qtype: QType | 'unknown'; selected: string[] }[],
): Promise<{ no: string; expected: string[] }[]> {
  const plan: { no: string; expected: string[] }[] = []
  for (const result of results) {
    const pageNo = result.pageNo || result.no
    const qtype = result.qtype === 'unknown' ? undefined : result.qtype
    const options = await page.locator('.e-q-body[data-num="' + pageNo + '"] li.e-a').evaluateAll((items) =>
      items.map((li) => ({ index: li.getAttribute('data-index') || '', text: (li as HTMLElement).innerText })))
    const available = options.map((option) => normalizeOption(option.text, qtype))
    const selected = new Set(result.selected.map((text) => matchOptionText(text, available, qtype)))
    const expected = options
      .filter((_, index) => selected.has(available[index]))
      .map((option) => option.index)
    if (result.source !== '空过' && (selected.has(null) || !expected.length || expected.length !== selected.size || expected.some((index) => !index))) {
      throw new Error('整卷复核失败：第 ' + result.no + ' 题答案无法定位')
    }
    plan.push({ no: pageNo, expected })
  }
  return plan
}

export function hasQr(page: Page): Promise<boolean> {
  return hasQrDialog(page)
}

export async function hasQrDialog(page: Page): Promise<boolean> {
  try {
    const info = await page.evaluate((sel) => {
      const d = document.querySelector(sel) as HTMLElement | null
      if (!d) return null
      const s = getComputedStyle(d)
      const r = d.getBoundingClientRect()
      const qr = d.querySelector('#qrCode') as HTMLElement | null
      let qrVisible = false
      if (qr) {
        const qs = getComputedStyle(qr)
        const b = qr.getBoundingClientRect()
        qrVisible = qs.display !== 'none' && qs.visibility !== 'hidden' && b.width > 2 && b.height > 2
      }
      return {
        display: s.display,
        visibility: s.visibility,
        opacity: s.opacity,
        width: r.width,
        height: r.height,
        text: d.innerText || '',
        qrVisible,
        top: r.top,
        left: r.left,
        vw: window.innerWidth,
        vh: window.innerHeight,
      }
    }, SEL.qrDialog)
    if (!info) return false
    return qrDialogLooksOpen(info)
  } catch {
    return false
  }
}

export async function clickNewPage(page: Page, locator: string): Promise<Page> {
  const ctx = page.context()
  const popupP = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null)
  await page.locator(locator).first().click()
  const popup = await popupP
  return popup || page
}
