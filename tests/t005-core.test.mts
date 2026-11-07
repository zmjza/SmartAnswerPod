import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORK_MODE_ORDER, normalizeLegacyWorkMode, normalizeWorkMode } from '../electron/core/work-mode.ts'
import { buildNoqrSnapshot } from '../electron/noqr/state.ts'
import {
  applyNoqrFailureToView,
  assertNoqrRecordPageCanReturn,
  decideNoqrRecovery,
  noqrAnswerProgressInterruption,
  shouldStopNoqrCourseAfterHomeworkFailure,
  noqrFailurePolicy,
  terminalNoqrPhase,
} from '../electron/noqr/page-policy.ts'
import { evaluateNoqrSaveEvidence } from '../electron/noqr/save.ts'
import { newestNoqrScoreRecord } from '../electron/noqr/score.ts'
import { NoqrSessionError } from '../electron/noqr/session.ts'
import { withNoqrStartupLock } from '../electron/noqr/startup-queue.ts'
import { noqrHomeworkRuleStatus, resolveNoqrHomeworkCard } from '../electron/noqr/homework.ts'
import {
  createNoqrStudentView,
  emptyNoqrQuestionKindCounts,
  noqrRunOutcome,
  recordNoqrSavedQuestionKind,
  resetNoqrStudentRunView,
  sanitizeNoqrLogText,
} from '../electron/noqr/view.ts'

test('T005-C01 工作模式固定保留三模式顺序并规范化旧值', () => {
  assert.deepEqual(WORK_MODE_ORDER, ['answer', 'extract', 'noqr'])
  assert.equal(normalizeWorkMode('answer'), 'answer')
  assert.equal(normalizeWorkMode('extract'), 'extract')
  assert.equal(normalizeWorkMode('noqr'), 'noqr')

  for (const value of [undefined, null, '', 'unknown', 'NOQR', 0, {}, []]) {
    assert.equal(normalizeWorkMode(value), 'answer')
  }
  assert.equal(normalizeLegacyWorkMode('answer'), 'answer')
  assert.equal(normalizeLegacyWorkMode('extract'), 'extract')
  assert.equal(normalizeLegacyWorkMode('noqr'), null)
  assert.equal(normalizeLegacyWorkMode('unknown'), null)
})

test('T005-C02 无码快照只暴露独立状态且不夹带旧授权或提取统计', () => {
  const snapshot = buildNoqrSnapshot({
    localId: 'student-a',
    running: true,
    phase: 'answering',
    courseName: '课程甲',
    homeworkName: '作业一',
    questionNo: 2,
    questionTotal: 10,
    bankCount: 3,
    aiCount: 1,
    attempt: 2,
    needsVerify: true,
    verified: true,
    qr: { open: true },
    extractStats: { added: 9, merged: 8, skipped: 7, conflict: 6, failed: 5 },
    writeback: [{ local_id: 'student-a' }],
  })

  assert.deepEqual(snapshot, {
    mode: 'noqr',
    localId: 'student-a',
    running: true,
    phase: 'answering',
    courseName: '课程甲',
    homeworkName: '作业一',
    questionNo: 2,
    questionTotal: 10,
    bankCount: 3,
    aiCount: 1,
    attempt: 2,
  })
  assert.equal('needsVerify' in snapshot, false)
  assert.equal('verified' in snapshot, false)
  assert.equal('qr' in snapshot, false)
  assert.equal('extractStats' in snapshot, false)
  assert.equal('writeback' in snapshot, false)

  assert.deepEqual(buildNoqrSnapshot({}), {
    mode: 'noqr',
    localId: '',
    running: false,
    phase: 'idle',
    courseName: '',
    homeworkName: '',
    questionNo: null,
    questionTotal: null,
    bankCount: 0,
    aiCount: 0,
    attempt: 0,
  })
})

