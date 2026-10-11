import type { Page, JSHandle } from 'patchright'
import { createHash } from 'node:crypto'
import { PATH, SEL, learningCenterVersion, prepareNewLearningCenter, checkOldLearningCenter } from './core/selectors'
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

export const UNSUPPORTED_COURSE_REASON = '新答题界面暂时不支持，等后续开发'
export type ListedCourse = { name: string; href: string; key: string; unsupportedReason?: string }

function courseKey(href: string): string {
  const url = new URL(href, 'https://l.shou.org.cn')
  const param = (name: string) => [...url.searchParams].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || ''
  const id = param('courseOpenId')
  return id ? `course:${id}:${param('minorCourseOpenId')}` : `href:${createHash('sha256').update(url.pathname + url.search).digest('hex')}`
}

export async function listCourses(page: Page, local_id: string, slot: SlotState, signal?: AbortSignal): Promise<ListedCourse[]> {
  signal?.throwIfAborted()
  const version = learningCenterVersion(page)
  if (version === 'new') {
    await prepareNewLearningCenter(page, signal)
    const out = await listNewCourses(page, signal)
    signal?.throwIfAborted()
    emitProgress({ local_id, slot, account: 'courses_listed', action: '已列出课程 ' + out.length, courseTotal: out.length, bankCount: 0, aiCount: 0 })
    return out
  }
  if (version !== 'old') throw new Error('未知学习中心页面')
  emitProgress({ local_id, slot, account: 'scanning_courses', action: '确认我的课程', bankCount: 0, aiCount: 0, click: 'tab-courseList' })
  const tab = page.locator(SEL.tabCourseList)
  if (!(await tab.getAttribute('class') || '').includes('is-active')) {
    await tab.click()
  }
  await checkOldLearningCenter(page)
  await page.locator(SEL.courseItem).first().waitFor({ timeout: 15000 }).catch(() => {})
  await checkOldLearningCenter(page)
  const out: ListedCourse[] = []
  const seen = new Set<string>()
  const sources = [
    { items: page.locator('.box-card .el-card__body .el-tabs__content > .course-item'), pinned: true },
    { items: page.locator(SEL.courseItem), pinned: false },
  ]
  for (const { items, pinned } of sources) {
    const n = await items.count()
    for (let i = 0; i < n; i++) {
      signal?.throwIfAborted()
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
  signal?.throwIfAborted()
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

function schoolCourseUrl(href: string, pathname: string): URL {
  const url = new URL(href, 'https://' + PATH.studyHost)
  const names = [...url.searchParams.keys()].map((key) => key.toLowerCase())
  if (url.protocol !== 'https:' || url.hostname !== PATH.studyHost || url.pathname.toLowerCase() !== pathname.toLowerCase() ||
    !names.includes('courseopenid') || !names.includes('minorcourseopenid') || ![...url.searchParams].find(([key]) => key.toLowerCase() === 'courseopenid')?.[1]) {
    throw new Error('形考入口主机、路径或课程参数无效')
  }
  return url
}

async function waitNewTasks(page: Page, ref: string, name: string, filter: string, signal?: AbortSignal,
  previousEmbed?: JSHandle<{ frame: HTMLIFrameElement | null; src: string; ref: string }>) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const state = await page.evaluate(({ ref, name, filter, space, card, tasks, previousEmbed }) => {
      const active = [...document.querySelectorAll(card)].find((node) => node.getAttribute('data-learning-course-ref') === ref && node.getAttribute('data-learning-course-card-active') === 'true')
      const root = document.querySelector(space)
      if (!root) return 'loading'
      const text = root.textContent || ''
      const failed = /加载失败|读取失败|发生错误/.test(text) || root.querySelector('[role="alert"]')
      const loading = /正在加载课程学习空间|加载中/.test(text)
      const region = root.querySelector(tasks)
      if (active && !region) {
        const frames = root.querySelectorAll('iframe')
        const links = root.querySelectorAll('a')
        const frame = frames[0]
        const link = links[0]
        if (frames.length === 1 && links.length === 1 && frame.title === '课程学习空间' && link.target === '_blank' && (link.textContent || '').trim() === '在新窗口打开' && frame.src === link.href) {
          const url = new URL(frame.src)
          // 切课加载时可能保留上一课 iframe，只有新节点或新 src 才属于本次切课。
          const currentEmbed = previousEmbed && (previousEmbed.ref === ref || frame !== previousEmbed.frame || frame.src !== previousEmbed.src)
          if (previousEmbed && !currentEmbed && (loading || failed)) return 'loading'
          if ((currentEmbed || (!loading && !failed)) && url.protocol === 'https:' && !url.username && !url.password && url.hostname !== 'shou.org.cn' && !url.hostname.endsWith('.shou.org.cn')) return 'unsupported'
        }
      }
      if (failed) return 'error'
      if (loading) return 'loading'
      const outer = region && [...region.querySelectorAll('div[aria-label]')].find((node) => node.getAttribute('aria-label') === name + ' 课程任务' && !node.hasAttribute('role'))
      const selected = !filter || root.querySelector('button[data-figma-segmented-tab-key="' + filter + '"][aria-pressed="true"]')
      const currentFilter = filter || root.querySelector('button[data-figma-segmented-tab-key][aria-pressed="true"]')?.getAttribute('data-figma-segmented-tab-key') || ''
      const emptyLabel = ({ active: '进行中', completed: '已完成', overdue: '已逾期' } as Record<string, string>)[currentFilter]
      const contentReady = outer && (outer.querySelector('[role="list"] [role="listitem"]') || (emptyLabel && (outer.textContent || '').includes('暂无' + emptyLabel + '的课程任务')))
      return active && outer && selected && contentReady ? 'ready' : 'loading'
    }, { ref, name, filter, space: SEL.learningSpace, card: SEL.learningCard, tasks: SEL.learningTasks, previousEmbed })
    if (state === 'ready' || state === 'unsupported') return state
    if (state === 'error') throw new Error('课程任务加载失败')
    await page.waitForTimeout(100)
  }
  throw new Error('对应课程任务未就绪')
}

async function listNewCourses(page: Page, signal?: AbortSignal): Promise<ListedCourse[]> {
  const cards = await page.locator(SEL.learningCourses).locator(SEL.learningCard).evaluateAll((nodes) => nodes.map((node) => ({
    ref: node.getAttribute('data-learning-course-ref') || '',
    name: (node.querySelector('h3')?.textContent || '').replace(/\s+/g, ' ').trim(),
  })))
  const out: ListedCourse[] = []
  const seen = new Set<string>()
  const refs = new Set<string>()
  for (const { ref, name } of cards) {
    signal?.throwIfAborted()
    if (!ref || !name || refs.has(ref)) throw new Error('新版课程卡片身份不可读取')
    refs.add(ref)
    const matching = page.locator(SEL.learningCourses).locator(SEL.learningCard + `[data-learning-course-ref=${JSON.stringify(ref)}]`)
    const previousEmbed = await page.evaluateHandle(({ space, card }) => {
      const frame = document.querySelector(space)?.querySelector('iframe') || null
      const ref = document.querySelector(card + '[data-learning-course-card-active="true"]')?.getAttribute('data-learning-course-ref') || ''
      return { frame, src: frame?.src || '', ref }
    }, { space: SEL.learningSpace, card: SEL.learningCard })
    let taskState: string
    try {
      const alreadyActive = await matching.getAttribute('data-learning-course-card-active') === 'true'
      await matching.locator('button[aria-label^="切换课程："]').evaluateAll((buttons, { courseName, alreadyActive }) => {
        const button = buttons[0]
        if (buttons.length !== 1 || !(button instanceof HTMLButtonElement) || button.disabled || button.getAttribute('aria-label') !== '切换课程：' + courseName) {
          throw new Error('课程切换按钮不可用')
        }
        // 学校切课按钮是无可视面积的辅助按钮，只触发当前课程的展示切换。
        if (!alreadyActive) button.click()
      }, { courseName: name, alreadyActive })
      taskState = await waitNewTasks(page, ref, name, '', signal, previousEmbed)
    } finally { await previousEmbed.dispose() }
    if (taskState === 'unsupported') {
      out.push({ name, href: '', key: 'unsupported:' + createHash('sha256').update(ref).digest('hex'), unsupportedReason: UNSUPPORTED_COURSE_REASON })
      continue
    }
    const space = page.locator(SEL.learningSpace)
    let found = false
    for (const filter of ['active', 'completed', 'overdue']) {
      signal?.throwIfAborted()
      const filterButton = space.locator(`button[data-figma-segmented-tab-key="${filter}"]`)
      if (await filterButton.getAttribute('aria-pressed') !== 'true') await filterButton.click()
      await waitNewTasks(page, ref, name, filter, signal)
      const container = space.locator(SEL.learningTasks).locator(`div[aria-label=${JSON.stringify(name + ' 课程任务')}]:not([role])`)
      const button = container.locator(SEL.learningHomework)
      if (!(await button.count())) continue
      const details = space.locator('a').filter({ hasText: '查看更多课程详情' })
      if (await details.count() !== 1) throw new Error('缺少当前课程目录链接')
      const catalog = schoolCourseUrl((await details.getAttribute('href')) || '', PATH.catalog)
      signal?.throwIfAborted()
      let popup: Page | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let receive: (opened: Page) => void = () => {}
      let abort: () => void = () => {}
      try {
        const pending = new Promise<Page>((resolve, reject) => {
          receive = (opened) => { popup = opened; resolve(opened) }
          abort = () => {
            void popup?.close().catch(() => {})
            reject(signal?.reason || new Error('任务已停止'))
          }
          page.once('popup', receive)
          signal?.addEventListener('abort', abort, { once: true })
          timer = setTimeout(() => reject(new Error('形考跳转未打开')), 20000)
        })
        const [opened] = await Promise.all([pending, button.click()])
        popup = opened
        signal?.throwIfAborted()
        await popup.waitForURL((url) => url.hostname === PATH.studyHost && url.pathname.toLowerCase() === PATH.homeworkList.toLowerCase(), { timeout: 20000, waitUntil: 'domcontentloaded' })
        await popup.waitForLoadState('domcontentloaded')
        signal?.throwIfAborted()
        const url = schoolCourseUrl(popup.url(), PATH.homeworkList)
        const key = courseKey(url.href)
        if (key !== courseKey(catalog.href)) throw new Error('形考跳转与当前课程身份不匹配')
        if (!seen.has(key)) { seen.add(key); out.push({ name, href: popup.url(), key }) }
        found = true
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof Error && error.name === 'TimeoutError') throw new Error('形考跳转未打开或未就绪')
        throw error
      } finally {
        clearTimeout(timer)
        page.off('popup', receive)
        signal?.removeEventListener('abort', abort)
        await popup?.close().catch(() => {})
      }
      break
    }
    if (!found) throw new Error('当前课程缺少形考作业入口')
  }
  return out
}

