import { app, BrowserWindow, clipboard, ipcMain, dialog, nativeImage } from 'electron'
import path from 'node:path'
import { basename } from 'node:path'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { addAccount, getSettings, listAccounts, patchAccount, removeAccount, saveSettings } from './store'
import { parseCsv, rowsFromMatrix } from './core/excel'
import { parsePastedAccounts, type AccountRow } from './core/excel'
import { parseBankJson } from './core/json-bank'
import { contentHash } from './core/hash'
import { deleteQuestions, listQuestionCourses, listQuestions, upsertQuestion, testConn } from './bank'
import { bankAccessStatus, unlockBank } from './bank-access'
import {
  applyStudentSettingsToAll,
  enqueueNewStudents,
  deleteStudentRuntime,
  getQrSnapshot,
  getHistoryPaperImage,
  getHomeworkHistory,
  loginAndRefresh,
  isRunning,
  isStudentLocked,
  openVisual,
  refreshQrSnapshot,
  setAnswerRoundLimit,
  setCourseScope,
  setSelectedCourses,
  setWorkMode,
  signalVerified,
  snapshot,
  startSelectedCourseExecution,
  startStudent,
  stopAllStudents,
  stopStudent,
  toggleDisplay,
  onNoqrChange,
} from './workbench-coordinator'
import { onProgress } from './progress'
import { checkForUpdates, currentUpdateState, downloadUpdate, installUpdate, updaterFeed } from './ota'
import * as XLSX from 'xlsx'
import { testAllModels, testSingleModel } from './connectivity.ts'
import { concurrencyChangeLocked } from './core/concurrency.ts'
import { refreshBrowserMemorySamples } from './pool.ts'
import { PUBLIC_SUPABASE_ANON, PUBLIC_SUPABASE_URL } from './core/public-config'

let win: BrowserWindow | null = null
const bankUnlockedWebContents = new Set<number>()

if (process.env.KAIDA_E2E_USERDATA) {
  mkdirSync(process.env.KAIDA_E2E_USERDATA, { recursive: true })
  app.setPath('userData', process.env.KAIDA_E2E_USERDATA)
}

function importExcelFromPath(p: string): { ok: boolean; error?: string; count?: number } {
  const rows = p.endsWith('.csv') ? parseCsv(readFileSync(p, 'utf8')) : (() => {
    const wb = XLSX.readFile(p)
    const sh = wb.Sheets[wb.SheetNames[0]]
    return rowsFromMatrix(XLSX.utils.sheet_to_json(sh, { header: 1, raw: false }) as string[][])
  })()
  const existing = new Set(listAccounts().map((account) => account.username))
  const addedIds: string[] = []
  let failed = 0
  for (const row of rows) {
    if (existing.has(row.username)) { failed++; continue }
    try {
      addedIds.push(addAccount(row).local_id)
      existing.add(row.username)
    } catch { failed++ }
  }
  enqueueNewStudents(addedIds)
  return { ok: failed === 0, count: addedIds.length, error: failed ? `${failed} 名学生重复或保存失败` : undefined }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#F5F3FF',
    frame: false,
    titleBarStyle: 'hidden',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false)
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(__dirname, '../dist/index.html'))
}

function pushSnap() {
  win?.webContents.send('kaida:snapshot', snapshot())
}

function bootstrapEnv() {
  const envFile = process.env.KAIDA_E2E_ENV
  if (envFile && existsSync(envFile)) {
    try {
      const d = JSON.parse(readFileSync(envFile, 'utf8')) as { url?: string; anon?: string; key?: string }
      if (d.url) process.env.KAIDA_SUPABASE_URL = d.url
      if (d.anon) process.env.KAIDA_SUPABASE_ANON = d.anon
      if (d.key) process.env.KAIDA_SILICONFLOW_KEY = d.key
    } catch {
      /* 本机 E2E env 读失败则跳过 */
    }
  }
  const siliconflow_key = process.env.KAIDA_SILICONFLOW_KEY || ''
  const supabase_url = process.env.KAIDA_SUPABASE_URL || ''
  const supabase_anon = process.env.KAIDA_SUPABASE_ANON || ''
  if (!supabase_url && !siliconflow_key) return
  const cur = getSettings()
  const patch: Record<string, string> = {}
  if (!cur.supabase_url || !cur.supabase_anon) {
    patch.supabase_url = PUBLIC_SUPABASE_URL
    patch.supabase_anon = PUBLIC_SUPABASE_ANON
  }
  if (supabase_url && !cur.supabase_url) patch.supabase_url = supabase_url
  if (supabase_anon && !cur.supabase_anon) patch.supabase_anon = supabase_anon
  if (siliconflow_key && !cur.siliconflow_key) patch.siliconflow_key = siliconflow_key
  if (Object.keys(patch).length) saveSettings(patch)
}

