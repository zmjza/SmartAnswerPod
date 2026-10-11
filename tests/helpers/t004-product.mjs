import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { _electron as electron } from 'patchright'

export async function waitUntil(check, label, timeout = 240_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(label + ' 超时')
}

export async function launchProduct({ accounts, mode, workModes, schoolOrigin = '', label }) {
  const writes = { post: 0, patch: 0, delete: 0 }
  const bank = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.split('?')[0] !== '/rest/v1/questions') { res.writeHead(404); res.end('[]'); return }
    if (req.method === 'GET') { res.end('[]'); return }
    const key = req.method?.toLowerCase()
    if (key in writes) writes[key]++
    res.writeHead(405); res.end('[]')
  })
  await new Promise(resolve => bank.listen(0, '127.0.0.1', resolve))
  const bankUrl = `http://127.0.0.1:${bank.address().port}`
  const env = { ...process.env, VITE_DEV_SERVER_URL: '',
    KAIDA_E2E_USERDATA: resolve('.playwright', `t004-${label}-${mode}-${process.pid}-${Date.now()}`),
    KAIDA_SUPABASE_URL: '', KAIDA_SUPABASE_ANON: '', KAIDA_SILICONFLOW_KEY: '' }
  for (const key of Object.keys(env)) {
    if (key.startsWith('KAIDA_E2E_') && key !== 'KAIDA_E2E_USERDATA') delete env[key]
  }
  for (const key of ['KAIDA_ACCOUNTS_JSON', 'KAIDA_AUTO_DETECT', 'KAIDA_GOAL_FILE',
    'KAIDA_TEST_USER', 'KAIDA_TEST_PASS', 'KAIDA_TEST_ACCOUNTS']) delete env[key]
  if (schoolOrigin) env.KAIDA_E2E_SCHOOL_ORIGIN = schoolOrigin
  let app
  try {
    app = await electron.launch({ args: ['.'], env })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const renderer = source => app.evaluate(({ BrowserWindow }, script) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
    const invoke = (fn, arg) => renderer('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')')
    const configured = await invoke(async ({ accounts, bankUrl, mode, workModes }) => {
      const settings = await window.kaida.saveSettings({ supabase_url: bankUrl, supabase_anon: 'local-test',
        siliconflow_key: '', account_parallel: accounts.length, course_parallel: 2 })
      if (!settings.ok) return { ok: false }
      const ids = []
      for (const [index, account] of accounts.entries()) {
        if (!(await window.kaida.addAccount(account)).ok) return { ok: false }
        const id = (await window.kaida.listAccounts())[index]?.local_id
        if (!id || !(await window.kaida.setDisplay(id, mode)).ok ||
          !(await window.kaida.setWorkMode(id, workModes[index])).ok ||
          !(await window.kaida.setCourseScope(id, 'selected')).ok) return { ok: false }
        ids.push(id)
      }
      return { ok: true, ids }
    }, { accounts, bankUrl, mode, workModes })
    assert.equal(configured.ok, true, '独立产品配置失败')
    // Only observe actual production contexts; no school network or business replacement.
    await app.evaluate(async ({ app }) => {
      const { createRequire } = process.getBuiltinModule('module')
      const { basename } = process.getBuiltinModule('path')
      const { chromium } = createRequire(app.getAppPath() + '/package.json')('patchright')
      const state = globalThis.__t004 = { contexts: new Map(), launches: [],
        counts: { saves: 0, submits: 0, answers: 0, reviews: 0, ai: 0, faceUploads: 0, faceConsents: 0 } }
      const original = chromium.launchPersistentContext
      chromium.launchPersistentContext = async function (profile, options) {
        const context = await original.call(this, profile, options)
        state.contexts.set(basename(profile), context)
        state.launches.push({ headless: options.headless })
        context.on('request', request => {
          const url = new URL(request.url()), path = url.pathname.toLowerCase()
          if (request.method() === 'POST' && path.endsWith('/ulpface/facecheck')) state.counts.faceUploads++
          if (request.method() === 'POST' && path.endsWith('/ulpface/agreenment')) state.counts.faceConsents++
          if (url.hostname !== 'l.shou.org.cn') return
          if (request.method() === 'POST' && /ajax-assignment-online_homework_(answer|subanswer|match)/.test(path)) state.counts.saves++
          if (request.method() === 'POST' && /ajax-assignment-online_homework_save/.test(path)) state.counts.submits++
          if (request.isNavigationRequest() && /\/study\/assignment\/(preview|continuation)\.aspx/.test(path)) state.counts.answers++
          if (request.isNavigationRequest() && /\/study\/assignment\/history\.aspx/.test(path)) state.counts.reviews++
        })
        return context
      }
      const originalFetch = globalThis.fetch
      globalThis.fetch = function (input, init) {
        const url = String(input?.url || input)
        if (/siliconflow|\/chat\/completions/.test(url)) state.counts.ai++
        return originalFetch.call(this, input, init)
      }
    })
    const product = { app, page, ids: configured.ids, writes,
      snapshot: () => renderer('window.kaida.snapshot()'),
      observe: () => app.evaluate(() => ({ launches: globalThis.__t004.launches, counts: globalThis.__t004.counts })),
      portalState: () => app.evaluate(async () => {
        const out = []
        for (const context of globalThis.__t004.contexts.values()) for (const page of context.pages()) {
          const url = new URL(page.url())
          if (!['aiedu.shou.org.cn', 'learning.shou.org.cn'].includes(url.hostname)) continue
          out.push(await page.evaluate(() => {
            const active = document.querySelector('[data-learning-course-card-active="true"]')
            const name = active?.querySelector('h3')?.textContent?.replace(/\s+/g, ' ').trim()
            const space = document.querySelector('[aria-label="课程学习空间"]')
            return { cards: document.querySelectorAll('[data-learning-course-card]').length,
              activeIndex: [...document.querySelectorAll('[data-learning-course-card]')].indexOf(active),
              cardTags: [...new Set([...document.querySelectorAll('[data-learning-course-card]')].map(node => node.tagName))],
              selfSwitch: [...document.querySelectorAll('[data-learning-course-card]')].filter(node => node.matches('button[aria-label^="切换课程："]')).length,
              childSwitch: document.querySelectorAll('[data-learning-course-card] button[aria-label^="切换课程："]').length,
              activeSwitchDisabled: active?.querySelector('button[aria-label^="切换课程："]')?.hasAttribute('disabled') || false,
              taskRegion: !!space?.querySelector('[role="region"][aria-label="课程任务"]'),
              matchingOuter: !![...(space?.querySelectorAll('div[aria-label]') || [])].find(node => node.getAttribute('aria-label') === name + ' 课程任务' && !node.hasAttribute('role')),
              pressed: [...(space?.querySelectorAll('button[aria-pressed="true"]') || [])].map(node => node.getAttribute('data-figma-segmented-tab-key')),
              homeworkButtons: space?.querySelectorAll('button[aria-label="去完成：完成课程形考作业"]').length || 0,
              globalHomeworkButtons: document.querySelectorAll('button[aria-label="去完成：完成课程形考作业"]').length,
              regionHomeworkButtons: space?.querySelector('[role="region"][aria-label="课程任务"]')?.querySelectorAll('button[aria-label="去完成：完成课程形考作业"]').length || 0,
              taskRows: space?.querySelectorAll('[role="listitem"]').length || 0,
              spaceMessage: space && !space.querySelector('[role="region"][aria-label="课程任务"]')
                ? [...document.querySelectorAll('[data-learning-course-card] h3')].reduce((text, title) =>
                  text.split(title.textContent?.trim() || '[none]').join('[course]'), space.textContent || '')
                  .replace(/\b\d{6,}\b/g, '[ID]').slice(0, 600) : '',
              externalLinks: !space?.querySelector('[role="region"][aria-label="课程任务"]')
                ? [...(space?.querySelectorAll('a[href]') || [])].map(anchor => {
                  const url = new URL(anchor.href)
                  return { label: anchor.textContent?.trim(), host: url.hostname, path: url.pathname,
                    params: [...url.searchParams.keys()], target: anchor.target }
                }) : [],
              details: [...(space?.querySelectorAll('a') || [])].filter(node => node.textContent?.includes('查看更多课程详情')).length,
              loading: /正在加载课程学习空间|加载中/.test(space?.textContent || '') }
          }).catch(() => ({ closed: true })))
        }
        return out
      }),
      async close() {
        try { await renderer('window.kaida.stopAllStudents()') } catch {}
        await app.close()
        await new Promise(resolve => bank.close(resolve))
      } }
    return product
  } catch (error) {
    if (app) await app.close().catch(() => {})
    await new Promise(resolve => bank.close(resolve))
    throw error
  }
}

