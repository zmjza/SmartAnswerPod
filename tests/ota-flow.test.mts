import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UpdateFlow } from '../electron/core/update-flow.ts'

test('更新检查、下载和安装遵守运行门禁', async () => {
  let installs = 0
  let running = true
  const seen: string[] = []
  const flow = new UpdateFlow({
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.1.8' } }),
    downloadUpdate: async () => ['update.zip'],
    quitAndInstall: () => { installs += 1 },
  }, true, () => running, (status) => seen.push(status.phase))
  assert.equal((await flow.check()).phase, 'available')
  assert.equal((await flow.download()).phase, 'downloaded')
  assert.equal(flow.install().phase, 'downloaded')
  assert.equal(installs, 0)
  running = false
  assert.equal(flow.install().phase, 'installing')
  assert.equal(installs, 1)
  assert.deepEqual(seen, ['checking', 'available', 'downloading', 'downloaded', 'installing'])
})

test('未发现更新不能下载；下载失败后可重试', async () => {
  let attempts = 0
  const flow = new UpdateFlow({
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.1.8' } }),
    downloadUpdate: async () => { if (++attempts === 1) throw new Error('网络中断'); return ['update.zip'] },
    quitAndInstall: () => {},
  }, true, () => false)
  assert.equal((await flow.download()).phase, 'unavailable')
  await flow.check()
  assert.equal((await flow.download()).phase, 'error')
  assert.equal((await flow.check()).phase, 'available')
  assert.equal((await flow.download()).phase, 'downloaded')
})

test('开发版明确跳过更新检查', async () => {
  let calls = 0
  const flow = new UpdateFlow({
    checkForUpdates: async () => { calls += 1; return null },
    downloadUpdate: async () => [],
    quitAndInstall: () => {},
  }, false, () => false)
  assert.equal((await flow.check()).phase, 'unavailable')
  assert.equal(calls, 0)
})

test('服务端返回当前版本时不提示下载', async () => {
  const flow = new UpdateFlow({
    checkForUpdates: async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.8.0' } }),
    downloadUpdate: async () => { throw new Error('不应下载') },
    quitAndInstall: () => {},
  }, true, () => false)
  assert.equal((await flow.check()).phase, 'unavailable')
})

test('发布配置同时生成 macOS 自动更新 ZIP 与 DMG', async () => {
  const { readFile } = await import('node:fs/promises')
  const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(config, /provider: github/)
  assert.match(config, /- dmg\n\s+- zip/)
  assert.match(config, /- nsis/)
  assert.match(config, /nsis:\n  createDesktopShortcut: always\n  createStartMenuShortcut: true\n  shortcutName: 开大智达舱/)
  assert.match(config, /productName: 开大智达舱/)
  assert.match(config, /repo: SmartAnswerPod/)
  assert.match(config, /icon: build\/icon\.png/g)
  const ota = await readFile(new URL('../electron/ota.ts', import.meta.url), 'utf8')
  assert.match(ota, /repo: 'SmartAnswerPod'/)
})

test('macOS Squirrel 安装更新后自动重新启动应用', async () => {
  const { readFile } = await import('node:fs/promises')
  const ota = await readFile(new URL('../electron/ota.ts', import.meta.url), 'utf8')
  assert.match(ota, /updater\.autoRunAppAfterInstall\s*=\s*true/)
  assert.match(ota, /updater\.autoInstallOnAppQuit\s*=\s*false/)
})

test('ad-hoc 更新使用跨版本稳定的应用要求', async () => {
  const { readFile } = await import('node:fs/promises')
  const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  const requirement = await readFile(new URL('../build/requirements.mac.txt', import.meta.url), 'utf8')
  assert.match(config, /identity: "-"\n  requirements: build\/requirements\.mac\.txt/)
  assert.match(requirement, /^designated => identifier "org\.kaida\.autoquiz"/)
  assert.match(requirement, /identifier "org\.kaida\.autoquiz\.helper\.Renderer"/)
  assert.match(requirement, /identifier "com\.github\.Squirrel"/)
})

test('下载进度事件只注册一次，避免重复广播', async () => {
  const { readFile } = await import('node:fs/promises')
  const ota = await readFile(new URL('../electron/ota.ts', import.meta.url), 'utf8')
  assert.equal(ota.match(/updater\.on\('download-progress'/g)?.length, 1)
})

test('发布配置使用 ad-hoc bundle 签名且发布门禁不依赖 Developer ID', async () => {
  const { readFile } = await import('node:fs/promises')
  const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(config, /identity: ['"]?-['"]?/)
  const publisher = await readFile(new URL('../scripts/release-publish.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(publisher, /Developer ID Application/)
  assert.match(publisher, /\['auth', 'status', '--hostname', 'github\.com'\]/)
  assert.match(publisher, /gh:github\.com/)
})
