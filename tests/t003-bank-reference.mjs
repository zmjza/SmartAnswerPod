import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'

let row = null
let patchIgnored = false
let deleteCalls = 0
globalThis.__protectedHashes = new Set()
globalThis.__protectFail = false
globalThis.__pendingDeletes = []
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (!url.pathname.endsWith('/questions')) { res.writeHead(404); res.end(); return }
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET') { res.end(JSON.stringify(row ? [row] : [])); return }
  if (req.method === 'DELETE') { deleteCalls++; row = null; res.end('[]'); return }
  let body = ''
  for await (const chunk of req) body += chunk
  const item = JSON.parse(body)
  if (req.method === 'PATCH') {
    if (!patchIgnored) row = { ...row, ...item }
    res.end(JSON.stringify([{ ...row, ...item }]))
    return
  }
  if (req.method === 'POST') row = item
  res.end(JSON.stringify([row]))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
globalThis.__bankUrl = `http://127.0.0.1:${server.address().port}`
const built = await build({
  entryPoints: ['electron/bank.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'local-settings', setup(plugin) {
    plugin.onResolve({ filter: /store$/ }, args => ({ path: args.path, namespace: 'local-store' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-store' }, () => ({
      contents: "export const getSettings = () => ({ supabase_url: globalThis.__bankUrl, supabase_anon: 'fake' }); export const getWriteback = () => globalThis.__pendingDeletes; export const protectReferenceHash = hash => { if (globalThis.__protectFail) return false; globalThis.__protectedHashes.add(hash); return true }; export const isReferenceHashProtected = hash => globalThis.__protectedHashes.has(hash)", loader: 'js',
    }))
  } }],
})
const bank = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
try {
  const item = { qtype: 'single', stem: '示例题', options: ['甲', '乙'], answer_texts: ['乙'], source: 'extract', referenceAnswer: true, verified: true, course_name: '测试课程' }
  assert.equal(await bank.upsertQuestion(item), 'added')
  assert.equal(globalThis.__protectedHashes.has(row.content_hash), true, '参考答案写库前应持久保护 hash')
  assert.deepEqual((await bank.lookupByHash(row.content_hash)).answer_texts, ['乙'])
  globalThis.__pendingDeletes = [{ need_delete_hashes: [row.content_hash] }]
  assert.deepEqual((await bank.lookupByHash(row.content_hash))?.answer_texts, ['乙'], '旧待删除记录不得挡住已确认参考答案')
  globalThis.__pendingDeletes = []
 assert.equal(await bank.deleteByHash(row.content_hash, ['乙']), 'protected')
  const restarted = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64') + '#restart')
  assert.equal(await restarted.deleteByHash(row.content_hash, ['乙']), 'protected', '重启后旧待删任务仍受保护')
 assert.equal(deleteCalls, 0, '旧待删队列不得删除参考答案确认的行')
  row = { ...row, answer_texts: ['甲'] }
  assert.equal(await bank.upsertQuestion(item), 'updated', '可靠参考答案可修正已验证旧行')
  assert.deepEqual((await bank.lookupByHash(row.content_hash)).answer_texts, ['乙'])
  assert.equal(await bank.upsertQuestion(item), 'merged', '相同答案去重')
  row = { ...row, conflict: true }
  assert.equal(await bank.upsertQuestion(item), 'merged', '可靠参考答案应解除旧冲突标记')
  assert.equal((await bank.lookupByHash(row.content_hash))?.conflict, false)
  row = { ...row, answer_texts: ['甲'] }
  patchIgnored = true
  assert.equal(await bank.upsertQuestion(item), 'failed', 'PATCH 200 但读回仍为旧答案不能报成功')
  assert.deepEqual(row.answer_texts, ['甲'])
  globalThis.__protectFail = true
  globalThis.__protectedHashes.clear()
  assert.equal(await bank.upsertQuestion(item), 'failed', '持久保护失败时不得开始云端覆盖')
  assert.deepEqual(row.answer_texts, ['甲'])
  console.log('T003 参考答案更新与读回通过')
} finally {
  server.close()
}
