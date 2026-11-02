import { createHash } from 'node:crypto'
import type { Page } from 'patchright'
import { maxAttemptsThisRun } from '../core/attempts.ts'
import { NoqrBlankRecoveryGate } from './blank-recovery.ts'
import type { NoqrHomework } from './types.ts'
import { NOQR_PATH, NOQR_SEL } from './selectors.ts'
import {
  classifyNoqrPage,
  isNoqrAnswerPath,
  NoqrNetworkActivity,
  NoqrSessionError,
  reloadNoqrPage,
  sleepNoqr,
  throwIfNoqrStopped,
} from './session.ts'
import { waitForNoqrCourseWorkReady } from './course.ts'

export type NoqrHomeworkRuleReason =
  | ''
  | 'start_disabled'
  | 'weight_zero'
  | 'unsupported_work_type'
  | 'out_of_window'
  | 'date_unknown'
  | 'attempts_exhausted'

const SUPPORTED_NOQR_URL_WORK_TYPES = new Set(['onlineWork', 'stageExam'])

export function isSupportedNoqrWorkType(value: unknown): value is 'onlineWork' | 'stageExam' {
  return typeof value === 'string' && SUPPORTED_NOQR_URL_WORK_TYPES.has(value)
}

export type NoqrHomeworkRule = {
  needDo: boolean
  maxRounds: number
  reason: NoqrHomeworkRuleReason
}

export type NoqrHomeworkRuleStatus =
  | 'todo'
  | 'not_startable'
  | 'date_unknown'
  | 'skip_weight0'
  | 'skip_non_objective'
  | 'skip_out_of_window'
  | 'skip_attempts_exhausted'

export type NoqrHomeworkList = {
  items: NoqrHomework[]
  empty: boolean
  courseTitle: string
}

export type NoqrHomeworkOpenOptions = {
  signal?: AbortSignal
  refreshBudget?: number
  onWaiting?: (waiting: number) => void
  blankGraceMs?: number
}

export type NoqrWorkCardSnapshot = {
  order: number
  name: string
  workId: string
  courseId: string
  visibleType: string
  info: string[]
  buttonTexts: string[]
  buttonDisabled: boolean[]
  stableToken: string
}