test('T005-C03 页面恢复只在可刷新页面刷新，答题启动返回重进，已答页停止', () => {
  const base = {
    page: 'login' as const,
    ready: false,
    activeRequest: false,
    loading: false,
    error: false,
    hasAnswerProgress: false,
    refreshAttempts: 0,
    refreshBudget: 2,
  }

  assert.equal(decideNoqrRecovery({ ...base, ready: true }), 'ready')
  assert.equal(decideNoqrRecovery({ ...base, activeRequest: true }), 'wait')
  assert.equal(decideNoqrRecovery({ ...base, loading: true }), 'wait')
  assert.equal(decideNoqrRecovery(base), 'refresh')
  assert.equal(decideNoqrRecovery({ ...base, page: 'home' }), 'refresh')
  assert.equal(decideNoqrRecovery({ ...base, page: 'course_work' }), 'refresh')
  assert.equal(decideNoqrRecovery({ ...base, page: 'record' }), 'refresh')
  assert.equal(decideNoqrRecovery({ ...base, page: 'submit_success' }), 'refresh')
  assert.equal(decideNoqrRecovery({ ...base, page: 'course_work', refreshAttempts: 2 }), 'stop')
  assert.equal(decideNoqrRecovery({ ...base, error: true, page: 'home' }), 'stop')
  assert.equal(decideNoqrRecovery({ ...base, page: 'unknown' }), 'stop')

  assert.equal(decideNoqrRecovery({ ...base, page: 'answer_boot' }), 'reenter')
  assert.equal(decideNoqrRecovery({ ...base, page: 'answer_boot', activeRequest: true }), 'wait')
  assert.equal(decideNoqrRecovery({ ...base, page: 'answer_boot', hasAnswerProgress: true }), 'stop')
  assert.equal(decideNoqrRecovery({ ...base, page: 'answer_boot', activeRequest: true, hasAnswerProgress: true }), 'wait')
  assert.equal(decideNoqrRecovery({ ...base, page: 'answer', hasAnswerProgress: true }), 'stop')
  assert.equal(decideNoqrRecovery({ ...base, page: 'answer', hasAnswerProgress: false }), 'stop')
  assert.equal(decideNoqrRecovery({ ...base, page: 'answer', activeRequest: true, hasAnswerProgress: true }), 'wait')
})

test('T005-C03b 登录失败、可隔离页面错误和需人工处理使用不同终端状态', () => {
  assert.equal(terminalNoqrPhase(new NoqrSessionError('login_failed', 'fixture')), 'login_failed')
  assert.equal(terminalNoqrPhase(new NoqrSessionError('auth_blocked', 'fixture')), 'needs_user')
  assert.equal(terminalNoqrPhase(new NoqrSessionError('credentials_missing', 'fixture')), 'needs_user')
  assert.equal(terminalNoqrPhase(new NoqrSessionError('blank_page', 'fixture')), 'not_full')
  assert.equal(terminalNoqrPhase(new NoqrSessionError('page_error', 'fixture')), 'not_full')
  assert.equal(terminalNoqrPhase(new NoqrSessionError('answer_interrupted', 'fixture')), 'needs_user')
  assert.equal(terminalNoqrPhase(new NoqrSessionError('submitted_uncertain', 'fixture')), 'needs_user')
  assert.equal(terminalNoqrPhase(new NoqrSessionError('homework_contract', 'fixture')), 'unsupported')
  assert.equal(terminalNoqrPhase(new NoqrSessionError('course_contract', 'fixture')), 'unsupported')
  assert.equal(terminalNoqrPhase(new Error('unsupported fixture')), 'unsupported')

  assert.deepEqual(noqrFailurePolicy(new NoqrSessionError('answer_interrupted', 'fixture')), {
    status: 'answer_page_interrupted',
    phase: 'needs_user',
    preservePage: true,
  })
  assert.deepEqual(noqrFailurePolicy(new NoqrSessionError('submitted_uncertain', 'fixture')), {
    status: 'submitted_uncertain',
    phase: 'needs_user',
    preservePage: true,
  })
  assert.deepEqual(noqrFailurePolicy(new NoqrSessionError('blank_page', 'fixture')), {
    status: 'page_interrupted',
    phase: 'needs_user',
    preservePage: false,
  })
  assert.deepEqual(noqrFailurePolicy(new NoqrSessionError('page_error', 'fixture')), {
    status: 'page_interrupted',
    phase: 'needs_user',
    preservePage: false,
  })
  assert.deepEqual(noqrFailurePolicy(new Error('unsupported fixture')), {
    status: 'submit_failed',
    phase: 'unsupported',
    preservePage: false,
  })
  assert.deepEqual(noqrFailurePolicy(new NoqrSessionError('homework_contract', 'fixture')), {
    status: 'submit_failed',
    phase: 'unsupported',
    preservePage: false,
  })
  assert.deepEqual(noqrFailurePolicy(new NoqrSessionError('course_contract', 'fixture')), {
    status: 'submit_failed',
    phase: 'unsupported',
    preservePage: false,
  })
})

