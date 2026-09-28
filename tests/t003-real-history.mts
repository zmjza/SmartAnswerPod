import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chromium } from 'patchright'
import { build } from 'esbuild'
import { parseGoalAccounts } from './helpers/goal-accounts.mjs'

const require = createRequire(import.meta.url)
const loadSource = async (entry: string) => {
  const built = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', write: false })
  const module = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports)
  return module.exports
}
const { loginIam } = await loadSource('electron/login.ts') as { loginIam: typeof import('../electron/login.ts')['loginIam'] }
const { detectCourse, listCourses, readHistory } = await loadSource('electron/detect.ts') as {
  detectCourse: typeof import('../electron/detect.ts')['detectCourse']
  listCourses: typeof import('../electron/detect.ts')['listCourses']
  readHistory: typeof import('../electron/detect.ts')['readHistory']
}

const goalFile = process.env.KAIDA_GOAL_FILE
assert.ok(goalFile, '缺少 KAIDA_GOAL_FILE')
const accounts = parseGoalAccounts(readFileSync(goalFile, 'utf8'))
const index = Number(process.env.KAIDA_E2E_INDEX || 0)
assert.ok(Number.isInteger(index) && accounts[index], '测试账号序号无效')
const reviewBuilt = await build({ entryPoints: ['electron/review.ts'], bundle: true, platform: 'node',
  format: 'esm', write: false, plugins: [{ name: 'readonly-bank', setup(plugin) {
    plugin.onResolve({ filter: /^\.\/bank\.ts$/ }, () => ({ path: 'bank', namespace: 'readonly' }))
    plugin.onLoad({ filter: /.*/, namespace: 'readonly' }, () => ({
      contents: "export const upsertQuestion = async () => { throw new Error('只读探针禁止写库') }; export const deleteByHash = upsertQuestion",
      loader: 'js',
    }))
  } }] })
const { readReviewedQuestions } = await import('data:text/javascript;base64,' +
  Buffer.from(reviewBuilt.outputFiles[0].text).toString('base64'))
