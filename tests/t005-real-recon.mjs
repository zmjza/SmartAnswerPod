import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'patchright'
import {
  ensureNoqrHomeReady,
  ensureNoqrSession,
  NoqrNetworkActivity,
  NoqrSessionError,
} from '../electron/noqr/session.ts'
import {
  openNoqrCourseWork,
  readNoqrCourseMenu,
  switchNoqrCourse,
  waitForNoqrCourseWorkReady,
} from '../electron/noqr/course.ts'
import {
  openNoqrHomework,
  readNoqrHomeworks,
} from '../electron/noqr/homework.ts'
import { waitForNoqrAnswerReady } from '../electron/noqr/answer.ts'
import { readNoqrQuestionGroup } from '../electron/noqr/question.ts'
import { NOQR_API, NOQR_PATH } from '../electron/noqr/selectors.ts'
import {
  T005_DEFAULT_GOAL_FILE,
  T005CredentialError,
  applyT005RuntimeConfig,
  readT005Credentials,
  selectT005Account,
  summarizeT005Credentials,
} from './helpers/t005-credentials.mjs'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function safePath(value) {
  try {
    return new URL(value).pathname
  } catch {
    return ''
  }
}

function queryNames(value) {
  try {
    return [...new URL(value).searchParams.keys()]
  } catch {
    return []
  }
}

function safeEnumQuery(value, name) {
  try {
    const raw = new URL(value).searchParams.get(name) || ''
    return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(raw) ? raw : ''
  } catch {
    return ''
  }
}

async function withTechnicalTimeout(task, message, ms) {
  let timer
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readHistoryProbe(page, homework) {
  const requests = []
  const responses = []
  let responseObject = null
  let resolveResponse
  const responseSeen = new Promise((resolve) => { resolveResponse = resolve })
  const requestListener = (request) => {
    if (request.method() !== 'GET') return
    if (!safePath(request.url()).endsWith(NOQR_API.history)) return
    requests.push({ url: request.url(), queryNames: queryNames(request.url()) })
  }
  const responseListener = (response) => {
    if (!safePath(response.url()).endsWith(NOQR_API.history)) return
    responses.push({
      status: response.status(),
      queryNames: queryNames(response.url()),
    })
    responseObject = response
    resolveResponse()
  }
  page.on('request', requestListener)
  page.on('response', responseListener)
  let opened = false
  try {
    await openNoqrHomework(page, homework, 'record', {
      onWaiting: () => undefined,
    })
    opened = true
    await Promise.race([responseSeen, new Promise((resolve) => setTimeout(resolve, 60_000))])
    const recordPage = new URL(page.url())
    let historyFieldNames = []
    let historyMarkedStates = []
    if (responseObject) {
      const text = await responseObject.text().catch(() => '')
      try {
        const payload = JSON.parse(text)
        const findArray = (value) => Array.isArray(value)
          ? value
          : value && typeof value === 'object'
            ? ['result', 'data', 'items', 'records', 'list'].map((key) => findArray(value[key])).find(Boolean) || null
            : null
        const rows = findArray(payload) || []
        historyFieldNames = rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).sort() : []
        historyMarkedStates = rows.map((row) => row && (row.isMarked === true || row.isMarked === 1 || row.isMarked === '1' || row.isMarked === 'true'))
      } catch { /* ignore response body for recon */ }
    }
    return {
      opened,
      requestCount: requests.length,
      responseCount: responses.length,
      requestQueryNames: requests.flatMap((item) => item.queryNames).filter((v, i, a) => a.indexOf(v) === i),
      statuses: responses.map((item) => item.status),
      historyFieldNames,
      historyMarkedStates,
      responseWaitMs: 60_000,
      recordDomCount: await page.locator('.record-item').count(),
      recordParams: [...recordPage.searchParams.keys()],
      idMatchesRecordWorkId: (() => {
        const recordWorkId = recordPage.searchParams.get('workId') || ''
        const firstRequestUrl = requests[0]?.url
        if (!recordWorkId || !firstRequestUrl) return null
        return new URL(firstRequestUrl).searchParams.get('id') === recordWorkId
      })(),
    }
  } finally {
    page.off('request', requestListener)
    page.off('response', responseListener)
    if (opened) {
      await page.locator('.van-nav-bar__left').first().click().catch(() => {})
      await waitForNoqrCourseWorkReady(page, { refreshBudget: 3 }).catch(() => {})
    }
  }
}

