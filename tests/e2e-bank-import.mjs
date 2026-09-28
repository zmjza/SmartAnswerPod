import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from 'patchright'
import { contentHash } from '../electron/core/hash.ts'

const goalFile = process.env.KAIDA_GOAL_FILE
const goal = goalFile ? readFileSync(goalFile, 'utf8').split(String.fromCharCode(92)).join('') : ''
let base = process.env.KAIDA_SUPABASE_URL || goal.match(new RegExp('https://[a-z]+[.]supabase[.]co'))?.[0]
let key = process.env.KAIDA_SUPABASE_ANON || goal.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0]
if (!base || !key) {
  const configApp = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
  try {
    await configApp.firstWindow()
    const saved = await configApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.kaida.getSettings()'))
    saved.base = saved.supabase_url
    saved.key = saved.supabase_anon
    base ||= saved.base
    key ||= saved.key
  } finally {
    await configApp.close()
  }
}
assert.ok(base && key, '本机配置缺少题库连接')

const auth = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
const batch = `codex-bank-import-e2e-${Date.now()}`
const tempDir = mkdtempSync(join(tmpdir(), 'kaida-bank-import-'))
const baseQuestion = { qtype: 'single', stem: `${batch}-基础题`, options: [`${batch}-甲`, `${batch}-乙`], answer_texts: [`${batch}-甲`], course_name: `${batch}-课程甲` }
const conflictQuestion = { qtype: 'single', stem: `${batch}-冲突题`, options: [`${batch}-正确`, `${batch}-错误`], answer_texts: [`${batch}-正确`], course_name: `${batch}-冲突课程` }
const writeFailureQuestion = { qtype: 'judge', stem: `${batch}-写入失败题`, options: ['正确', '错误'], answer_texts: ['正确'], course_name: `${batch}-失败课程` }
const readbackFailureQuestion = { qtype: 'judge', stem: `${batch}-回读失败题`, options: ['正确', '错误'], answer_texts: ['错误'], course_name: `${batch}-失败课程` }
const questions = [baseQuestion, conflictQuestion, writeFailureQuestion, readbackFailureQuestion]
const hashes = questions.map((item) => contentHash(item.qtype, item.stem, item.options))

async function request(path, init = {}) {
  return fetch(`${base.replace(/\/$/, '')}/rest/v1${path}`, { ...init, headers: { ...auth, ...init.headers } })
}
async function rowsByHashes() {
  const response = await request(`/questions?select=*&content_hash=in.(${hashes.join(',')})`)
  assert.ok(response.ok, `测试批次回读失败 HTTP ${response.status}`)
  return response.json()
}
async function nonBatchSample() {
  const response = await request(`/questions?select=id,content_hash,answer_texts,course_names&content_hash=not.in.(${hashes.join(',')})&limit=1`)
  assert.ok(response.ok, `非本批题目回读失败 HTTP ${response.status}`)
  const rows = await response.json()
  assert.equal(rows.length, 1, '真实题库没有可用于保护校验的非本批题目')
  return rows[0]
}
async function cleanup() {
  const response = await request(`/questions?content_hash=in.(${hashes.join(',')})`, { method: 'DELETE' })
  assert.ok(response.ok, `测试批次清理失败 HTTP ${response.status}`)
  assert.equal((await rowsByHashes()).length, 0, '测试批次清理后仍有残留')
}
function jsonFile(name, value, raw = false) {
  const path = join(tempDir, name)
  writeFileSync(path, raw ? value : JSON.stringify(value), 'utf8')
  return path
}
async function selectImportFile(app, filePath) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, filePath)
}
async function runImport(app, page, filePath) {
  await selectImportFile(app, filePath)
  await page.getByRole('button', { name: '开始导入' }).click()
  await page.waitForFunction(() => document.querySelector('#btn-text')?.textContent?.trim() === '开始导入')
  return page.evaluate(() => ({
    added: Number(document.querySelector('#metric-added')?.textContent || 0),
    merged: Number(document.querySelector('#metric-merged')?.textContent || 0),
    conflict: Number(document.querySelector('#metric-conflict')?.textContent || 0),
    skipped: Number(document.querySelector('#metric-skipped')?.textContent || 0),
    failed: Number(document.querySelector('#metric-failed')?.textContent || 0),
    status: document.querySelector('#status-text')?.textContent?.trim() || '',
    badge: document.querySelector('#status-banner > span')?.textContent?.trim() || '',
  }))
}
async function patchFetch(app, mode, targetHash) {
  await app.evaluate(({ net }, payload) => {
    const scope = globalThis
    scope.__kaidaOriginalFetch ||= scope.fetch
    const original = scope.__kaidaOriginalFetch
    let matchingReads = 0
    scope.fetch = async (input, init) => {
      const url = String(input)
      if (payload.mode === 'write' && init?.method === 'POST' && url.includes('/questions?on_conflict=content_hash')) {
        return new Response('controlled write failure', { status: 503 })
      }
      if (payload.mode === 'readback' && url.includes(`content_hash=eq.${payload.hash}`) && (!init?.method || init.method === 'GET')) {
        matchingReads++
        if (matchingReads >= 2 && matchingReads <= 3) return new Response('controlled readback failure', { status: 503 })
      }
      return original(input, init)
    }
    void net
  }, { mode, hash: targetHash })
}
async function restoreFetch(app) {
  await app.evaluate(() => {
    const scope = globalThis
    if (scope.__kaidaOriginalFetch) scope.fetch = scope.__kaidaOriginalFetch
  })
}

