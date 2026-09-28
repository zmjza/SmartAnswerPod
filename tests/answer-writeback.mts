import assert from 'node:assert/strict'
import { chromium } from 'patchright'
import { waitAnswer, readAnswer, verifyAnswerSheet, incompleteQuestionNos, buildAnswerPlan } from '../electron/page-tools.ts'
import { SEL } from '../electron/core/selectors.ts'
import { readStableAnswerRows, readStableReviewedRows } from '../electron/core/review-read.ts'

// Local DOM integration only: this is not evidence of passing the live school flow.
const browser = await chromium.launch({ headless: false })
try {
  const page = await browser.newPage()
  for (const variant of ['e-choice-a', 'e-checking-a']) {
    await page.setContent(`<div class="e-q-body"><div class="e-q"><div class="e-a-g ${variant}"><ul><li class="e-a checked">A) 正确</li><li class="e-a">B) 错误</li></ul></div></div></div>`)
    assert.equal(await page.locator(SEL.reviewedOptions).count(), 2, variant + ' must retain options for hashing')
    assert.equal(await page.locator(SEL.reviewedOptions + '.checked').count(), 1)
  }
  let loads = 0
  await page.route('https://example.test/review-retry', async (route) => {
    loads++
    const stem = loads < 3 ? '损坏' + String.fromCodePoint(0xfffd) : '正常题干'
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div class="e-q-body" data-questiontype="1"><div class="e-q"><div class="e-q-right"></div><div class="e-q-q">' + stem + '</div><div class="e-a-g e-choice-a"><ul><li class="e-a checked">A) 甲</li><li class="e-a">B) 乙</li></ul></div></div></div>' })
  })
  await page.goto('https://example.test/review-retry')
  const recovered = await readStableReviewedRows(page, async () => page.locator('.e-q-body').evaluateAll((bodies) => bodies.map((body) => ({
    stem: body.querySelector('.e-q-q')?.textContent || '',
    options: [...body.querySelectorAll('li.e-a')].map((li) => li.textContent || ''),
  }))))
  assert.equal(loads, 3, '批阅页损坏文字应有限重载直至恢复')
  assert.equal(recovered[0].stem, '正常题干')
  loads = 0
  await page.route('https://example.test/review-partial', async (route) => {
    loads++
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div class="e-q-body"><div class="e-q-q">正常题干</div><ul><li>甲</li><li>乙</li></ul></div><div class="e-q-body"><div class="e-q-q">固定损坏' + String.fromCodePoint(0xfffd) + '</div><ul><li>正确</li><li>错误</li></ul></div>' })
  })
  await page.goto('https://example.test/review-partial')
  const partial = await readStableReviewedRows(page, async () => page.locator('.e-q-body').evaluateAll((bodies) => bodies.map((body) => ({
    stem: body.querySelector('.e-q-q')?.textContent || '',
    options: [...body.querySelectorAll('li')].map((li) => li.textContent || ''),
  }))))
  assert.equal(loads, 3, '固定损坏题应重载到上限后逐题隔离')
  assert.equal(partial.length, 2, '单题损坏不得让整卷 0 题')
  loads = 0
  await page.route('https://example.test/answer-retry', async (route) => {
    loads++
    const stem = loads < 3 ? '损坏' + String.fromCodePoint(0xfffd) : '正常作答题干'
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div class="e-q-body" data-num="1" data-questiontype="1"><div class="e-q-q">' + stem + '</div><ul><li class="e-a" data-index="0">A) 甲</li><li class="e-a" data-index="1">B) 乙</li></ul></div>' })
  })
  await page.goto('https://example.test/answer-retry')
  const questions = await readStableAnswerRows(page, async () => page.locator('.e-q-body').evaluateAll((bodies) => bodies.map((body) => ({
    stem: body.querySelector('.e-q-q')?.textContent || '',
    options: [...body.querySelectorAll('li.e-a')].map((li) => li.textContent || ''),
  }))))
  assert.equal(loads, 3, '作答页应在任何点击前有限重载到整卷文字完整')
  assert.equal(questions[0].stem, '正常作答题干')
  await page.setContent('<div class="e-q-body" data-num="1"><form><input name="answer" value="0"></form></div>')
  const start = Date.now()
  const pending = waitAnswer(page, '1', 3000, ['0', '2'])
  await page.waitForTimeout(350)
  await page.locator('[name=answer]').fill('2,0')
  assert.equal(await pending, '2,0')
  assert.ok(Date.now() - start >= 350, 'partial value must not resolve early')
  await page.locator('[name=answer]').fill('0,1,2')
  assert.equal(await waitAnswer(page, '1', 400, ['0', '2']), '')
  await page.locator('[name=answer]').fill('0')
  assert.equal(await waitAnswer(page, '1', 400, ['0']), '0')
  const fallbackPage = new Proxy(page, { get(target, property) {
    if (property === 'evaluate') return async () => ''
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  assert.equal(await readAnswer(fallbackPage, '1'), '0', 'CDP fallback must read judgment zero')
  await page.setContent('<div class="e-q-body" data-num="1"><input name="answer" value="0,2"></div><div class="e-q-body" data-num="2"><input name="answer" value="0"></div><div class="e-selects-g"><a class="e-item active" data-num="1"></a><a class="e-item active" data-num="2"></a></div>')
  const plan = [{ no: '1', expected: ['0', '2'] }, { no: '2', expected: ['0'] }]
  await verifyAnswerSheet(page, plan)
  assert.deepEqual(await incompleteQuestionNos(page, ['1', '2']), [])
  await page.locator('.e-item[data-num="2"]').evaluate((el) => el.classList.remove('active'))
  assert.deepEqual(await incompleteQuestionNos(page, ['1', '2']), ['2'])
  await assert.rejects(verifyAnswerSheet(page, plan), /2/)
  await page.locator('.e-item[data-num="2"]').evaluate((el) => el.classList.add('active'))
  await page.locator('[data-num="1"] [name="answer"]').fill('0')
  await assert.rejects(verifyAnswerSheet(page, plan), /1/)
  await page.locator('[data-num="1"] [name="answer"]').fill('0,2')
  await assert.rejects(verifyAnswerSheet(page, plan.slice(0, 1)), /数量/)
  await page.locator('[data-num="2"] [name="answer"]').fill('')
  await assert.rejects(verifyAnswerSheet(page, plan), /2/)
  await page.setContent('<div class="e-q-body" data-num="1"><ul><li class="e-a" data-index="0">A) 甲</li><li class="e-a" data-index="1">B) 乙</li></ul></div>')
  const repaired = { no: '1', source: '空过' as const, qtype: 'single' as const, selected: [] as string[] }
  assert.deepEqual(await buildAnswerPlan(page, [repaired]), [{ no: '1', expected: [] }])
  const repairedByAi = { ...repaired, source: 'AI 答题' as const, selected: ['乙'] }
  assert.deepEqual(await buildAnswerPlan(page, [repairedByAi]), [{ no: '1', expected: ['1'] }], '补答后必须按最新选择重建整卷复核计划')
  console.log('PASS: delayed multi-selection, extra option rejected, judgment zero accepted')
} finally {
  await browser.close()
}
