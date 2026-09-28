import assert from 'node:assert/strict'
import { _electron as electron } from 'patchright'

const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
const fakeName = 'E2E 临时学生 ' + Date.now()
const fakeAccount = 'e2e-temp-' + Date.now()
const fakePassword = ['e2e', 'temp', Date.now()].join('-')
const overflowName = 'E2E 布局临时学生 ' + Date.now()
const overflowAccount = 'e2e-overflow-' + Date.now()
let added = false
let overflowAdded = false
let renderer
let originalBrowserDefault
let browserDefaultChanged = false
let originalAccountParallel
let accountParallelChanged = false

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  renderer = (source) => app.evaluate(({ BrowserWindow }, script) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
  const before = await renderer('window.kaida.listAccounts()')
  const settings = await renderer('window.kaida.getSettings()')
  originalBrowserDefault = Boolean(settings.browser_visible_default)
  originalAccountParallel = settings.account_parallel
  if (settings.account_parallel !== 1) {
    const result = await renderer('window.kaida.saveSettings({ account_parallel: 1 })')
    assert.equal(result.ok, true, result.error || '无法准备学生菜单布局测试')
    accountParallelChanged = true
  }
  if (originalBrowserDefault) {
    const result = await renderer('window.kaida.saveSettings({ browser_visible_default: false })')
    assert.equal(result.ok, true, result.error || '无法准备默认无头账号测试')
    browserDefaultChanged = true
  }

  await page.getByText('学生账号', { exact: true }).first().click()
  await page.getByRole('heading', { name: '学生账号管理' }).waitFor()
  await page.getByRole('button', { name: '+ 新增学员' }).click()
  await page.getByPlaceholder('如 张明').waitFor()
  await page.getByPlaceholder('如 张明').fill(fakeName)
  await page.getByPlaceholder('如 20240101').fill(fakeAccount)
  await page.getByPlaceholder('••••••••').fill(fakePassword)
  await page.getByRole('button', { name: '保存并添加' }).click()
  added = true
  await page.getByText(fakeName, { exact: true }).waitFor()
  const overflowResult = await renderer('window.kaida.addAccount(' + JSON.stringify({ name: overflowName, username: overflowAccount, password: fakePassword }) + ')')
  assert.equal(overflowResult.ok, true, overflowResult.error || '无法准备更多学生菜单布局测试')
  overflowAdded = true
  assert.equal(await page.locator("#accounts-grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length), 3, '学生账号卡片应在桌面端一行显示三个')
  const defaultSnapshot = await renderer('window.kaida.snapshot()')
  const defaultStudent = defaultSnapshot.students.find((item) => item.name === fakeName)
  assert.equal(defaultStudent?.workMode, 'answer', '新学生默认工作模式不是答题')
  assert.equal(defaultStudent?.courseScope, 'all', '新学生默认课程范围不是全部自动执行')
  assert.equal(defaultStudent?.displayMode, 'headless', '新学生默认浏览器模式不是无头')

  const search = page.getByPlaceholder(/搜索姓名、学号/)
  await search.fill(fakeName)
  const card = page.locator('div.group.relative').filter({ hasText: fakeName }).first()
  await card.waitFor()
  await card.getByRole('button', { name: '编辑' }).click()
  await card.getByPlaceholder('新密码（留空保持）').waitFor()
  await card.getByRole('button', { name: '取消' }).click()
  assert.equal(await card.getByPlaceholder('新密码（留空保持）').count(), 0, '编辑取消没有关闭编辑区')

  await card.getByRole('button', { name: '编辑' }).click()
  await card.locator('input[placeholder="姓名"]').fill(fakeName + ' Updated')
  await card.getByRole('button', { name: '保存' }).click()
  await page.getByText(fakeName + ' Updated', { exact: true }).waitFor()

  const updatedCard = page.locator('div.group.relative').filter({ hasText: fakeName + ' Updated' }).first()
  await updatedCard.getByRole('button', { name: '查看工作台' }).click()
  await page.locator('#student-id').waitFor()
  const visibleStudent = await page.locator('#student-switcher .student-pill').last().boundingBox()
  const moreMenu = await page.locator('#student-more').boundingBox()
  assert.ok(visibleStudent && moreMenu, '当前学生之外应有可展开的更多学生菜单')
  assert.ok(Math.abs((visibleStudent.y + visibleStudent.height / 2) - (moreMenu.y + moreMenu.height / 2)) < 2, '更多学生菜单应与最后一行学生胶囊水平对齐')
  assert.ok(moreMenu.x > visibleStudent.x, '更多学生菜单应位于最后一行学生胶囊右侧')
  assert.equal(await page.locator('#student-id').innerText(), fakeAccount, '查看工作台没有切换到新增学生')

  await page.getByText('学生账号', { exact: true }).first().click()
  await page.getByRole('heading', { name: '学生账号管理' }).waitFor()
  await page.getByPlaceholder(/搜索姓名、学号/).fill(fakeName + ' Updated')
  const finalCard = page.locator('div.group.relative').filter({ hasText: fakeName + ' Updated' }).first()
  await finalCard.waitFor()
  await finalCard.getByTitle('删除账号').click()
  await page.getByText(fakeName + ' Updated', { exact: true }).waitFor({ state: 'detached' })
  const overflowAccountRecord = (await renderer('window.kaida.listAccounts()')).find((item) => item.account === overflowAccount)
  assert.ok(overflowAccountRecord, '布局测试临时学生不存在')
  await renderer('window.kaida.removeAccount(' + JSON.stringify(overflowAccountRecord.local_id) + ')')
  await page.waitForFunction(async (count) => (await window.kaida.listAccounts()).length === count, before.length)
  overflowAdded = false
  const after = await renderer('window.kaida.listAccounts()')
  assert.equal(after.length, before.length, '临时学生删除后账号数量未恢复')
  assert.equal(after.some((item) => item.account === fakeAccount), false, '临时学生删除后仍残留')
  added = false
  console.log(JSON.stringify({ ok: true, added: true, editCancelled: true, editSaved: true, switched: true, deleted: true }))
} finally {
  if (added && renderer) {
    const accounts = await renderer('window.kaida.listAccounts()').catch(() => [])
    const target = accounts.find((item) => item.name.startsWith('E2E 临时学生'))
    if (target) await renderer('window.kaida.removeAccount(' + JSON.stringify(target.local_id) + ')').catch(() => {})
  }
  if (overflowAdded && renderer) {
    const accounts = await renderer('window.kaida.listAccounts()').catch(() => [])
    const target = accounts.find((item) => item.account === overflowAccount)
    if (target) await renderer('window.kaida.removeAccount(' + JSON.stringify(target.local_id) + ')').catch(() => {})
  }
  if (browserDefaultChanged && renderer) {
    await renderer('window.kaida.saveSettings({ browser_visible_default: ' + JSON.stringify(originalBrowserDefault) + ' })').catch(() => {})
  }
  if (accountParallelChanged && renderer) {
    await renderer('window.kaida.saveSettings({ account_parallel: ' + JSON.stringify(originalAccountParallel) + ' })').catch(() => {})
  }
  await app.close()
}
