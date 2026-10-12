import type { Page } from 'patchright'
import { PATH, SEL } from './core/selectors'
import { hasQr } from './page-tools'
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
  onNeedVerify?: () => Promise<void>
  signal?: AbortSignal
  local_id: string
  slot: SlotState
  account: AccountState
  homeworkName: string
}): Promise<{ ok: boolean; incomplete?: boolean }> {
  const { page, local_id, slot, account, homeworkName } = opts
  const hasComposite = await page.locator('.e-q-body[data-questiontype="7"], .e-q-body[data-questiontype="8"], .e-q-body[data-questiontype="9"], .e-q-body[data-questiontype="11"]').count() > 0
  if (opts.signal?.aborted) return { ok: false }
  if (hasComposite && !opts.verifiedComposite) {
    emitProgress({ local_id, slot, account, action: '英语复合题未逐项复核，禁止提交', homeworkName, homework: 'submit_failed', bankCount: 0, aiCount: 0 })
    return { ok: false, incomplete: true }
  }
  emitProgress({
    local_id, slot, account, action: '点击提交作业', homeworkName, homework: 'submitting',
    bankCount: 0, aiCount: 0, click: '#submitHomeWork',
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.signal?.aborted) return { ok: false }
    await page.locator(SEL.submit).click()
    let deadline = Date.now() + 20000
    let resumeAfterQr = false
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) return { ok: false }
      if (new URL(page.url()).pathname.toLowerCase() === PATH.assignmentPreview.toLowerCase()) {
        dumpSubmit('navigated-preview', { homeworkName })
        return { ok: true }
      }
      const qrOpen = await hasQr(page)
      if (opts.signal?.aborted) return { ok: false }
      if (qrOpen) {
        if (!opts.onNeedVerify) return { ok: false }
        await opts.onNeedVerify()
        if (opts.signal?.aborted || await hasQr(page)) return { ok: false }
        resumeAfterQr = true
        deadline = Date.now() + 20000
        continue
      }
      const ok = page.locator(SUBMIT.ok).filter({ visible: true }).first()
      const hasConfirm = await ok.count() > 0
      if (opts.signal?.aborted) return { ok: false }
      if (hasConfirm) {
        const dialogText = ((await ok.locator('xpath=ancestor::*[contains(@class,"xcConfirm")]').innerText()) || '').trim()
        if (opts.signal?.aborted) return { ok: false }
        if (isUnansweredConfirm(dialogText)) {
          await page.locator(SUBMIT.cancel).filter({ visible: true }).first().click()
          emitProgress({ local_id, slot, account, action: '发现未作答警告，已取消提交', homeworkName,
            homework: 'submit_failed', bankCount: 0, aiCount: 0, click: 'a.sgBtn.cancel' })
          return { ok: false, incomplete: true }
        }
        await ok.click()
        emitProgress({ local_id, slot, account, action: '确认提交', homeworkName,
          homework: 'submitting', bankCount: 0, aiCount: 0, click: 'a.sgBtn.ok' })
        await page.waitForTimeout(400)
      } else await page.waitForTimeout(200)
    }
    // 部分学校扫码成功只关闭弹窗；先等自动保存，仍未跳转才恢复一次原生提交。
    if (!resumeAfterQr) break
  }
  emitProgress({ local_id, slot, account, action: '提交后未返回作业预览，未确认交卷', homeworkName,
    homework: 'submit_failed', bankCount: 0, aiCount: 0 })
  return { ok: false }
}

export async function historyHasNew(page: Page, before: string[]): Promise<boolean> {
  const rows = await readHistory(page)
  return newSubmission(rows, before) !== null
}