await cleanup()
const protectedBefore = await nonBatchSample()
const app = await electron.launch({ args: ['.'], env: { ...process.env, VITE_DEV_SERVER_URL: '' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const configured = await app.evaluate(({ BrowserWindow }, settings) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`window.kaida.saveSettings(${JSON.stringify(settings)})`),
  { supabase_url: base, supabase_anon: key })
  assert.equal(configured.ok, true, configured.error || '题库导入测试无法保存产品连接配置')
  await page.getByText('题库', { exact: true }).first().click()
  await page.getByRole('button', { name: '导入题库' }).click()
  await page.getByRole('button', { name: '开始导入' }).waitFor()

  const invalidItems = [
    { stem: baseQuestion.stem, options: baseQuestion.options, answer_texts: baseQuestion.answer_texts },
    { qtype: baseQuestion.qtype, options: baseQuestion.options, answer_texts: baseQuestion.answer_texts },
    { qtype: baseQuestion.qtype, stem: baseQuestion.stem, answer_texts: baseQuestion.answer_texts },
    { qtype: baseQuestion.qtype, stem: baseQuestion.stem, options: baseQuestion.options },
    { ...baseQuestion, stem: '' },
    { ...baseQuestion, qtype: 'essay' },
    { ...baseQuestion, options: [] },
    { ...baseQuestion, answer_texts: [] },
    { ...baseQuestion, stem: `${batch}-损坏�题干` },
    { ...baseQuestion, answer_texts: [`${batch}-不存在`] },
    { ...baseQuestion, answer_texts: baseQuestion.options },
  ]
  const first = await runImport(app, page, jsonFile('first.json', [baseQuestion, ...invalidItems]))
  assert.deepEqual({ added: first.added, merged: first.merged, conflict: first.conflict, skipped: first.skipped, failed: first.failed }, { added: 1, merged: 0, conflict: 0, skipped: 11, failed: 0 })
  assert.match(first.status, /导入完成/)
  assert.equal(first.badge, '已写入 Supabase 云端题库')

  const duplicate = await runImport(app, page, jsonFile('duplicate.json', [baseQuestion]))
  assert.equal(duplicate.merged, 1, '完全重复没有计入合并')

  const otherCourse = await runImport(app, page, jsonFile('course.json', [{ ...baseQuestion, course_name: `${batch}-课程乙` }]))
  assert.equal(otherCourse.merged, 1, '同题同答案不同课程没有合并')
  const shuffled = await runImport(app, page, jsonFile('shuffled.json', [{ ...baseQuestion, options: [...baseQuestion.options].reverse(), course_name: `${batch}-课程丙` }]))
  assert.equal(shuffled.merged, 1, '选项顺序变化没有去重')

  const existingConflict = {
    qtype: conflictQuestion.qtype,
    stem: conflictQuestion.stem,
    options: conflictQuestion.options,
    answer_texts: conflictQuestion.answer_texts,
    content_hash: hashes[1],
    course_names: [conflictQuestion.course_name],
    source: 'extract',
    verified: true,
    conflict: false,
  }
  const inserted = await request('/questions?on_conflict=content_hash', { method: 'POST', headers: { Prefer: 'return=representation,resolution=merge-duplicates' }, body: JSON.stringify(existingConflict) })
  assert.ok(inserted.ok, `冲突前置题写入失败 HTTP ${inserted.status}`)
  const conflict = await runImport(app, page, jsonFile('conflict.json', [{ ...conflictQuestion, answer_texts: [`${batch}-错误`] }]))
  assert.equal(conflict.conflict, 1, '已验证答案冲突没有计入冲突')
  const conflictRow = (await rowsByHashes()).find((row) => row.content_hash === hashes[1])
  assert.deepEqual(conflictRow.answer_texts, conflictQuestion.answer_texts, '冲突导入覆盖了已验证答案')
  assert.equal(conflictRow.conflict, true, '冲突题没有标记 conflict')

  const empty = await runImport(app, page, jsonFile('empty.json', []))
  assert.match(empty.status, /导入完成/, '合法空数组被误显示为等待导入')

  const malformed = await runImport(app, page, jsonFile('malformed.json', '{', true))
  assert.match(malformed.badge, /导入失败/)
  assert.equal(malformed.added + malformed.merged + malformed.conflict + malformed.skipped + malformed.failed, 0, '失败后残留上一次统计')

  await patchFetch(app, 'write', hashes[2])
  const writeFailure = await runImport(app, page, jsonFile('write-failure.json', [writeFailureQuestion]))
  await restoreFetch(app)
  assert.equal(writeFailure.failed, 1, '写入失败没有计入失败')
  assert.equal(writeFailure.badge, '存在写入失败')

  await patchFetch(app, 'readback', hashes[3])
  const readbackFailure = await runImport(app, page, jsonFile('readback-failure.json', [readbackFailureQuestion]))
  await restoreFetch(app)
  assert.equal(readbackFailure.failed, 1, '回读失败没有计入失败')
  assert.equal(readbackFailure.badge, '存在写入失败')

  const stored = await rowsByHashes()
  const baseRow = stored.find((row) => row.content_hash === hashes[0])
  assert.deepEqual(baseRow.course_names.sort(), [`${batch}-课程甲`, `${batch}-课程乙`, `${batch}-课程丙`].sort(), '课程名没有去重合并')

  console.log(JSON.stringify({ ok: true, added: 1, duplicate: 1, courseMerged: 1, shuffledMerged: 1, conflict: 1, skipped: 11, emptyArray: true, malformedRejected: true, writeFailure: 1, readbackFailure: 1, nonBatchProtected: true }))
} finally {
  await restoreFetch(app).catch(() => {})
  await app.close()
  await cleanup()
  assert.deepEqual(await nonBatchSample(), protectedBefore, '非本批真实题目在测试后发生变化')
  rmSync(tempDir, { recursive: true, force: true })
}
