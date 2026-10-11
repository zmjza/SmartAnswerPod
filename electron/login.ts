import type { BrowserContext, Page, Route } from 'patchright'
import { request as pwRequest } from 'patchright'
import { PATH, SEL, learningCenterVersion, prepareNewLearningCenter, checkOldLearningCenter } from './core/selectors.ts'
import { emitProgress } from './progress.ts'
import type { AccountState, SlotState } from './core/states.ts'
import { hasQr } from './page-tools.ts'

const SCENTER = 'https://learning.shou.org.cn/scenter'
const PORTAL_HOST = 'learning.shou.org.cn'
const STUDY_HOME = 'https://l.shou.org.cn/'

type OauthHit = { status: number; len: number; json: boolean; ok?: boolean }
type Asset = { body: Buffer; contentType: string; headers: Record<string, string> }
type PortalGate = {
  code: string
  html: string
  assets: Map<string, Asset>
  xh: string
  armed?: boolean
}

const gates = new WeakMap<BrowserContext, PortalGate>()

async function fillIam(page: Page, user: string, pass: string) {
  await page.evaluate(
    ({ user, pass }) => {
      const vis = (el: HTMLInputElement) => el.getBoundingClientRect().width > 80
      const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
      const u =
        inputs.find((el) => vis(el) && /学号|工号|账号/.test(el.placeholder || '')) ||
        inputs.find((el) => vis(el) && el.type === 'text')
      const p = inputs.find((el) => vis(el) && el.type === 'password')
      const setVal = (el: HTMLInputElement, v: string) => {
        el.focus()
        el.value = ''
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.blur()
      }
      if (u) setVal(u, user)
      if (p) setVal(p, pass)
      for (const el of document.querySelectorAll('*')) {
        const v = (el as unknown as { __vue__?: { $options?: { name?: string }; content_input?: string; content_password?: string } }).__vue__
        if (v?.$options?.name === 'login-model') {
          v.content_input = user
          v.content_password = pass
        }
      }
      const sub = document.querySelector('.content_submit')
      sub?.removeAttribute('disabled')
      sub?.classList.remove('is-disabled')
    },
    { user, pass },
  )
}

async function submitIam(page: Page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const v = (el as unknown as { __vue__?: { $options?: { name?: string }; submitLogin?: () => unknown } }).__vue__
      if (v?.$options?.name === 'login-content' && typeof v.submitLogin === 'function') {
        v.submitLogin()
        return 'submitLogin'
      }
    }
    ;(document.querySelector('.content_submit') as HTMLElement | null)?.click()
    return 'click'
  })
}

function isPortalAsset(path: string) {
  return path.startsWith('/assets/') || path === '/favicon.ico'
}

function corsHeaders(h: Record<string, string>, ct: string) {
  const out: Record<string, string> = {
    'content-type': ct,
    'access-control-allow-origin': h['access-control-allow-origin'] || '*',
    'access-control-allow-credentials': h['access-control-allow-credentials'] || 'true',
  }
  return out
}

function htmlPaths(html: string) {
  const paths = new Set<string>()
  const re = /(?:src|href)=["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    let p = m[1]
    if (p.startsWith('./')) p = p.slice(1)
    if (!p.startsWith('/') || p.startsWith('//')) continue
    p = p.split('?')[0]
    if (p.startsWith('/assets/') || p === '/favicon.ico') paths.add(p)
  }
  return paths
}

async function warmAssets(ctx: BrowserContext, g: PortalGate) {
  if (!g.html) return
  for (const path of htmlPaths(g.html)) {
    if (g.assets.has(path)) continue
    const r = await ctx.request.get(`https://${PORTAL_HOST}${path}`, { headers: { Referer: SCENTER } }).catch(() => null)
    if (!r || r.status() !== 200) continue
    const headers = r.headers()
    g.assets.set(path, {
      body: await r.body(),
      contentType: headers['content-type'] || 'application/javascript',
      headers,
    })
  }
}

async function fetchBare(url: string) {
  const tmp = await pwRequest.newContext()
  try {
    const r = await tmp.get(url, { maxRedirects: 0, timeout: 20000 })
    const setCookies = r
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value)
    return {
      status: r.status(),
      body: await r.body(),
      headers: r.headers(),
      contentType: r.headers()['content-type'] || '',
      setCookies,
    }
  } finally {
    await tmp.dispose()
  }
}

async function xhrHooked(page: Page) {
  return page
    .evaluate(() => {
      try {
        return !XMLHttpRequest.prototype.open.toString().includes('[native code]')
      } catch {
        return false
      }
    })
    .catch(() => false)
}

async function waitHooked(page: Page, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await xhrHooked(page)) return true
    await page.waitForTimeout(200)
  }
  return xhrHooked(page)
}

async function hasEnable(ctx: BrowserContext) {
  const names = (await ctx.cookies('https://' + PORTAL_HOST)).map((c) => c.name)
  return names.some((n) => n.startsWith('enable_'))
}