function bootstrapAccountsFromEnv() {
  const p = process.env.KAIDA_ACCOUNTS_JSON
  if (!p || !existsSync(p)) return
  let arr: { name?: string; user?: string; username?: string; pass?: string; password?: string }[] = []
  try {
    arr = JSON.parse(readFileSync(p, 'utf8')) as typeof arr
  } catch {
    return
  }
  const have = new Set(listAccounts().map((a) => a.username))
  for (const r of arr) {
    const username = String(r.user || r.username || '')
    const password = String(r.pass || r.password || '')
    const name = String(r.name || '学生')
    if (!username || !password || have.has(username)) continue
    addAccount({ name, username, password })
    have.add(username)
  }
}

app.whenReady().then(() => {
  bootstrapEnv()
  bootstrapAccountsFromEnv()
  if (process.env.KAIDA_E2E_STORE === '1') {
    const round = process.env.KAIDA_E2E_STORE_ROUND || 'save'
    const out = process.env.KAIDA_E2E_STORE_OUT || '/tmp/kaida-e2e-store.json'
    const bin = path.join(app.getPath('userData'), 'kaida-store.bin')
    if (round === 'save') {
      const r = saveSettings({
        siliconflow_key: 'siliconflow-test-placeholder',
        supabase_url: 'https://example.supabase.co',
        supabase_anon: 'supabase-public-test-placeholder',
        account_parallel: 2,
        course_parallel: 2,
        browser_visible_default: false,
        log_enabled: true,
      })
      const csvPath = process.env.KAIDA_EXCEL_PATH || '/tmp/kaida-e2e-accounts.csv'
      if (!existsSync(csvPath)) {
        writeFileSync(csvPath, '姓名,账号,密码\n张同学,000000000001,pass1\n李同学,000000000002,pass2\n')
      }
      const imp = importExcelFromPath(csvPath)
      const s = getSettings()
      const acc = listAccounts()
      const raw = existsSync(bin) ? readFileSync(bin) : Buffer.from('')
      const text = raw.toString('utf8')
      writeFileSync(out, JSON.stringify({
        round,
        saveOk: r.ok,
        saveErr: r.error || '',
        keyRoundtrip: s.siliconflow_key === 'siliconflow-test-placeholder',
        url: s.supabase_url,
        importCount: imp.count || 0,
        names: acc.map((a) => a.name),
        users: acc.map((a) => a.username),
        binExists: existsSync(bin),
        plaintextLeak: /siliconflow-test-placeholder|pass1|000000000001/.test(text),
      }))
      app.exit(r.ok && !/siliconflow-test-placeholder|pass1/.test(text) ? 0 : 1)
      return
    }
    const s = getSettings()
    const acc = listAccounts()
    writeFileSync(out, JSON.stringify({
      round,
      keyRoundtrip: s.siliconflow_key === 'siliconflow-test-placeholder',
      url: s.supabase_url,
      names: acc.map((a) => a.name),
      users: acc.map((a) => a.username),
      parallel: s.account_parallel,
    }))
    app.exit(s.siliconflow_key === 'siliconflow-test-placeholder' && acc.length >= 2 ? 0 : 1)
    return
  }
  createWindow()
  void checkForUpdates()
  onNoqrChange(pushSnap)
  onProgress((e) => {
    win?.webContents.send('kaida:progress', e)
    pushSnap()
  })
  setInterval(() => { void refreshBrowserMemorySamples().finally(pushSnap) }, 2000)
  if (process.env.KAIDA_AUTO_DETECT === '1') {
    setTimeout(() => {
      void loginAndRefresh()
    }, 2500)
    setInterval(() => {
      if (!existsSync('/tmp/kaida-run-now')) return
      try { unlinkSync('/tmp/kaida-run-now') } catch { /* ignore */ }
      void loginAndRefresh()
    }, 800)
  }
})

