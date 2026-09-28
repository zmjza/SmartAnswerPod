import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({
  entryPoints: ['electron/detect.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'progress', setup(plugin) {
    plugin.onResolve({ filter: /^\.\/progress$/ }, () => ({ path: 'progress', namespace: 'mock' }))
    plugin.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const emitProgress = () => {}', loader: 'js' }))
  } }],
})
const { listCourses, detectCourse } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const catalog = (id, minor = 'm') => `/study/learnCatalogNew.aspx?courseOpenId=${id}&minorCourseOpenId=${minor}`
const card = (name, href) => {
  const url = new URL(href, 'https://l.shou.org.cn')
  const id = url.searchParams.get('courseOpenId')
  const minor = url.searchParams.get('minorCourseOpenId')
  return { name, href, key: id ? `course:${id}:${minor || ''}` : `href:${url.pathname}${url.search}` }
}

function portal(pinned = [], tabCourses = [], messages = [], collections = []) {
  const find = (source, selector) => {
    if (selector.includes('el-link__inner')) return source.name
    if (selector.includes('点击进入学习')) return source.href
    return null
  }
  const item = (value) => ({
    locator: (selector) => ({ innerText: async () => find(value, selector), getAttribute: async () => find(value, selector) }),
  })
  const list = (values) => ({ count: async () => values.length, nth: (i) => item(values[i]), first: () => ({ waitFor: async () => {} }) })
  return {
    messages, collections,
    locator(selector) {
      if (selector === '#tab-courseList') return { getAttribute: async () => 'is-active', click: async () => {} }
      if (selector === '#pane-courseList .course-item') return list(tabCourses)
      if (selector === '.box-card .el-card__body .el-tabs__content > .course-item') return list(pinned)
      throw Error(`Unexpected selector ${selector}`)
    },
  }
}

const slot = 'idle'
async function scan(page) { return listCourses(page, 'test-student', slot) }

assert.deepEqual(await scan(portal([], [card('普通课', catalog('normal'))])), [card('普通课', catalog('normal'))], '置顶卡缺失时保留 Tab')
assert.deepEqual(await scan(portal([card('形势与政策（3）', catalog('top'))], [])), [card('形势与政策（3）', catalog('top'))], 'Tab 空时仍收录置顶')
assert.deepEqual(await scan(portal(
  [card('形势与政策（1）', catalog('top'))],
  [card('形势与政策（1）', catalog('top')), card('普通课', catalog('normal'))],
)), [card('形势与政策（1）', catalog('top')), card('普通课', catalog('normal'))], '相同课程 ID 只保留一次且置顶在前')
assert.deepEqual(await scan(portal(
  [card('形势与政策（2）', catalog('top'))],
  [card('形势与政策（2）', catalog('other'))],
)), [card('形势与政策（2）', catalog('top')), card('形势与政策（2）', catalog('other'))], '同名不同 ID 不能合并')
assert.deepEqual(await scan(portal(
  [card('形势与政策（2）', catalog('top'))],
  [card('形势与政策（2）', '/study/learnCatalogNew.aspx?minorcourseopenid=m&courseopenid=top&view=1')],
)), [card('形势与政策（2）', catalog('top'))], '参数名大小写和顺序变化不应重复课程')
assert.equal((await scan(portal([], [card('普通课', catalog('top', 'another'))])))[0].key, 'course:top:another', '次课程 ID 参与课程身份')
assert.deepEqual(await scan(portal([], [])), [], '另一个账号没有置顶时不能复用旧结果')
const fallback = await scan(portal([], [
  card('无 ID 课程一', '/study/learnCatalogNew.aspx?access=private-one'),
  card('无 ID 课程二', '/study/learnCatalogNew.aspx?access=private-two'),
]))
assert.equal(fallback.length, 2)
assert.notEqual(fallback[0].key, fallback[1].key)
assert.doesNotMatch(fallback[0].key, /private-one/)
assert.deepEqual(await scan(portal(
  [card('课程评价', '/study/evaluationNew.aspx?courseOpenId=message'), card('形势与政策（4）', catalog('top'))],
  [card('普通课', catalog('normal'))],
  [card('形势与政策（5）', catalog('message'))], [card('形势与政策（6）', catalog('collection'))],
)), [card('形势与政策（4）', catalog('top')), card('普通课', catalog('normal'))], '消息和收藏不属于扫描范围')

function homeworkPage(online, phased) {
  const row = (name) => ({
    locator(selector) {
      if (selector.includes('assignment-preview.aspx')) return { getAttribute: async () => '' }
      if (selector !== 'td') throw Error(`Unexpected row selector ${selector}`)
      const cells = ['', name, '线上阶段性测验', '客观题', '100%', '2020/1/1', '2099/1/1', '0/无限制']
      return { nth: (i) => ({
        getAttribute: async (attr) => attr === 'title' && (i === 1 || i === 5 || i === 6) ? cells[i] : '',
        innerText: async () => cells[i],
        locator: () => ({ inputValue: async () => '-1' }),
      }) }
    },
  })
  const page = {
    closed: false,
    goto: async () => {}, waitForURL: async () => {}, content: async () => '',
    close: async () => { page.closed = true },
    locator(selector) {
      if (selector === 'a#courseHomeWorkNew') return { waitFor: async () => {}, click: async () => {} }
      if (selector === '#onlineHomework' || selector === '#phasedTest') {
        const rows = selector === '#onlineHomework' ? online : phased
        return { count: async () => 1, locator: () => ({ count: async () => rows.length }) }
      }
      const rows = selector.startsWith('#onlineHomework') ? online : phased
      return { count: async () => rows.length, nth: (i) => row(rows[i]) }
    },
  }
  return page
}

async function detect(online, phased) {
  const coursePage = homeworkPage(online, phased)
  const portalPage = { context: () => ({ newPage: async () => coursePage }) }
  const result = await detectCourse({
    portal: portalPage, href: catalog('top'), key: 'course:top:m', courseName: '形势与政策（2）',
    local_id: 'test-student', slot, index: 1, total: 1,
  })
  assert.equal(coursePage.closed, true)
  return result
}

const phasedOnly = await detect([], ['阶段测验'])
assert.equal(phasedOnly.key, 'course:top:m')
assert.deepEqual(phasedOnly.homeworks.map(({ section, name }) => [section, name]), [['phasedTest', '阶段测验']])
assert.deepEqual((await detect(['记分作业'], ['阶段测验'])).homeworks.map(({ section }) => section), ['onlineHomework', 'phasedTest'])
assert.equal((await detect([], [])).status, '无作业')
console.log('T003 detect course discovery checks passed')
