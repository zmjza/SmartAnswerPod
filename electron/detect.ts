import type { Page } from 'patchright'
import { createHash } from 'node:crypto'
import { PATH, SEL } from './core/selectors'
import { judgeListRow, newestGraded, shouldInspectHistory, skipFullScore, type HistoryRow } from './core/homework'
import { inWindow } from './core/homework'
import { maxAttemptsThisRun, parseUsedAttempts, parseWeight } from './core/attempts'
import { emitProgress } from './progress'
import type { HomeworkState, SlotState } from './core/states'
import type { ExtractStats } from './core/live-view.ts'
import { emptyExtractStats } from './core/live-view.ts'

export type DetectedHomework = {
  section: 'onlineHomework' | 'phasedTest'
  name: string
  workType: string
  weightPercent: number
  previewHref: string
  status: HomeworkState
  needDo: boolean
  remainingCap: number
  attempt?: number
  score?: number | null
  lastAttempt?: number
  lastScore?: number | null
  extractStats?: ExtractStats
  page?: Page
}

export type DetectedCourse = {
  key: string
  name: string
  status: string
  homeworks: DetectedHomework[]
}

export type ListedCourse = { name: string; href: string; key: string }

function courseKey(href: string): string {
  const url = new URL(href, 'https://l.shou.org.cn')
  const param = (name: string) => [...url.searchParams].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || ''
  const id = param('courseOpenId')
  return id ? `course:${id}:${param('minorCourseOpenId')}` : `href:${createHash('sha256').update(url.pathname + url.search).digest('hex')}`
}

export async function listCourses(page: Page, local_id: string, slot: SlotState): Promise<ListedCourse[]> {
  emitProgress({ local_id, slot, account: 'scanning_courses', action: '确认我的课程', bankCount: 0, aiCount: 0, click: 'tab-courseList' })
  const tab = page.locator(SEL.tabCourseList)
  if (!(await tab.getAttribute('class') || '').includes('is-active')) {
    await tab.click()
  }
  await page.locator(SEL.courseItem).first().waitFor({ timeout: 15000 }).catch(() => {})
  const out: ListedCourse[] = []
  const seen = new Set<string>()
  const sources = [
    { items: page.locator('.box-card .el-card__body .el-tabs__content > .course-item'), pinned: true },
    { items: page.locator(SEL.courseItem), pinned: false },
  ]
  for (const { items, pinned } of sources) {
    const n = await items.count()
    for (let i = 0; i < n; i++) {
      const it = items.nth(i)
      const name = ((await it.locator(SEL.courseName).innerText()) || '').replace(/\s+/g, ' ').trim()
      const href = (await it.locator(SEL.courseLink).getAttribute('href')) || ''
      if (!href || !name) continue
      if (pinned) {
        const url = new URL(href, 'https://l.shou.org.cn')
        if (!/^形势与政策[（(]\d+[）)]$/.test(name) || !url.pathname.toLowerCase().endsWith('/study/learncatalognew.aspx') || ![...url.searchParams.keys()].some((key) => key.toLowerCase() === 'courseopenid')) continue
      }
      const key = courseKey(href)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name, href, key })
    }
  }
  emitProgress({
    local_id,
    slot,
    account: 'courses_listed',
    action: '已列出课程 ' + out.length,
    courseTotal: out.length,
    bankCount: 0,
    aiCount: 0,
  })
  return out
}

async function sectionEmpty(page: Page, id: '#onlineHomework' | '#phasedTest', title: string): Promise<boolean> {
  const html = await page.content()
  if (html.includes(title + SEL.noDataMarker)) return true
  const box = page.locator(id)
  if ((await box.count()) === 0) return true
  return (await box.locator('tbody tr').count()) === 0
}

async function parseSection(page: Page, id: '#onlineHomework' | '#phasedTest', section: DetectedHomework['section'], runLimit: number): Promise<DetectedHomework[]> {
  const rows = page.locator(id + ' tbody tr')
  const n = await rows.count()
  const out: DetectedHomework[] = []
  for (let i = 0; i < n; i++) {
    const tr = rows.nth(i)
    const tds = tr.locator('td')
    const name = (await tds.nth(1).getAttribute('title')) || (await tds.nth(1).innerText())
    const workType = (await tds.nth(3).innerText()) || ''
    const weightPercent = parseWeight(await tds.nth(4).innerText())
    const startTitle = (await tds.nth(5).getAttribute('title')) || (await tds.nth(5).innerText())
    const endTitle = (await tds.nth(6).getAttribute('title')) || (await tds.nth(6).innerText())
    const vis = (await tds.nth(7).innerText()) || ''
    const hidden = await tds.nth(7).locator('input[name=replyCount]').inputValue().catch(() => '')
    const href = (await tr.locator(SEL.previewViewLink).getAttribute('href')) || ''
    const judge = judgeListRow(workType, weightPercent)
    const now = Date.now()
    const startMs = Date.parse(startTitle) || null
    const endMs = Date.parse(endTitle) || null
    let status = judge.status
    let needDo = judge.needDo
    if (needDo && !inWindow(now, startMs, endMs)) {
      needDo = false
      status = 'skip_out_of_window'
    }
    const hiddenN = hidden === '' ? null : Number(hidden)
    const used = parseUsedAttempts(vis)
    const cap = hiddenN === -1 ? null : hiddenN
    const remainingCap = maxAttemptsThisRun({ replyCountHidden: hiddenN, visible: vis, used, cap, runLimit })
    if (needDo && remainingCap <= 0) {
      needDo = false
      status = 'skip_attempts_exhausted'
    }
    out.push({
      section,
      name: name.trim(),
      workType,
      weightPercent,
      previewHref: href,
      status,
      needDo,
      remainingCap,
    })
  }
  return out
}

