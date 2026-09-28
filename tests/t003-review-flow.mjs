import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'patchright'
import { contentHash, englishMatchStem, englishSlotStem } from '../electron/core/hash.ts'

const rows = new Map()
let deleteCalls = 0
globalThis.__protectedHashes = new Set()
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const hash = url.searchParams.get('content_hash')?.slice(3)
  if (!url.pathname.endsWith('/questions')) { res.writeHead(404); res.end(); return }
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET') { res.end(JSON.stringify(hash && rows.has(hash) ? [rows.get(hash)] : [])); return }
  let body = ''
  for await (const chunk of req) body += chunk
  const item = JSON.parse(body)
  if (req.method === 'POST') rows.set(item.content_hash, item)
  if (req.method === 'PATCH' && hash) rows.set(hash, { ...rows.get(hash), ...item })
  if (req.method === 'DELETE' && hash) { deleteCalls++; rows.delete(hash) }
  res.end(JSON.stringify([req.method === 'PATCH' ? rows.get(hash) : item]))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
globalThis.__reviewUrl = `http://127.0.0.1:${server.address().port}`
const built = await build({
  entryPoints: ['electron/review.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'local-settings', setup(plugin) {
    plugin.onResolve({ filter: /store$/ }, args => ({ path: args.path, namespace: 'local-store' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-store' }, () => ({
      contents: "export const getSettings = () => ({ supabase_url: globalThis.__reviewUrl, supabase_anon: 'fake' }); export const getWriteback = () => []; export const protectReferenceHash = hash => (globalThis.__protectedHashes.add(hash), true); export const isReferenceHashProtected = hash => globalThis.__protectedHashes.has(hash)", loader: 'js',
    }))
  } }],
})
const review = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const question = (stem, right, reference) => `<div class="e-q-body" data-questiontype="1"><div class="e-q">` +
  `<div class="e-q-q">${stem}</div><div class="e-q-l"><span class="e-q-${right ? 'right' : 'wrong'}"></span></div>` +
  `<div class="e-a-g e-choice-a"><ul><li class="e-a checked">A) 甲</li><li class="e-a">B) 乙</li></ul></div>` +
  (reference === null ? '' : `<div class="e-a-ans"><div class="e-ans-ref"><span class="e-ans-r">${reference}</span></div></div>`) +
  '</div></div>'