export async function scanProduct(product) {
  await product.page.locator('#btn-primary-action').click()
  let lastReport = 0, lastState = ''
  const portalHistory = new Map()
  await waitUntil(async () => {
    const students = (await product.snapshot()).students
    const portals = await product.portalState()
    for (const portal of portals) if (portal.cards)
      portalHistory.set(portal.activeIndex + ':' + portal.pressed.join(','), portal)
    const currentState = students.map(student => student.account + ':' + student.courses.length).join(',')
    if (Date.now() - lastReport > 20_000 || currentState !== lastState) {
      console.log('T004 扫描状态', students.map(student => ({ account: student.account, slot: student.slot,
        courses: student.courses.length, awaitingCourseSelection: student.awaitingCourseSelection })))
      console.log('T004 门户结构', JSON.stringify(portals))
      lastReport = Date.now()
      lastState = currentState
    }
    const failed = students.find(student => ['login_failed', 'round_ended', 'stopped'].includes(student.account))
    if (failed) console.log('T004 扫描错误分类', { resolved: /locator resolved/.test(failed.action),
      disabled: /not enabled/.test(failed.action), intercepted: /intercepts pointer events/.test(failed.action),
      invisible: /not visible/.test(failed.action), unstable: /not stable/.test(failed.action) })
    if (failed) console.log('T004 最近任务结构', JSON.stringify([...portalHistory.values()]))
    assert.ok(!failed, '产品扫描失败或提前结束：' + (failed?.action || '').split('Call log:')[0].replace(/https?:\/\/\S+/g, '[URL]').replace(/\b\d{10,}\b/g, '[ID]'))
    return students.length === product.ids.length && students.every(student => student.awaitingCourseSelection)
  }, '产品完整扫描')
  const state = await product.snapshot()
  const observed = await product.observe()
  assert.equal(observed.launches.length, product.ids.length, '生产浏览器观测缺失')
  assert.ok(observed.launches.every(item => item.headless === (state.students[0].displayMode !== 'visual')), '真实启动模式与产品模式不一致')
  assert.equal(state.settings.hasSilicon, false, '测试配置不应有AI密钥')
  assert.ok(state.students.every(student => !student.verified && !student.needsVerify && student.aiCount === 0 &&
    student.courses.every(course => course.status !== '检测失败')), '扫描阶段检测、授权或AI异常')
  return state
}

