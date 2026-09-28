import assert from 'node:assert/strict'
import { chromium } from 'patchright'
import { SEL, PATH } from '../electron/core/selectors.ts'

/** 产品 Playwright 从学习中心进入 IAM，不代替本机 Chrome。无账密时只验选择器。 */
const url = 'https://learning.shou.org.cn/scenter'

const browser = await chromium.launch({ headless: false })
const context = await browser.newContext()
const page = await context.newPage()
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2000)
  const user = await page.locator(SEL.iamUser).count()
  const pass = await page.locator(SEL.iamPass).count()
  const sub = await page.locator(SEL.iamSubmit).count()
  assert.ok(page.url().includes(PATH.iamHost), '学习中心未按预期跳转到 IAM 登录页')
  assert.ok(user > 0, '学号/账号输入框')
  assert.ok(pass > 0, '密码输入框')
  assert.ok(sub > 0, '登录按钮')
  console.log('E2E IAM selectors ok', { user, pass, sub, host: new URL(page.url()).host })
} finally {
  await browser.close()
}