function collapse(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function normalizedPath(urlText: string): string {
  try { return new URL(urlText).pathname.replace(/\/+$/, '') || '/' } catch { return '' }
}

export function shouldResetNoqrCoursePage(urlText: string, previousHomeworkFailed: boolean): boolean {
  return previousHomeworkFailed || normalizedPath(urlText) !== NOQR_PATH.courseWork
}

export function parseNoqrWeight(text: string): number {
  const matched = String(text).match(/(-?\d+(?:\.\d+)?)\s*%/)
  if (!matched) return 0
  const value = Number(matched[1])
  return Number.isFinite(value) ? value : 0
}

export function parseNoqrAttempts(text: string): { visible: string; used: number; cap: number | null } {
  const visible = collapse(text)
  if (/无限制|不限/.test(visible)) return { visible, used: 0, cap: null }
  const pair = visible.match(/(\d+)\s*\/\s*(\d+)/)
  if (pair) return { visible, used: Number(pair[1]), cap: Number(pair[2]) }
  const max = visible.match(/(\d+)\s*次/)
  return { visible, used: 0, cap: max ? Number(max[1]) : 0 }
}

function parseDateMs(value: string): number | null {
  const normalized = collapse(value).replace(/\//g, '-')
  if (!normalized) return null
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function infoValue(info: string[], label: string): string {
  const target = info.find((entry) => {
    const text = collapse(entry)
    return text.startsWith(label + ':') || text.startsWith(label + '：')
  })
  return target ? collapse(target.replace(/^[^:：]+[:：]\s*/, '')) : ''
}

function parseRecordCount(text: string): number {
  const matched = collapse(text).match(/[\(（](\d+)[\)）]/)
  return matched ? Number(matched[1]) : 0
}

export function noqrHomeworkKey(
  name: string,
  order: number,
  stableToken = '',
  courseToken = '',
): string {
  return 'homework:' + createHash('sha256')
    .update(`${courseToken.trim()}\n${order}\n${collapse(name)}\n${stableToken.trim()}`)
    .digest('hex')
    .slice(0, 20)
}

export function parseNoqrHomeworkCard(card: NoqrWorkCardSnapshot, courseToken = ''): NoqrHomework {
  const name = collapse(card.name)
  if (!name) throw new NoqrSessionError('homework_contract', '作业卡缺少作业名称，禁止猜身份')
  const objectiveLabel = infoValue(card.info, '题目类型')
  const workType = /客观题/.test(card.visibleType) || /客观题/.test(objectiveLabel) ? 'onlineWork' : 'unknown'
  return {
    key: noqrHomeworkKey(name, card.order, card.stableToken, courseToken),
    name,
    workId: card.workId || undefined,
    courseId: card.courseId || undefined,
    workType,
    section: 'onlineHomework',
    weightPercent: parseNoqrWeight(infoValue(card.info, '权重')),
    startAt: infoValue(card.info, '形考开始时间'),
    endAt: infoValue(card.info, '形考结束时间'),
    reviewDeadline: infoValue(card.info, '批阅截止时间'),
    attemptsText: infoValue(card.info, '作答次数'),
    recordCount: parseRecordCount(card.buttonTexts[1] || ''),
    startEnabled: Boolean(card.buttonTexts[0]) && card.buttonDisabled[0] !== true,
    recordEnabled: Boolean(card.buttonTexts[1]) && card.buttonDisabled[1] !== true,
  }
}

export function evaluateNoqrHomeworkRule(
  homework: NoqrHomework,
  now: number,
  answerRoundLimit: number,
): NoqrHomeworkRule {
  if (!homework.startEnabled) return { needDo: false, maxRounds: 0, reason: 'start_disabled' }
  if (homework.weightPercent <= 0) return { needDo: false, maxRounds: 0, reason: 'weight_zero' }
  if (!isSupportedNoqrWorkType(homework.workType)) return { needDo: false, maxRounds: 0, reason: 'unsupported_work_type' }
  const start = parseDateMs(homework.startAt)
  const end = parseDateMs(homework.endAt)
  if (start == null || end == null) return { needDo: false, maxRounds: 0, reason: 'date_unknown' }
  if (now < start || now > end) return { needDo: false, maxRounds: 0, reason: 'out_of_window' }
  const attempts = parseNoqrAttempts(homework.attemptsText)
  const maxRounds = maxAttemptsThisRun({
    replyCountHidden: attempts.cap == null ? -1 : attempts.cap,
    visible: attempts.visible,
    used: attempts.used,
    cap: attempts.cap,
    runLimit: answerRoundLimit,
  })
  if (maxRounds <= 0) return { needDo: false, maxRounds: 0, reason: 'attempts_exhausted' }
  return { needDo: true, maxRounds, reason: '' }
}

export function noqrHomeworkRuleStatus(rule: NoqrHomeworkRule): NoqrHomeworkRuleStatus {
  if (rule.needDo) return 'todo'
  switch (rule.reason) {
    case 'start_disabled': return 'not_startable'
    case 'date_unknown': return 'date_unknown'
    case 'weight_zero': return 'skip_weight0'
    case 'unsupported_work_type': return 'skip_non_objective'
    case 'out_of_window': return 'skip_out_of_window'
    case 'attempts_exhausted': return 'skip_attempts_exhausted'
    default: return 'todo'
  }
}

async function readCards(page: Page): Promise<{ cards: NoqrWorkCardSnapshot[]; empty: boolean; title: string }> {
  return page.evaluate((selectors) => {
    const clean = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
    const visible = (node: Element) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
    }
    const cards = [...document.querySelectorAll(selectors.courseWorkItem)].filter(visible).map((node, index) => {
      const buttons = [...node.querySelectorAll(selectors.courseWorkButtons)]
      return {
        order: index + 1,
        name: clean(node.querySelector(selectors.courseWorkTitle)?.textContent),
        workId: clean(node.getAttribute('data-work-id')),
        courseId: clean(node.getAttribute('data-course-id')),
        visibleType: clean(node.querySelector(selectors.courseWorkType)?.textContent),
        info: [...node.querySelectorAll(selectors.courseWorkInfo)].map((entry) => clean(entry.textContent)),
        buttonTexts: buttons.map((button) => clean(button.textContent)),
        buttonDisabled: buttons.map((button) => (button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled') === 'true'),
        stableToken: [
          node.getAttribute('data-work-id'),
          node.getAttribute('data-id'),
          node.getAttribute('data-key'),
        ].filter(Boolean).join('|'),
      }
    })
    const text = document.body?.innerText || ''
    return {
      cards,
      empty: !cards.length && (
        [...document.querySelectorAll('.van-empty')].some(visible) ||
        /暂无作业|没有作业|暂无数据/.test(text)
      ),
      title: clean(document.querySelector(selectors.navTitle)?.textContent),
    }
  }, NOQR_SEL)
}

export async function readNoqrHomeworkList(
  page: Page,
  opts: NoqrHomeworkOpenOptions = {},
): Promise<NoqrHomeworkList> {
  if (normalizedPath(page.url()) !== NOQR_PATH.courseWork) {
    throw new NoqrSessionError('homework_contract', '当前不在形考作业页，不能读取作业卡')
  }
  const readiness = await waitForNoqrCourseWorkReady(page, opts)
  const value = await readCards(page)
  const items = value.cards.map((card) => parseNoqrHomeworkCard(card, value.title))
  return {
    items,
    empty: value.empty || (readiness === 'empty' && items.length === 0),
    courseTitle: value.title,
  }
}

export async function readNoqrHomeworks(
  page: Page,
  opts: NoqrHomeworkOpenOptions = {},
): Promise<NoqrHomework[]> {
  return (await readNoqrHomeworkList(page, opts)).items
}

export function resolveNoqrHomeworkCard(
  cards: NoqrHomework[],
  target: Pick<NoqrHomework, 'key' | 'name'>,
): NoqrHomework {
  const byKey = cards.find((item) => item.key === target.key)
  if (byKey) return byKey
  const byName = cards.filter((item) => item.name === target.name)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new NoqrSessionError('homework_contract', '同名作业卡不唯一，禁止按名称猜测')
  }
  throw new NoqrSessionError('homework_contract', '目标作业卡已变化，禁止按旧位置点击')
}

async function visibleWorkItemIndexes(page: Page): Promise<number[]> {
  return page.locator(NOQR_SEL.courseWorkItem).evaluateAll((nodes) => nodes
    .map((node, index) => {
      if (!(node instanceof HTMLElement)) return -1
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
        ? index
        : -1
    })
    .filter((index) => index >= 0))
}

export async function openNoqrHomework(
  page: Page,
  homework: NoqrHomework,
  action: 'start' | 'record',
  opts: NoqrHomeworkOpenOptions = {},
): Promise<void> {
  throwIfNoqrStopped(opts.signal)
  if (normalizedPath(page.url()) !== NOQR_PATH.courseWork) {
    throw new NoqrSessionError('homework_contract', '当前不在形考作业页，不能打开作业')
  }
  const clickAction = async (): Promise<void> => {
    const homeworks = await readNoqrHomeworks(page, opts)
    const resolved = resolveNoqrHomeworkCard(homeworks, homework)
    const index = homeworks.findIndex((item) => item.key === resolved.key)
    if (index < 0) throw new NoqrSessionError('homework_contract', '目标作业卡已变化，禁止按旧位置点击')
    const visibleIndexes = await visibleWorkItemIndexes(page)
    const domIndex = visibleIndexes[index]
    if (domIndex == null) throw new NoqrSessionError('homework_contract', '目标作业不在当前可见卡片中')
    const target = page.locator(NOQR_SEL.courseWorkItem).nth(domIndex)
    const buttonIndex = action === 'start' ? 0 : 1
    const button = target.locator(NOQR_SEL.courseWorkButtons).nth(buttonIndex)
    if (!(await button.count())) {
      throw new NoqrSessionError('homework_contract', action === 'start' ? '目标作业缺少开始作答按钮' : '目标作业缺少作答记录按钮')
    }
    if (await button.isDisabled().catch(() => false)) {
      throw new NoqrSessionError('homework_contract', action === 'start' ? '目标作业开始作答按钮不可用' : '目标作业作答记录按钮不可用')
    }
    throwIfNoqrStopped(opts.signal)
    await button.click()
  }
  const expectedPath = action === 'start' ? NOQR_PATH.answer : NOQR_PATH.record
  const startedAt = Date.now()
  const network = new NoqrNetworkActivity(page)
  const recovery = new NoqrBlankRecoveryGate({
    graceMs: opts.blankGraceMs,
    refreshBudget: opts.refreshBudget ?? 3,
  })
  try {
    // The work-card click may start the slow answer/document request
    // synchronously, so network tracking must be installed first.
    await clickAction()
    for (;;) {
      throwIfNoqrStopped(opts.signal)
      if (normalizedPath(page.url()) === expectedPath) {
        const url = new URL(page.url())
        const actualWorkType = url.searchParams.get('workType')
        if (action === 'start' && !isSupportedNoqrWorkType(actualWorkType)) {
          throw new NoqrSessionError('homework_contract', '目标作业的 workType 不是已确认的 onlineWork 或 stageExam')
        }
        const actualWorkId = url.searchParams.get('workId') || ''
        const actualCourseId = url.searchParams.get('courseId') || ''
        if (!actualWorkId || !actualCourseId) {
          throw new NoqrSessionError('homework_contract', '目标作业 URL 缺少 workId 或 courseId，禁止继续')
        }
        if (homework.workId && actualWorkId !== homework.workId) {
          throw new NoqrSessionError('homework_contract', '目标作业 URL 的 workId 与作业卡不一致，禁止继续')
        }
        if (homework.courseId && actualCourseId !== homework.courseId) {
          throw new NoqrSessionError('homework_contract', '目标作业 URL 的 courseId 与作业卡不一致，禁止继续')
        }
        return
      }
      const surface = await classifyNoqrPage(page)
      if (surface === 'auth_blocked' || surface === 'login') {
        throw new NoqrSessionError('auth_blocked', '打开作业后进入登录或人工认证')
      }
      if (surface === 'error') throw new NoqrSessionError('page_error', '打开作业后页面显示明确错误')
      if (
        isNoqrAnswerPath(page.url()) &&
        action === 'record'
      ) {
        throw new NoqrSessionError('answer_interrupted', '打开作答记录时误入答题页，已保留页面且不刷新')
      }
      const decision = recovery.observe({
        now: Date.now(),
        activityVersion: network.businessActivityVersion,
        empty: true,
        active: network.isBusinessActive(),
        stopRequested: opts.signal?.aborted,
      })
      if (decision.action === 'refresh') {
        await reloadNoqrPage(page, { signal: opts.signal })
        await waitForNoqrCourseWorkReady(page, opts)
        await clickAction()
        continue
      }
      if (decision.action === 'stop') {
        throw new NoqrSessionError(
          'blank_page',
          action === 'start' ? '开始作答入口持续无响应' : '作答记录入口持续无响应',
        )
      }
      opts.onWaiting?.(Date.now() - startedAt)
      await sleepNoqr(page, 150, opts.signal)
    }
  } finally {
    network.dispose()
  }
}

export const listNoqrHomeworks = readNoqrHomeworks
export const readHomeworkCards = readNoqrHomeworkList
