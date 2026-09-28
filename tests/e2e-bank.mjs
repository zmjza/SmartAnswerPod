import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { _electron as electron } from 'patchright'
import { contentHash } from '../electron/core/hash.ts'

const goalFile = process.env.KAIDA_GOAL_FILE
const goal = goalFile ? readFileSync(goalFile, 'utf8').split(String.fromCharCode(92)).join('') : ''
let base = process.env.KAIDA_SUPABASE_URL || goal.match(new RegExp('https://[a-z]+[.]supabase[.]co'))?.[0]
let key = process.env.KAIDA_SUPABASE_ANON || goal.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0]
if (!base || !key) {
  const configApp = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
  try {
    const configPage = await configApp.firstWindow()
    await configPage.waitForLoadState('domcontentloaded')
    const saved = await configApp.evaluate(({ app, safeStorage }) => {
      const { readFileSync } = process.getBuiltinModule('fs')
      const { join } = process.getBuiltinModule('path')
      const stored = JSON.parse(safeStorage.decryptString(readFileSync(join(app.getPath('userData'), 'kaida-store.bin'))))
      return { base: stored.settings.supabase_url, key: stored.settings.supabase_anon }
    })
    base ||= saved.base
    key ||= saved.key
  } finally {
    await configApp.close()
  }
}
assert.ok(base && key, '目标配置缺少题库连接')

const passwords = await new Promise((resolve) => {
  const values = []
  const input = createInterface({ input: process.stdin, terminal: false })
  input.on('line', (line) => {
    values.push(line)
    if (values.length === 3) { input.close(); resolve(values) }
  })
})
assert.equal(passwords.length, 3, '需要三个查看题库密码')

const auth = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
const batch = `codex-bank-e2e-${Date.now()}`
const course = `${batch}-course`
const rows = [1, 2, 3].map((index) => {
  const stem = index === 1 ? `${batch}-question-${index}-${'长题干'.repeat(80)}` : `${batch}-question-${index}`
  const options = index === 1
    ? [`${batch}-option-a-${index}-${'长选项'.repeat(40)}`, `${batch}-option-b-${index}-${'长选项'.repeat(40)}`]
    : [`${batch}-option-a-${index}`, `${batch}-option-b-${index}`]
  return { qtype: 'single', stem, options, answer_texts: [options[0]], content_hash: contentHash('single', stem, options), course_names: [course], source: 'import', verified: false, conflict: false }
})

async function request(path, init = {}) {
  return fetch(`${base}/rest/v1${path}`, { ...init, headers: { ...auth, ...init.headers } })
}
async function remaining() {
  const hashes = rows.map((row) => row.content_hash).join(',')
  const response = await request(`/questions?select=id,content_hash&content_hash=in.(${hashes})`)
  assert.ok(response.ok, `测试批次回读失败 HTTP ${response.status}`)
  return response.json()
}
async function cleanup() {
  const hashes = rows.map((row) => row.content_hash).join(',')
  await request(`/questions?content_hash=in.(${hashes})`, { method: 'DELETE' })
  assert.equal((await remaining()).length, 0, '测试批次清理后仍有残留')
}
async function launch() {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const configured = await app.evaluate(async ({ BrowserWindow }, settings) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`window.kaida.saveSettings(${JSON.stringify(settings)})`), { supabase_url: base, supabase_anon: key })
  assert.equal(configured.ok, true, configured.error || '题库查看测试无法保存产品连接配置')
  return { app, page }
}
async function patchDeleteFailure(app, id) {
  await app.evaluate((_, targetId) => {
    const scope = globalThis
    scope.__kaidaBankE2eOriginalFetch ||= scope.fetch
    const original = scope.__kaidaBankE2eOriginalFetch
    scope.fetch = async (input, init) => {
      const url = String(input)
      if (init?.method === 'DELETE' && url.includes('/questions?id=eq.' + encodeURIComponent(targetId))) {
        return new Response('controlled delete failure', { status: 503 })
      }
      return original(input, init)
    }
  }, id)
}
async function restoreFetch(app) {
  await app.evaluate(() => {
    const scope = globalThis
    if (scope.__kaidaBankE2eOriginalFetch) {
      scope.fetch = scope.__kaidaBankE2eOriginalFetch
      delete scope.__kaidaBankE2eOriginalFetch
    }
  })
}
async function openBank(page, password) {
  await page.getByText('题库', { exact: true }).first().click()
  await page.getByText('选择题库操作', { exact: true }).waitFor()
  assert.equal(await page.locator('[title="当前操作员"]').count(), 0, '顶栏头像仍存在')
  assert.equal(await page.locator('button').filter({ hasText: '导入题库' }).count(), 1, '题库首页缺少导入题库卡片')
  assert.equal(await page.locator('button').filter({ hasText: '查看题库' }).count(), 1, '题库首页缺少查看题库卡片')
  await page.getByRole('button', { name: '查看题库' }).click()
  const input = page.getByPlaceholder('请输入密码')
  await input.fill(password)
  await page.getByRole('button', { name: '进入题库' }).click()
  await page.getByRole('heading', { name: '查看题库', exact: true }).waitFor()
  await page.getByText(/共 \d+ 题/).waitFor()
}
async function waitRowCount(page, count) {
  await page.waitForFunction((expected) => {
    const rows = [...document.querySelectorAll('tbody tr')]
    return rows.length === expected && rows.every((row) => !row.textContent?.includes('正在读取云端题库'))
  }, count)
}

