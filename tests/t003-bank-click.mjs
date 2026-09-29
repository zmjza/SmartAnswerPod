import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'patchright'

const built = await build({
  entryPoints: ['electron/answer.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'bank-hit', setup(plugin) {
    plugin.onResolve({ filter: /bank$|ai$/ }, args => ({ path: args.path, namespace: 'test-boundary' }))
    plugin.onLoad({ filter: /.*/, namespace: 'test-boundary' }, args => ({
      contents: args.path === './bank'
        ? 'export const lookupByHash=async()=>({answer_texts:[globalThis.__bankAnswer]})'
        : 'export const askAi=async()=>{throw new Error("题库命中后不应调用 AI")};export const askAiGroup=async()=>{throw new Error("意外的英语整组题")};export const retryAsked=()=>{}',
      loader: 'js',
    }))
  } }],
})
const { answerPage } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.setContent(`<div class="e-selects-g"><a class="e-item" data-num="1"></a></div>
    <div class="e-q-body" data-num="1" data-questiontype="1">
      <div class="e-q-q">普通单选题</div><form><input name="answer" value=""></form>
      <ul><li class="e-a" data-index="0">A) A.less</li><li class="e-a" data-index="1">B) B.most</li>
      <li class="e-a" data-index="2">C) C.as intelligent as</li></ul>
    </div>`)
  await page.evaluate(() => {
    document.querySelectorAll('li.e-a').forEach((li) => li.addEventListener('click', () => {
      document.querySelector('[name=answer]').value = li.getAttribute('data-index')
      document.querySelector('.e-item').classList.add('active')
    }))
  })
  for (const [text, index] of [['A.less', '0'], ['B.most', '1'], ['C.as intelligent as', '2']]) {
    globalThis.__bankAnswer = text
    const solved = await answerPage({ page, local_id: 'test', slot: 'occupied', account: 'auto_answering',
      courseName: '测试课程', homeworkName: '双层选项前缀' })
    assert.equal(solved.results[0].source, '题库答题')
    assert.deepEqual(solved.results[0].selected, [text])
    assert.equal(await page.locator('[name=answer]').inputValue(), index)
  }
  globalThis.__bankAnswer = '不存在的选项'
  await assert.rejects(answerPage({ page, local_id: 'test', slot: 'occupied', account: 'auto_answering',
    courseName: '测试课程', homeworkName: '题库点选失败' }), /题库答案无法匹配当前页面选项/)
  console.log('双层选项前缀题库点选及不匹配拦截通过')
} finally {
  await browser.close()
}
