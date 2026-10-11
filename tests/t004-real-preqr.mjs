import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { qrPreflight, REVIEWED_INDUSTRY_QR_SOURCES } from './helpers/t004-qr-preflight.mjs'
import { launchProduct, scanProduct, selectCourse, stopProduct, openQr } from './helpers/t004-product.mjs'

const mode = process.env.KAIDA_DISPLAY_MODE === 'visual' ? 'visual' : 'headless'
const mixed = process.env.KAIDA_TEST_CASE === 'mixed'
const alias = process.env.KAIDA_TEST_ALIAS || 'NEW-01'
const oldScanOnly = !mixed && ['OLD-01', 'OLD-02'].includes(alias)
let accounts
if (mixed && process.env.KAIDA_TEST_ACCOUNTS) accounts = JSON.parse(process.env.KAIDA_TEST_ACCOUNTS)
else if (!mixed && process.env.KAIDA_TEST_USER && process.env.KAIDA_TEST_PASS)
  accounts = [{ name: alias, username: process.env.KAIDA_TEST_USER, password: process.env.KAIDA_TEST_PASS }]
else {
  // A pipe keeps the supplied runtime credentials out of files and shell history.
  const input = createInterface({ input: process.stdin, terminal: false })
  const [line] = await new Promise(resolve => input.once('line', line => resolve([line])))
  input.close()
  accounts = JSON.parse(line)
}
assert.equal(accounts.length, mixed ? 3 : 1, '测试账号数量不匹配')
assert.ok(accounts.every(account => ['NEW-01', 'OLD-01', 'OLD-02'].includes(account.name) && account.username && account.password), '仅接受完整测试别名输入')

async function findSafeCourse(product, student) {
  return product.app.evaluate(async (_, { id, courses, expression, inspect }) => {
    const context = globalThis.__t004.contexts.get(id)
    if (!context) return { index: -1, reason: 'context-not-observed' }
    const identity = href => {
      const url = new URL(href, 'https://l.shou.org.cn')
      return url.pathname.toLowerCase() + JSON.stringify([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value]).sort())
    }
    const checked = []
    for (const [index, course] of courses.entries()) {
      const rows = course.groups.flatMap(group => group.rows).filter(row => row.status === 'todo')
      if (!rows.length) continue
      const previews = []
      let safe = true
      for (const row of rows) {
        const preview = context.pages().find(page => !page.isClosed() && identity(page.url()) === identity(row.previewHref))
        if (!preview) { safe = false; break }
        const cdp = await context.newCDPSession(preview)
        let result
        try {
          // Deny camera access in the isolated test profile; retain the school's verification flow.
          await cdp.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin: 'https://l.shou.org.cn' })
          result = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
        }
        finally { await cdp.detach() }
        if (!result) { safe = false; break }
        const { historyState, sourceShape, ...flags } = result
        if (inspect) flags.sourceShape = sourceShape
        checked.push({ index, ...flags })
        if (!result.safe || inspect) { safe = false; break }
        previews.push({ href: preview.url(), historyState })
      }
      if (safe && previews.length === rows.length) {
        globalThis.__t004.prechecked = { id, previews }
        return { index, previewCount: previews.length, checked }
      }
    }
    return { index: -1, checked, reason: 'no-proven-unverified-course' }
  }, { id: student.local_id, courses: student.courses, inspect: process.env.KAIDA_TEST_INSPECT === '1',
    expression: '(async () => (' + qrPreflight.toString() + ')(' + JSON.stringify(REVIEWED_INDUSTRY_QR_SOURCES) +
      ', (await navigator.permissions.query({ name: "camera" })).state))()' })
}

async function verifySchoolStateUnchanged(product) {
  return product.app.evaluate(async () => {
    const { id, previews } = globalThis.__t004.prechecked
    const context = globalThis.__t004.contexts.get(id)
    for (const before of previews) {
      const page = await context.newPage()
      try {
        await page.goto(before.href, { waitUntil: 'domcontentloaded' })
        const after = await page.evaluate(() => [...document.querySelectorAll('#mainContent table.am-table tbody tr')].map(row =>
          [...row.querySelectorAll('td')].slice(0, 5).map(cell => cell.textContent?.trim() || '')))
        if (JSON.stringify(before.historyState) !== JSON.stringify(after)) return false
      } finally { await page.close() }
    }
    return true
  })
}

async function reconcileCourses(product, scanned) {
  return product.app.evaluate(async (_, { students }) => {
    const param = (url, name) => [...url.searchParams].find(([key]) => key.toLowerCase() === name)?.[1] || ''
    for (const student of students) {
      const context = globalThis.__t004.contexts.get(student.local_id)
      const portal = context?.pages().find(page => ['learning.shou.org.cn', 'aiedu.shou.org.cn'].includes(new URL(page.url()).hostname))
      if (!portal) return { ok: false }
      const version = new URL(portal.url()).hostname === 'aiedu.shou.org.cn' ? 'new' : 'old'
      const cards = version === 'new'
        ? await portal.locator('[data-learning-course-card]').evaluateAll(items => items.map(item => item.querySelector('h3')?.textContent?.replace(/\s+/g, ' ').trim()))
        : await portal.locator('.box-card .el-card__body .el-tabs__content > .course-item, #pane-courseList .course-item').evaluateAll(items => items.map(item => ({ name: item.querySelector('.el-link__inner')?.textContent?.replace(/\s+/g, ' ').trim(), href: item.querySelector('a[title="点击进入学习"]')?.href, pinned: !item.closest('#pane-courseList') })))
      let expected
      if (version === 'new') expected = cards
      else {
        const seen = new Set()
        expected = cards.filter(card => {
          if (!card.href || !card.name) return false
          const url = new URL(card.href), key = 'course:' + param(url, 'courseopenid') + ':' + param(url, 'minorcourseopenid')
          if (card.pinned && (!/^形势与政策[（(]\d+[）)]$/.test(card.name) ||
            url.pathname.toLowerCase() !== '/study/learncatalognew.aspx' || !param(url, 'courseopenid'))) return false
          if (seen.has(key)) return false
          seen.add(key); return true
        }).map(card => card.name)
      }
      if (JSON.stringify(expected) !== JSON.stringify(student.courses.map(course => course.name))) return { ok: false }
      globalThis.__t004.versions ||= new Map()
      globalThis.__t004.versions.set(student.local_id, version)
    }
    return { ok: true, versions: students.map(student => globalThis.__t004.versions.get(student.local_id)) }
  }, { students: scanned.students })
}