export async function detectCourse(opts: {
  portal: Page
  href: string
  key: string
  courseName: string
  local_id: string
  slot: SlotState
  index: number
  total: number
  mode?: 'answer' | 'extract'
  answerRoundLimit?: number
}): Promise<DetectedCourse> {
  const { portal, href, key, courseName, local_id, slot, index, total, mode = 'answer', answerRoundLimit = 10 } = opts
  emitProgress({
    local_id,
    slot,
    account: 'detecting',
    action: '检测课程',
    courseName,
    courseIndex: index,
    courseTotal: total,
    bankCount: 0,
    aiCount: 0,
    click: 'open catalog',
  })
  const abs = href.startsWith('http') ? href : 'https://l.shou.org.cn' + (href.startsWith('/') ? href : '/study/' + href)
  const ctx = portal.context()
  const coursePage = await ctx.newPage()
  await coursePage.goto(abs, { waitUntil: 'domcontentloaded' })
  await coursePage.locator(SEL.courseHomeWork).waitFor({ timeout: 20000 })
  emitProgress({
    local_id,
    slot,
    account: 'detecting',
    action: '点形考作业',
    courseName,
    courseIndex: index,
    courseTotal: total,
    bankCount: 0,
    aiCount: 0,
    click: '#courseHomeWorkNew',
  })
  await coursePage.locator(SEL.courseHomeWork).click()
  await coursePage.waitForURL((u) => u.pathname.toLowerCase().includes('homeworknew.aspx'), { timeout: 20000 })
  const emptyOnline = await sectionEmpty(coursePage, SEL.onlineHomework, '网上记分作业列表')
  const emptyPhased = await sectionEmpty(coursePage, SEL.phasedTest, '阶段性测验')
  let homeworks: DetectedHomework[] = []
  if (!emptyOnline) homeworks = homeworks.concat(await parseSection(coursePage, SEL.onlineHomework, 'onlineHomework', answerRoundLimit))
  if (!emptyPhased) homeworks = homeworks.concat(await parseSection(coursePage, SEL.phasedTest, 'phasedTest', answerRoundLimit))
  if (emptyOnline && emptyPhased) {
    await coursePage.close()
    return { key, name: courseName, status: '无作业', homeworks: [] }
  }
  for (const hw of homeworks) {
    if (!hw.previewHref) {
      hw.status = 'skip_no_history'
      continue
    }
    if (!shouldInspectHistory(hw, mode)) continue
    hw.status = 'previewing'
    const preview = await ctx.newPage()
    try {
      const ph = hw.previewHref.startsWith('http') ? hw.previewHref : 'https://l.shou.org.cn' + hw.previewHref
      await preview.goto(ph, { waitUntil: 'domcontentloaded' })
      const hist = await readHistory(preview)
      if (mode === 'answer' && skipFullScore(hist)) {
        hw.needDo = false
        hw.status = 'skip_full_score'
        await preview.close()
        continue
      }
      hw.status = 'todo'
      hw.page = preview
    } catch {
      await preview.close().catch(() => {})
      if (mode === 'extract') {
        const stats: ExtractStats = emptyExtractStats()
        stats.failed = 1
        hw.extractStats = stats
        hw.status = 'extracting_done'
      } else {
        throw new Error('作业预览页读取失败：' + hw.name)
      }
    }
  }
  await coursePage.close()
  return { key, name: courseName, status: '已检测', homeworks }
}

async function readHistory(page: Page): Promise<HistoryRow[]> {
  await page.locator(SEL.historyTable).waitFor({ timeout: 20000 }).catch(() => {})
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel + ' tbody tr')].map((tr) => {
      const tds = [...tr.querySelectorAll('td')]
      const attempt = Number((tds[0]?.textContent || '').replace(/[^0-9]/g, ''))
      const submittedAt = (tds[1]?.textContent || '').trim()
      const status = (tds[3]?.textContent || '').trim()
      const scoreTitle = tds[4]?.getAttribute('title') || tds[4]?.textContent || ''
      const score = Number(String(scoreTitle).replace(/[^0-9.]/g, ''))
      return {
        attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : undefined,
        status,
        score: String(scoreTitle).trim() && Number.isFinite(score) ? score : null,
        submittedAt,
        hasContinue: !!tr.querySelector('a[href*="continuation.aspx"]'),
        hasHistoryView: !!tr.querySelector('a[href*="history.aspx"]'),
        historyHref: tr.querySelector('a[href*="history.aspx"]')?.getAttribute('href') || '',
      }
    })
  }, SEL.historyTable)
}

export { newestGraded, readHistory }
