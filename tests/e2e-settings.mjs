import assert from 'node:assert/strict'
import { _electron as electron } from 'patchright'
import { AI_MODELS } from '../electron/core/ai-parse.ts'

const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const renderer = (source) => app.evaluate(({ BrowserWindow }, script) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
  const rendererCall = (fn, arg) => renderer('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')')
  const waitUntil = async (check, timeout = 30_000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('等待真实渲染进程状态超时')
  }
  const original = await renderer('window.kaida.getSettings()')

  await page.getByText('设置', { exact: true }).first().click()
  await page.getByRole('heading', { name: '系统偏好设置' }).waitFor()
  await page.getByText('v0.1.7 开发版', { exact: true }).waitFor()

  const initialBrowserOn = await page.locator('#browser-toggle').isChecked()
  const initialLogOn = await page.locator('#log-toggle').isChecked()
  const accountInput = page.locator('#account-concurrency')
  const courseInput = page.locator('#course-concurrency')
  const accountControls = accountInput.locator('xpath=../..').getByRole('button')
  const courseControls = courseInput.locator('xpath=../..').getByRole('button')
  const accountBefore = Number(await accountInput.inputValue())
  const courseBefore = Number(await courseInput.inputValue())
  await accountControls.nth(accountBefore < 8 ? 1 : 0).click()
  await courseControls.nth(courseBefore < 6 ? 1 : 0).click()
  assert.equal(Number(await accountInput.inputValue()), accountBefore < 8 ? accountBefore + 1 : accountBefore - 1)
  assert.equal(Number(await courseInput.inputValue()), courseBefore < 6 ? courseBefore + 1 : courseBefore - 1)
  await page.locator('label:has(#browser-toggle)').click()
  await page.locator('label:has(#log-toggle)').click()
  assert.equal(await page.locator('#browser-toggle').isChecked(), !initialBrowserOn)
  assert.equal(await page.locator('#log-toggle').isChecked(), !initialLogOn)
  await page.locator('label:has(#browser-toggle)').click()
  await page.locator('label:has(#log-toggle)').click()
  assert.equal(await page.locator('#browser-toggle').isChecked(), initialBrowserOn)
  assert.equal(await page.locator('#log-toggle').isChecked(), initialLogOn)
  const siliconKey = page.locator('#siliconflow-key')
  const anonKey = page.locator('#supabase-anon')
  const siliconVisibility = siliconKey.locator('xpath=..').getByTitle('显隐')
  assert.equal(await page.locator('#supabase-url').isVisible(), false)
  assert.equal(await anonKey.isVisible(), false)
  await siliconVisibility.click()
  assert.equal(await siliconKey.getAttribute('type'), 'text')
  await siliconVisibility.click()
  assert.equal(await siliconKey.getAttribute('type'), 'password')
  await siliconKey.locator('xpath=..').getByTitle('复制').click()

  const recommendation = await renderer('window.kaida.snapshot()')
  const warningPatch = recommendation.machine.recommendedAccount < 8
    ? { account_parallel: recommendation.machine.recommendedAccount + 1, course_parallel: original.course_parallel }
    : recommendation.machine.recommendedCourse < 6
      ? { account_parallel: original.account_parallel, course_parallel: recommendation.machine.recommendedCourse + 1 }
      : null
  if (warningPatch) {
    const warningSave = await rendererCall((patch) => window.kaida.saveSettings(patch), warningPatch)
    assert.equal(warningSave.ok, true, '高于建议值的配置没有保存成功')
    await page.getByText('当前配置高于建议', { exact: true }).waitFor()
    assert.equal(await page.getByText('当前配置高于建议', { exact: true }).count(), 1)
    const warningSettings = await renderer('window.kaida.getSettings()')
    assert.equal(warningSettings.account_parallel, warningPatch.account_parallel)
    assert.equal(warningSettings.course_parallel, warningPatch.course_parallel)
    const restoredAfterWarning = await rendererCall((patch) => window.kaida.saveSettings(patch), {
      account_parallel: original.account_parallel,
      course_parallel: original.course_parallel,
    })
    assert.equal(restoredAfterWarning.ok, true, '高于建议值测试后恢复配置失败')
  }

  const beforeRejectedSave = await renderer('window.kaida.getSettings()')
  await renderer(`window.__kaidaSettingsEvents = []; window.__kaidaSettingsOff = window.kaida.onSettingsChanged((value) => window.__kaidaSettingsEvents.push(value)); true`)
  const rejectedSave = await rendererCall((value) => window.kaida.saveSettings({ supabase_url: value }), 'service_role')
  assert.equal(rejectedSave.ok, false, '非法服务端密钥没有被拒绝')
  const afterRejectedSave = await renderer('window.kaida.getSettings()')
  assert.equal(afterRejectedSave.supabase_url, beforeRejectedSave.supabase_url, '保存失败覆盖了旧 URL')
  assert.equal(afterRejectedSave.account_parallel, beforeRejectedSave.account_parallel, '保存失败覆盖了旧账号并发')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal((await renderer('window.__kaidaSettingsEvents.length')), 0, '保存失败错误广播了新配置')
  await renderer('window.__kaidaSettingsOff?.(); true')

  const snapshots = await rendererCall(async () => {
    const values = []
    const off = window.kaida.onSnapshot((value) => values.push(value))
    await new Promise((resolve) => setTimeout(resolve, 4500))
    off()
    return values
  }, null)
  assert.ok(snapshots.length >= 2, '本机状态没有持续推送')
  for (const snapshot of snapshots) {
    assert.match(snapshot.machine.cpu, /^\d+%$/)
    assert.match(snapshot.machine.memory, /^\d+%$/)
    assert.match(snapshot.machine.app, /^\d+MB$/)
    assert.ok(Number.isInteger(snapshot.machine.browsers) && snapshot.machine.browsers >= 0)
    assert.ok(Number.isInteger(snapshot.machine.recommendedAccount) && snapshot.machine.recommendedAccount >= 1)
    assert.ok(Number.isInteger(snapshot.machine.recommendedCourse) && snapshot.machine.recommendedCourse >= 1)
  }

  await rendererCall(() => {
    window.__kaidaConnectivityProgress = []
    window.__kaidaConnectivityOff = window.kaida.onConnectivityProgress((payload) => {
      window.__kaidaConnectivityProgress.push({
        targetModel: payload.targetModel || '',
        statuses: (payload.results || []).map((item) => ({
          model: item.model,
          status: item.status,
          elapsedMs: item.elapsedMs,
          reason: item.reason || '',
          httpStatus: item.httpStatus || 0,
        })),
      })
    })
  }, null)
  await page.getByRole('button', { name: '连通性测试' }).click()
  await page.getByRole('heading', { name: 'AI 模型连通性测试' }).waitFor()
  await page.getByText('正在按受控并发检测模型…', { exact: true }).waitFor({ state: 'hidden', timeout: 120_000 })
  const connectivityDialog = page.getByRole('heading', { name: 'AI 模型连通性测试' }).locator('xpath=ancestor::div[contains(@class,"fixed")][1]')
  assert.match(await connectivityDialog.innerText(), /20\d{2}/, '连通性弹窗没有显示检测时间')

  for (const model of AI_MODELS) await page.getByText(model, { exact: true }).waitFor()
  const connectivity = await renderer('window.__kaidaConnectivityProgress')
  assert.ok(connectivity.length > 2, '没有收到逐模型进度')
  assert.deepEqual(connectivity[0].statuses.map((item) => item.status), AI_MODELS.map(() => 'queued'))
  const peak = Math.max(...connectivity.map((entry) => entry.statuses.filter((item) => item.status === 'running').length))
  assert.ok(peak >= 1 && peak <= 3, '模型检测并发峰值异常：' + peak)
  const final = connectivity.filter((entry) => !entry.targetModel).at(-1).statuses
  assert.equal(final.length, AI_MODELS.length)
  assert.ok(final.every((item) => item.status === 'success' || item.status === 'failed'))
  assert.ok(final.every((item) => item.elapsedMs >= 0))
  assert.ok(final.filter((item) => item.status === 'failed').every((item) => item.reason))
  assert.equal(await page.getByText('✓', { exact: true }).count(), final.filter((item) => item.status === 'success').length)
  assert.equal(await page.getByText('✕', { exact: true }).count(), final.filter((item) => item.status === 'failed').length)
  const expectedSummary = final.filter((item) => item.status === 'success').length * 2 > final.length
    ? 'AI 服务正常'
    : final.filter((item) => item.status === 'success').length <= 2
      ? final.some((item) => item.status === 'success') ? '请检查 API 配置或模型状态' : 'AI 服务不可用'
      : '请注意，部分模型不可用'
  await page.getByText(expectedSummary, { exact: true }).waitFor()

 const failedModel = final.find((item) => item.status === 'failed')?.model
  const fallbackOrderBeforeRetest = [...AI_MODELS]
 let singleRetest = 'all-models-succeeded'
  if (failedModel) {
    const model = page.getByText(failedModel, { exact: true })
    const card = model.locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
    await card.getByRole('button', { name: '重新检测' }).click()
    await waitUntil(() => rendererCall((target) => window.__kaidaConnectivityProgress.some((entry) => entry.targetModel === target && entry.statuses[0]?.status !== 'running'), failedModel))
    const retest = await rendererCall((target) => window.__kaidaConnectivityProgress.filter((entry) => entry.targetModel === target).at(-1), failedModel)
    assert.equal(retest.statuses.length, 1, '单模型重测影响了其它模型')
    assert.equal(retest.statuses[0].model, failedModel)
    singleRetest = failedModel
 } else {
   const retest = await rendererCall((model) => window.kaida.testConnectivityModel(model), AI_MODELS[0])
   assert.equal(retest.results.length, 1)
   assert.equal(retest.results[0].model, AI_MODELS[0])
 }
  assert.deepEqual(AI_MODELS, fallbackOrderBeforeRetest, '单模型重测改变了答题降级模型顺序')

  await page.getByRole('button', { name: '×' }).click()
  const saved = await renderer('window.kaida.saveSettings({ account_parallel: 1, course_parallel: 1 })')
  assert.equal(saved.ok, true)
  await page.waitForFunction(() => document.querySelector('#account-concurrency')?.value === '1' && document.querySelector('#course-concurrency')?.value === '1')
  await page.getByText('工作台', { exact: true }).first().click()
  await page.getByText('账号并行 1', { exact: true }).waitFor()
  await page.getByText('课程并行 1', { exact: true }).waitFor()

  const restored = await rendererCall((settings) => window.kaida.saveSettings({
    account_parallel: settings.account_parallel,
    course_parallel: settings.course_parallel,
  }), original)
  assert.equal(restored.ok, true)
  await waitUntil(() => rendererCall(async (settings) => {
    const snap = await window.kaida.snapshot()
    return snap.settings.account_parallel === settings.account_parallel && snap.settings.course_parallel === settings.course_parallel
  }, original))

  const summary = await page.getByRole('heading', { name: 'AI 模型连通性测试' }).count()
  console.log(JSON.stringify({
    ok: true,
    models: AI_MODELS.length,
    peak,
    success: final.filter((item) => item.status === 'success').length,
    failed: final.filter((item) => item.status === 'failed').length,
    failureReasons: [...new Set(final.filter((item) => item.status === 'failed').map((item) => item.reason))],
    singleRetest: Boolean(singleRetest),
    machineSamples: snapshots.length,
    settingsSynced: true,
    dialogClosed: summary === 0,
  }))
} finally {
  await app.close()
}