test('T005-C03c 答题页异常与结果不确定会更新真实学生视图并保留页面', () => {
  const view = createNoqrStudentView({
    local_id: 'student-a',
    name: '学生甲',
    username: 'fixture-user',
    password: ['fixture', 'password'].join('-'),
    display_mode: 'headless',
    work_mode: 'noqr',
    course_scope: 'all',
    answer_round_limit: 3,
  })
  assert.match(view.studentNo, /^....\*{4}....$/)
  assert.notEqual(view.studentNo, view.name)
  const course = { key: 'course-a', name: '课程甲', order: 1, current: true }
  const homework = {
    key: 'homework-a',
    name: '作业甲',
    workType: 'onlineWork',
    section: 'onlineHomework' as const,
    weightPercent: 20,
    startAt: '',
    endAt: '',
    reviewDeadline: '',
    attemptsText: '',
    recordCount: 0,
    startEnabled: true,
    recordEnabled: true,
  }
  view.courses = [{ key: course.key, name: course.name, order: course.order, status: '作答中', groups: [] }]

  const interrupted = applyNoqrFailureToView(
    view,
    course,
    homework,
    new NoqrSessionError('answer_interrupted', 'fixture'),
  )
  assert.equal(interrupted.preservePage, true)
  assert.equal(view.phase, 'needs_user')
  assert.equal(view.courses[0]?.status, '有失败待处理')
  assert.equal(view.courses[0]?.groups[0]?.rows[0]?.status, 'answer_page_interrupted')

  const uncertain = applyNoqrFailureToView(
    view,
    course,
    homework,
    new NoqrSessionError('submitted_uncertain', 'fixture'),
  )
  assert.equal(uncertain.preservePage, true)
  assert.equal(view.phase, 'needs_user')
  assert.equal(view.courses[0]?.groups[0]?.rows[0]?.status, 'submitted_uncertain')
})

test('T005-C03d 只有确认页面异常的已作答答题页才保留，普通业务错误不得占用槽位', () => {
  const answerUrl = 'https://coursework.shou.org.cn/course_work_detail/index.html?workId=fixture&workType=onlineWork'
  assert.equal(noqrAnswerProgressInterruption({
    url: answerUrl,
    hasAnswerProgress: true,
    submitConfirmed: false,
    pageInterrupted: false,
  }), null)
  const interrupted = noqrAnswerProgressInterruption({
    url: answerUrl,
    hasAnswerProgress: true,
    submitConfirmed: false,
    pageInterrupted: true,
  })
  assert.equal(interrupted?.code, 'answer_interrupted')
  assert.equal(noqrAnswerProgressInterruption({
    url: answerUrl,
    hasAnswerProgress: false,
    submitConfirmed: false,
    pageInterrupted: true,
  }), null)
  assert.equal(noqrAnswerProgressInterruption({
    url: 'https://coursework.shou.org.cn/course_work/index.html',
    hasAnswerProgress: true,
    submitConfirmed: false,
    pageInterrupted: true,
  }), null)
  assert.equal(noqrAnswerProgressInterruption({
    url: answerUrl,
    hasAnswerProgress: true,
    submitConfirmed: true,
  }), null)
  assert.equal(
    shouldStopNoqrCourseAfterHomeworkFailure(
      'https://coursework.shou.org.cn/course_work_detail/index.html?workId=fixture&workType=onlineWork',
    ),
    true,
  )
  assert.equal(
    shouldStopNoqrCourseAfterHomeworkFailure(
      'https://coursework.shou.org.cn/course_work/index.html?courseId=fixture',
    ),
    false,
  )
})

test('T005-C03e 作答记录恢复遇到答题页时必须零返回并保留页面', () => {
  const answerUrl = 'https://coursework.shou.org.cn/course_work_detail/index.html?workId=fixture&workType=onlineWork'
  assert.throws(
    () => assertNoqrRecordPageCanReturn(answerUrl, 'answer'),
    (error: unknown) => error instanceof NoqrSessionError && error.code === 'answer_interrupted',
  )
  assert.throws(
    () => assertNoqrRecordPageCanReturn(
      'https://coursework.shou.org.cn/course_work_record/index.html?workId=fixture',
      'auth_blocked',
    ),
    (error: unknown) => error instanceof NoqrSessionError && error.code === 'auth_blocked',
  )
  assert.doesNotThrow(() => assertNoqrRecordPageCanReturn(
    'https://coursework.shou.org.cn/course_work_record/index.html?workId=fixture',
    'record',
  ))
})

