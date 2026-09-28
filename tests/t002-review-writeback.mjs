import assert from "node:assert/strict"
import { createServer } from "node:http"
import { build } from "esbuild"
import { chromium } from "patchright"

const rows = new Map()
let deleteDoesNothing = false
let deleteCalls = 0
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  const hash = url.searchParams.get("content_hash")?.slice(3)
  if (!url.pathname.endsWith("/questions")) { res.writeHead(404); res.end(); return }
  if (req.method === "GET") {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(hash && rows.has(hash) ? [rows.get(hash)] : []))
    return
  }
  if (req.method === "DELETE") {
    deleteCalls++
    if (!deleteDoesNothing && hash) rows.delete(hash)
    res.writeHead(200, { "content-type": "application/json" })
    res.end("[]")
    return
  }
  let body = ""
  for await (const chunk of req) body += chunk
  const item = JSON.parse(body)
  if (req.method === "POST") rows.set(item.content_hash, item)
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify([item]))
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
globalThis.__reviewUrl = `http://127.0.0.1:${server.address().port}`
const built = await build({
  entryPoints: ["electron/review.ts"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "local-settings", setup(plugin) {
    plugin.onResolve({ filter: /store$/ }, args => ({ path: args.path, namespace: "local-store" }))
    plugin.onLoad({ filter: /.*/, namespace: "local-store" }, () => ({
      contents: "export const getSettings = () => ({ supabase_url: globalThis.__reviewUrl, supabase_anon: 'fake' }); export const getWriteback = () => []; export const protectReferenceHash = () => true; export const isReferenceHashProtected = () => false", loader: "js",
    }))
  } }],
})
const review = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
try {
  const question = (no, stem, result) => `
    <div class="e-q-body" data-questiontype="1"><div class="e-q">
      <div class="e-q-q">${stem}</div>
      <div class="e-q-l"><span class="e-q-${result}"></span></div>
      <input name="GiveScore" value="${result === "right" ? 50 : 0}">
      <div class="e-a-g e-choice-a"><ul>
        <li class="e-a checked">A) 甲</li><li class="e-a">B) 乙</li>
      </ul></div>
    </div></div>`
  await page.setContent(question(1, "正确的第一题", "right") + question(2, "答错的第二题", "wrong"))
  const observed = await review.readReviewedQuestions(page)
  assert.equal(observed.length, 2)
  assert.deepEqual(observed.map(item => item.correct), [true, false])
  const results = observed.map((item, index) => ({
    no: String(index + 1), hash: item.hash, source: index ? "题库答题" : "AI 答题",
    qtype: item.qtype, stem: item.stem, options: item.options, selected: item.selected,
  }))
  rows.set(results[1].hash, { content_hash: results[1].hash, qtype: "single", answer_texts: ["甲"], verified: true })
  const outcome = await review.reviewResults(page, results, "测试课程")
  assert.equal(outcome.inserted, 1, "AI 正确题应进入真实题库写入路径")
  assert.equal(outcome.deleted, 1, "题库错题必须 DELETE 后回读确认")
  assert.equal(outcome.bankWrong, 1)
  assert.equal(outcome.pendingCandidates.length, 0)
  assert.deepEqual(rows.get(results[0].hash)?.answer_texts, ["甲"])
  assert.equal(rows.has(results[1].hash), false)
  assert.equal(deleteCalls, 1)

  rows.set(results[1].hash, { content_hash: results[1].hash, qtype: "single", answer_texts: ["甲"], verified: true })
  deleteDoesNothing = true
  const failed = await review.reviewResults(page, [results[1]], "测试课程")
  assert.equal(failed.deleted, 0)
  assert.equal(failed.deleteFailed, 1, "HTTP 200 但回读仍在不能算删除成功")
  assert.deepEqual(failed.pendingDeleteHashes, [results[1].hash])
  assert.equal(rows.has(results[1].hash), true)
  console.log("T002 真实批阅与题库回写路径通过")
} finally {
  await browser.close()
  server.close()
}
