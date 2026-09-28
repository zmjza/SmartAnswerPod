import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { _electron as electron, chromium } from 'patchright'
import { contentHash, normalizeStem, normalizeOption, sameAnswerTexts } from '../electron/core/hash.ts'
import { SEL } from '../electron/core/selectors.ts'
import { normalizeGoalText, parseGoalAccounts } from './helpers/goal-accounts.mjs'
import { isFinishedExtractJobStatus } from './helpers/extract-status.mjs'

// Exercise the real preload and main-process modules; never print credentials.
const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
const keepProductWindow = process.env.KAIDA_KEEP_OPEN === '1'
const holdProductWindowOnFailure = (reason) => {
  console.error(reason instanceof Error ? reason.stack || reason.message : reason)
  if (keepProductWindow) void new Promise(() => {})
  else process.exitCode = 1
}
process.on('uncaughtException', holdProductWindowOnFailure)
process.on('unhandledRejection', holdProductWindowOnFailure)
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
const inRenderer = (fn) => app.evaluate(({ BrowserWindow }, source) =>
  BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('(' + source + ')()'), fn.toString())
const rendererSource = (source) => app.evaluate(({ BrowserWindow }, script) =>
  BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
let goalTargetIds = []
if (process.env.KAIDA_GOAL_FILE) {
  const text = readFileSync(process.env.KAIDA_GOAL_FILE, 'utf8')
  const parsedAccounts = parseGoalAccounts(text)
  const accountLimit = Math.max(0, Number(process.env.KAIDA_ACCOUNT_LIMIT) || 0)
  const accounts = accountLimit ? parsedAccounts.slice(0, accountLimit) : parsedAccounts
  const normalizedText = normalizeGoalText(text)
  const settings = {
    supabase_url: normalizedText.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0],
    supabase_anon: normalizedText.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0],
    siliconflow_key: normalizedText.match(/sk-[A-Za-z0-9]+/)?.[0],
    account_parallel: Math.min(8, Math.max(1, Number(process.env.KAIDA_ACCOUNT_PARALLEL) || 2)), course_parallel: 2, browser_visible_default: true,
  }
  assert.ok(accounts.length && settings.supabase_anon && settings.siliconflow_key, '目标凭据字段不完整')
  const plan = await app.evaluate(async ({ app, safeStorage }, desired) => {
    const { readFileSync, existsSync } = process.getBuiltinModule('fs')
    const { join } = process.getBuiltinModule('path')
    const file = join(app.getPath('userData'), 'kaida-store.bin')
    let stored = []
    if (existsSync(file)) {
      try { stored = JSON.parse(safeStorage.decryptString(readFileSync(file))).accounts || [] } catch {
        stored = []
      }
    }
    return {
      ids: desired.map((row) => stored.find((old) => old.username === row.username)?.local_id || null),
      obsolete: stored.filter((old) => !desired.some((row) => row.username === old.username))
        .map((old) => ({ id: old.local_id, testOwned: /^测试学生\d+$/.test(old.name) })),
    }
  }, accounts)
  const outcome = await app.evaluate(async ({ BrowserWindow }, payload) => {
    return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      '(async (payload) => { ' +
      'const saved = await window.kaida.saveSettings(payload.settings); if (!saved.ok) return { ok: false }; ' +
      'for (let i = 0; i < payload.accounts.length; i++) { const row = payload.accounts[i]; const id = payload.plan.ids[i]; ' +
      'const r = id ? await window.kaida.updateAccount(id, { password: row.password }) : await window.kaida.addAccount(row); ' +
      'if (!r.ok) return { ok: false }; } return { ok: true }; })(' + JSON.stringify(payload) + ')')
  }, { accounts, settings, plan })
  assert.ok(outcome.ok, '加密保存未成功')
  const verified = await app.evaluate(async ({ app, safeStorage }, desired) => {
    const { readFileSync } = process.getBuiltinModule('fs')
    const { join } = process.getBuiltinModule('path')
    const stored = JSON.parse(safeStorage.decryptString(readFileSync(join(app.getPath('userData'), 'kaida-store.bin')))).accounts
    return desired.every((row) =>
      stored.some((old) => old.username === row.username && old.password === row.password))
  }, accounts)
  assert.ok(verified, '保存后目标账号不一致，禁止运行')
  const targetMasks = accounts.map((row) => row.username.length >= 8 ? row.username.slice(0, 4) + '****' + row.username.slice(-4) : '****')
  goalTargetIds = await app.evaluate(async ({ BrowserWindow }, masks) => {
    return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      '(async (masks) => (await window.kaida.listAccounts()).filter((row) => masks.includes(row.account)).map((row) => row.local_id))(' +
      JSON.stringify(masks) + ')')
  }, targetMasks)
  assert.equal(goalTargetIds.length, accounts.length, '目标账号没有全部保存，禁止运行')
  console.log('goal-accounts-verified', { count: accounts.length, profilesRetained: plan.ids.filter(Boolean).length })
}
// Read-only course census: reuse current encrypted accounts' profiles, never start assignments.
if (process.env.KAIDA_COURSE_PROBE === '1') {
  const profiles = await app.evaluate(({ app, safeStorage }) => {
    const { readFileSync } = process.getBuiltinModule('fs')
    const { join } = process.getBuiltinModule('path')
    const stored = JSON.parse(safeStorage.decryptString(readFileSync(join(app.getPath('userData'), 'kaida-store.bin'))))
    return stored.accounts.map((account) => join(app.getPath('userData'), 'pw-profiles', account.local_id))
  })
  try {
    for (const [index, profile] of profiles.entries()) {
      const context = await chromium.launchPersistentContext(profile, { headless: false })
      try {
        const portal = await context.newPage()
        await portal.goto('https://learning.shou.org.cn/scenter', { waitUntil: 'domcontentloaded' })
        const ready = await portal.locator(SEL.tabCourseList).waitFor({ timeout: 20000 }).then(() => true, () => false)
        if (!ready) {
          console.log('course-probe', { index, ready: false, reason: '课程入口未出现，需要核查登录态' })
          if (process.env.KAIDA_COURSE_WAIT === '1' && index === 0) {
            console.log('course-probe-waiting', { index, reason: '请在可视化窗口完成扫码或登录后继续' })
            await new Promise(() => {})
          }
          continue
        }
        await portal.locator(SEL.tabCourseList).click()
        for (const delay of [0, 1000, 2000, 5000]) {
          await portal.waitForTimeout(delay)
          const census = await portal.locator(SEL.paneCourseList).evaluate((pane) => {
            const cards = [...pane.querySelectorAll('.course-item')]
            const links = cards.map((card) => card.querySelector('.course-title a')?.getAttribute('href') || '')
            return { count: cards.length, uniqueLinks: new Set(links).size, missingLinks: links.filter((href) => !href).length,
              controls: [...pane.querySelectorAll('button,[role=button],.el-pagination')].map((el) => ({ tag: el.tagName, className: el.className, text: (el.textContent || '').trim().slice(0, 60) })) }
          })
          console.log('course-probe', { index, delay, ...census })
          await portal.locator(SEL.courseItem).last().scrollIntoViewIfNeeded().catch(() => {})
        }
      } finally { await context.close() }
    }
  } finally { await app.close() }
  process.exit(0)
}
const initial = await inRenderer(async () => {
  const state = await window.kaida.snapshot()
  const accounts = await window.kaida.listAccounts()
  return { count: accounts.length, machine: state.machine, configured: state.settings }
})
console.log('product-started', JSON.stringify(initial))
assert.ok(initial.count > 0, '需要已有加密账号')
if (process.env.KAIDA_WORK_MODE === 'answer' && process.env.KAIDA_ACCOUNT_PARALLEL) {
  assert.equal(initial.configured.account_parallel, Math.min(8, Math.max(1, Number(process.env.KAIDA_ACCOUNT_PARALLEL) || 2)), '产品未加载请求的账号并发配置')
}
const pending = await app.evaluate(({ app, safeStorage }) => {
  const { readFileSync } = process.getBuiltinModule('fs')
  const { join } = process.getBuiltinModule('path')
  const stored = JSON.parse(safeStorage.decryptString(readFileSync(join(app.getPath('userData'), 'kaida-store.bin'))))
  return stored.accounts.map((account, index) => ({
    index,
    pending: stored.writeback.filter((item) => item.local_id === account.local_id).map((item) => ({
      hasHistory: Boolean(item.history_href), candidates: item.candidates?.length || 0,
      insert: item.need_insert_hashes.length, remove: item.need_delete_hashes.length,
      identities: (item.candidates || []).map((candidate) => ({
        hash: candidate.hash.slice(0, 10),
        stemDamaged: candidate.stem.includes(String.fromCodePoint(0xfffd)),
        optionDamaged: candidate.options.some((option) => option.includes(String.fromCodePoint(0xfffd))),
      })),
    })),
  }))
})
console.log('writeback-summary', JSON.stringify(pending))
if (process.env.KAIDA_REVIEW_PROBE === '1') {
  const probe = await app.evaluate(({ app, safeStorage }, selector) => {
    const { readFileSync } = process.getBuiltinModule('fs')
    const { join } = process.getBuiltinModule('path')
    const stored = JSON.parse(safeStorage.decryptString(readFileSync(join(app.getPath('userData'), 'kaida-store.bin'))))
    const eligible = stored.writeback.filter((row) => stored.accounts.some((a) => a.local_id === row.local_id) && row.history_href && row.candidates?.length)
    const item = selector.hash
      ? eligible.find((row) => row.candidates.some((candidate) => candidate.hash.startsWith(selector.hash)))
      : eligible[selector.index]
    return item ? { item, profile: join(app.getPath('userData'), 'pw-profiles', item.local_id) } : null
  }, { index: Number(process.env.KAIDA_REVIEW_INDEX || 0), hash: process.env.KAIDA_REVIEW_HASH || '' })
  assert.ok(probe, '需要可检查的历史记录')
  const context = await chromium.launchPersistentContext(probe.profile, { headless: false })
  try {
    const history = await context.newPage()
    const response = await history.goto(new URL(probe.item.history_href, 'https://l.shou.org.cn').href)
    await history.locator('.e-q-body').first().waitFor({ timeout: 30000 })
    await history.waitForTimeout(1000)
    const production = await history.evaluate((selector) => [...document.querySelectorAll('.e-q-body')].map((b) => ({ type: b.getAttribute('data-questiontype'), stem: b.querySelector('.e-q .e-q-q')?.textContent || '', options: [...b.querySelectorAll(selector)].map((li) => li.textContent || '') })), SEL.reviewedOptions)
    const rows = await history.locator('.e-q-body').evaluateAll((bodies) => bodies.map((body) => ({
      no: body.getAttribute('data-num') || body.querySelector('.e-q-no')?.textContent || '',
      type: body.getAttribute('data-questiontype'),
      structure: [...body.querySelectorAll('.e-q *')].map((e) => e.tagName + '.' + e.className).slice(0, 65),
      stemText: body.querySelector('.e-q-q')?.textContent || '',
      stemInner: body.querySelector('.e-q-q')?.innerText || '',
      optionsText: [...body.querySelectorAll('.e-a-g:is(.e-checking-a, .e-choice-a) li.e-a')].map((li) => li.textContent || ''),
      optionsInner: [...body.querySelectorAll('.e-a-g:is(.e-checking-a, .e-choice-a) li.e-a')].map((li) => li.innerText || ''),
      selected: [...body.querySelectorAll('.e-a-g:is(.e-checking-a, .e-choice-a) li.e-a.checked')].map((li) => li.textContent || ''),
      correct: body.querySelector('.e-q-right') ? true : body.querySelector('.e-q-wrong') ? false : null,
    })))
    const hashes = new Set(probe.item.candidates.map((q) => q.hash))
    console.log('review-structure', rows[0]?.structure)
    const types = { '1': 'single', '2': 'multiple', '3': 'judge' }
    const match = (inner) => rows.filter((q) => types[q.type] && hashes.has(contentHash(types[q.type], inner ? q.stemInner : q.stemText, inner ? q.optionsInner : q.optionsText))).length
    console.log('production-parser', { matches: production.filter((q) => types[q.type] && hashes.has(contentHash(types[q.type], q.stem, q.options))).length, counts: production.slice(0, 2).map((q) => q.options.length) })
    console.log('review-probe', { rows: rows.length, types: [...new Set(rows.map((q) => q.type))], textMatches: match(false), innerMatches: match(true), storedTypes: [...new Set(probe.item.candidates.map((q) => q.qtype))] })
    console.log('review-components', probe.item.candidates.slice(0, 3).map((c) => {
      const row = rows.find((q) => normalizeStem(q.stemInner) === normalizeStem(c.stem))
      const noSpace = rows.find((q) => normalizeStem(q.stemInner).replace(/\s/g, '') === normalizeStem(c.stem).replace(/\s/g, ''))
      const closest = [...rows].sort((a,b) => [...b.stemInner].filter((ch) => c.stem.includes(ch)).length / b.stemInner.length - [...a.stemInner].filter((ch) => c.stem.includes(ch)).length / a.stemInner.length)[0]
      const other = normalizeStem(closest.stemInner)
      const own = normalizeStem(c.stem)
      let prefix = 0; while (prefix < Math.min(other.length, own.length) && other[prefix] === own[prefix]) prefix++
      let suffix = 0; while (suffix < Math.min(other.length, own.length) - prefix && other[other.length - suffix - 1] === own[own.length - suffix - 1]) suffix++
      const differences = { prefix, suffix, stored: [...own.slice(prefix, own.length - suffix)].slice(0, 30).map((ch) => ch.codePointAt(0)), history: [...other.slice(prefix, other.length - suffix)].slice(0, 30).map((ch) => ch.codePointAt(0)) }
      const normalizeTwice = rows.filter((q) => types[q.type] && c.hash === contentHash(types[q.type], normalizeStem(q.stemText), q.optionsText.map((o) => normalizeOption(o, types[q.type])))).length
      const sameOptions = rows.find((q) => types[q.type] === c.qtype && contentHash(c.qtype, '', c.options) === contentHash(c.qtype, '', q.optionsInner))
      const byNo = rows.filter((q) => String(q.no).replace(/\D/g, '') === String(c.no).replace(/\D/g, ''))
      return { hash: c.hash.slice(0, 10), candidateNo: c.no, sameNoCount: byNo.length, sameNoType: byNo[0] ? types[byNo[0].type] === c.qtype : false, sameNoOptions: byNo[0] ? contentHash(c.qtype, '', c.options) === contentHash(c.qtype, '', byNo[0].optionsInner) : false, sameNoSelected: byNo[0] ? sameAnswerTexts(byNo[0].selected, c.selected, c.qtype) : false, sameNoSelectedCount: byNo[0]?.selected.length, sameNoCorrect: byNo[0]?.correct, source: c.source, correct: row?.correct, selectedCount: row?.selected.length, storedSelectedCount: c.selected.length, selectedMatch: row ? sameAnswerTexts(row.selected, c.selected, c.qtype) : false, validStoredHash: c.hash === contentHash(c.qtype, c.stem, c.options), stemMatched: Boolean(row), optionLengths: c.options.map((s) => s.length), historyLengths: row?.optionsInner.map((s) => normalizeOption(s, c.qtype).length), optionsMatched: row?.optionsInner.filter((s) => c.options.includes(normalizeOption(s, c.qtype))).length,
        differences: JSON.stringify(differences), noSpaceMatched: Boolean(noSpace), normalizeTwice, sameOptions: Boolean(sameOptions), storedStemLength: c.stem.length, historyStemLength: sameOptions?.stemInner.length,
        whitespaceOnlyDifference: sameOptions ? normalizeStem(sameOptions.stemInner).replace(/\s/g, '') === normalizeStem(c.stem).replace(/\s/g, '') : false }
    }))
    const reloads = []
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await history.reload({ waitUntil: 'domcontentloaded' })
      await history.locator('.e-q-body').first().waitFor({ timeout: 30000 })
      const state = await history.locator('.e-q-body').evaluateAll((bodies, selector) => {
        const replacement = String.fromCodePoint(0xfffd)
        const rows = bodies.map((body) => ({
          type: body.getAttribute('data-questiontype') || '',
          stem: body.querySelector('.e-q-q')?.textContent || '',
          options: [...body.querySelectorAll(selector)].map((li) => li.textContent || ''),
        }))
        return {
          charset: document.characterSet,
          replacementCount: rows.reduce((sum, row) => sum + [...row.stem, ...row.options].join('').split(replacement).length - 1, 0),
          rows,
        }
      }, SEL.reviewedOptions)
      reloads.push({
        charset: state.charset,
        replacementCount: state.replacementCount,
        exactMatches: state.rows.filter((q) => types[q.type] && hashes.has(contentHash(types[q.type], q.stem, q.options))).length,
      })
    }
    console.log('reload-stability', { contentType: response?.headers()['content-type'] || '', reloads })
  } finally { await context.close(); await app.close() }
  process.exit(0)
}
const workMode = process.env.KAIDA_WORK_MODE === 'extract' ? 'extract' : 'answer'
const displayMode = process.env.KAIDA_DISPLAY_MODE === 'headless' ? 'headless' : 'visual'
const courseScope = process.env.KAIDA_COURSE_SCOPE === 'selected' ? 'selected' : 'all'
const answerRoundLimit = Math.min(10, Math.max(1, Number(process.env.KAIDA_ANSWER_ROUND_LIMIT) || 10))
let displaySamples = 0
let displayMismatches = 0
const sequentialSelected = process.env.KAIDA_SEQUENTIAL_SELECTED === '1' && courseScope === 'selected' && goalTargetIds.length > 1
let selectedRunStarted = false
let sequentialIndex = 0
let currentSequentialId = sequentialSelected ? goalTargetIds[0] : ''
const selectedCourses = new Map()
const waitForUi = async (check, timeout = 30_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('等待可选课程页面状态超时')
}
const selectStudentInUi = async (student) => {
  if ((await page.locator('#student-id').innerText()) === student.studentNo) return
  await page.locator('#student-more button').first().click()
  await page.locator('#student-more .source-popover button').filter({ hasText: student.name }).click()
  await waitForUi(async () => (await page.locator('#student-id').innerText()) === student.studentNo)
}
const chooseCourseInUi = async (student, courseName) => {
  await selectStudentInUi(student)
  const item = page.locator('#course-list .course-item').filter({ hasText: courseName }).first()
  await item.getByText(courseName, { exact: true }).click()
  await waitForUi(async () => {
    const snapshot = await rendererSource('window.kaida.snapshot()')
    return snapshot.students.find((row) => row.local_id === student.local_id)?.selectedCourseNames?.includes(courseName)
  })
}
if (process.env.KAIDA_PRODUCT_RUN === '1') {
  await app.evaluate(async ({ BrowserWindow }, payload) => {
    const source = `(async (payload) => {
      const targetIds = payload.targetIds
      for (const account of await window.kaida.listAccounts()) {
        if (targetIds && !targetIds.includes(account.local_id)) continue
        await window.kaida.setDisplay(account.local_id, payload.displayMode)
        await window.kaida.setWorkMode(account.local_id, payload.mode)
        await window.kaida.setCourseScope(account.local_id, payload.courseScope)
        await window.kaida.setAnswerRoundLimit(account.local_id, payload.answerRoundLimit)
      }
      if (!payload.sequentialSelected) void window.kaida.loginRefresh(targetIds || undefined)
      else void window.kaida.loginRefresh([targetIds[0]])
    })(${JSON.stringify(payload)})`
    return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source)
  }, { mode: workMode, displayMode, courseScope, answerRoundLimit, targetIds: goalTargetIds.length ? goalTargetIds : null, sequentialSelected })
}
let previous = ''
while (app.process().exitCode === null) {
  const status = await inRenderer(async () => {
    const state = await window.kaida.snapshot()
    return {
      running: state.running,
      browsers: state.machine.browsers,
      students: state.students.map((s, index) => ({
        local_id: s.local_id, index, name: s.name, studentNo: s.studentNo, slot: s.slot, state: s.account, needsVerify: s.needsVerify,
        browserWindowVisible: s.browserWindowVisible,
        answerRoundLimit: s.answerRoundLimit,
        action: s.action,
        courses: s.courses.length, bank: s.bankCount, ai: s.aiCount,
        activeCourseIndex: s.courses.findIndex((c) => c.name === s.activeCourseName),
        courseStatuses: s.courses.map((c) => ({ name: c.name, status: c.status, homeworks: c.groups.flatMap((g) => g.rows.map((r) => ({ name: r.name, status: r.status, attempt: r.attempt ?? null, score: r.score ?? null }))) })),
        questionCounts: s.courses.map((c) => c.groups.reduce((n, g) => n + g.rows.reduce((m, r) => m + r.questions.length, 0), 0)),
        extract: {
          totals: s.extractTotals,
          courses: s.courses.map((c) => ({
            name: c.name,
            status: c.status,
            homeworks: c.groups.flatMap((g) => g.rows.map((r) => ({
              group: g.title,
              name: r.name,
              status: r.status,
              stats: r.extractStats || null,
            }))),
          })),
          progress: {
            courses: [s.extractCompletedCourses, s.extractTotalCourses],
            homeworks: [s.extractCompletedHomeworks, s.extractTotalHomeworks],
            history: [s.extractHistoryCompleted, s.extractHistoryTotal],
            pages: s.extractHistoryPages,
            current: s.extractCurrentHistory,
          },
        },
        reviewDiagnostics: s.logs.filter((line) => /^(校对读取|补偿读取|校对完成)/.test(line)).slice(-3),
        homeworkStates: s.courses.flatMap((c) => c.groups.flatMap((g) => g.rows.map((r) => r.status))),
        homeworkAttempts: s.courses.flatMap((c) => c.groups.flatMap((g) => g.rows.map((r) => ({
          status: r.status,
          attempt: r.attempt ?? null,
          score: r.score ?? null,
        })))),
      })),
    }
  })
  if (goalTargetIds.length) status.students = status.students.filter((student) => goalTargetIds.includes(student.local_id))
  const runStudents = sequentialSelected ? status.students.filter((student) => student.local_id === currentSequentialId) : status.students
  if (courseScope === 'selected' && !selectedRunStarted) {
    const active = runStudents.filter((student) => !['login_failed', 'stopped', 'round_ended'].includes(student.state))
    if (active.length && active.every((student) => student.state === 'waiting_course_selection')) {
      assert.ok(active.every((student) => student.extract.courses.every((course) =>
        course.homeworks.every((homework) => homework.status !== 'extracting' && homework.status !== 'extracting_done'))),
      '选择课程前已有作业进入提取队列')
      for (const student of active) {
        const course = student.extract.courses.find((item) => item.homeworks.some((homework) => homework.status === 'todo'))
        assert.ok(course, '没有可用于可选课程真机测试的客观题课程')
        await chooseCourseInUi(student, course.name)
        selectedCourses.set(student.local_id, course.name)
      }
      const expectedSelectedLabel = sequentialSelected ? '开始执行（已选 1 门）' : '开始执行（已选 2 门）'
      await page.getByText(expectedSelectedLabel, { exact: true }).waitFor()
      await page.locator('#btn-primary-action').click()
      await waitForUi(async () => !(await rendererSource('window.kaida.snapshot()')).students.some((student) => student.state === 'waiting_course_selection'))
      selectedRunStarted = true
      console.log('selected-course-gate-verified', { students: active.length, selected: selectedCourses.size, sequential: sequentialSelected, ui: true })
    }
  }
  for (const student of status.students) {
    if (!['occupied', 'occupying_verify'].includes(student.slot) || student.browserWindowVisible == null) continue
    displaySamples++
    if (student.browserWindowVisible !== (displayMode === 'visual')) displayMismatches++
  }
    const compact = {
    running: status.running,
    browsers: status.browsers,
    students: status.students.map((student) => ({
      index: student.index,
      slot: student.slot,
      state: student.state,
      action: student.action,
      courses: student.courses,
      progress: student.extract.progress,
      totals: student.extract.totals,
      needsVerify: student.needsVerify,
      browserWindowVisible: student.browserWindowVisible,
      courseStatuses: student.courseStatuses,
    })),
  }
  const serial = JSON.stringify(compact)
  if (serial !== previous) console.log('product-state', serial)
  previous = serial
  if (process.env.KAIDA_QR_PROBE === '1' && workMode === 'answer') {
    const target = status.students.find((student) => student.needsVerify)
    if (target) {
      assert.equal(target.slot, 'occupying_verify', '真实二维码出现后没有占用验证名额')
      assert.equal(target.browserWindowVisible, displayMode === 'visual', '二维码验证期间浏览器模式状态不一致')
      const first = await rendererSource('window.kaida.getQrSnapshot(' + JSON.stringify(target.local_id) + ')')
      assert.equal(first?.ok, true, first?.error || '程序内二维码快照读取失败')
      assert.equal(first.snapshot.localId, target.local_id)
      assert.ok(first.snapshot.courseName && first.snapshot.homeworkName, '二维码快照缺少课程或作业')
      assert.match(first.snapshot.image, /^data:image\/png;base64,/)
      assert.equal(first.snapshot.status, '等待扫码')
      assert.ok(Number.isInteger(first.snapshot.version) && first.snapshot.version > 0)

      await page.getByRole('button', { name: '查看作业二维码' }).click()
      await page.getByRole('heading', { name: '作业二维码' }).waitFor()
      const qrDialog = page.getByRole('heading', { name: '作业二维码' }).locator('xpath=ancestor::section[1]')
      await qrDialog.locator('img[alt="当前作业扫码二维码"]').waitFor()
      await qrDialog.getByText(first.snapshot.courseName, { exact: true }).waitFor()
      await qrDialog.getByText(first.snapshot.homeworkName, { exact: true }).waitFor()
      await qrDialog.getByRole('button', { name: '复制二维码' }).click()
      const copiedFirst = await app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty())
      assert.equal(copiedFirst, true, '复制二维码没有得到 PNG 图片')

      const refreshed = await rendererSource('window.kaida.refreshQrSnapshot(' + JSON.stringify(target.local_id) + ')')
      assert.equal(refreshed?.ok, true, refreshed?.error || '真实二维码刷新失败')
      assert.ok(refreshed.snapshot.version > first.snapshot.version, '刷新二维码没有递增版本')
      const staleCopy = await rendererSource('window.kaida.copyQrSnapshot(' + JSON.stringify(target.local_id) + ', ' + first.snapshot.version + ')')
      assert.equal(staleCopy?.ok, false, '旧二维码版本仍可复制')
      assert.match(staleCopy?.error || '', /失效|刷新/)
      const copiedRefresh = await rendererSource('window.kaida.copyQrSnapshot(' + JSON.stringify(target.local_id) + ', ' + refreshed.snapshot.version + ')')
      assert.equal(copiedRefresh?.ok, true, copiedRefresh?.error || '刷新后的二维码复制失败')

      const blocked = await rendererSource('window.kaida.verifyDone(' + JSON.stringify(target.local_id) + ')')
      assert.equal(blocked?.ok, false, '二维码仍在时验证完毕不应放行')
      assert.match(blocked?.error || '', /二维码仍在|扫码/)
      await qrDialog.getByRole('button', { name: '关闭二维码弹窗' }).click()
      assert.equal(await page.getByRole('heading', { name: '作业二维码' }).count(), 0)

      await rendererSource('window.kaida.stop(' + JSON.stringify(target.local_id) + ')')
      for (let i = 0; i < 120; i++) {
        const after = await rendererSource('window.kaida.snapshot()')
        if (!after.running) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      const afterStop = await rendererSource('window.kaida.snapshot()')
      assert.equal(afterStop.running, false, '二维码探针停止后运行态未释放')
      console.log('qr-probe-verified', { mode: displayMode, course: first.snapshot.courseName, homework: first.snapshot.homeworkName, refreshedVersion: refreshed.snapshot.version })
      await app.close()
      break
    }
  }
  if (!status.running && workMode === 'extract') {
    assert.ok(displaySamples > 0, '没有取得浏览器窗口显隐实测样本')
    assert.equal(displayMismatches, 0, displayMode + ' 模式标签与真实窗口状态不一致')
    assert.ok(status.students.length > 0, '提取模式没有学生结果')
    const sum = (rows, key) => rows.reduce((total, row) => total + Number(row?.stats?.[key] || 0), 0)
    const completed = status.students.filter((student) => student.state === 'round_ended')
    const loginFailed = status.students.filter((student) => student.state === 'login_failed')
    for (const student of completed) {
      const selectedName = selectedCourses.get(student.local_id)
      const selected = selectedName ? student.extract.courses.filter((course) => course.name === selectedName) : student.extract.courses
      const jobs = selected.flatMap((course) => course.homeworks)
      assert.ok(jobs.length > 0, '学生没有可核对的提取作业')
      assert.ok(jobs.every((job) => isFinishedExtractJobStatus(job.status)), '仍有提取作业未完成')
      if (selectedName) {
        const unselected = student.extract.courses.filter((course) => course.name !== selectedName)
        assert.ok(unselected.every((course) => course.status === '本轮未选择'), '未选课程没有明确标记为本轮未选择')
        assert.ok(unselected.every((course) => course.homeworks.every((job) => !['extracting', 'extracting_done'].includes(job.status))), '未选课程进入了提取队列')
        assert.equal(student.extract.progress.courses[1], 1, '可选课程运行总数不是一门')
      }
      for (const key of ['added', 'merged', 'skipped', 'conflict', 'failed']) {
        assert.equal(student.extract.totals[key], sum(jobs, key), '学生' + (student.index + 1) + '的' + key + '统计与作业明细不一致')
      }
    }
    assert.equal(loginFailed.length, 0, '有 ' + loginFailed.length + ' 个目标账号登录失败，未执行提取')
    assert.equal(completed.length, status.students.length, '仍有学生未进入明确终态')
    const allJobs = completed.flatMap((student) => {
      const selectedName = selectedCourses.get(student.local_id)
      return student.extract.courses
        .filter((course) => !selectedName || course.name === selectedName)
        .flatMap((course) => course.homeworks)
    })
    const total = ['added', 'merged', 'skipped', 'conflict', 'failed'].reduce((result, key) => {
      result[key] = sum(allJobs, key)
      return result
    }, {})
    console.log('extract-summary-verified', { students: status.students.length, jobs: allJobs.length, total })
    if (courseScope === 'selected') console.log('selected-course-extract-verified', { students: selectedCourses.size, jobs: allJobs.length })
    console.log('display-mode-verified', { mode: displayMode, samples: displaySamples })
    if (process.env.KAIDA_KEEP_OPEN === '1') await new Promise(() => {})
    break
  }
  if (!status.running && workMode === 'answer') {
    const completed = runStudents.filter((student) => student.state === 'round_ended')
    assert.equal(completed.length, runStudents.length, '当前顺序账号未进入明确答题终态')
    assert.equal(status.browsers, 0, '答题终态仍有浏览器未释放')
    assert.equal(runStudents.some((student) => student.needsVerify), false, '答题终态仍有学生停在验证门')
    await rendererSource('window.kaida.stop()')
    await waitForUi(async () => !(await rendererSource('window.kaida.snapshot()')).running, 30_000).catch(() => {})
    if (sequentialSelected && sequentialIndex + 1 < goalTargetIds.length) {
      sequentialIndex++
      currentSequentialId = goalTargetIds[sequentialIndex]
      selectedRunStarted = false
      console.log('sequential-student-finished', { completed: completed.map((student) => student.local_id), next: currentSequentialId })
      await rendererSource('void window.kaida.loginRefresh(' + JSON.stringify([currentSequentialId]) + ')')
      await new Promise((resolve) => setTimeout(resolve, 1000))
      continue
    }
    console.log('answer-summary-verified', {
      students: completed.length,
      states: completed.map((student) => ({ index: student.index, state: student.state, action: student.action, courses: student.courseStatuses })),
    })
    console.log('product-window-kept-open', { running: false, browsers: (await rendererSource('window.kaida.snapshot()')).machine.browsers, sequential: sequentialSelected })
    if (process.env.KAIDA_KEEP_OPEN === '1') await new Promise(() => {})
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