let product, stage = 'launch'
try {
  const rounds = process.env.KAIDA_TEST_INSPECT === '1' ? [['answer']] : mixed ? [[ 'answer', 'extract', 'answer' ], [ 'extract', 'answer', 'extract' ]] : [[ 'extract' ], [ 'answer' ]]
  for (const [round, workModes] of rounds.entries()) {
    product = await launchProduct({ accounts, mode, workModes, label: `real-${mixed ? 'mixed' : alias}-${round}` })
    stage = 'scan'
    const scanned = await scanProduct(product)
    console.log('T004 作业状态计数', scanned.students.map(student => ({ courses: student.courses.length,
      statuses: student.courses.flatMap(course => course.groups.flatMap(group => group.rows)).reduce((out, row) => {
        out[row.status] = (out[row.status] || 0) + 1; return out
      }, {}) })))
    const reconciled = await reconcileCourses(product, scanned)
    assert.equal(reconciled.ok, true, '产品课程与真实完整列表不一致')
    const unsupported = scanned.students.map((student, index) => {
      const rows = student.courses.filter(course => course.key.startsWith('unsupported:'))
      assert.equal(rows.length, reconciled.versions[index] === 'new' ? 1 : 0, '第三方课程数量与已核对真实样本不一致')
      if (rows.length) {
        assert.equal(rows[0].name, '招聘与人才测评')
        assert.equal(rows[0].status, '新答题界面暂时不支持，等后续开发')
        assert.equal(rows[0].groups.length, 0)
      }
      return rows.map(course => ({ key: course.key, status: course.status }))
    })
    if (unsupported[0].length) {
      await product.page.locator('#student-switcher [data-student="0"]').click()
      const previous = product.page.getByRole('button', { name: '上一页课程' })
      while (await previous.count() && await previous.isEnabled()) await previous.click()
      await product.page.getByText('新答题界面暂时不支持，等后续开发', { exact: true }).waitFor()
    }
    if (mixed || oldScanOnly || workModes[0] === 'extract') {
      for (let index = 0; index < accounts.length; index++) {
        assert.ok(scanned.students[index].courses.length > 0, '账号没有合法课程样本')
        const otherSelections = (await product.snapshot()).students.map(student => JSON.stringify(student.selectedCourseKeys))
        await selectCourse(product, index, scanned.students[index].courses.length - 1)
        const selected = (await product.snapshot()).students
        assert.ok(selected.every((student, j) => j === index || JSON.stringify(student.selectedCourseKeys) === otherSelections[j]), '产品选课串账号')
      }
    } else {
      stage = 'preflight'
      const candidate = await findSafeCourse(product, scanned.students[0])
      console.log('T004 扫码条件只读核对', { alias, mode, ...candidate })
      assert.ok(candidate.index >= 0, '无可证明仍需扫码的整门课程；真实样本受限，不能计通过')
      await selectCourse(product, 0, candidate.index)
      stage = 'qr'
      await product.page.locator('#btn-primary-action').click()
      await openQr(product)
      assert.equal(await verifySchoolStateUnchanged(product), true, '学校作答历史发生改变')
    }
    stage = 'stop'
    await stopProduct(product)
    const stoppedStudents = (await product.snapshot()).students
    assert.ok(stoppedStudents.every((student, index) => unsupported[index].every(before =>
      student.courses.find(course => course.key === before.key)?.status === before.status)), '第三方提示被选课/执行/停止覆写')
    console.log('T004 真实扫码前通过', { alias: mixed ? 'mixed' : alias, mode, workModes,
      versions: reconciled.versions, unsupported: unsupported.map(rows => rows.length), courses: scanned.students.map(student => student.courses.length),
      previews: scanned.students.map(student => student.courses.flatMap(course => course.groups.flatMap(group => group.rows)).filter(row => row.previewHref).length),
      qrWaiting: !mixed && !oldScanOnly && workModes[0] === 'answer', schoolStateUnchanged: !mixed && !oldScanOnly && workModes[0] === 'answer' ? true : 'read-only-scan', writes: product.writes,
      ...(await product.observe()), stopped: true })
    await product.close(); product = undefined
  }
} catch (error) {
  console.error('T004 真机未通过', { alias: mixed ? 'mixed' : alias, mode, stage,
    reason: String(error.message).replace(/https?:\/\/\S+/g, '[URL]').replace(/\b\d{10,}\b/g, '[ID]').slice(0, 250) })
  process.exitCode = 1
} finally {
  if (product) await product.close()
}
