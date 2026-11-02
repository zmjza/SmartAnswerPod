import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { courseOutcome } from '../electron/core/live-view.ts'
import {
  isNoqrFatalWorkflowError,
  NoqrScoreUnavailableError,
  noqrHomeworkFailureStatus,
  shouldDegradeNoqrBaselineFailure,
} from '../electron/noqr/workflow-errors.ts'
import { NoqrSessionError } from '../electron/noqr/session.ts'
import { shouldRestoreNoqrRecordPage } from '../electron/noqr/page-policy.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('T005-FLOW01 作业静态规则必须先于作答记录读取', () => {
  const source = readFileSync(join(ROOT, 'electron/noqr/run.ts'), 'utf8')
  const start = source.indexOf('async function processHomework')
  assert.ok(start >= 0)
  const ruleIndex = source.indexOf(
    'const rule = evaluateNoqrHomeworkRule(homework, Date.now(), view.answerRoundLimit)',
    start,
  )
  const historyIndex = source.indexOf(
    'readRecordsForHomework(page, course, homework, view, signal)',
    start,
  )
  assert.ok(ruleIndex >= 0, '作业规则调用缺失')
  assert.ok(historyIndex >= 0, '历史基线读取缺失')
  assert.ok(ruleIndex < historyIndex, '记录读取发生在静态规则之前')
})

test('T005-FLOW02 取分失败映射为分数待确认，不冒充提交失败', () => {
  const error = new NoqrScoreUnavailableError('已交卷但分数读取失败')
  assert.equal(error.code, 'score_unavailable')
  assert.equal(noqrHomeworkFailureStatus(error), 'score_unavailable')
  assert.equal(noqrHomeworkFailureStatus(new Error('fixture failure')), null)
})

test('T005-FLOW03 分数待确认有独立课程结果，不标成提交失败', () => {
  assert.equal(courseOutcome(['score_unavailable']), '分数待确认')
  assert.equal(courseOutcome(['score_unavailable', 'done_100']), '分数待确认')
})

test('T005-FLOW04 真实失败优先于分数待确认，页面中断单独呈现', () => {
  assert.equal(courseOutcome(['score_unavailable', 'submit_failed']), '有失败待处理')
  assert.equal(courseOutcome(['score_unavailable', 'page_interrupted']), '有失败待处理')
  assert.equal(courseOutcome(['page_interrupted']), '有失败待处理')
})

test('T005-FLOW05 页面中断与会话错误不能被包装成分数待确认', () => {
  for (const code of [
    'auth_blocked',
    'login_failed',
    'credentials_missing',
    'stopped',
    'blank_page',
    'page_error',
    'answer_interrupted',
    'submitted_uncertain',
  ] as const) {
    assert.equal(isNoqrFatalWorkflowError(new NoqrSessionError(code, 'fixture')), true, code)
  }
  assert.equal(isNoqrFatalWorkflowError(new Error('fixture')), false)
  assert.equal(isNoqrFatalWorkflowError(new NoqrSessionError('homework_contract', 'fixture')), false)
  assert.equal(isNoqrFatalWorkflowError(new NoqrSessionError('course_contract', 'fixture')), false)
  assert.equal(isNoqrFatalWorkflowError(new NoqrScoreUnavailableError('fixture')), false)
})

test('T005-FLOW06 只有非致命历史基线错误才允许降级继续作答', () => {
  assert.equal(shouldDegradeNoqrBaselineFailure(new Error('作答记录接口暂时失败')), true)
  assert.equal(shouldDegradeNoqrBaselineFailure(new NoqrSessionError('blank_page', 'fixture')), false)
  assert.equal(shouldDegradeNoqrBaselineFailure(new NoqrSessionError('page_error', 'fixture')), false)
  assert.equal(shouldDegradeNoqrBaselineFailure(new NoqrSessionError('answer_interrupted', 'fixture')), false)
  assert.equal(shouldDegradeNoqrBaselineFailure(new NoqrSessionError('submitted_uncertain', 'fixture')), false)
})

test('T005-FLOW07 停止后不得再点击作答记录页返回按钮', () => {
  assert.equal(shouldRestoreNoqrRecordPage('/course_work_record/index.html', false), true)
  assert.equal(shouldRestoreNoqrRecordPage('/course_work_record/index.html', true), false)
  assert.equal(shouldRestoreNoqrRecordPage('/course_work/index.html', false), false)
})