async function sectionEmpty(page: Page, id: '#onlineHomework' | '#phasedTest', title: string): Promise<boolean> {
  const html = await page.content()
  if (html.includes(title + SEL.noDataMarker)) return true
  const box = page.locator(id)
  if ((await box.count()) === 0) throw new Error('形考作业列表读取失败')
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
  signal?: AbortSignal
}): Promise<DetectedCourse> {
  const { portal, href, key, courseName, local_id, slot, index, total, mode = 'answer', answerRoundLimit = 10, signal } = opts
  signal?.throwIfAborted()
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
  const entry = new URL(abs)
  if (entry.protocol !== 'https:' || entry.hostname !== PATH.studyHost || ![PATH.catalog.toLowerCase(), PATH.homeworkList.toLowerCase()].includes(entry.pathname.toLowerCase())) {
    throw new Error('课程检测入口主机或路径无效')
  }
  const ctx = portal.context()
  const coursePage = await ctx.newPage()
  const previews = new Set<Page>()
  let complete = false
  try {
    signal?.throwIfAborted()
    await coursePage.goto(abs, { waitUntil: 'domcontentloaded' })
    signal?.throwIfAborted()
    if (new URL(abs).pathname.toLowerCase() !== PATH.homeworkList.toLowerCase()) {
      await coursePage.locator(SEL.courseHomeWork).waitFor({ timeout: 20000 })
      signal?.throwIfAborted()
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
      await coursePage.waitForURL((u) => u.hostname === PATH.studyHost && u.pathname.toLowerCase() === PATH.homeworkList.toLowerCase(), { timeout: 20000 })
    }
    signal?.throwIfAborted()
    const actual = new URL(coursePage.url())
    if (actual.protocol !== 'https:' || actual.hostname !== PATH.studyHost || actual.pathname.toLowerCase() !== PATH.homeworkList.toLowerCase()) {
      throw new Error('形考列表主机或路径无效')
    }
    if (key.startsWith('course:') && courseKey(actual.href) !== key) throw new Error('形考列表与当前课程身份不匹配')
    const emptyOnline = await sectionEmpty(coursePage, SEL.onlineHomework, '网上记分作业列表')
    const emptyPhased = await sectionEmpty(coursePage, SEL.phasedTest, '阶段性测验')
    let homeworks: DetectedHomework[] = []
    if (!emptyOnline) homeworks = homeworks.concat(await parseSection(coursePage, SEL.onlineHomework, 'onlineHomework', answerRoundLimit))
    if (!emptyPhased) homeworks = homeworks.concat(await parseSection(coursePage, SEL.phasedTest, 'phasedTest', answerRoundLimit))
    if (emptyOnline && emptyPhased) {
      complete = true
      return { key, name: courseName, status: '无作业', homeworks: [] }
    }
    for (const hw of homeworks) {
      signal?.throwIfAborted()
      if (!hw.previewHref) {
        hw.status = 'skip_no_history'
        continue
      }
      if (!shouldInspectHistory(hw, mode)) continue
      hw.status = 'previewing'
      const preview = await ctx.newPage()
      previews.add(preview)
      try {
        signal?.throwIfAborted()
        const ph = hw.previewHref.startsWith('http') ? hw.previewHref : 'https://l.shou.org.cn' + hw.previewHref
        await preview.goto(ph, { waitUntil: 'domcontentloaded' })
        signal?.throwIfAborted()
        const hist = await readHistory(preview)
        signal?.throwIfAborted()
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
        signal?.throwIfAborted()
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
    complete = true
    return { key, name: courseName, status: '已检测', homeworks }
  } finally {
    await coursePage.close().catch(() => {})
    if (!complete) await Promise.all([...previews].map((preview) => preview.close().catch(() => {})))
  }
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