export async function selectCourse(product, studentIndex, courseIndex) {
  const { page } = product
  await page.locator(`#student-switcher [data-student="${studentIndex}"]`).click()
  const previous = page.getByRole('button', { name: '上一页课程' })
  while (await previous.count() && await previous.isEnabled()) await previous.click()
  for (let index = 0; index < Math.floor(courseIndex / 7); index++)
    await page.getByRole('button', { name: '下一页课程' }).click()
  await page.locator('#course-list .course-item').nth(courseIndex % 7).click()
  const course = (await product.snapshot()).students[studentIndex].courses[courseIndex]
  await waitUntil(async () => (await product.snapshot()).students[studentIndex].selectedCourseKeys.includes(course.key), '产品页面选课')
}

export async function stopProduct(product) {
  const closeQr = product.page.getByRole('button', { name: '关闭二维码弹窗' })
  if (await closeQr.count()) await closeQr.click()
  await product.page.locator('#btn-stop-all').click()
  try { await waitUntil(async () => {
    const state = await product.snapshot()
    return !state.running && state.machine.browsers === 0 &&
      state.students.every(student => student.slot === 'released' && !student.configLocked && !student.verified && !student.needsVerify)
  }, '产品停止与名额释放', 30_000) } catch (error) {
    const state = await product.snapshot()
    console.log('T004 停止未收口', { running: state.running, browsers: state.machine.browsers,
      students: state.students.map(({ account, slot, configLocked, verified, needsVerify }) => ({ account, slot, configLocked, verified, needsVerify })) })
    throw error
  }
  const { counts } = await product.observe()
  assert.deepEqual(counts, { saves: 0, submits: 0, answers: 0, reviews: 0, ai: 0, faceUploads: 0, faceConsents: 0 }, '扫码前出现作答、提交、批阅、AI、人脸上传或授权提交')
  assert.deepEqual(product.writes, { post: 0, patch: 0, delete: 0 }, '扫码前题库防写计数不为零')
}

export async function openQr(product) {
  await waitUntil(async () => (await product.snapshot()).students[0].needsVerify, '真实二维码等待', 60_000)
  const waiting = (await product.snapshot()).students[0]
  assert.equal(waiting.verified, false)
  assert.equal(waiting.slot, 'occupying_verify')
  await product.page.locator('#btn-open-qr').click()
  const heading = product.page.getByRole('heading', { name: '作业二维码' })
  await heading.waitFor()
  const image = heading.locator('xpath=ancestor::section[1]').locator('img[alt="当前作业扫码二维码"]')
  await waitUntil(() => image.evaluate(img => img.complete && img.naturalWidth > 0), '产品二维码图片加载', 15_000)
}