async function domSignals(page) {
  return page.evaluate(() => {
    const count = (selector) => document.querySelectorAll(selector).length
    const idAttributes = new Set()
    for (const node of document.querySelectorAll('*')) {
      for (const attribute of node.getAttributeNames()) {
        if (/(?:^|[-_])(?:id|flag|unique)$/i.test(attribute) || /(?:id|flag|unique)/i.test(attribute)) {
          idAttributes.add(attribute)
        }
      }
    }
    return {
      counts: {
        questionInfo: count('.question-info'),
        questionTitle: count('.question-title'),
        questionOptions: count('.question-options'),
        optionItem: count('.option-item'),
        radio: count('.option-item[role="radio"]'),
        checkbox: count('.option-item[role="checkbox"]'),
        subQuestions: count('.sub-questions > .sub-item'),
        picker: count('input[name="picker"]'),
        skeleton: count('.skeleton-area.van-skeleton'),
      },
      idAttributeNames: [...idAttributes].sort(),
      urlQueryNames: [...new URL(location.href).searchParams.keys()],
    }
  })
}

function parseOptions(argv) {
  const options = { preflight: false, accountAlias: 'NOQR-01' }
  for (const arg of argv) {
    if (arg === '--preflight') {
      options.preflight = true
      continue
    }
    if (arg.startsWith('--account=')) {
      options.accountAlias = arg.slice('--account='.length).trim()
      continue
    }
    throw new T005CredentialError('cli_invalid', 'Unknown or invalid read-only recon option')
  }
  return options
}

function safeErrorText(error) {
  if (error instanceof T005CredentialError) return error.message
  if (error instanceof NoqrSessionError) return `${error.code}: ${error.message}`.slice(0, 240)
  return error instanceof Error ? error.name : 'UnknownError'
}

