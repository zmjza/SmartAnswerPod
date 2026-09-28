import type { Page } from 'patchright'
import { SEL } from './core/selectors'
import { SUBMIT, isUnansweredConfirm, newSubmission } from './core/homework'
import { emitProgress } from './progress'
import { readHistory } from './detect'
import type { AccountState, SlotState } from './core/states'
import { appendFileSync } from 'node:fs'

function dumpSubmit(ev: string, extra?: Record<string, unknown>) {
  try {
    appendFileSync('/tmp/kaida-submit.jsonl', JSON.stringify({ t: Date.now(), ev, ...extra }) + '\n')
  } catch { /* ignore */ }
}

export async function submitHomework(opts: {
  page: Page
  verifiedComposite?: boolean
  local_id: string
  slot: SlotState
  account: AccountState
  homeworkName: string
}): Promise<{ ok: boolean; incomplete?: boolean }> {
  const { page, local_id, slot, account, homeworkName } = opts
  const hasComposite = await page.locator('.e-q-body[data-questiontype="7"], .e-q-body[data-questiontype="8"], .e-q-body[data-questiontype="9"], .e-q-body[data-questiontype="11"]').count() > 0
  if (hasComposite && !opts.verifiedComposite) {
    emitProgress({ local_id, slot, account, action: '英语复合题未逐项复核，禁止提交', homeworkName, homework: 'submit_failed', bankCount: 0, aiCount: 0 })
    return { ok: false, incomplete: true }
  }
  emitProgress({
    local_id, slot, account, action: '点击提交作业', homeworkName, homework: 'submitting',
    bankCount: 0, aiCount: 0, click: '#submitHomeWork',
  })
  const clickOk = async (timeout: number, which: string): Promise<'clicked' | 'incomplete' | 'missing'> => {
    const ok = page.locator(SUBMIT.ok).first()
    try {
      await ok.waitFor({ state: 'visible', timeout })
      const dialogText = ((await page.locator('.xcConfirm').first().innerText()) || '').trim()
      if (isUnansweredConfirm(dialogText)) {
        await page.locator(SUBMIT.cancel).first().click()
        emitProgress({
          local_id, slot, account, action: '发现未作答警告，已取消提交', homeworkName, homework: 'submit_failed',
          bankCount: 0, aiCount: 0, click: 'a.sgBtn.cancel',
        })
        dumpSubmit('unanswered-cancelled', { which, homeworkName })
        return 'incomplete'
      }
      const label = ((await ok.innerText()) || '').trim()
      dumpSubmit('ok-visible', { which, label, homeworkName })
      await ok.click()
      emitProgress({
        local_id, slot, account, action: '确认提交', homeworkName, homework: 'submitting',
        bankCount: 0, aiCount: 0, click: 'a.sgBtn.ok',
      })
      dumpSubmit('ok-clicked', { which, label, homeworkName })
      await page.waitForTimeout(400)
      return 'clicked'
    } catch {
      dumpSubmit('ok-missing', { which, homeworkName })
      return 'missing'
    }
  }
  dumpSubmit('click-submit', { homeworkName })
  await page.locator(SEL.submit).click()
  let first = await clickOk(8000, 'first')
  if (first === 'incomplete') return { ok: false, incomplete: true }
  if (first === 'missing') {
    await page.waitForTimeout(8000)
    if (await page.locator(SEL.submit).count()) {
      await page.locator(SEL.submit).click()
      dumpSubmit('retry-submit', { homeworkName })
      first = await clickOk(8000, 'first-retry')
      if (first === 'incomplete') return { ok: false, incomplete: true }
    }
  }
  if (first !== 'clicked') {
    dumpSubmit('no-dialog', { homeworkName })
    emitProgress({ local_id, slot, account, action: '提交弹窗未出现', homeworkName, homework: 'submit_failed', bankCount: 0, aiCount: 0 })
    return { ok: false }
  }
  await page.locator(SUBMIT.ok).first().waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {})
  const second = await clickOk(5000, 'second')
  if (second === 'incomplete') return { ok: false, incomplete: true }
  dumpSubmit(second === 'clicked' ? 'second-ok' : 'no-second-ok', { homeworkName })
  try {
    await page.waitForURL((u) => u.pathname.includes('assignment-preview.aspx'), { timeout: 20000 })
    dumpSubmit('navigated-preview', { homeworkName })
  } catch {
    dumpSubmit('still-on-answer', { homeworkName })
  }
  return { ok: true }
}

export async function historyHasNew(page: Page, before: string[]): Promise<boolean> {
  const rows = await readHistory(page)
  return newSubmission(rows, before) !== null
}