async function waitEnable(ctx: BrowserContext, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await hasEnable(ctx)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return hasEnable(ctx)
}

async function installPortalGate(page: Page): Promise<PortalGate> {
  const ctx = page.context()
  const old = gates.get(ctx)
  if (old) return old
  const g: PortalGate = { code: '', html: '', assets: new Map(), xh: '', armed: false }
  gates.set(ctx, g)
  ctx.on('response', (res) => {
    const u = res.url()
    if (!u.includes(PORTAL_HOST)) return
    let path = ''
    try {
      path = new URL(u).pathname
    } catch {
      return
    }
    const st = res.status()
    if (path === '/scenter' && st === 200) {
      void res
        .text()
        .then((t) => {
          if (t.includes('assets/') && t.length > 2000) g.html = t
        })
        .catch(() => {})
    }
    if (st === 200 && isPortalAsset(path)) {
      void res
        .body()
        .then((body) => {
          g.assets.set(path, {
            body,
            contentType: res.headers()['content-type'] || 'application/javascript',
            headers: res.headers(),
          })
        })
        .catch(() => {})
    }
  })
  return g
}

async function armPortalIntercept(page: Page) {
  const ctx = page.context()
  const g = gates.get(ctx)
  if (!g || g.armed) return
  g.armed = true
  await ctx.route(
    (url) =>
      url.hostname === PORTAL_HOST &&
      (url.pathname === '/login' ||
        url.pathname === '/scenter' ||
        isPortalAsset(url.pathname)),
    async (route: Route) => {
    const req = route.request()
    const u = new URL(req.url())
    const path = u.pathname
    const method = req.method()
    const isDoc = req.resourceType() === 'document' || req.isNavigationRequest()

    if (path === '/scenter' && method === 'GET' && isDoc) {
      await route.continue()
      return
    }

    if (path === '/login' && method === 'GET' && isDoc) {
      const code = u.searchParams.get('code') || ''
      if (code) g.code = code
      if (g.html) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: g.html,
          headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
        })
        return
      }
      await route.continue()
      return
    }

    if (isPortalAsset(path) && method === 'GET') {
      const cached = g.assets.get(path)
      if (cached) {
        await route.fulfill({
          status: 200,
          contentType: cached.contentType,
          headers: corsHeaders(cached.headers, cached.contentType),
          body: cached.body,
        })
        return
      }
      const ch = await fetchBare(`https://${PORTAL_HOST}${path}`).catch(() => null)
      if (ch && ch.status === 200) {
        const ct = ch.contentType || 'application/javascript'
        g.assets.set(path, { body: ch.body, contentType: ct, headers: ch.headers })
        await route.fulfill({
          status: 200,
          contentType: ct,
          headers: corsHeaders(ch.headers, ct),
          body: ch.body,
        })
        return
      }
      await route.continue()
      return
    }

    await route.continue()
  },
  )
  return g
}

async function exchangeCode(page: Page, code: string): Promise<OauthHit> {
  return page.evaluate(async (code) => {
    const text = await new Promise<string>((resolve, reject) => {
      const x = new XMLHttpRequest()
      x.open('POST', '/api/auth/oauth-login')
      x.setRequestHeader('Content-Type', 'application/json')
      x.withCredentials = true
      x.onload = () => resolve(String(x.status) + '|' + x.responseText)
      x.onerror = () => reject(new Error('xhr'))
      x.send(JSON.stringify({ code }))
    })
    let json = false
    let ok = false
    let status = 0
    try {
      const nl = text.indexOf('|')
      status = Number(text.slice(0, nl))
      const body = text.slice(nl + 1)
      const j = JSON.parse(body) as { code?: number; result?: { token?: string; userInfo?: { userType?: string } } }
      json = true
      const token = j.result && j.result.token
      if (j.code === 200 && token) {
        window.localStorage.setItem('token', JSON.stringify({ token, expire: Date.now() + 3600 * 1000 }))
        if (j.result && j.result.userInfo) {
          window.localStorage.setItem('META_USER__', JSON.stringify(j.result.userInfo))
          if (j.result.userInfo.userType) window.localStorage.setItem('META_TYPE__', j.result.userInfo.userType)
        }
        ok = true
      }
    } catch {}
    return { status, len: text.length, json, ok }
  }, code)
}

async function finishPortal(page: Page, g: PortalGate, xh: string): Promise<boolean> {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (await hasPortal(page)) return true
    await page.waitForTimeout(200)
  }
  return hasPortal(page)
}

