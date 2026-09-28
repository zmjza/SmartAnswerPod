import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'patchright'
import { headlessUserAgent } from '../electron/core/browser-mode.ts'
import { isAnswerPath, isPreviewPath, SEL } from '../electron/core/selectors.ts'
import { hasQr } from '../electron/page-tools.ts'
import { loginIam } from '../electron/login.ts'
import { skipFullScore, SUBMIT } from '../electron/core/homework.ts'
import { contentHash, normalizeOption, normalizeStem, qtypeFromPage, type QType } from '../electron/core/hash.ts'
import { AI_MODELS, AI_SYSTEM_PROMPT, parseOptionTexts } from '../electron/core/ai-parse.ts'

/** 产品 Playwright 登录学习中心并检测形考。账密只从本机 /tmp 读，不进仓库。 */

function loadAccounts(): { name: string; user: string; pass: string }[] {
  const p = '/tmp/kaida-e2e-accounts.json'
  if (!existsSync(p)) throw new Error('缺少 /tmp/kaida-e2e-accounts.json')
  const arr = JSON.parse(readFileSync(p, 'utf8')) as { name: string; user: string; pass: string }[]
  assert.ok(arr.length > 0, '上号器至少一条账密')
  return arr
}

function mask(u: string) {
  return u.length >= 8 ? u.slice(0, 2) + '****' + u.slice(-2) : '****'
}

async function minimize(page: Page) {
  try {
    const cdp = await page.context().newCDPSession(page)
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  } catch {}
}

async function restore(page: Page) {
  try {
    const cdp = await page.context().newCDPSession(page)
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  } catch {}
}