try {
  await cleanup()
  const inserted = await request('/questions?on_conflict=content_hash', { method: 'POST', headers: { Prefer: 'return=representation,resolution=merge-duplicates' }, body: JSON.stringify(rows) })
  assert.ok(inserted.ok, `测试批次写入失败 HTTP ${inserted.status}`)
  assert.equal((await remaining()).length, 3, '测试批次写入数量不正确')

  for (let index = 0; index < passwords.length; index++) {
    const { app, page } = await launch()
    try {
      await openBank(page, passwords[index])
      if (index !== 0) continue

      await page.locator('select').first().locator('option', { hasText: course }).waitFor({ state: 'attached', timeout: 25000 })
      await page.locator('select').first().selectOption({ label: course })
      await page.getByText(rows[0].stem, { exact: true }).waitFor()
      await waitRowCount(page, 3)
      assert.equal(await page.locator('tbody tr').count(), 3, '课程筛选结果不正确')
      assert.deepEqual(await page.locator('thead th').allTextContents(), ['', '序号', '所属课程', '题目', '题目选项', '正确答案', '时间', '操作'], '题库表头不符合七列表格要求')
      assert.match(await page.locator('tbody tr').first().locator('td').nth(6).textContent() || '', /^[0-9]{4}\/[0-9]{2}\/[0-9]{2} [0-9]{2}:[0-9]{2}$/, '题库时间未按年月日时分显示')
      const stemCell = page.locator('tbody tr').filter({ hasText: rows[0].stem }).locator('td').nth(3)
      const stemButton = stemCell.getByRole('button')
      assert.match(await stemButton.getAttribute('class') || '', /line-clamp-3/, '长题干初始没有截断')
      const optionCell = page.locator('tbody tr').filter({ hasText: rows[0].stem }).locator('td').nth(4).locator('div')
      const answerCell = page.locator('tbody tr').filter({ hasText: rows[0].stem }).locator('td').nth(5).locator('div')
      assert.match(await optionCell.getAttribute('class') || '', /line-clamp-3/, '长选项初始没有截断')
      assert.ok(await optionCell.getAttribute('title'), '长选项没有完整提示')
      assert.match(await answerCell.getAttribute('class') || '', /line-clamp-3/, '答案初始没有截断')
      assert.ok(await answerCell.getAttribute('title'), '答案没有完整提示')
      await stemButton.click()
      assert.doesNotMatch(await stemButton.getAttribute('class') || '', /line-clamp-3/, '长题干点击后没有展开')

      const search = page.getByPlaceholder('搜索课程、题干、选项或答案')
      await search.fill(batch.slice(0, 12))
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      await waitRowCount(page, 3)
      assert.equal(await page.locator('tbody tr').count(), 3, '模糊搜索结果不正确')
      await search.fill(rows[1].stem)
      await page.locator('select').nth(1).selectOption('exact')
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      await page.getByText(rows[1].stem, { exact: true }).waitFor()
      await waitRowCount(page, 1)
      assert.equal(await page.locator('tbody tr').count(), 1, '精确搜索结果不正确')
      await page.getByRole('button', { name: '清除' }).click()
      await page.locator('select').first().selectOption({ label: course })
      await page.getByText(rows[0].stem, { exact: true }).waitFor()
      assert.match(await page.getByText(/共 \d+ 题 · 第 \d+\/\d+ 页/).first().textContent() || '', /^共 [0-9]+ 题 · 第 [0-9]+\/[0-9]+ 页$/, '清除筛选后分页信息缺失')
      const allSummary = await page.getByText(/共 \d+ 题 · 第 \d+\/\d+ 页/).first().textContent() || ''
      const allTotal = Number(allSummary.match(/共 (\d+) 题/)?.[1] || 0)
      const allPageCount = Number(allSummary.match(/第 \d+\/(\d+) 页/)?.[1] || 1)
      if (allTotal > 20 && allPageCount > 1) {
        await page.getByRole('button', { name: '下一页' }).click()
        await page.getByText(/共 \d+ 题 · 第 2\/\d+ 页/).waitFor()
        assert.equal(await page.locator('tbody tr').first().locator('td').nth(1).innerText(), '21', '下一页序号没有按服务端分页递增')
        await page.getByRole('button', { name: '上一页' }).click()
        await page.getByText(/共 \d+ 题 · 第 1\/\d+ 页/).waitFor()
      }
      await page.locator('select').first().selectOption({ label: course })
      await page.getByText(rows[0].stem, { exact: true }).waitFor()

      const targetRow = page.locator('tbody tr').filter({ hasText: rows[0].stem })
      await targetRow.getByRole('button', { name: '删除' }).click()
      await page.getByText(rows[0].stem, { exact: true }).last().waitFor()
      await page.getByRole('button', { name: '取消' }).click()
      assert.equal((await remaining()).length, 3, '取消单删仍删除了数据')

      await targetRow.getByRole('button', { name: '删除' }).click()
      await page.getByRole('button', { name: '确认删除' }).click()
      await page.getByText(/已删除|删除失败/).last().waitFor({ timeout: 25000 })
      const singleDeleteMessage = await page.locator('body').textContent()
      assert.match(singleDeleteMessage || '', /已删除并回读确认 1 条/)
      assert.equal((await remaining()).length, 2, '单删没有真实删除并回读')

      await page.locator('thead input[type=checkbox]').check()
      await page.getByRole('button', { name: /批量删除（2）/ }).click()
      await page.getByRole('button', { name: '取消' }).click()
      assert.equal((await remaining()).length, 2, '取消批删仍删除了数据')

      const beforePartial = await remaining()
      await patchDeleteFailure(app, beforePartial[1].id)
      await page.getByRole('button', { name: /批量删除（2）/ }).click()
      await page.getByRole('button', { name: '确认删除' }).click()
      await page.getByText('已删除 1 条，失败 1 条', { exact: true }).waitFor()
      assert.match(await page.locator('body').textContent() || '', /HTTP 503/, '批删失败原因没有逐条显示')
      const afterPartial = await remaining()
      assert.deepEqual(afterPartial.map((row) => row.id), [beforePartial[1].id], '批删部分失败没有保留失败项')

      await restoreFetch(app)
      await page.getByRole('button', { name: '取消' }).click()
      await page.locator('thead input[type=checkbox]').check()
      await page.getByRole('button', { name: /批量删除（1）/ }).click()
      await page.getByRole('button', { name: '确认删除' }).click()
      await page.getByText('已删除并回读确认 1 条', { exact: true }).waitFor()
      assert.equal((await remaining()).length, 0, '恢复后没有清理批删失败残留')
    } finally {
      await restoreFetch(app).catch(() => {})
      await app.close()
    }
  }

  const first = await launch()
  try {
    await first.page.getByText('题库', { exact: true }).first().click()
    await first.page.getByRole('button', { name: '查看题库' }).click()
    for (let attempt = 0; attempt < 5; attempt++) {
      await first.page.getByPlaceholder('请输入密码').fill(`wrong-${attempt}`)
     await first.page.getByRole('button', { name: '进入题库' }).click()
      if (attempt < 4) await first.page.getByText(`密码错误，还可尝试 ${4 - attempt} 次`, { exact: true }).waitFor()
    }
    await first.page.getByText(/已冻结/).waitFor()
  } finally { await first.app.close() }

  const second = await launch()
  try {
    await second.page.getByText('题库', { exact: true }).first().click()
    await second.page.getByRole('button', { name: '查看题库' }).click()
    assert.equal(await second.page.getByPlaceholder('请输入密码').isDisabled(), true, '重启绕过了密码冻结')
    await second.page.waitForTimeout(61_000)
    await second.page.getByPlaceholder('请输入密码').fill(passwords[0])
    await second.page.getByRole('button', { name: '进入题库' }).click()
    await second.page.getByRole('heading', { name: '查看题库', exact: true }).waitFor()
  } finally { await second.app.close() }

  console.log(JSON.stringify({ ok: true, validPasswords: 3, inserted: 3, singleDeleted: 1, batchPartial: { deleted: 1, failed: 1 }, batchRetryDeleted: 1, freezePersisted: true, freezeExpired: true }))
} finally {
  await cleanup()
}
