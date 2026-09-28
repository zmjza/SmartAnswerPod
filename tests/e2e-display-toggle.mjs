import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { _electron as electron } from 'patchright'

const runFile = promisify(execFile)
const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
const window = await app.firstWindow()
await window.waitForLoadState('domcontentloaded')
const renderer = (source) => app.evaluate(({ BrowserWindow }, script) =>
  BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
const waitFor = async (check, message, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(message)
}
const browserProcesses = async (profile) => {
  const { stdout } = await runFile('/bin/ps', ['-axo', 'pid=,command='])
  return stdout.split('\n').flatMap((row) => {
    if (!row.includes(profile) || row.includes('--type=')) return []
    const match = row.trim().match(/^(\d+)\s+(.*)$/)
    return match ? [{ pid: Number(match[1]), command: match[2] }] : []
  })
}
const browserProcess = async (profile) => {
  return (await browserProcesses(profile))[0] || null
}
const stopAndWait = async (id, profile) => {
  await renderer(`window.kaida.stop(${JSON.stringify(id)})`)
  await waitFor(async () => !(await renderer('window.kaida.snapshot()')).running, '停止后运行态未释放', 45000)
  await waitFor(async () => !(await browserProcess(profile)), '停止后浏览器进程未释放', 15000)
}

try {
  const account = await renderer('(async () => (await window.kaida.listAccounts())[0])()')
  assert.ok(account?.local_id, '没有可验证的加密账号')
  const profile = await app.evaluate(({ app }, id) => {
    const { join } = process.getBuiltinModule('path')
    return join(app.getPath('userData'), 'pw-profiles', id)
  }, account.local_id)

  const initial = await renderer(`(async () => {
    await window.kaida.setWorkMode(${JSON.stringify(account.local_id)}, 'extract')
    const result = await window.kaida.setDisplay(${JSON.stringify(account.local_id)}, 'headless')
    void window.kaida.loginRefresh([${JSON.stringify(account.local_id)}])
    return result
  })()`)
  assert.equal(initial.ok, true, initial.error || '无头模式保存失败')
  const headlessProcess = await waitFor(() => browserProcess(profile), '没有找到无头浏览器进程')
  assert.match(headlessProcess.command, /--headless(?:=\w+)?(?:\s|$)/, '无头模式没有用 Playwright headless:true 启动')
  await waitFor(async () => {
    const state = await renderer('window.kaida.snapshot()')
    return state.students.find((row) => row.local_id === account.local_id)?.browserWindowVisible === false
  }, '无头模式没有报告为无窗口')
  assert.equal(await window.locator('.mode-visual-btn').isDisabled(), true, '运行中可视化按钮未锁定')
  const rejectedVisual = await renderer(`window.kaida.setDisplay(${JSON.stringify(account.local_id)}, 'visual')`)
  assert.equal(rejectedVisual.ok, false, '运行中不应允许切换为可视化模式')
  assert.match(rejectedVisual.error, /运行中|停止任务/, '运行中拒绝原因不明确')

  const beforeCrash = await browserProcesses(profile)
  for (const process of beforeCrash) await runFile('/bin/kill', ['-9', String(process.pid)])
  await waitFor(async () => !(await browserProcess(profile)), '浏览器崩溃后进程未释放', 15000)
  await waitFor(async () => (await renderer('window.kaida.snapshot()')).machine.browsers === 0, '浏览器崩溃后名额未释放', 15000)
  await stopAndWait(account.local_id, profile)

  const visual = await renderer(`window.kaida.setDisplay(${JSON.stringify(account.local_id)}, 'visual')`)
  assert.equal(visual.ok, true, visual.error || '停止后可视化模式保存失败')
  await renderer(`void window.kaida.loginRefresh([${JSON.stringify(account.local_id)}])`)
  const visualProcess = await waitFor(() => browserProcess(profile), '没有找到可视化浏览器进程')
  assert.doesNotMatch(visualProcess.command, /--headless(?:=\w+)?(?:\s|$)/, '可视化模式错误使用了 headless:true')
  assert.notEqual(visualProcess.pid, headlessProcess.pid, '模式切换必须停止后重新启动浏览器')
  await waitFor(async () => {
    const state = await renderer('window.kaida.snapshot()')
    return state.students.find((row) => row.local_id === account.local_id)?.browserWindowVisible === true
  }, '可视化模式没有报告为真实可见窗口')
  assert.equal(await window.locator('.mode-headless-btn').isDisabled(), true, '运行中无头按钮未锁定')
  const rejectedHeadless = await renderer(`window.kaida.setDisplay(${JSON.stringify(account.local_id)}, 'headless')`)
  assert.equal(rejectedHeadless.ok, false, '运行中不应允许切换为无头模式')
  await stopAndWait(account.local_id, profile)

  console.log('display-mode-verified', {
    modes: ['headless:true', 'headless:false'],
    runtimeSwitchRejected: true,
    restartedAfterStop: true,
    persistentProfileReused: true,
  })
} finally {
  await app.close()
}