const browser = await chromium.launch({ channel: 'chrome', headless: false })
const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const page = await context.newPage()
try {
  const account = accounts[index]
  const login = await loginIam({ page, local_id: 't003-readonly', username: account.username,
    password: account.password, slot: 'occupied', onNeedVerify: async () => {} })
  assert.ok(login.ok, '学习中心登录未成功')
  const courses = await listCourses(page, 't003-readonly', 'occupied')
  console.log('course-summary', { total: courses.length, pinned: courses.filter(c => /^形势与政策[（(]\d+[）)]$/.test(c.name)).length, english: courses.filter(c => c.name.includes('英语')).length })
  let historyCount = 0
  for (const course of courses.filter(c => c.name.includes('英语'))) {
    const detected = await detectCourse({ portal: page, href: course.href, key: course.key,
      courseName: course.name, local_id: 't003-readonly', slot: 'occupied', index: 1,
      total: courses.length, mode: 'extract' })
    for (const homework of detected.homeworks) {
      if (!homework.page) continue
      try {
        const histories = (await readHistory(homework.page)).filter(row => row.status.includes('已批阅') && row.historyHref)
        for (const row of histories.slice(0, 1)) {
          const history = await context.newPage()
          try {
            await history.goto(new URL(row.historyHref, 'https://l.shou.org.cn').href, { waitUntil: 'domcontentloaded' })
            await history.locator('.e-q-body').first().waitFor({ timeout: 15000 })
            const structure = await history.locator('.e-q-body').evaluateAll(bodies => bodies.map(body => ({
              type: body.getAttribute('data-questiontype') || '',
              forms: body.querySelectorAll('form').length,
              answers: body.querySelectorAll('form [name="answer"]').length,
              references: body.querySelectorAll('.e-ans-ref').length,
              subReferences: [...body.querySelectorAll('form')].map(form => form.querySelectorAll('.e-ans-ref').length),
              right: body.querySelectorAll('.e-q-right').length,
              wrong: body.querySelectorAll('.e-q-wrong').length,
              optionGroups: [...body.querySelectorAll('.e-a-g')].map(group => group.className).slice(0, 4),
              referenceChildren: [...body.querySelectorAll('.e-ans-ref')].map(ref => [...ref.children].map(child => [child.tagName, child.className, child.children.length])),
              referenceLetters: body.querySelectorAll('.e-ans-ref span.e-ans-r').length,
              referenceChecked: body.querySelectorAll('.e-ans-ref p.checked').length,
              referenceTextLength: [...body.querySelectorAll('.e-ans-ref')].map(ref => (ref.textContent || '').trim().length),
              referenceLetterCount: [...body.querySelectorAll('.e-ans-ref')].map(ref => ((ref.textContent || '').match(/[A-Z]/gi) || []).length),
              selectCount: body.querySelectorAll('select').length,
              matchingRightCount: body.querySelectorAll('.e-short-a .am-u-offset-1.am-u-sm-5 .ErichText').length,
              formChildren: [...body.querySelectorAll('form')].slice(0, 2).map(form => [...form.children].map(child => child.className)),
              formRight: [...body.querySelectorAll('form')].map(form => form.querySelectorAll('.e-q-right').length),
              formWrong: [...body.querySelectorAll('form')].map(form => form.querySelectorAll('.e-q-wrong').length),
              selectedOptions: [...body.querySelectorAll('form')].map(form => form.querySelectorAll('li.e-a.checked').length),
              directChildren: [...(body.querySelector('.e-q')?.children || [])].map(child => child.className),
            })))
            if (!historyCount) console.log('history-structure', JSON.stringify({ accountIndex: index,
              homeworkSection: homework.section, parentCount: structure.length,
              composite: structure.filter(row => ['7', '8', '9', '11'].includes(row.type)) }))
            const evidence = await history.locator('.e-q-body[data-questiontype="11"], .e-q-body[data-questiontype="7"]').evaluateAll(bodies => ({
              listening: bodies.filter(body => body.getAttribute('data-questiontype') === '11').map(body => ({
                transcript: body.querySelectorAll('[data-transcript], .transcript').length,
                mediaLinks: body.querySelectorAll('a[href], a[data-url], audio[src]').length,
                media: [...body.querySelectorAll('a[href], a[data-url], audio[src]')].map(node => {
                  const attribute = ['data-url', 'href', 'src'].find(name => node.getAttribute(name)) || ''
                  const value = node.getAttribute(attribute) || ''
                  try {
                    const url = new URL(value, document.baseURI)
                    const href = node.getAttribute('href')
                    const hrefUrl = href ? new URL(href, document.baseURI) : null
                    return { attribute, sameOrigin: url.origin === location.origin,
                      extension: url.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || 'none',
                      hrefProtocol: hrefUrl?.protocol || 'missing',
                      hrefExtension: hrefUrl?.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || 'none' }
                  } catch { return { attribute, sameOrigin: false, extension: 'invalid' } }
                }),
              })),
              matching: bodies.filter(body => body.getAttribute('data-questiontype') === '7').map(body => ({
                references: body.querySelectorAll('.e-ans-ref span.e-ans-r, .e-ans-ref p.checked').length,
                selects: body.querySelectorAll('select').length,
              })),
            }))
            if (!historyCount) {
              const audioHead = await history.locator('.e-q-body[data-questiontype="11"] a[data-url]').first().evaluate(async node => {
                const value = node.getAttribute('data-url')
                if (!value) return { status: 0, type: 'missing', bytes: 'unknown' }
                try {
                  const response = await fetch(new URL(value, document.baseURI), { method: 'HEAD', credentials: 'include' })
                  return { status: response.status, type: response.headers.get('content-type') || 'unknown',
                    bytes: response.headers.get('content-length') || 'unknown' }
                } catch { return { status: 0, type: 'fetch-failed', bytes: 'unknown' } }
              })
              console.log('audio-head', audioHead)
              const audioGet = await history.locator('.e-q-body[data-questiontype="11"] a[data-url]').first().evaluate(async node => {
                const value = node.getAttribute('data-url')
                if (!value) return { status: 0, type: 'missing', format: 'unknown' }
                try {
                  const response = await fetch(new URL(value, document.baseURI), { credentials: 'include',
                    headers: { Range: 'bytes=0-15' } })
                  const reader = response.body?.getReader()
                  const first = (await reader?.read())?.value || new Uint8Array()
                  await reader?.cancel()
                  const format = first[0] === 0x49 && first[1] === 0x44 && first[2] === 0x33 ? 'mp3-id3'
                    : first[0] === 0xff && (first[1] & 0xe0) === 0xe0 ? 'mp3-frame' : first[0] === 0x3c ? 'html' : 'unknown'
                  return { status: response.status, type: response.headers.get('content-type') || 'unknown',
                    redirected: response.redirected, format }
                } catch { return { status: 0, type: 'fetch-failed', format: 'unknown' } }
              })
              console.log('audio-get', audioGet)
              const audioResponses: { status: number; type: string }[] = []
              history.on('response', response => {
                const type = response.headers()['content-type'] || ''
                if (/audio|mpeg/i.test(type) || /\.mp3(?:\?|$)/i.test(response.url()))
                  audioResponses.push({ status: response.status(), type })
              })
              const play = await history.locator('.e-q-body[data-questiontype="11"] a[data-url]').first()
                .click({ timeout: 5000 }).then(() => 'clicked', () => 'click-failed')
              await history.waitForTimeout(2000)
              console.log('audio-click', { play, responses: audioResponses, pages: context.pages().length })
            }
            try {
              const parsed = await readReviewedQuestions(history)
              console.log('history-evidence', JSON.stringify({ ordinal: historyCount + 1,
                parentCount: structure.length, rows: parsed.length,
                valid: parsed.filter(item => item.referenceState === 'valid').length,
                absent: parsed.filter(item => item.referenceState === 'absent').length,
                invalid: parsed.filter(item => item.referenceState === 'invalid').length,
                hashed: parsed.filter(item => item.hash).length, ...evidence }))
            } catch (error) { console.log('history-parser-error', error instanceof Error ? error.message : 'unknown') }
            historyCount++
          } finally { await history.close() }
        }
      } finally { await homework.page.close() }
    }
  }
  console.log('history-summary', { accountIndex: index, readable: historyCount })
} finally {
  await context.close()
  await browser.close()
}