test('T005-C04 最新分数按完成时间与有效记录选择，不按 DOM 顺序', () => {
  const records = [
    { finishedTime: '2026-10-12 20:49:10', score: 97, isMarked: true, status: '已批阅' },
    { finishedTime: '2026/10/12 20:52:16', score: 100, isMarked: true, status: '已批阅' },
    { finishedTime: '2026-11-01 03:30:58', score: 3, isMarked: true, status: '未完成提交' },
    { finishedTime: '2026-11-01 03:31:58', score: 88, isMarked: false, status: '未完成提交' },
    { finishedTime: '', score: 66, isMarked: true, status: '已批阅' },
  ]

  assert.equal(newestNoqrScoreRecord(records)?.score, 100)
  assert.equal(newestNoqrScoreRecord([
    { finishedTime: '2026/10/12 20:52:16', score: 0, isMarked: true },
    { finishedTime: '2026/10/12 20:49:10', score: 95, isMarked: true },
  ])?.score, 0)
  assert.equal(newestNoqrScoreRecord([
    { finishedTime: '2026-10-12 20:52:16', score: null, isMarked: true },
    { finishedTime: '2026-10-12 20:49:10', score: 95, isMarked: false },
  ]), null)
})

test('T005-C05 保存必须同时满足请求、业务响应和页面推进才允许继续', () => {
  const base = {
    requestObserved: false,
    responseObserved: false,
    responseAccepted: false,
    pageAdvanced: false,
    lastQuestionNotice: false,
    stopRequested: false,
  }

  assert.deepEqual(evaluateNoqrSaveEvidence(base), {
    state: 'waiting_request',
    saved: false,
    canAdvance: false,
  })
  assert.deepEqual(evaluateNoqrSaveEvidence({ ...base, pageAdvanced: true }), {
    state: 'unconfirmed_page_change',
    saved: false,
    canAdvance: false,
  })
  assert.deepEqual(evaluateNoqrSaveEvidence({ ...base, requestObserved: true }), {
    state: 'waiting_response',
    saved: false,
    canAdvance: false,
  })
  assert.deepEqual(evaluateNoqrSaveEvidence({ ...base, requestObserved: true, stopRequested: true }), {
    state: 'submitted_uncertain',
    saved: false,
    canAdvance: false,
  })
  assert.deepEqual(evaluateNoqrSaveEvidence({ ...base, requestObserved: true, responseObserved: true }), {
    state: 'failed',
    saved: false,
    canAdvance: false,
  })
  assert.deepEqual(evaluateNoqrSaveEvidence({
    ...base,
    requestObserved: true,
    responseObserved: true,
    responseAccepted: true,
  }), {
    state: 'awaiting_advance',
    saved: true,
    canAdvance: false,
  })
  assert.deepEqual(evaluateNoqrSaveEvidence({
    ...base,
    requestObserved: true,
    responseObserved: true,
    responseAccepted: true,
    pageAdvanced: true,
  }), {
    state: 'ready',
    saved: true,
    canAdvance: true,
  })
  assert.deepEqual(evaluateNoqrSaveEvidence({
    ...base,
    requestObserved: true,
    responseObserved: true,
    responseAccepted: true,
    lastQuestionNotice: true,
  }), {
    state: 'ready',
    saved: true,
    canAdvance: true,
  })
})

test('T005-C06 已保存题型计数只保留白名单枚举并累计真实保存次数', () => {
  const counts = emptyNoqrQuestionKindCounts()
  recordNoqrSavedQuestionKind(counts, 'english_listening')
  recordNoqrSavedQuestionKind(counts, 'english_listening')
  recordNoqrSavedQuestionKind(counts, 'english_reading')
  assert.deepEqual(counts, {
    english_listening: 2,
    english_reading: 1,
  })
})