ipcMain.handle('kaida:snapshot', () => snapshot())
ipcMain.handle('kaida:settings:get', () => {
  const s = getSettings()
  return {
    ...s,
    siliconflow_key: s.siliconflow_key ? '********' : '',
    supabase_anon: s.supabase_anon ? '********' : '',
    supabase_url: s.supabase_url,
  }
})
ipcMain.handle('kaida:settings:save', (_e, partial: Record<string, unknown>) => {
  const current = getSettings()
  if (concurrencyChangeLocked(current, partial, isRunning())) {
    return { ok: false, error: '任务运行中，本轮并发配置已锁定' }
  }
  const result = saveSettings(partial as never)
  if (result.ok) {
    pushSnap()
    win?.webContents.send('kaida:settings:changed', snapshot().settings)
  }
  return result
})
ipcMain.handle('kaida:settings:test', () => testConn())
ipcMain.handle('kaida:settings:connectivity', (event) => testAllModels(
  getSettings().siliconflow_key,
  3,
  (results) => event.sender.send('kaida:settings:connectivity-progress', { results }),
))
ipcMain.handle('kaida:settings:connectivity:one', (event, model: string) => testSingleModel(
  getSettings().siliconflow_key,
  model,
  (results) => event.sender.send('kaida:settings:connectivity-progress', { results, targetModel: model }),
))
ipcMain.handle('kaida:accounts:list', () => listAccounts().map((a) => ({
  local_id: a.local_id,
  name: a.name,
  account: a.username,
})))
ipcMain.handle('kaida:accounts:add', (_e, row: { name: string; username: string; password: string }) => {
  if (!row.username || !row.password) return { ok: false, error: '姓名、账号、密码都要填' }
  if (listAccounts().some((a) => a.username === row.username)) return { ok: false, error: '账号已存在' }
  const added = addAccount(row)
  enqueueNewStudents([added.local_id])
  pushSnap()
  return { ok: true }
})
ipcMain.handle('kaida:accounts:update', (_e, id: string, row: { name?: string; password?: string; display_mode?: 'headless' | 'visual'; work_mode?: 'answer' | 'extract' | 'noqr' }) => {
  if (!listAccounts().some((a) => a.local_id === id)) return { ok: false, error: '账号不存在' }
  const patch: Record<string, unknown> = {}
  if (row.name?.trim()) patch.name = row.name.trim()
  if (row.password) patch.password = row.password
  if (row.display_mode) patch.display_mode = row.display_mode
  if (row.work_mode) patch.work_mode = row.work_mode
  if ((patch.display_mode || patch.work_mode) && isStudentLocked(id)) return { ok: false, error: '该学生运行中，配置已锁定' }
  if (!Object.keys(patch).length) return { ok: false, error: '没有可保存的修改' }
  patchAccount(id, patch)
  pushSnap()
  return { ok: true }
})
ipcMain.handle('kaida:accounts:remove', async (_e, id: string) => {
  await deleteStudentRuntime(id)
  removeAccount(id)
  pushSnap()
  return { ok: true }
})
ipcMain.handle('kaida:accounts:removeAll', async (_e, confirmedIds: string[]) => {
  const ids = listAccounts().map((a) => a.local_id)
  if (!Array.isArray(confirmedIds) || ids.length !== confirmedIds.length || ids.some((id) => !confirmedIds.includes(id))) {
    return { ok: false, removed: 0, error: '学生账号已变化，请重新确认' }
  }
  await stopAllStudents()
  const current = listAccounts().map((a) => a.local_id)
  if (current.length !== ids.length || current.some((id) => !ids.includes(id))) return { ok: false, removed: 0, error: '学生账号已变化，请重新确认' }
  let removed = 0
  for (const id of ids) {
    try { removeAccount(id); removed++ } catch { break }
  }
  pushSnap()
  return { ok: removed === ids.length, removed, error: removed === ids.length ? undefined : '部分账号删除失败，请核对后重试' }
})
ipcMain.handle('kaida:accounts:importExcel', async () => {
  const forced = process.env.KAIDA_EXCEL_PATH
  let p = forced || ''
  if (!p) {
    const r = await dialog.showOpenDialog({ filters: [{ name: 'Excel', extensions: ['xlsx', 'xls', 'csv'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: '未选择文件' }
    p = r.filePaths[0]
  }
  const done = importExcelFromPath(p)
  pushSnap()
  return done
})
ipcMain.handle('kaida:accounts:paste:parse', (_e, text: string) => {
  const parsed = parsePastedAccounts(String(text || ''))
  const existing = new Set(listAccounts().map((account) => account.username))
  const errors = [...parsed.errors]
  const rows = parsed.rows.filter((row) => {
    if (!existing.has(row.username)) return true
    errors.push({ line: 0, text: row.username, reason: '账号已存在' })
    return false
  })
  return { ok: true, rows, errors, skippedHeaders: parsed.skippedHeaders }
})
ipcMain.handle('kaida:accounts:paste:confirm', (_e, rows: AccountRow[]) => {
  const existing = new Set(listAccounts().map((account) => account.username))
  let imported = 0
  let failed = 0
  const addedIds: string[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.name || !row?.username || !row?.password || existing.has(row.username)) continue
    try {
      addedIds.push(addAccount({ name: row.name, username: row.username, password: row.password }).local_id)
      existing.add(row.username)
      imported++
    } catch { failed++ }
  }
  enqueueNewStudents(addedIds)
  pushSnap()
  return { ok: failed === 0, imported, error: failed ? `${failed} 名学生保存失败` : undefined }
})
ipcMain.handle('kaida:bank:importJson', async () => {
  const startedAt = Date.now()
  const r = await dialog.showOpenDialog({ filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return { ok: false, error: '先选择 JSON' }
  try {
    const stat = statSync(r.filePaths[0])
    const raw = readFileSync(r.filePaths[0], 'utf8')
    const parsed = parseBankJson(raw)
    let added = 0, merged = 0, conflict = 0, skipped = parsed.skipped, failed = 0
    for (const it of parsed.items) {
      const kind = await upsertQuestion({
        qtype: it.qtype,
        stem: it.stem,
        options: it.options,
        answer_texts: it.answer_texts,
        course_name: it.course_name,
        source: 'import',
        verified: false,
      })
      if (kind === 'added') added++
      else if (kind === 'merged') merged++
      else if (kind === 'conflict') conflict++
      else failed++
      void contentHash
    }
    return { ok: true, fileName: basename(r.filePaths[0]), fileSize: stat.size, durationMs: Date.now() - startedAt, added, merged, conflict, skipped, failed }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'JSON 题库格式错误', durationMs: Date.now() - startedAt }
  }
})
ipcMain.handle('kaida:bank:access:status', () => bankAccessStatus())
ipcMain.handle('kaida:bank:unlock', (event, password: string) => {
  const result = unlockBank(String(password || ''))
  if (result.ok) bankUnlockedWebContents.add(event.sender.id)
  return result
})
ipcMain.handle('kaida:bank:list', (event, query) => {
  if (!bankUnlockedWebContents.has(event.sender.id)) return { ok: false, error: '请先输入查看题库密码', rows: [], total: 0, page: 1, pageSize: 20 }
  return listQuestions(query)
})
ipcMain.handle('kaida:bank:courses', (event) => {
  if (!bankUnlockedWebContents.has(event.sender.id)) return { ok: false, error: '请先输入查看题库密码', courses: [] }
  return listQuestionCourses()
})
ipcMain.handle('kaida:bank:delete', (event, ids: string[]) => {
  if (!bankUnlockedWebContents.has(event.sender.id)) return { requestedIds: [], deletedIds: [], failed: [], readbackConfirmed: false, error: '请先输入查看题库密码' }
  return deleteQuestions(Array.isArray(ids) ? ids : [])
})
ipcMain.handle('kaida:run:detect', async (_e, accountIds?: string[]) => {
  return loginAndRefresh(Array.isArray(accountIds) ? accountIds : undefined)
})
ipcMain.handle('kaida:run:startStudent', (_e, id: string) => {
  const result = startStudent(id)
  pushSnap()
  return result
})
ipcMain.handle('kaida:run:stopAll', async () => {
  await stopAllStudents()
  pushSnap()
  return { ok: true }
})
ipcMain.handle('kaida:settings:applyAll', (_e, id: string) => {
  const result = applyStudentSettingsToAll(id)
  pushSnap()
  return result
})
ipcMain.handle('kaida:display', async (_e, id: string, mode: 'headless' | 'visual') => {
  const result = await toggleDisplay(id, mode)
  pushSnap()
  return result
})
ipcMain.handle('kaida:workMode', async (_e, id: string, mode: 'answer' | 'extract' | 'noqr') => {
  const result = await setWorkMode(id, mode)
  pushSnap()
  return result
})
ipcMain.handle('kaida:courseScope', (_e, id: string, scope: 'all' | 'selected') => {
  const result = setCourseScope(id, scope)
  pushSnap()
  return result
})
ipcMain.handle('kaida:selectedCourses', (_e, id: string, names: string[]) => {
  const result = setSelectedCourses(id, Array.isArray(names) ? names : [])
  pushSnap()
  return result
})
ipcMain.handle('kaida:selectedCourses:start', () => {
  const result = startSelectedCourseExecution()
  pushSnap()
  return result
})
ipcMain.handle('kaida:history:list', (_e, id: string, courseName: string, homeworkName: string) =>
  getHomeworkHistory(id, courseName, homeworkName))
ipcMain.handle('kaida:history:paper', (_e, id: string, courseName: string, homeworkName: string, submittedAt: string) =>
  getHistoryPaperImage(id, courseName, homeworkName, submittedAt))
ipcMain.handle('kaida:answerRoundLimit', (_e, id: string, limit: number) => {
  const result = setAnswerRoundLimit(id, limit)
  pushSnap()
  return result
})
ipcMain.handle('kaida:openVisual', async (_e, id: string) => openVisual(id))
ipcMain.handle('kaida:qr:get', (_e, id: string) => getQrSnapshot(id))
ipcMain.handle('kaida:qr:refresh', (_e, id: string) => refreshQrSnapshot(id))
ipcMain.handle('kaida:qr:copy', (_e, id: string, version: number) => {
  const result = getQrSnapshot(id)
  if (!result.ok || !result.snapshot) return result
  if (result.snapshot.version !== version) return { ok: false, error: '该二维码已失效，请刷新后再复制' }
  const image = nativeImage.createFromDataURL(result.snapshot.image)
  if (image.isEmpty()) return { ok: false, error: '二维码图片不可用' }
  clipboard.writeImage(image)
  return { ok: true }
})
ipcMain.handle('kaida:verifyDone', async (_e, id: string) => signalVerified(id))
ipcMain.handle('kaida:stop', async (_e, id: string) => {
  const result = await stopStudent(id)
  pushSnap()
  return result
})
ipcMain.handle('kaida:ota', () => updaterFeed())
ipcMain.handle('kaida:ota:check', () => checkForUpdates())
ipcMain.handle('kaida:ota:state', () => currentUpdateState())
ipcMain.handle('kaida:ota:download', () => downloadUpdate())
ipcMain.handle('kaida:ota:install', () => installUpdate())
ipcMain.handle('kaida:window:minimize', () => { win?.minimize(); return { ok: true } })
ipcMain.handle('kaida:window:maximize', () => { if (win?.isMaximized()) win.unmaximize(); else win?.maximize(); return { ok: true, maximized: Boolean(win?.isMaximized()) } })
ipcMain.handle('kaida:window:close', () => {
  if (!win) return { ok: true }
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    title: '关闭程序',
    message: '确定要关闭开大智达舱吗？',
    buttons: ['取消', '关闭程序'],
    defaultId: 0,
    cancelId: 0,
  })
  if (choice === 1) win.close()
  return { ok: choice === 1 }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