async function loadCourses(page: Page, g: PortalGate) {
  if (learningCenterVersion(page) === 'new') return prepareNewLearningCenter(page)
  await checkOldLearningCenter(page)
  if ((await page.locator(SEL.courseItem).count()) > 0) return
  await waitHooked(page, 8000)
  if (g.code) {
    const ex = await exchangeCode(page, g.code).catch(() => ({ status: 0, len: 0, json: false, ok: false }))
    if (ex.ok) {
      await page.goto(STUDY_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(1500)
      if (!(await hasPortal(page))) {
        await page.goto(SCENTER, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      }
      if (learningCenterVersion(page) === 'new') return prepareNewLearningCenter(page)
      await waitHooked(page, 8000)
    }
  }
  await page.locator(SEL.courseItem).first().waitFor({ timeout: 12000 }).catch(() => {})
  await checkOldLearningCenter(page)
}

async function hasPortal(page: Page): Promise<boolean> {
  const version = learningCenterVersion(page)
  if (version === 'new') return (await page.locator(SEL.learningNav).count()) > 0 || (await page.locator(SEL.learningCourses).count()) > 0
  return version === 'old' && (await page.locator(SEL.tabCourseList).count()) > 0
}

export async function loginIam(opts: {
  page: Page
  local_id: string
  username: string
  password: string
  slot: SlotState
  onNeedVerify: () => Promise<void>
}): Promise<{ ok: boolean; reason?: 'login_failed' | 'needs_verify' | 'timeout'; account: AccountState }> {
  const { page, local_id, username, password, slot } = opts
  const gate = await installPortalGate(page)
  gate.xh = username
  emitProgress({ local_id, slot, account: 'logging_in', action: '打开学习中心', bankCount: 0, aiCount: 0, click: 'goto scenter' })
  await page.goto(SCENTER, { waitUntil: 'domcontentloaded', timeout: 30000 })
  if (await hasPortal(page)) {
    await loadCourses(page, gate)
    emitProgress({ local_id, slot, account: 'logged_in', action: '进入学习中心', bankCount: 0, aiCount: 0 })
    return { ok: true, account: 'logged_in' }
  }
  await waitEnable(page.context(), 8000)
  await armPortalIntercept(page)
  for (let i = 0; i < 25 && !gate.html; i++) await page.waitForTimeout(100)
  if (!gate.html) {
    const r = await page.context().request.get(SCENTER, { maxRedirects: 0 }).catch(() => null)
    if (r && r.status() === 200) {
      const t = await r.text()
      if (t.includes('assets/')) gate.html = t
    }
  }
  await warmAssets(page.context(), gate)
  await waitHooked(page, 8000)
  await Promise.race([
    page.locator(SEL.tabCourseList).waitFor({ timeout: 20000 }),
    page.locator(SEL.learningNav).waitFor({ timeout: 20000 }),
    page.locator(SEL.learningCourses).waitFor({ timeout: 20000 }),
    page.locator('.content_submit').waitFor({ timeout: 20000 }),
  ]).catch(() => {})

  if (await hasPortal(page)) {
    await loadCourses(page, gate)
    emitProgress({ local_id, slot, account: 'logged_in', action: '进入学习中心', bankCount: 0, aiCount: 0 })
    return { ok: true, account: 'logged_in' }
  }

  try {
    await page.locator('.content_submit').waitFor({ state: 'visible', timeout: 15000 })
  } catch {
    if (await hasPortal(page)) {
      await loadCourses(page, gate)
      return { ok: true, account: 'logged_in' }
    }
    return { ok: false, reason: 'timeout', account: 'login_failed' }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    await fillIam(page, username, password)
    await page.waitForTimeout(600)
    emitProgress({ local_id, slot, account: 'logging_in', action: '点击登录', bankCount: 0, aiCount: 0, click: 'iam submitLogin' })
    const pendingAuth = page.waitForResponse((r) => r.url().includes('authExecute') && r.status() === 200, { timeout: 12000 }).catch(() => null)
    await submitIam(page)
    await pendingAuth
    const err = await page.locator(SEL.iamError).first().textContent().catch(() => '')
    if (err && (err.includes('认证失败') || err.includes('密码错误'))) {
      if (attempt === 2) return { ok: false, reason: 'login_failed', account: 'login_failed' }
      continue
    }
    const face = await page.locator('iframe[src*="face"]').count().catch(() => 0)
    if ((await hasQr(page) || face > 0) && page.url().includes(PATH.iamHost)) {
      emitProgress({ local_id, slot, account: 'needs_verify', action: 'IAM 需验证', bankCount: 0, aiCount: 0 })
      await opts.onNeedVerify()
    }
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      if (await hasPortal(page)) break
      if (gate.code) break
      await page.waitForTimeout(200)
    }
    if (await hasPortal(page) || gate.code) break
    if (page.url().includes(PATH.iamHost) && (await page.locator('.content_submit').count())) {
      if (attempt === 2) break
      continue
    }
    break
  }

  if (!(await hasPortal(page))) {
    const ok = await finishPortal(page, gate, username)
    if (!ok) return { ok: false, reason: 'timeout', account: 'login_failed' }
  }
  if (!(await hasPortal(page))) {
    return { ok: false, reason: 'timeout', account: 'login_failed' }
  }
  await loadCourses(page, gate)
  emitProgress({ local_id, slot, account: 'logged_in', action: '进入学习中心', bankCount: 0, aiCount: 0 })
  return { ok: true, account: 'logged_in' }
}
