import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { chromium } from 'patchright'
import ts from 'typescript'
import { SEL } from '../electron/core/selectors.ts'
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
const { detectCourse, listCourses } = await loadSource('electron/detect.ts') as {
  detectCourse: typeof import('../electron/detect.ts')['detectCourse']; listCourses: typeof import('../electron/detect.ts')['listCourses']
}

const goalFile = process.env.KAIDA_GOAL_FILE
assert.ok(goalFile, '缺少 KAIDA_GOAL_FILE')
const account = parseGoalAccounts(readFileSync(goalFile, 'utf8'))[Number(process.env.KAIDA_E2E_INDEX || 0)]
assert.ok(account, '测试账号序号无效')
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.KAIDA_DISPLAY_MODE !== 'visual' })
const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const pageErrors: string[] = []
const consoleIssues: string[] = []
context.on('page', page => {
  page.on('pageerror', error => pageErrors.push(error.name + ':' + error.message.slice(0, 80)))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const value = message.text()
    consoleIssues.push(/content security policy|refused to execute an inline script/i.test(value) ? 'csp-inline'
      : /failed to load resource/i.test(value) ? 'resource' : 'other')
  })
})
const portal = await context.newPage()
try {
  const login = await loginIam({ page: portal, local_id: 't003-preview-readonly', username: account.username,
    password: account.password, slot: 'occupied', onNeedVerify: async () => {} })
  assert.equal(login.ok, true, `真实站点登录失败：${login.reason || 'unknown'}，路径 ${new URL(portal.url()).pathname}，登录控件 ${await portal.locator('.content_submit').count()}`)
  const courses = await listCourses(portal, 't003-preview-readonly', 'occupied')
 let chosen: { pinned: boolean; section: string; buttonCount: number; hrefIsAnswer: boolean;
   onclickDoHomework: boolean; disabled: boolean; previewIsHistory: boolean } | null = null
  let guardedCount = 0
  let todoCount = 0
  for (const [index, course] of courses.entries()) {
    const detected = await detectCourse({ portal, href: course.href, key: course.key, courseName: course.name,
      local_id: 't003-preview-readonly', slot: 'occupied', index: index + 1, total: courses.length, mode: 'answer' })
    for (const homework of detected.homeworks) {
      if (!homework.page) continue
      try {
       if (chosen || homework.status !== 'todo') continue
        todoCount++
        const candidateScript = await homework.page.evaluate(() => [...document.scripts]
          .find(script => !script.src && /(?:function|const|let|var)\s+doHomework\b/.test(script.textContent || ''))?.textContent || '')
        const candidateSource = ts.createSourceFile('candidate.js', candidateScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
        const candidateFunction = candidateSource.statements.find((node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === 'doHomework')
        const candidateOuter = candidateFunction?.body?.statements.find(ts.isIfStatement)
        const candidateGuard = candidateOuter && ts.isBlock(candidateOuter.thenStatement)
          ? candidateOuter.thenStatement.statements.find(ts.isIfStatement)?.expression : undefined
        if (candidateGuard && ts.isStringLiteral(candidateGuard) && candidateGuard.text) { guardedCount++; continue }
       const button = homework.page.locator(SEL.doHomework)
        const count = await button.count()
        const href = count ? await button.first().getAttribute('href') : null
        const onclick = count ? await button.first().getAttribute('onclick') : null
        const disabled = count ? await button.first().getAttribute('disabled') : null
        chosen = { pinned: /^形势与政策[（(]\d+[）)]$/.test(course.name), section: homework.section,
          buttonCount: count, hrefIsAnswer: Boolean(href && new URL(href, homework.page.url()).pathname === '/study/assignment/preview.aspx'),
          onclickDoHomework: Boolean(onclick?.includes('doHomework')), disabled: disabled !== null,
          previewIsHistory: new URL(homework.page.url()).pathname === '/study/assignment-preview.aspx' }
        if (process.env.KAIDA_PROBE_CLICK === '1' && count) {
          const dialogs: string[] = []
          const responses: string[] = []
          homework.page.on('dialog', async dialog => {
            dialogs.push(`${dialog.type()}:${dialog.message().slice(0, 80)}`)
            await dialog.dismiss()
          })
         homework.page.on('response', response => {
           const path = new URL(response.url()).pathname
           if (path.includes('assignment') || path.includes('homework')) responses.push(`${response.status()}:${path}`)
         })
          const probeCdp = await homework.page.context().newCDPSession(homework.page)
          const clickSetup = await probeCdp.send('Runtime.evaluate', {
           expression: '(() => { const b = document.querySelector(' + JSON.stringify(SEL.doHomework) +
              '); const original = window.doHomework; const throttle = window.throttleHref; ' +
              'window.__t003Calls = 0; window.__t003ThrottleCalls = 0; if (typeof throttle === "function") ' +
              'window.throttleHref = function(...args) { window.__t003ThrottleCalls++; const value = throttle.apply(this, args); ' +
             'window.__t003ThrottleReturn = value === true ? "true" : value === false ? "false" : typeof value; return value }; ' +
             'const originalAlert = window.alert; window.__t003Alerts = 0; window.alert = function(...args) { ' +
             'window.__t003Alerts++; return originalAlert.apply(this, args) }; ' +
              'window.__t003Trace = {}; ["validateCheckStatus", "showQRCodeDialog", "doFaceInit", "handleHref"].forEach(name => { ' +
             'const fn = window[name]; if (typeof fn === "function") window[name] = function(...args) { ' +
              'window.__t003Trace[name] = (window.__t003Trace[name] || 0) + 1; ' +
              'const value = fn.apply(this, args); if (name === "validateCheckStatus") window.__t003Validation = Boolean(value); return value }; }); ' +
             'if (typeof original === "function") ' +
              'window.doHomework = function(...args) { window.__t003Calls++; const value = original.apply(this, args); ' +
              'window.__t003Return = value === false ? "false" : typeof value; return value }; ' +
              'return { onclick: typeof b?.onclick, defined: typeof original, throttle: typeof throttle }; })()',
            returnByValue: true,
          }).finally(() => probeCdp.detach())
          await button.first().click()
          await homework.page.waitForTimeout(5000)
          const sourceText = await homework.page.evaluate(() => [...document.scripts]
            .find(script => !script.src && /(?:function|const|let|var)\s+doHomework\b/.test(script.textContent || ''))?.textContent || '')
          const parsed = ts.createSourceFile('preview.js', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
          let functionDeclarations = 0
          let topLevelDeclaration = false
          const inspect = (node: ts.Node) => {
            if (ts.isFunctionDeclaration(node) && node.name?.text === 'doHomework') {
              functionDeclarations++
              if (node.parent === parsed) topLevelDeclaration = true
            }
            ts.forEachChild(node, inspect)
          }
         inspect(parsed)
          const homeworkFunction = parsed.statements.find((node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === 'doHomework')
          const guardNames = (node: ts.Node) => {
            const names: string[] = []
            const collect = (child: ts.Node) => {
              if (ts.isIdentifier(child)) names.push(child.text)
              ts.forEachChild(child, collect)
            }
            collect(node)
            return [...new Set(names)]
          }
         const functionShape = homeworkFunction?.body?.statements.map(statement =>
           ts.SyntaxKind[statement.kind] + ':' + (ts.isIfStatement(statement) ? guardNames(statement.expression).join(',') : ''))
          const outerGuard = homeworkFunction?.body?.statements.find(ts.isIfStatement)
          const firstGuard = outerGuard && ts.isBlock(outerGuard.thenStatement)
            ? outerGuard.thenStatement.statements.find(ts.isIfStatement)?.expression : undefined
          const firstGuardState = firstGuard && ts.isStringLiteral(firstGuard)
            ? { kind: 'string', nonEmpty: Boolean(firstGuard.text), length: firstGuard.text.length }
            : { kind: firstGuard ? ts.SyntaxKind[firstGuard.kind] : 'missing' }
          const scrubbedFunction = homeworkFunction && (() => {
            const transformed = ts.transform(homeworkFunction, [context => root => ts.visitNode(root, function visit(node) {
              if (ts.isStringLiteralLike(node)) return ts.factory.createStringLiteral('[string]')
              if (ts.isNumericLiteral(node)) return ts.factory.createNumericLiteral(0)
              return ts.visitEachChild(node, visit, context)
            })])
            const printed = ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0], parsed)
            transformed.dispose()
            return printed.slice(1400, 3500)
          })()
          const cdp = await homework.page.context().newCDPSession(homework.page)
          const mainWorld = await cdp.send('Runtime.evaluate', {
            expression: "({ defined: typeof doHomework === 'function', lexical: typeof doHomework, calls: window.__t003Calls, returned: window.__t003Return, throttleCalls: window.__t003ThrottleCalls, throttleReturned: window.__t003ThrottleReturn, trace: window.__t003Trace, validated: window.__t003Validation, alerts: window.__t003Alerts })",
            returnByValue: true,
          }).finally(() => cdp.detach())
          console.log('T003 真实入口点击后', {
            clickSetup: clickSetup.result?.value,
           scriptDeclaration: { functionDeclarations, topLevelDeclaration, parseErrors: parsed.parseDiagnostics.length },
           functionShape,
            firstGuardState,
            scrubbedFunction,
            mainWorld: mainWorld.result?.value,
            paths: homework.page.context().pages().map(page => new URL(page.url()).pathname),
            qrCount: await homework.page.locator('#dl_qrCodeCheck').count(),
            qrVisible: await homework.page.locator('#dl_qrCodeCheck').isVisible().catch(() => false),
            answerBodies: await homework.page.locator('.e-q-body').count(),
            handler: await homework.page.evaluate(() => ({
              exists: typeof (window as Window & { doHomework?: unknown }).doHomework === 'function',
              lexical: (0, eval)('typeof doHomework'),
              inlineDefines: [...document.scripts].filter(script => !script.src)
                .map(script => [/(?:function|const|let|var)\s+doHomework\b/.test(script.textContent || '') ? 'defines' : 'other',
                  script.type || 'classic', script.isConnected, script.async, script.defer].join(':')),
              inlineSyntax: [...document.scripts].filter(script => !script.src).map(script => {
                try { new Function(script.textContent || ''); return 'valid' }
                catch (error) { return error instanceof Error ? `${error.name}:${error.message}` : 'invalid' }
              }),
              scripts: [...document.scripts].map(script => script.src ? new URL(script.src).pathname : 'inline'),
            })),
            buttonHandler: { calls: onclick?.match(/[A-Za-z_$][\w$]*(?=\()/g),
              target: await button.first().getAttribute('target') },
           dialogs, responses, pageErrors,
            consoleIssues,
          })
        }
      } finally { await homework.page.close() }
    }
  }
  console.log('T003 真实预览只读结构', { courseCount: courses.length, todoCount, guardedCount, chosen })
} finally {
  await context.close()
  await browser.close()
}