async function dumpHistoryStructure(page: Page) {
  const link = page.locator('a[href*="history.aspx"]').first()
  if (!(await link.count())) return false
  const href = await link.getAttribute('href')
  if (!href) return false
  const history = await page.context().newPage()
  try {
    const absolute = href.startsWith('http') ? href : 'https://l.shou.org.cn' + href
    await history.goto(absolute, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await history.waitForTimeout(500)
    const sanitized = await history.evaluate(() => {
      const root = document.documentElement.cloneNode(true) as HTMLElement
      root.querySelectorAll('script,style,noscript,iframe').forEach((node) => node.remove())
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const textNodes: Node[] = []
      while (walker.nextNode()) textNodes.push(walker.currentNode)
      for (const node of textNodes) node.textContent = '⟦TEXT⟧'
      root.querySelectorAll('*').forEach((element) => {
        for (const attr of [...element.attributes]) {
          if (attr.name === 'href') {
            try { element.setAttribute('href', new URL(attr.value, location.href).pathname) } catch { element.removeAttribute('href') }
            continue
          }
          if (attr.name === 'src') {
            try { element.setAttribute('src', new URL(attr.value, location.href).pathname) } catch { element.removeAttribute('src') }
            continue
          }
          if (['class', 'name', 'type', 'role', 'for', 'checked', 'selected'].includes(attr.name) || attr.name.startsWith('aria-')) continue
          if (attr.name === 'id') {
            element.setAttribute('id', attr.value.replace(/[A-Za-z0-9_-]{16,}/g, '⟦ID⟧'))
            continue
          }
          element.removeAttribute(attr.name)
        }
      })
      return '<!doctype html>\n' + root.outerHTML
    })
    writeFileSync('/tmp/kaida-history-structure.html', sanitized)
    console.log('history structure dumped')
    return true
  } finally {
    await history.close()
  }
}

async function dumpHistorySemantics(page: Page) {
  const link = page.locator('a[href*="history.aspx"]').first()
  if (!(await link.count())) return false
  const href = await link.getAttribute('href')
  if (!href) return false
  const history = await page.context().newPage()
  try {
    const absolute = href.startsWith('http') ? href : 'https://l.shou.org.cn' + href
    await history.goto(absolute, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await history.waitForTimeout(500)
    const observed = await history.evaluate(() => ({
      path: location.pathname,
      hiddenNames: [...document.querySelectorAll('input[type="hidden"]')].map((x) => x.getAttribute('name') || '').filter(Boolean),
      questionCount: document.querySelectorAll('.e-q').length,
      questions: [...document.querySelectorAll('.e-q')].slice(0, 12).map((q) => ({
        id: q.id,
        className: q.className,
        questionType: q.closest('.e-q-body')?.getAttribute('data-questiontype') || '',
        questionTextLength: q.querySelector('.e-q-q')?.textContent?.trim().length || 0,
        questionMarkers: [...q.querySelector('.e-q-l')?.children || []].map((x) => x.className),
        stem: q.querySelector('.e-q-q')?.textContent?.replace(/\s+/g, ' ').trim() || '',
        options: [...q.querySelectorAll('.e-a-g ul > li.e-a')].map((li) => ({
          className: li.className,
          text: li.textContent?.replace(/\s+/g, ' ').trim() || '',
          textLength: li.textContent?.trim().length || 0,
          childClasses: [...li.children].map((x) => x.className),
        })),
        referenceAnswers: [...q.querySelectorAll('.e-a-ans .e-a-g p.checked')].map((x) => x.textContent?.replace(/\s+/g, ' ').trim() || ''),
        answerBlocks: [...q.querySelectorAll('.e-q-b > div')].map((x) => ({ className: x.className, textLength: x.textContent?.trim().length || 0 })),
      })),
    }))
    writeFileSync('/tmp/kaida-history-semantics.json', JSON.stringify(observed, null, 2))
    console.log('history semantics dumped', { questionCount: observed.questionCount, hiddenNames: observed.hiddenNames })
    return true
  } finally {
    await history.close()
  }
}

type CloudEnv = { url: string; anon: string; key: string }
function loadCloud(): CloudEnv {
  const p = '/tmp/kaida-e2e-env.json'
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as CloudEnv
  return { url: process.env.KAIDA_SUPABASE_URL || '', anon: process.env.KAIDA_SUPABASE_ANON || '', key: process.env.KAIDA_SILICONFLOW_KEY || '' }
}

async function cdpAnswer(page: Page, dataNum: string) {
  try {
    const cdp = await page.context().newCDPSession(page)
    const expr = '(() => { const b = document.querySelector(".e-q-body[data-num=\"' + dataNum + '\"]"); const i = b && b.querySelector("[name=answer]"); return i ? (i.value || "") : ""; })()'
    const res = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    return String(res.result?.value || '')
  } catch {
    return ''
  }
}

async function clickTexts(page: Page, dataNum: string, qtype: QType, texts: string[]) {
  const body = page.locator('.e-q-body[data-num="' + dataNum + '"]')
  const lis = body.locator('li.e-a')
  const n = await lis.count()
  const want = new Set(texts.map((t) => normalizeOption(t, qtype)))
  for (let i = 0; i < n; i++) {
    const li = lis.nth(i)
    const text = normalizeOption(((await li.innerText()) || '').trim(), qtype)
    if (!want.has(text)) continue
    await li.click()
    if (qtype !== 'multiple') break
  }
  const start = Date.now()
  while (Date.now() - start < 8000) {
    if ((await cdpAnswer(page, dataNum)).trim()) return true
    await page.waitForTimeout(200)
  }
  return false
}

async function lookupHash(env: CloudEnv, hash: string) {
  if (!env.url || !env.anon) return null
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 2000)
  try {
    const res = await fetch(env.url.replace(/\/$/, '') + '/rest/v1/questions?content_hash=eq.' + encodeURIComponent(hash) + '&select=*&limit=1', {
      headers: { apikey: env.anon, Authorization: 'Bearer ' + env.anon },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const rows = (await res.json()) as { answer_texts?: string[] }[]
    return rows[0] || null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function askCloud(env: CloudEnv, qtype: QType, stem: string, options: string[]) {
  if (!env.key) return null as string[] | null
  const prompt = '题型:' + qtype + '\n题干:' + stem + '\n选项:\n' + options.map((t, i) => i + '. ' + t).join('\n') + '\n只输出 JSON {"option_texts":["正确选项正文"]}'
  for (const model of AI_MODELS) {
    try {
      const res = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: AI_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        }),
      })
      if (!res.ok) continue
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const texts = parseOptionTexts(data.choices?.[0]?.message?.content || '')
      if (!texts) continue
      const allowed = new Set(options)
      if (!texts.every((t) => allowed.has(t))) continue
      return texts
    } catch {
      continue
    }
  }
  return null
}

async function answerAndSubmit(page: Page) {
  const env = loadCloud()
  await page.locator(SEL.questionBody).first().waitFor({ timeout: 20000 })
  const bodies = page.locator(SEL.questionBody)
  const total = await bodies.count()
  let bankCount = 0
  let aiCount = 0
  let skipCount = 0
  const samples: { no: string; source: string; active: number }[] = []
  for (let i = 0; i < total; i++) {
    const body = bodies.nth(i)
    const dataNum = (await body.getAttribute('data-num')) || String(i + 1)
    const qtype = qtypeFromPage((await body.getAttribute('data-questiontype')) || '')
    const stemRaw = ((await body.locator('.e-q-q, .e-q-qt, .e-q-title, .e-q-h').first().innerText().catch(() => '')) || (await body.innerText())).trim()
    const lis = body.locator('li.e-a')
    const oc = await lis.count()
    const options: string[] = []
    for (let k = 0; k < oc; k++) options.push(normalizeOption((await lis.nth(k).innerText()) || '', qtype === 'unknown' ? undefined : qtype))
    if (qtype === 'unknown') { skipCount++; continue }
    const hash = contentHash(qtype, normalizeStem(stemRaw), options)
    const hit = await lookupHash(env, hash)
    let source = '空过'
    if (hit?.answer_texts?.length && await clickTexts(page, dataNum, qtype, hit.answer_texts)) {
      bankCount++
      source = '题库答题'
    } else {
      const ai = await askCloud(env, qtype, normalizeStem(stemRaw), options)
      if (ai && await clickTexts(page, dataNum, qtype, ai)) {
        aiCount++
        source = 'AI 答题'
      } else skipCount++
    }
    if (samples.length < 6) {
      samples.push({ no: dataNum, source, active: await page.locator(SEL.doneCard).count() })
    }
  }
  const beforeSubmit = new URL(page.url()).pathname
  await page.locator(SEL.submit).click()
  let okClicks = 0
  for (let i = 0; i < 2; i++) {
    try {
      await page.locator(SUBMIT.ok).first().waitFor({ state: 'visible', timeout: 8000 })
      await page.locator(SUBMIT.ok).first().click()
      okClicks++
    } catch {
      break
    }
  }
  if (okClicks < 2) {
    await page.waitForTimeout(8000)
    if (await page.locator(SEL.submit).count()) {
      await page.locator(SEL.submit).click()
      for (let i = okClicks; i < 2; i++) {
        try {
          await page.locator(SUBMIT.ok).first().waitFor({ state: 'visible', timeout: 8000 })
          await page.locator(SUBMIT.ok).first().click()
          okClicks++
        } catch { break }
      }
    }
  }
  await page.waitForURL((u) => u.pathname.includes('assignment-preview.aspx'), { timeout: 20000 }).catch(() => {})
  return { total, bankCount, aiCount, skipCount, samples, okClicks, after: new URL(page.url()).pathname, beforeSubmit }
}

async function pageHint(page: Page) {
  const u = new URL(page.url())
  const title = await page.title().catch(() => '')
  const hasTab = (await page.locator(SEL.tabCourseList).count()) > 0
  const hasIam = (await page.locator(SEL.iamSubmit).count()) > 0
  return { host: u.host, path: u.pathname, title, hasTab, hasIam }
}

async function login(page: Page, user: string, pass: string) {
  const r = await loginIam({
    page,
    local_id: 'e2e',
    username: user,
    password: pass,
    slot: 'occupied',
    onNeedVerify: async () => {},
  })
  if (r.ok) return 'ok'
  return r.reason || 'timeout'
}


const allAccounts = loadAccounts()
const rawIdx = process.env.KAIDA_E2E_INDEX
const only = rawIdx == null || rawIdx === '' ? NaN : Number(rawIdx)
const accounts = Number.isInteger(only) && only >= 0 && only < allAccounts.length ? [allAccounts[only]] : allAccounts
const dir = process.env.KAIDA_E2E_USERDATA || mkdtempSync(join(tmpdir(), 'kaida-e2e-'))
if (process.env.KAIDA_E2E_USERDATA) mkdirSync(dir, { recursive: true })
console.log('profile', process.env.KAIDA_E2E_USERDATA ? 'reuse' : 'temp')
const headless = process.env.KAIDA_DISPLAY_MODE === 'headless'
const context = await chromium.launchPersistentContext(dir, {
  headless,
  viewport: { width: 1280, height: 800 },
  channel: process.env.KAIDA_CHROME === '1' ? 'chrome' : 'chromium',
  userAgent: headless ? headlessUserAgent() : undefined,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
})
const page = context.pages()[0] || (await context.newPage())
page.on('console', (msg) => {
  const t = msg.text()
  if (/oauthlogin|has token|router path|has no token/i.test(t)) {
    console.log('page', t.replace(/[A-Za-z0-9_-]{16,}/g, '[id]'))
  }
})
page.on('requestfailed', (req) => {
  let path = req.url()
  try {
    path = new URL(req.url()).host + new URL(req.url()).pathname
  } catch {}
  console.log('fail', req.failure()?.errorText || '', path)
})
page.on('pageerror', (err) => {
  console.log('pageerror', String(err.message || err).slice(0, 160))
})
page.on('request', (req) => {
  if (!req.url().includes('authExecute')) return
  const raw = req.postData() || ''
  let keys: string[] = []
  let lens: Record<string, number> = {}
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    keys = Object.keys(j)
    for (const k of keys) lens[k] = String(j[k] ?? '').length
  } catch {
    keys = ['rawlen:' + raw.length]
  }
  console.log('authExecute req keys', keys, 'lens', lens)
})
page.on('response', async (res) => {
  const u = res.url()
  if (!u.includes('shou.org.cn')) return
  try {
    const x = new URL(u)
    if (x.pathname.includes('authExecute')) {
      console.log('authExecute', res.status())
      return
    }
    if (x.pathname.includes('oauth-login')) {
      const txt = await res.text().catch(() => '')
      const raw = res.request().postData() || ''
      let reqKeys: string[] = []
      let reqLens: Record<string, number> = {}
      try {
        const j = JSON.parse(raw) as Record<string, unknown>
        reqKeys = Object.keys(j)
        for (const k of reqKeys) reqLens[k] = String(j[k] ?? '').length
      } catch {
        reqKeys = ['rawlen:' + raw.length]
      }
      let msg = ''
      try {
        const j = JSON.parse(txt) as Record<string, unknown>
        msg = JSON.stringify({ code: j.code ?? j.status, message: j.message ?? j.msg, keys: Object.keys(j).slice(0, 10) })
      } catch {
        msg = 'nonjson len ' + txt.length
      }
      console.log('oauth-login', res.status(), 'req', reqKeys, reqLens, msg)
      return
    }
    if (res.request().method() === 'GET' && res.status() < 400) return
    console.log('net', res.request().method(), res.status(), x.host + x.pathname)
  } catch {}
})
const evidence: Record<string, unknown> = { clickedDoHomework: false, usedComputerUse: false, profileReuse: Boolean(process.env.KAIDA_E2E_USERDATA) }
try {
  let logged = ''
  let picked = ''
  for (const a of accounts) {
    const r = await login(page, a.user, a.pass)
    picked = mask(a.user)
    console.log('login try', mask(a.user), r, await pageHint(page))
    if (r === 'ok') {
      logged = r
      break
    }
    if (r === 'timeout') break
    if (r === 'login_failed' || r === 'no_scenter') {
      continue
    }
    logged = r
    break
  }
  evidence.picked = picked
  evidence.login = logged
  evidence.hint = await pageHint(page)
  evidence.xhrHooked = await page
    .evaluate(() => {
      try {
        return !XMLHttpRequest.prototype.open.toString().includes('[native code]')
      } catch {
        return false
      }
    })
    .catch(() => false)
  evidence.cookieNames = (await page.context().cookies())
    .filter((c) => c.domain.includes('shou.org.cn'))
    .map((c) => c.name)
    .sort()
  evidence.hasEnable = (evidence.cookieNames as string[]).some((n) => n.startsWith('enable_'))
  evidence.apiProbe = await page
    .evaluate(async () => {
      try {
        const r = await fetch('/api/study/learning-course-list', { credentials: 'include' })
        const t = await r.text()
        return { status: r.status, len: t.length, json: t.trim().startsWith('{') || t.trim().startsWith('[') }
      } catch (e) {
        return { status: 0, len: 0, json: false, err: String(e).slice(0, 80) }
      }
    })
    .catch(() => ({ status: 0 }))
  writeFileSync('/tmp/kaida-e2e-evidence.json', JSON.stringify({ ...evidence, hint: evidence.hint }, null, 2))
  assert.equal(logged, 'ok', '应登录进学习中心')
  await minimize(page)
  const n = await page.locator(SEL.courseItem).count()
  const courses: { name: string; href: string }[] = []
  for (let i = 0; i < n; i++) {
    const it = page.locator(SEL.courseItem).nth(i)
    const name = ((await it.locator(SEL.courseName).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
    const href = (await it.locator(SEL.courseLink).getAttribute('href')) || ''
    courses.push({ name, href })
  }
  evidence.courseCount = courses.length
  evidence.courseNames = courses.map((c) => c.name)
  assert.ok(courses.length > 0, '我的课程至少一门')
  assert.equal(await page.locator(SEL.collectionsPane).isVisible().catch(() => false), false)

  const detected: {
    name: string
    emptyOnline: boolean
    emptyPhased: boolean
    online: { name: string; workType: string; weight: string; href: string }[]
    phased: { name: string; workType: string; weight: string; href: string }[]
  }[] = []
  const previews: {
    course: string
    hw: string
    skip: boolean
    path: string
    href: string
    hist: { status: string; score: number | null; hasContinue: boolean }[]
    doBtn: number
  }[] = []
  for (const first of courses) {
  const abs = first.href.startsWith('http') ? first.href : 'https://l.shou.org.cn' + (first.href.startsWith('/') ? first.href : '/study/' + first.href)
  const coursePage = await context.newPage()
  await minimize(coursePage)
  await coursePage.goto(abs, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await coursePage.locator(SEL.courseHomeWork).waitFor({ timeout: 20000 })
  await coursePage.locator(SEL.courseHomeWork).click()
  await coursePage.waitForURL((u) => u.pathname.toLowerCase().includes('homeworknew.aspx'), { timeout: 20000 })
  const html = await coursePage.content()
  const emptyOnline = html.includes('网上记分作业列表' + SEL.noDataMarker)
  const emptyPhased = html.includes('阶段性测验' + SEL.noDataMarker)
  async function rows(id: string) {
    const trs = coursePage.locator(id + ' tbody tr')
    const count = await trs.count()
    const out: { name: string; workType: string; weight: string; href: string }[] = []
    for (let i = 0; i < count; i++) {
      const tds = trs.nth(i).locator('td')
      out.push({
        name: ((await tds.nth(1).getAttribute('title')) || (await tds.nth(1).innerText())).trim(),
        workType: ((await tds.nth(3).innerText()) || '').trim(),
        weight: ((await tds.nth(4).innerText()) || '').trim(),
        href: (await trs.nth(i).locator(SEL.previewViewLink).getAttribute('href')) || '',
      })
    }
    return out
  }
  const online = emptyOnline ? [] : await rows('#onlineHomework')
  const phased = emptyPhased ? [] : await rows('#phasedTest')
    assert.equal(await coursePage.locator(SEL.doHomework).count(), 0)
    detected.push({ name: first.name, emptyOnline, emptyPhased, online, phased })
    for (const row of [...online, ...phased]) {
      const w = Number(String(row.weight).replace(/[^0-9.]/g, ''))
      if (!row.workType.includes('客观题') || !(w > 0) || !row.href) continue
      const preview = await context.newPage()
      await minimize(preview)
      const ph = row.href.startsWith('http') ? row.href : 'https://l.shou.org.cn' + row.href
      await preview.goto(ph, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await preview.locator(SEL.historyTable).waitFor({ timeout: 20000 }).catch(() => {})
      const path = new URL(preview.url()).pathname
      assert.equal(isAnswerPath(path), false)
      assert.equal(isPreviewPath(path), true)
      const hist = await preview.evaluate((sel) => {
        return [...document.querySelectorAll(sel + ' tbody tr')].map((tr) => {
          const tds = [...tr.querySelectorAll('td')]
          const status = (tds[3]?.textContent || '').trim()
          const scoreTitle = tds[4]?.getAttribute('title') || tds[4]?.textContent || ''
          const score = Number(String(scoreTitle).replace(/[^0-9.]/g, ''))
          return {
            status,
            score: Number.isFinite(score) ? score : null,
            hasContinue: !!tr.querySelector('a[href*="continuation.aspx"]'),
            hasHistoryView: !!tr.querySelector('a[href*="history.aspx"]'),
          }
        })
      }, SEL.historyTable)
      previews.push({
        course: first.name,
        hw: row.name,
        skip: skipFullScore(hist.map((h) => ({ ...h, submittedAt: '', hasHistoryView: false }))),
        path,
        href: ph,
        hist,
        doBtn: await preview.locator(SEL.doHomework).count(),
      })
      if (process.env.KAIDA_E2E_DUMP_HISTORY === '1' && hist.some((row) => row.hasHistoryView)) {
        await dumpHistoryStructure(preview)
        await dumpHistorySemantics(preview)
      }
      await preview.close()
    }
    await coursePage.close()
  }
  evidence.detected = detected
  evidence.previews = previews
  evidence.clickedDoHomework = false
  evidence.clickedContinue = false
  evidence.fullScoreSkip = previews.filter((p) => p.skip).map((p) => p.course + '/' + p.hw)
  const needDo = previews.filter((p) => !p.skip)
  evidence.needDo = needDo.map((p) => p.course + '/' + p.hw)
  if (process.env.KAIDA_E2E_DO === '1' && needDo[0]) {
    const target = needDo[0]
    const preview = await context.newPage()
    await minimize(preview)
    await preview.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await preview.locator(SEL.doHomework).first().waitFor({ timeout: 20000 })
    await preview.locator(SEL.doHomework).first().click()
    evidence.clickedDoHomework = true
    evidence.clickedContinue = false
    await preview.waitForTimeout(2000)
    await minimize(preview)
    const qr = await hasQr(preview)
    const after = new URL(preview.url())
    evidence.doHomework = {
      course: target.course,
      hw: target.hw,
      qr,
      path: after.pathname,
      isAnswer: isAnswerPath(after.pathname),
      windowMinimized: true,
    }
    writeFileSync('/tmp/kaida-e2e-evidence.json', JSON.stringify(evidence, null, 2))
    console.log('clicked 做作业', { course: target.course, hw: target.hw, qr, path: after.pathname })
    if (qr) {
      console.log('needs QR, window stays minimized; wait /tmp/kaida-e2e-verified or QR gone')
      await preview.waitForTimeout(8000)
      evidence.doHomework = { ...evidence.doHomework, hiddenMs: 8000 }
      writeFileSync('/tmp/kaida-e2e-evidence.json', JSON.stringify(evidence, null, 2))
      console.log('4.2 hidden with QR; restore as 打开可视化浏览器 stand-in, please scan WeChat QR')
      await restore(preview)
      evidence.restoredForScan = true
      writeFileSync('/tmp/kaida-e2e-evidence.json', JSON.stringify(evidence, null, 2))
      const start = Date.now()
      while (Date.now() - start < 45 * 60 * 1000) {
        if (existsSync('/tmp/kaida-e2e-verified')) break
        if (!(await hasQr(preview))) break
        await preview.waitForTimeout(5000)
      }
      evidence.qrGone = !(await hasQr(preview))
      evidence.verifiedFile = existsSync('/tmp/kaida-e2e-verified')
      if (evidence.qrGone) {
        evidence.answerPath = new URL(preview.url()).pathname
        evidence.isAnswer = isAnswerPath(evidence.answerPath)
      }
    }
    if (!qr || evidence.qrGone) {
      if (!(await isAnswerPath(new URL(preview.url()).pathname))) {
        if (await hasQr(preview)) {
          /* still blocked */
        } else if (await preview.locator(SEL.doHomework).count()) {
          await preview.locator(SEL.doHomework).first().click()
          await preview.waitForTimeout(2000)
        }
      }
      try {
        await preview.waitForURL((u) => isAnswerPath(u.pathname), { timeout: 20000 })
      } catch {}
      evidence.answerPath = new URL(preview.url()).pathname
      evidence.isAnswer = isAnswerPath(evidence.answerPath)
      if (evidence.isAnswer) {
        console.log('answering page', evidence.answerPath)
        evidence.answerSubmit = await answerAndSubmit(preview)
        writeFileSync('/tmp/kaida-e2e-evidence.json', JSON.stringify(evidence, null, 2))
        console.log('answered', {
          bank: evidence.answerSubmit.bankCount,
          ai: evidence.answerSubmit.aiCount,
          skip: evidence.answerSubmit.skipCount,
          okClicks: evidence.answerSubmit.okClicks,
          after: evidence.answerSubmit.after,
        })
      }
    }
  }
  writeFileSync('/tmp/kaida-e2e-evidence.json', JSON.stringify(evidence, null, 2))
  console.log('E2E scenter ok', {
    picked,
    courseCount: courses.length,
    none: detected.filter((d) => d.emptyOnline && d.emptyPhased).length,
    withHw: detected.filter((d) => !d.emptyOnline || !d.emptyPhased).map((d) => d.name),
    previews: previews.length,
    fullScoreSkip: evidence.fullScoreSkip,
    needDo: evidence.needDo,
    clickedDoHomework: evidence.clickedDoHomework,
  })
} finally {
  await context.close()
}