test('T005-C06b 新一轮启动清空计数、日志和旧课程状态', () => {
  const view = createNoqrStudentView({
    local_id: 'student-a',
    name: '学生甲',
    username: 'fixture-user',
    password: ['fixture', 'password'].join('-'),
    display_mode: 'headless',
    work_mode: 'noqr',
    course_scope: 'selected',
    answer_round_limit: 3,
  })
  view.bankCount = 8
  view.aiCount = 4
  view.questionKindCounts = { single: 3, picker: 1 }
  view.logs = ['旧日志']
  view.courseLogs = [{ time: '', level: 'info', courseName: '旧课程', homeworkName: '', action: '', result: '', reason: '' }]
  view.courses = [{ key: 'old', name: '旧课程', order: 1, status: '尚未完成', groups: [] }]
  view.groups = [{ title: '网上记分作业', rows: [{ name: '旧作业', status: 'todo', questions: [] }] }]
  view.activeCourseName = '旧课程'
  view.activeCourseKey = 'old'
  resetNoqrStudentRunView(view)
  assert.equal(view.bankCount, 0)
  assert.equal(view.aiCount, 0)
  assert.deepEqual(view.questionKindCounts, {})
  assert.deepEqual(view.logs, [])
  assert.deepEqual(view.courseLogs, [])
  assert.deepEqual(view.courses, [])
  assert.deepEqual(view.groups, [])
  assert.equal(view.activeCourseName, '')
  assert.equal(view.activeCourseKey, '')
})

test('T005-C06c 无码日志脱敏且作业规则失败保持真实状态', () => {
  const safe = sanitizeNoqrLogText('等待 https://coursework.shou.org.cn/path?token=fixture-secret')
  assert.equal(safe.includes('coursework.shou.org.cn'), false)
  assert.equal(safe.includes('fixture-secret'), false)
  assert.equal(noqrHomeworkRuleStatus({ needDo: true, maxRounds: 2, reason: '' }), 'todo')
  assert.equal(noqrHomeworkRuleStatus({ needDo: false, maxRounds: 0, reason: 'start_disabled' }), 'not_startable')
  assert.equal(noqrHomeworkRuleStatus({ needDo: false, maxRounds: 0, reason: 'date_unknown' }), 'date_unknown')
  assert.equal(noqrHomeworkRuleStatus({ needDo: false, maxRounds: 0, reason: 'weight_zero' }), ['skip', 'weight0'].join('_'))
})

test('T005-C06d 只有可做作业已完成时才把整轮标记完成', () => {
  assert.equal(noqrRunOutcome(['本轮可做作业已完成', '无作业']).phase, 'completed')
  assert.equal(noqrRunOutcome(['尚未完成']).phase, 'not_full')
  assert.match(noqrRunOutcome(['尚未完成']).message, /未完成/)
  assert.equal(noqrRunOutcome(['检测失败']).phase, 'not_full')
  assert.match(noqrRunOutcome(['检测失败']).message, /失败/)
})

test('T005-C07 同一账号页面启动串行，不同账号仍可并行', async () => {
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const events = []
  const first = withNoqrStartupLock('student-a', async () => {
    events.push('a:first:start')
    await firstGate
    events.push('a:first:end')
  })
  const second = withNoqrStartupLock('student-a', async () => {
    events.push('a:second:start')
  })
  const other = withNoqrStartupLock('student-b', async () => {
    events.push('b:start')
  })

  await other
  assert.deepEqual(events, ['a:first:start', 'b:start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(events, ['a:first:start', 'b:start', 'a:first:end', 'a:second:start'])
})

test('T005-C08 停止后等待中的页面启动不会继续', async () => {
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const controller = new AbortController()
  let secondStarted = false
  const first = withNoqrStartupLock('student-a', async () => firstGate)
  const second = withNoqrStartupLock('student-a', async () => {
    secondStarted = true
  }, controller.signal)

  controller.abort()
  releaseFirst()
  await first
  await assert.rejects(
    second,
    (error) => error instanceof NoqrSessionError && error.code === 'stopped',
  )
  assert.equal(secondStarted, false)
})

test('T005-C09 恢复后作业 key 变化只允许按唯一名称重新绑定', () => {
  const cards = [
    { key: 'new-a', name: '记分作业一' },
    { key: 'new-b', name: '记分作业二' },
  ]
  assert.equal(resolveNoqrHomeworkCard(cards, { key: 'new-a', name: '旧名称' }).key, 'new-a')
  assert.equal(resolveNoqrHomeworkCard(cards, { key: 'stale-key', name: '记分作业二' }).key, 'new-b')
  assert.throws(
    () => resolveNoqrHomeworkCard([
      { key: 'same-1', name: '同名作业' },
      { key: 'same-2', name: '同名作业' },
    ], { key: 'stale-key', name: '同名作业' }),
    (error: unknown) => error instanceof NoqrSessionError && error.code === 'homework_contract',
  )
})
