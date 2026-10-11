import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { launchProduct, scanProduct, selectCourse, stopProduct, openQr } from './helpers/t004-product.mjs'
import { catalogHref, homeworkHref, newCenterHtml, oldCenterHtml, homeworkHtml, previewHtml } from './helpers/t004-school.mjs'

const mode = process.env.KAIDA_DISPLAY_MODE === 'visual' ? 'visual' : 'headless'
for (const version of ['new', 'old']) {
  const requests = { homework: 0, preview: 0, writes: 0, answers: 0 }
  const courses = Array.from({ length: 9 }, (_, i) => ({ id: `fixture-${i}`, ref: `ref-${i}`,
    name: `测试课程${i}`, catalog: catalogHref(`fixture-${i}`), popup: homeworkHref(`fixture-${i}`) }))
  const school = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.method !== 'GET') { requests.writes++; res.writeHead(405); res.end(''); return }
    let html = ''
    const host = req.headers['x-kaida-test-host']
    if (host === 'learning.shou.org.cn') html = version === 'new'
      ? '<script>location.href="https://aiedu.shou.org.cn/"</script>' : oldCenterHtml({ courses })
    else if (host === 'aiedu.shou.org.cn') html = newCenterHtml({ courses, home: url.pathname !== '/learning' })
    else if (/learncatalognew\.aspx/i.test(url.pathname)) html = `<a id="courseHomeWorkNew" href="${homeworkHref(url.searchParams.get('courseOpenId'))}">形考作业</a>`
    else if (/homeworknew\.aspx/i.test(url.pathname)) {
      requests.homework++
      html = homeworkHtml({ courseId: url.searchParams.get('courseopenid'), online: [{ name: '记分作业1', id: 'h1' }] })
    } else if (url.pathname === '/study/assignment-preview.aspx') {
      requests.preview++
      html = previewHtml().replace('hidden>微信扫码验证', 'hidden style="width:240px;height:260px;background:white">微信扫码验证<div id="qrCode" style="width:180px;height:180px;background:repeating-conic-gradient(black 0% 25%, white 0% 50%) 0/20px 20px"></div>')
    } else {
      requests.answers++
      res.writeHead(404)
    }
    res.end(html)
  })
  await new Promise(resolve => school.listen(0, '127.0.0.1', resolve))
  let product
  try {
    product = await launchProduct({ accounts: [{ name: `fixture-${version}`, username: 'fixture', password: 'fixture' }],
      mode, workModes: ['answer'], schoolOrigin: `http://127.0.0.1:${school.address().port}`, label: `internal-${version}` })
    const scanned = await scanProduct(product)
    assert.equal(scanned.students[0].courses.length, 9, '完整课程列表包含视口以外课程')
    assert.deepEqual(scanned.students[0].courses.map(course => course.name), courses.map(course => course.name))
    assert.ok(scanned.students[0].courses.every(course => course.groups.flatMap(group => group.rows).some(row => row.status === 'todo')))
    await selectCourse(product, 0, 8)
    await product.page.locator('#btn-primary-action').click()
    await openQr(product)
    await stopProduct(product)
    assert.ok(requests.homework >= 9 && requests.preview >= 9)
    assert.equal(requests.writes, 0)
    assert.equal(requests.answers, 0)
    console.log('T004 内部产品扫码前通过', { version, mode, courses: 9, qrWaiting: true, stopped: true, requests })
  } finally {
    if (product) await product.close()
    await new Promise(resolve => school.close(resolve))
  }
}
