import type { Page } from 'patchright'
import { NOQR_SEL } from './selectors.ts'
import { NoqrMutationObserver } from './network.ts'
import { isNoqrRequestAccepted } from './save.ts'
import { classifyNoqrPage, NoqrNetworkActivity, NoqrSessionError, reloadNoqrPage, sleepNoqr } from './session.ts'
import type { NoqrQuestionGroup, NoqrQuestionKind } from './question.ts'

export type NoqrAnswerCardAudit = {
  ok: boolean
  answered: number
  current: number
  unanswered: number
  missingKeys: string[]
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

async function visibleText(page: Page, selector: string): Promise<string> {
  const nodes = page.locator(selector)
  const values: string[] = []
  for (let index = 0; index < await nodes.count(); index++) {
    const node = nodes.nth(index)
    if (await node.isVisible().catch(() => false)) values.push((await node.textContent().catch(() => '')) || '')
  }
  return values.join('\n').replace(/\s+/g, ' ').trim()
}

async function openAnswerCard(page: Page, stopRequested: () => boolean): Promise<void> {
  const button = page.locator(NOQR_SEL.answerCardButton).first()
  if (!(await button.count())) throw new Error('答题页缺少答题卡入口')
  if (stopRequested()) throw new Error('任务已停止')
  await button.click()
  for (let poll = 0; poll < 200; poll++) {
    if (stopRequested()) throw new Error('任务已停止')
    const card = page.locator(NOQR_SEL.answerCardGroup)
    if (await card.count()) return
    await sleepNoqr(page, 50)
  }
  throw new Error('答题卡未打开')
}

async function closeAnswerCard(page: Page): Promise<void> {
  const backdrop = page.locator('.van-overlay').last()
  if (await backdrop.isVisible().catch(() => false)) {
    await backdrop.click({ position: { x: 5, y: 5 } }).catch(() => {})
  } else {
    await page.keyboard.press('Escape').catch(() => {})
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
  return page.locator('.content-area').first().innerText()
    .then((text) => text.replace(/\s+/g, ' ').trim())
    .catch(() => '')
}

async function targetQuestionVisible(page: Page, section: string, number: string): Promise<boolean> {
  const text = await page.locator('.content-area').first().innerText().catch(() => '')
  const displaySection = answerCardDisplaySection(answerCardLocator(section).section)
  if (!displaySection || !text.includes(displaySection)) return false
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
    let occurrence = 0
    for (const node of nodes) {
      const title = clean(node.querySelector(expected.titleSelector)?.textContent)
      if (title !== expected.section && !title.includes(expected.section)) continue
      occurrence++
      if (occurrence !== expected.occurrence) continue
      const target = [...node.querySelectorAll(expected.questionSelector)]
        .find((item) => clean(item.textContent) === expected.number)
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
  opts: { verifyBudgetMs?: number } = {},
): Promise<void> {
  const separator = key.lastIndexOf('#')
  if (separator <= 0 || separator === key.length - 1) throw new Error('答题卡漏题键格式无效')
  const sectionKey = key.slice(0, separator).trim()
  const locator = answerCardLocator(sectionKey)
  const number = key.slice(separator + 1).trim()
  const beforeSignature = await answerPageNavigationSignature(page)
  await openAnswerCard(page, stopRequested)
  try {
    const clicked = await page.locator(NOQR_SEL.answerCardGroup).evaluateAll((nodes, expected) => {
      const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      let occurrence = 0
      for (const node of nodes) {
        const title = clean(node.querySelector(expected.titleSelector)?.textContent)
        if (title !== expected.section && !title.includes(expected.section)) continue
        occurrence++
        if (occurrence !== expected.occurrence) continue
        const target = [...node.querySelectorAll(expected.questionSelector)]
          .find((item) => clean(item.textContent) === expected.number)
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
      if (Date.now() - verifyStartedAt >= Math.max(50, opts.verifyBudgetMs ?? 5_000)) {
        throw new Error(`答题卡跳转后未到达目标题：${sectionKey}#${number}`)
      }
      await sleepNoqr(page, 100)
    }
  } finally {
    await closeAnswerCard(page)
  }
}

export async function auditNoqrAnswerCard(page: Page, opts: {
  stopRequested: () => boolean
  savedKeys?: ReadonlySet<string>
  expectedKeys?: ReadonlySet<string>
  expectedCount?: number
  onWaiting?: (elapsedMs: number) => void
  onRecovery?: (message: string, attempt: number) => void
  onDiagnostic?: (message: string) => void
  noProgressBudgetMs?: number
  maxReopens?: number
}): Promise<NoqrAnswerCardAudit> {
  const noProgressBudgetMs = Math.max(50, opts.noProgressBudgetMs ?? 15_000)
  const maxReopens = Math.max(1, opts.maxReopens ?? 3)
  const network = new NoqrNetworkActivity(page)
  let opened = false
  for (let openAttempt = 0; openAttempt <= maxReopens; openAttempt++) {
    try {
      await openAnswerCard(page, opts.stopRequested)
      opened = true
      break
    } catch (error) {
      if (openAttempt >= maxReopens || opts.stopRequested()) throw error
      opts.onRecovery?.('答题卡未出现结构，关闭重开', openAttempt + 1)
      await closeAnswerCard(page)
    }
  }
  if (!opened) throw new Error('答题卡连续打开失败')
  const startedAt = Date.now()
  let lastProgressAt = startedAt
  let lastFingerprint = ''
  let reopens = 0
  const expectedKeys = new Set([...(opts.expectedKeys || [])].filter((key) => key.includes('#')))
  const expectedCount = Math.max(0, Math.trunc(Number(opts.expectedCount) || 0))
  try {
    for (;;) {
      const rows = await page.locator(NOQR_SEL.answerCardGroup).evaluateAll((cards) => {
        const occurrences = new Map<string, number>()
        const rows: Array<{
          key: string
          legacyKey: string
          number: string
          answered: boolean
          current: boolean
        }> = []
        for (const card of cards) {
          const title = (card.querySelector('.question-cart-title')?.textContent || '')
            .replace(/\s+/g, ' ').trim()
          const section = ['听力理解', '词汇匹配', '完型填空', '完形填空', '阅读理解', '多选题', '单选题', '判断题', '语法']
            .find((label) => title.includes(label)) || ''
          const occurrence = section ? (occurrences.get(section) || 0) + 1 : 0
          if (section) occurrences.set(section, occurrence)
          for (const node of card.querySelectorAll('.sub-question')) {
            const number = (node.textContent || '').replace(/\s+/g, ' ').trim()
            const legacyKey = section ? `${section}#${number}` : ''
            const scopedKey = section ? `${section}@${occurrence}#${number}` : ''
            rows.push({
              key: scopedKey || `${title}#${number}`,
              legacyKey,
              number,
              answered: node.classList.contains('has-answered'),
              current: node.classList.contains('is-current'),
            })
          }
        }
        return rows
      })
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
      const expectedLoaded = expectedCount > 0
        ? rows.length >= expectedCount
        : mappedRows
          ? [...expectedKeys].every((key) => observedKeys.has(key))
          : [...expectedNumbers].every(([number, count]) => (observedNumbers.get(number) || 0) >= count)
      const skeleton = await page.locator('.van-skeleton').first().isVisible().catch(() => false)
      const networkActive = network.isActive()
      const fingerprint = JSON.stringify({
        rows: rows.map((row) => [row.key, row.legacyKey, row.answered, row.current]),
        expectedLoaded,
        skeleton,
        networkActive,
      })
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint
        lastProgressAt = Date.now()
      }
      if ((!expectedCount && !expectedKeys.size) || expectedLoaded) {
        const missing = rows.filter((row) =>
          !row.answered &&
          !(opts.savedKeys?.has(row.key) || opts.savedKeys?.has(row.legacyKey) || opts.savedKeys?.has(row.number)))
        return {
          ok: rows.length > 0 && missing.length === 0,
          answered: rows.filter((row) => row.answered).length,
          current: rows.filter((row) => row.current).length,
          unanswered: missing.length,
          missingKeys: missing.map((row) => row.key),
        }
      }
      if (opts.stopRequested()) throw new Error('任务已停止')
      if (
        !skeleton &&
        !networkActive &&
        Date.now() - lastProgressAt >= noProgressBudgetMs
      ) {
        const recognizedSections = new Set(
          rows.map((row) => row.legacyKey.split('#')[0]).filter(Boolean),
        )
        opts.onDiagnostic?.(
          `答题卡结构不足：已加载 ${rows.length}/${expectedCount || expectedKeys.size}，` +
          `已答 ${rows.filter((row) => row.answered).length}，` +
          `识别题型 ${recognizedSections.size}`,
        )
        if (reopens >= maxReopens) {
          throw new Error(`答题卡连续 ${maxReopens + 1} 次无进展，已安全停止当前作业`)
        }
        reopens++
        opts.onRecovery?.('答题卡加载无进展，关闭重开', reopens)
        await closeAnswerCard(page)
        await openAnswerCard(page, opts.stopRequested)
        lastFingerprint = ''
        lastProgressAt = Date.now()
        continue
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(page, 100)
    }
  } finally {
    network.dispose()
    await closeAnswerCard(page)
  }
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

export async function submitNoqrHomework(opts: {
  page: Page
  workId: string
  observer: NoqrMutationObserver
  stopRequested: () => boolean
  expectedHomeWorkUniqueFlag?: string
  onWaiting?: (state: string, elapsedMs: number) => void
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
  const network = new NoqrNetworkActivity(opts.page)
  try {
    if (opts.stopRequested()) throw new Error('任务已停止')
    await submit.click()
  } catch (error) {
    network.dispose()
    throw error
  }
  const startedAt = Date.now()
  let clickAttempts = 1
  let idlePolls = 0
  let requestFailureReason = ''
  let successToast = false
  let buttonDisabled = false
  let dialogCancelReason: string | null = null
  let monitoring = true
  const uiMonitor = (async () => {
    while (monitoring) {
      if (!dialogCancelReason) dialogCancelReason = await cancelIncompleteDialog(opts.page, opts.stopRequested)
      const ui = await submitUiState(opts.page)
      successToast ||= ui.successToast
      buttonDisabled ||= ui.buttonDisabled
      if (successToast && buttonDisabled) return
      if (opts.stopRequested()) return
      await sleepNoqr(opts.page, 100)
    }
  })()

  let finish: ReturnType<NoqrMutationObserver['findRequest']> = null
  while (!opts.stopRequested() || network.isActive()) {
    if (dialogCancelReason) break
    finish = opts.observer.findRequest({ after: marker, kinds: ['finish'], workId: opts.workId })
    if (finish) break
    if (!opts.stopRequested() && !successToast && !buttonDisabled && !network.isActive()) {
      idlePolls++
    } else {
      idlePolls = 0
    }
    if (idlePolls >= 20) {
      if (clickAttempts >= 3 || !(await submit.isVisible().catch(() => false))) {
        requestFailureReason = `未捕获到最终交卷请求（已点击 ${clickAttempts} 次）`
        break
      }
      if (opts.stopRequested()) {
        requestFailureReason = '任务已停止'
        break
      }
      opts.onWaiting?.(`未观察到交卷请求，重新点击 ${clickAttempts + 1}/3`, Date.now() - startedAt)
      await submit.click()
      clickAttempts++
      idlePolls = 0
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

  while (!opts.stopRequested()) {
    if (dialogCancelReason) break
    if (successToast && buttonDisabled) break
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

export async function returnToNoqrCourseWork(page: Page, stopRequested: () => boolean): Promise<void> {
  const back = page.locator(NOQR_SEL.navBack).first()
  if (!(await back.count())) throw new Error('交卷成功后缺少返回按钮')
  if (stopRequested()) throw new Error('任务已停止')
  await back.click()
  const network = new NoqrNetworkActivity(page)
  let refreshAttempts = 0
  try {
    for (;;) {
      if (stopRequested()) throw new Error('任务已停止')
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked' || surface === 'login') {
        throw new NoqrSessionError('auth_blocked', '交卷返回后进入登录或人工认证页面')
      }
      if (surface === 'error') throw new NoqrSessionError('page_error', '交卷返回后页面显示明确错误')
      if (page.url().includes('/course_work/index.html')) {
        const state = await page.evaluate((selectors) => ({
          items: document.querySelectorAll(selectors.courseWorkItem).length,
          empty: Boolean(document.querySelector('.van-empty')) ||
            /暂无作业|没有作业|暂无数据/.test(document.body?.innerText || ''),
          skeleton: Boolean(document.querySelector('.skeleton-area.van-skeleton')),
        }), NOQR_SEL)
        if (state.items > 0 || state.empty) return
        if (state.skeleton || network.isActive()) {
          await sleepNoqr(page, 100)
          continue
        }
        if (refreshAttempts < 3) {
          refreshAttempts++
          await reloadNoqrPage(page, { stopRequested })
          continue
        }
        throw new NoqrSessionError('blank_page', '交卷返回后作业区连续刷新仍无作业卡或明确空态')
      }
      await sleepNoqr(page, 100)
    }
  } finally {
    network.dispose()
  }
}