try {
  await page.setContent(question('可靠参考', false, 'B') + question('旧分支', true, null) + question('损坏参考', false, 'Z'))
  const parsed = await review.readReviewedQuestions(page)
  const results = parsed.map((q, index) => ({ no: String(index + 1), hash: q.hash, qtype: q.qtype, stem: q.stem, options: q.options, selected: q.selected, source: 'AI 答题' }))
 const outcome = await review.reviewResults(page, results, '测试课程')
  assert.equal(outcome.oldModeQuestions, 1)
  assert.equal(outcome.referenceQuestions, 2, '损坏参考答案仍属于参考分支待重试')
  assert.equal(outcome.referenceStats.added, 1)
  assert.equal(outcome.inserted, 1, '无参考答案旧分支保持 AI 答对入库')
  assert.equal(outcome.referenceStats.retry, 1)
  assert.deepEqual(rows.get(parsed[0].hash).answer_texts, ['乙'])
  assert.deepEqual(outcome.pendingCandidates.map(q => q.hash), [parsed[2].hash])
 const blocked = await review.reviewResults(page, [results[0]], '测试课程', { blockedHashes: new Set([parsed[0].hash]) })
  assert.equal(blocked.oldModeQuestions, 0)
  assert.equal(blocked.referenceQuestions, 1)
  assert.equal(blocked.referenceStats.contradictions, 1)
  assert.equal(blocked.pendingCandidates.length, 0)
  const extract = await review.extractReviewedQuestions(page, '测试课程', undefined, undefined, { questions: parsed })
  assert.equal(extract.referenceStats.merged, 1)
  assert.equal(extract.merged, 1, '无参考答案答对时沿用旧提取规则')
  assert.equal(extract.referenceStats.retry, 1)
  assert.equal(extract.pendingReferenceHashes.includes(parsed[2].hash), true)
  const contradiction = review.contradictoryReferenceHashes([
    parsed[0], { ...parsed[0], answerTexts: ['甲'] },
  ])
  assert.equal(contradiction.has(parsed[0].hash), true)
  const skipped = await review.extractReviewedQuestions(page, '测试课程', undefined, undefined, {
    questions: [parsed[0]], blockedHashes: contradiction,
  })
  assert.equal(skipped.referenceStats.contradictions, 1)
  await page.setContent(question('可靠参考', false, null))
 const oldDeletion = await review.reviewResults(page, [{ ...results[0], source: '题库答题' }], '测试课程')
  assert.equal(oldDeletion.oldModeQuestions, 1)
  assert.equal(oldDeletion.referenceQuestions, 0)
  assert.equal(oldDeletion.protectedDeletes, 1)
  assert.equal(oldDeletion.deleted, 0)
  assert.equal(oldDeletion.pendingCandidates.length, 0)
  assert.equal(deleteCalls, 0)
  assert.deepEqual(rows.get(parsed[0].hash).answer_texts, ['乙'])
  const slots = ['共享语篇一', '共享语篇二'].map(shared => {
    const stem = englishSlotStem(shared, 9, 1, '第 1 空')
    return { ...parsed[0], stem, hash: contentHash('single', stem, parsed[0].options) }
  })
  const slotWriteback = await review.extractReviewedQuestions(page, '测试课程', undefined, undefined, { questions: slots })
  assert.equal(slotWriteback.referenceStats.added, 2, '不同共享语篇的同序号子题分别入库')
  assert.notEqual(slots[0].hash, slots[1].hash)
  assert.deepEqual(slots.map(slot => rows.get(slot.hash).answer_texts), [['乙'], ['乙']])
  const child = (stem, right, kind = 'single', reference = '') => `<form><div class='e-q-l'><span class='e-q-${right ? 'right' : 'wrong'}'></span></div>
    <div class='e-q-quest'><div class='e-q-q'>${stem}</div><div class='e-a-g e-choice-a'><ul>
    <li class='e-a checked' data-subquestiontype='${kind === 'judge' ? 3 : 1}'>${kind === 'judge' ? '正确' : 'A) 甲'}</li>
    <li class='e-a' data-subquestiontype='${kind === 'judge' ? 3 : 1}'>${kind === 'judge' ? '错误' : 'B) 乙'}</li>
    </ul></div></div>${reference ? `<div class='e-a-ans'><div class='e-ans-ref'>${reference}</div></div>` : ''}</form>`
  const composite = (type, shared, children, transcript = '') => `<div class='e-q-body' data-questiontype='${type}'><div class='e-q'>
    <div class='e-q-r'><div class='e-q-quest'><div class='e-q-q'>${shared}</div>
    ${transcript ? `<div data-transcript='${transcript}'></div>` : ''}${children.join('')}</div></div></div></div>`
  await page.setContent([
    composite(8, '阅读篇章一', [child('判断一', true, 'judge'), child('判断二', false, 'judge',
      "<div class='e-ans-r'><div class='e-a-g'><p class='checked'>错误</p></div></div>")]),
    composite(9, '完型语篇一', [child('', true), child('', false)]),
    composite(11, '听力材料一', [child('听力一', true)], '可靠转写文本'),
    composite(11, '听力材料二', [child('听力一', true)]),
    `<div class='e-q-body' data-questiontype='7'><div class='e-q'><div class='e-q-q'>配对材料</div>
      <div class='e-short-a'><div class='am-u-offset-1 am-u-sm-5'><div class='ErichText'>A 、词一</div>
      <div class='ErichText'>B 、词二</div></div></div></div></div>`,
    question('普通单选', true, null),
  ].join(''))
  const english = await review.readReviewedQuestions(page)
  assert.equal(english.length, 8)
  assert.deepEqual(english.map(q => q.correct), [true, false, true, false, true, true, null, true])
  assert.deepEqual(english.map(q => q.referenceState), ['absent', 'valid', 'absent', 'absent', 'valid', 'valid', 'invalid', 'absent'])
  assert.ok(english.slice(0, 6).every(q => q.hash))
  assert.equal(english[4].hash, contentHash('single', englishSlotStem('听力材料一', 11, 1, '听力一'), ['甲', '乙']),
    '听力题库身份只取固定题干、子题与选项，不依赖转写')
  assert.equal(english[5].stem, englishSlotStem('听力材料二', 11, 1, '听力一'))
  assert.equal(english[6].hash, '', '无逐槽配对证据不能写库')
  assert.notEqual(english[0].hash, english[1].hash)
  assert.notEqual(english[2].hash, english[3].hash)
  assert.deepEqual(english[1].answerTexts, ['错误'])
  const englishExtract = await review.extractReviewedQuestions(page, '测试课程', undefined, undefined, { questions: english })
  assert.equal(englishExtract.added, 3, '无转写听力也只提取明确判对的子题')
  assert.equal(englishExtract.skipped, 1, '错误且无参考答案的子题不得入库')
 assert.equal(englishExtract.referenceStats.added, 3, '错误子题与听力明确判对题均应入库')
  assert.equal(englishExtract.referenceStats.retry, 1, '无逐槽配对证据仍保留待证')
  assert.deepEqual(rows.get(english[1].hash).answer_texts, ['错误'])
  await page.setContent(`<div class="e-q-body" data-questiontype="7"><div class="e-q"><form>
    <div class="e-q-r"><div class="e-q-quest"><div class="e-q-q">配对材料</div>
    <div class="e-short-a">
    <div class="am-u-sm-5"><div class="ErichText">1、左一</div><div class="ErichText">2、左二</div></div>
    <div class="am-u-sm-1"><div class="e-ans-ref"><span class="e-ans-r">B</span></div>
    <div class="e-ans-ref"><span class="e-ans-r">A</span></div></div>
    <div class="am-u-offset-1 am-u-sm-5"><div class="ErichText">A、右一</div>
    <div class="ErichText">B、右二</div></div></div></div></div></form></div></div>`)
  const matching = await review.readReviewedQuestions(page)
  assert.equal(matching.length, 2, '有逐槽标准配对时应展开每个匹配槽')
  assert.deepEqual(matching.map(row => row.answerTexts), [['右二'], ['右一']])
  assert.deepEqual(matching.map(row => row.referenceState), ['valid', 'valid'])
  assert.deepEqual(matching.map(row => row.hash), ['左一', '左二'].map((left, index) =>
    contentHash('single', englishMatchStem('配对材料', index + 1, left), ['右一', '右二'])))
  console.log('T003 参考答案逐题分流通过')
} finally {
  await browser.close()
  server.close()
}
