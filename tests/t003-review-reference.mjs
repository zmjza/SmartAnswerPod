import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'patchright'

const built = await build({
  entryPoints: ['electron/review.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'local-settings', setup(plugin) {
    plugin.onResolve({ filter: /store$/ }, args => ({ path: args.path, namespace: 'local-store' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-store' }, () => ({
      contents: "export const getSettings = () => ({}); export const getWriteback = () => []; export const protectReferenceHash = () => true; export const isReferenceHashProtected = () => false", loader: 'js',
    }))
  } }],
})
const review = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
try {
  const question = (type, stem, options, answer) => `<div class="e-q-body" data-questiontype="${type}"><div class="e-q">
    <div class="e-q-q">${stem}</div><div class="e-q-l"><span class="e-q-wrong"></span></div>
    <div class="e-a-g ${type === 3 ? 'e-checking-a' : 'e-choice-a'}"><ul>
      ${options.map((value, index) => `<li class="e-a${index === 0 ? ' checked' : ''}" data-index="${index}">${String.fromCharCode(65 + index)}) ${value}</li>`).join('')}
    </ul></div>${answer === null ? '' : `<div class="e-a-ans"><div class="e-ans-ref">${answer}</div></div>`}
    </div></div>`
  await page.setContent([
    question(1, '单选题', ['甲', '乙'], '<span class="e-ans-r">B</span>'),
    question(2, '多选题', ['甲', '乙', '丙', '丁'], '<span class="e-ans-r">A</span><span class="e-ans-r">B</span><span class="e-ans-r">C</span>'),
    question(3, '判断题', ['正确', '错误'], '<div class="e-ans-r"><div class="e-a-g"><p class="checked">错误</p></div></div>'),
    question(1, '无参考答案', ['甲', '乙'], null),
   question(1, '损坏参考答案', ['甲', '乙'], '<span class="e-ans-r">Z</span>'),
 ].join(''))
  await page.locator('.e-q-body').last().evaluate(body => {
    const reference = body.querySelector('.e-ans-ref')
    reference?.remove()
  })
 const rows = await review.readReviewedQuestions(page)
 assert.deepEqual(rows.map(row => row.referenceState), ['valid', 'valid', 'valid', 'absent', 'invalid'])
 assert.deepEqual(rows.slice(0, 3).map(row => row.answerTexts), [['乙'], ['甲', '乙', '丙'], ['错误']])
  const child = (stem, correct, selected) => `<form><div class="e-q-l"><span class="${correct ? 'e-q-right' : 'e-q-wrong'}"></span></div>
    <div class="e-q-quest"><div class="e-q-q">${stem}</div><div class="e-a-g e-choice-a"><ul>
    <li class="e-a${selected === 0 ? ' checked' : ''}" data-subquestiontype="3" data-index="1">正确</li>
    <li class="e-a${selected === 1 ? ' checked' : ''}" data-subquestiontype="3" data-index="0">错误</li>
    </ul></div></div></form>`
  await page.setContent(`<div class="e-q-body" data-num="1" data-questiontype="8"><div class="e-q">
    <div class="e-q-r"><div class="e-q-quest"><div class="e-q-q">A sample passage.</div>
    ${child('Statement one', true, 0)}${child('Statement two', false, 1)}</div></div>
    <div class="e-a-ans"><div class="e-ans-ref">参考答案：</div></div></div></div>
    <div class="e-q-body" data-num="2" data-questiontype="9"><div class="e-q">
    <div class="e-q-r"><div class="e-q-quest"><div class="e-q-q">A passage with a blank.</div>
    ${child('', true, 0)}</div></div></div></div>
    <div class="e-q-body" data-num="3" data-questiontype="7"><div class="e-q">
    <form><div class="e-q-r"><div class="e-q-quest"><div class="e-q-q">Match shared.</div>
    <div class="e-a-g e-short-a"><div class="am-u-offset-1 am-u-sm-5">
    <div class="ErichText">A 、alpha</div><div class="ErichText">B 、beta</div>
    </div></div></div></div></form></div></div>`)
  const english = await review.readReviewedQuestions(page)
  assert.equal(english.length, 4, '英语复合题应逐子题读取，匹配题保留待证')
  assert.deepEqual(english.slice(0, 3).map(row => row.correct), [true, false, true])
  assert.deepEqual(english.map(row => row.referenceState), ['absent', 'absent', 'absent', 'invalid'])
  assert.ok(english.slice(0, 3).every(row => row.hash && row.options.length === 2))
  assert.equal(english[3].hash, '')
  assert.match(english[0].stem, /父题型 8.*子题 1/)
  assert.match(english[2].stem, /父题型 9.*子题 1/)
  console.log('T003 参考答案 DOM 映射通过')
} finally {
  await browser.close()
}
