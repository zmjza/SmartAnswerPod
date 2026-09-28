import { app, BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { isRunning } from './runner'
import { UpdateFlow, type UpdateState } from './core/update-flow'

export const otaConfig = { provider: 'github' as const, owner: 'zmjza', repo: 'SmartAnswerPod' }

type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  on: (event: string, listener: (...args: any[]) => void) => void
  checkForUpdates: () => Promise<{ isUpdateAvailable: boolean; updateInfo?: { version?: string } } | null>
  downloadUpdate: () => Promise<string[]>
  quitAndInstall: () => void
}

const noopUpdater: Updater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  autoRunAppAfterInstall: false,
  on: () => {},
  checkForUpdates: async () => null,
  downloadUpdate: async () => [],
  quitAndInstall: () => {},
}
const updater = (app.isPackaged
  ? createRequire(__filename)('electron-updater').autoUpdater as Updater
  : noopUpdater)

function broadcast(state: UpdateState) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('kaida:ota:status', state)
}

updater.autoDownload = false
updater.autoInstallOnAppQuit = false
updater.autoRunAppAfterInstall = true
const flow = new UpdateFlow(updater, app.isPackaged, isRunning, broadcast)
updater.on('download-progress', progress => {
  const percent = Math.round(progress.percent)
  const speed = progress.bytesPerSecond > 0 ? ` · ${(progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : ''
  flow.setProgress(percent, `${percent}% · 已下载 ${(progress.transferred / 1024 / 1024).toFixed(1)} / ${(progress.total / 1024 / 1024).toFixed(1)} MB${speed}`)
})
updater.on('error', error => {
  flow.fail(error instanceof Error ? error.message : '安装器报告未知错误')
})

export function currentUpdateState() { return flow.getState() }
export function downloadUpdate() { return flow.download() }
export function installUpdate() { return flow.install() }

export function updaterFeed() {
  return otaConfig
}

export function checkForUpdates() { return flow.check() }
