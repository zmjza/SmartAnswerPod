import type { Page } from 'patchright'

/** 选择器真源：docs/page-structures 与根作答页。禁止混用两条 preview 路径。 */
export const PATH = {
  iamHost: 'iam.shou.org.cn',
  learningHost: 'learning.shou.org.cn',
  newLearningHost: 'aiedu.shou.org.cn',
  studyHost: 'l.shou.org.cn',
  scenter: '/scenter',
  homeworkList: '/study/HomeWorkNew.aspx',
  catalog: '/study/learnCatalogNew.aspx',
  assignmentPreview: '/study/assignment-preview.aspx',
  assignmentAnswer: '/study/assignment/preview.aspx',
  history: '/study/assignment/history.aspx',
  continuation: '/study/assignment/continuation.aspx',
  readpreview: '/study/assignment/readpreview.aspx',
  laboratory: '/study/laboratoryInfo/preview.aspx',
} as const

export const SEL = {
  reviewedOptions: '.e-q .e-a-g:is(.e-checking-a, .e-choice-a) ul > li.e-a',
  tabCourseList: '#tab-courseList',
  learningNav: 'nav[aria-label="主导航"] button[aria-label="学习"]',
  learningCourses: '[aria-label="课程列表"]',
  learningCard: '[data-learning-course-card]',
  learningSpace: '[aria-label="课程学习空间"]',
  learningTasks: '[role="region"][aria-label="课程任务"]',
  learningHomework: 'button[aria-label="去完成：完成课程形考作业"]',
  paneCourseList: '#pane-courseList',
  courseItem: '#pane-courseList .course-item',
  courseLink: '.course-title a.el-link[title="点击进入学习"]',
  courseName: '.course-title a.el-link .el-link__inner',
  collectionsPane: '#pane-collections',
  courseHomeWork: 'a#courseHomeWorkNew',
  onlineHomework: '#onlineHomework',
  phasedTest: '#phasedTest',
  noDataMarker: '：暂无数据',
  previewViewLink: 'a[href*="assignment-preview.aspx"]',
  doHomework: 'a.am-btn[href*="/study/assignment/preview.aspx"]',
  doHomeworkAccessible: 'a[href*="readpreview.aspx"]',
  continueLink: 'a[href*="continuation.aspx"]',
  historyView: '#mainContent table.am-table tbody tr a[href*="history.aspx"]',
  historyTable: '#mainContent table.am-table',
  qrDialog: '#dl_qrCodeCheck',
  qrTitle: '微信扫码验证',
  submit: '#submitHomeWork',
  confirmOk: '.xcConfirm a.sgBtn.ok',
  confirmCancel: '.xcConfirm a.sgBtn.cancel',
  questionBody: '.e-q-body',
  option: 'li.e-a',
  answerInput: 'form [name=answer]',
  doneCard: '.e-selects-g a.e-item.active',
  iamUser: 'input[placeholder*="学号"], input[placeholder*="工号"], input[placeholder*="账号"]',
  iamPass: 'input[placeholder*="密码"]',
  iamSubmit: '.content_submit, button.el-button--primary',
  iamError: '.el-alert--warning, .el-alert--error',
} as const

export function learningCenterVersion(page: Page): 'old' | 'new' | null {
  const url = new URL(page.url())
  if (url.hostname === PATH.newLearningHost && ['/', '/learning', '/learning/'].includes(url.pathname)) return 'new'
  if (url.hostname === PATH.learningHost && url.pathname === PATH.scenter) return 'old'
  return null
}

export async function prepareNewLearningCenter(page: Page, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (learningCenterVersion(page) !== 'new') throw new Error('未知学习中心页面')
  if (new URL(page.url()).pathname === '/') {
    await page.locator(SEL.learningNav).click()
    await page.waitForURL((url) => url.hostname === PATH.newLearningHost && /^\/learning\/?$/.test(url.pathname), { timeout: 20000 })
  }
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const state = await page.evaluate(({ list, card, space }) => {
      const root = document.querySelector(list)
      if (!root) return 'loading'
      const text = root.textContent || ''
      if (/失败|出错|异常|重试/.test(text) || document.querySelector('[role="alert"]')) return 'error'
      if (/正在加载|加载中/.test(text)) return 'loading'
      if (root.querySelector(card) && document.querySelector(space)) return 'ready'
      if (/暂无课程|没有课程/.test(text)) return 'ready'
      return 'loading'
    }, { list: SEL.learningCourses, card: SEL.learningCard, space: SEL.learningSpace })
    if (state === 'ready') return
    if (state === 'error') throw new Error('新版课程列表加载失败')
    await page.waitForTimeout(100)
  }
  throw new Error('新版课程列表未就绪')
}

export async function checkOldLearningCenter(page: Page): Promise<void> {
  const pane = page.locator(SEL.paneCourseList)
  await pane.waitFor({ state: 'attached', timeout: 20000 }).catch(() => { throw new Error('旧版课程列表未就绪') })
  if (await pane.locator('[role="alert"], .el-alert--error').count() || /课程(?:列表)?(?:加载|读取)失败/.test(await pane.innerText())) {
    throw new Error('旧版课程列表加载失败')
  }
}

export function isAnswerPath(pathname: string): boolean {
  return pathname.includes('/study/assignment/preview.aspx')
}

export function isPreviewPath(pathname: string): boolean {
  return pathname.includes('/study/assignment-preview.aspx') && !pathname.includes('/study/assignment/preview.aspx')
}

export function isHomeworkListPath(pathname: string): boolean {
  return pathname.toLowerCase().includes('homeworknew.aspx')
}