async function main(options, credentials) {
  const account = selectT005Account(credentials, options.accountAlias)
  const profileRoot = join(PROJECT_ROOT, '.playwright')
  mkdirSync(profileRoot, { recursive: true })
  const userDataDir = mkdtempSync(join(profileRoot, 't005-recon-'))
  const startedAt = Date.now()
  const bundled = chromium.executablePath()
  const executablePath = existsSync(bundled)
    ? bundled
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled', '--hide-crash-restore-bubble'],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  // Chromium has already launched, so the test-process key is not inherited by the browser.
  const restoreRuntimeConfig = applyT005RuntimeConfig(credentials, process.env)
  process.once('exit', restoreRuntimeConfig)
  const page = context.pages()[0] || await context.newPage()
  const pageTicker = setInterval(() => {
    void page.evaluate(() => ({
      path: location.pathname,
      bodyLength: (document.body?.innerText || '').replace(/\s+/g, '').length,
      homeMenuItems: document.querySelectorAll('.menu-items').length,
      navTitle: document.querySelectorAll('.van-nav-bar__title').length,
      courseMenuItems: document.querySelectorAll('.van-popover__action.top-pop-item').length,
      workItems: document.querySelectorAll('.work-item').length,
      skeletons: document.querySelectorAll('.skeleton-area.van-skeleton').length,
      questionInfo: document.querySelectorAll('.question-info').length,
      recordItems: document.querySelectorAll('.record-item').length,
    })).then((state) => console.log(JSON.stringify({ phase: 'page-tick', elapsedMs: Date.now() - startedAt, ...state }))).catch(() => {})
  }, 10_000)
  const report = {
    accountAlias: account.alias,
    login: null,
    homeSelectors: null,
    courses: null,
    homeworks: null,
    history: null,
    answer: null,
    mismatches: [],
  }
  try {
    const loginResponses = []
    const loginListener = (response) => {
      if (response.request().method() !== 'POST') return
      if (!/login|auth|token|signin/i.test(response.url())) return
      loginResponses.push({ path: safePath(response.url()), status: response.status() })
    }
    page.on('response', loginListener)
    let lastProgressSecond = -1
    const login = await ensureNoqrSession(page, {
      username: account.username,
      password: account.password,
      onPhase: (phase) => console.log(JSON.stringify({ phase, elapsedMs: Date.now() - startedAt })),
      onWaiting: (elapsed) => {
        const second = Math.floor(elapsed / 1000)
        if (second < lastProgressSecond + 10 && lastProgressSecond >= 0) return
        lastProgressSecond = second
        void page.evaluate(() => ({
          path: location.pathname,
          title: document.title,
          usernameInputs: document.querySelectorAll('input[name="用户名"]').length,
          passwordInputs: document.querySelectorAll('input[name="密码"]').length,
          loading: /加载中/.test(document.body?.innerText || ''),
          bodyLength: (document.body?.innerText || '').replace(/\s+/g, '').length,
        })).then((state) => console.log(JSON.stringify({ phase: 'login-wait', second, ...state }))).catch(() => {})
      },
    })
    await ensureNoqrHomeReady(page, { refreshBudget: 3 })
    page.off('response', loginListener)
    report.login = {
      reused: login.reused,
      loginFormDisappeared: await page.locator('input[name="用户名"]').count() === 0,
      homeMenuItems: await page.locator('.menu-items').count(),
      courseCards: await page.locator('.course-card').count(),
      responseCount: loginResponses.length,
      responseStatuses: loginResponses.map((item) => item.status),
      elapsedMs: login.elapsedMs,
    }

    await openNoqrCourseWork(page, { refreshBudget: 3 })
    report.homeSelectors = {
      urlQueryNames: queryNames(page.url()),
      navTitle: await page.locator('.van-nav-bar__title').count(),
      menuTrigger: await page.locator('.van-nav-bar__right .van-popover__wrapper').count(),
      workItem: await page.locator('.work-item').count(),
    }
    const courses = await readNoqrCourseMenu(page)
    report.courses = {
      count: courses.length,
      sameNameCount: courses.length - new Set(courses.map((course) => course.name)).size,
      activeCount: courses.filter((course) => course.current).length,
      selectors: {
        items: '.van-popover__action.top-pop-item',
        active: '.top-pop-active',
      },
    }
    console.log(JSON.stringify({ phase: 'course-scan-start', courseCount: courses.length }))
    const orderedCourses = [...courses].sort((a, b) => Number(b.current) - Number(a.current))
    for (const course of orderedCourses) {
      try {
        let lastSwitchSecond = -1
        console.log(JSON.stringify({ phase: 'course-switch-start', order: course.order, current: course.current }))
        await switchNoqrCourse(page, course, {
          refreshBudget: 3,
          onWaiting: (elapsed) => {
            const second = Math.floor(elapsed / 1000)
            if (second < lastSwitchSecond + 10 && lastSwitchSecond >= 0) return
            lastSwitchSecond = second
            console.log(JSON.stringify({ phase: 'course-switch-wait', order: course.order, second }))
          },
        })
        console.log(JSON.stringify({ phase: 'course-switch-ready', order: course.order }))
        const list = await readNoqrHomeworks(page, { refreshBudget: 3 })
        console.log(JSON.stringify({ phase: 'course-homeworks', order: course.order, count: list.length }))
        if (!list.length) continue
        report.homeworks = {
          courseOrder: course.order,
          count: list.length,
          onlineWorkCount: list.filter((item) => item.workType === 'onlineWork').length,
          unlimitedCount: list.filter((item) => /无限制|不限/.test(item.attemptsText)).length,
          recordButtonCount: list.filter((item) => item.recordEnabled).length,
          fields: {
            title: await page.locator('.work-title').count(),
            type: await page.locator('.work-type').count(),
            info: await page.locator('.work-info').count(),
            buttons: await page.locator('.work-btns .btn-item').count(),
          },
        }
        const target = list.find((item) => item.workType === 'onlineWork' && item.startEnabled && /无限制|不限/.test(item.attemptsText))
          || list.find((item) => item.workType === 'onlineWork' && item.startEnabled)
        if (!target) continue
        if (target.recordEnabled) report.history = await readHistoryProbe(page, target)
        const network = new NoqrNetworkActivity(page)
        try {
          await openNoqrHomework(page, target, 'start', {
            onWaiting: () => undefined,
          })
          let reentries = 0
          await waitForNoqrAnswerReady({
            page,
            stopRequested: () => false,
            network,
            maxReentries: 2,
            reenter: async () => {
              reentries++
              await page.locator('.van-nav-bar__left').first().click()
              await waitForNoqrCourseWorkReady(page, { refreshBudget: 3 })
              await openNoqrHomework(page, target, 'start', { onWaiting: () => undefined })
            },
          })
          const group = await readNoqrQuestionGroup(page)
          const dom = await domSignals(page)
          report.answer = {
            reentries,
            readOk: group.ok,
            kind: group.ok ? group.group.kind : null,
            position: group.ok ? group.group.position || null : null,
            total: group.ok ? group.group.total || null : null,
            unitCount: group.ok ? group.group.units.length : null,
            optionCounts: group.ok ? group.group.units.map((unit) => unit.options.length) : [],
            subQuestionCount: dom.counts.subQuestions,
            pickerCount: dom.counts.picker,
            audioPresent: group.ok ? Boolean(group.group.audioUrl) : false,
            urlQueryNames: dom.urlQueryNames,
            domIdAttributeNames: dom.idAttributeNames,
            selectors: {
              questionInfo: dom.counts.questionInfo,
              optionItem: dom.counts.optionItem,
              radio: dom.counts.radio,
              checkbox: dom.counts.checkbox,
            },
          }
          if (!group.ok) report.mismatches.push('首题结构未能按页面契约读取')
          if (dom.counts.questionInfo !== 1) report.mismatches.push('question-info 数量不是 1')
          if (!dom.urlQueryNames.includes('workId') || !dom.urlQueryNames.includes('courseId') || !dom.urlQueryNames.includes('workType')) {
            report.mismatches.push('答题 URL 缺少已记录参数名')
          }
          if (!dom.idAttributeNames.length) report.mismatches.push('答题 DOM 未发现 id/flag/unique 属性名')
          break
        } finally {
          network.dispose()
        }
      } catch (error) {
        const message = safeErrorText(error)
        report.mismatches.push(`课程 ${course.order} 只读切换失败：${message}`)
        console.log(JSON.stringify({ phase: 'course-isolated', order: course.order }))
        try {
          const answerPath = safePath(page.url()).replace(/\/+$/, '')
          if (answerPath === NOQR_PATH.answer) {
            let answerWaitError = ''
            const answerNetwork = new NoqrNetworkActivity(page)
            try {
              await waitForNoqrAnswerReady({
                page,
                stopRequested: () => false,
                network: answerNetwork,
                maxReentries: 0,
                reenter: async () => undefined,
              })
            } catch (waitError) {
              answerWaitError = safeErrorText(waitError)
            } finally {
              answerNetwork.dispose()
            }
            const group = await readNoqrQuestionGroup(page)
            const dom = await domSignals(page)
            report.answer = {
              openError: message,
              waitError: answerWaitError,
              workType: safeEnumQuery(page.url(), 'workType'),
              readOk: group.ok,
              kind: group.ok ? group.group.kind : null,
              position: group.ok ? group.group.position || null : null,
              total: group.ok ? group.group.total || null : null,
              unitCount: group.ok ? group.group.units.length : null,
              optionCounts: group.ok ? group.group.units.map((unit) => unit.options.length) : [],
              subQuestionCount: dom.counts.subQuestions,
              pickerCount: dom.counts.picker,
              audioPresent: group.ok ? Boolean(group.group.audioUrl) : false,
              urlQueryNames: dom.urlQueryNames,
              domIdAttributeNames: dom.idAttributeNames,
            }
            break
          }
        } catch { /* keep the original isolated failure */ }
        await waitForNoqrCourseWorkReady(page, { refreshBudget: 3 }).catch(() => {})
      }
    }
    if (!report.homeworks) report.mismatches.push('未找到可只读启动的在线作业')
    report.elapsedMs = Date.now() - startedAt
    console.log(JSON.stringify(report, null, 2))
  } finally {
    clearInterval(pageTicker)
    await context.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    restoreRuntimeConfig()
    process.removeListener('exit', restoreRuntimeConfig)
  }
}

async function entry() {
  const options = parseOptions(process.argv.slice(2))
  const goalFile = process.env.T005_GOAL_FILE || T005_DEFAULT_GOAL_FILE
  const credentials = readT005Credentials(goalFile)
  if (options.preflight) {
    console.log(JSON.stringify({
      ok: true,
      phase: 'preflight',
      ...summarizeT005Credentials(credentials, options.accountAlias),
    }))
    return
  }
  await main(options, credentials)
}

entry().catch((error) => {
  const code = error instanceof T005CredentialError ? error.code : 'recon_failed'
  console.error(JSON.stringify({ ok: false, code, error: safeErrorText(error) }))
  process.exitCode = 1
})
