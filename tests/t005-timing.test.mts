import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createNoqrTimingAccumulator,
  noqrPacingDelayMs,
  recordNoqrGroupTiming,
  snapshotNoqrTiming,
} from '../electron/noqr/timing.ts'
import { formatNoqrDurationMs } from '../electron/core/live-view.ts'

test('T005-TIME01 复合题组按题位数均摊平均时长和最长单题时长', () => {
  const timing = createNoqrTimingAccumulator()
  recordNoqrGroupTiming(timing, 60_000, 10)
  recordNoqrGroupTiming(timing, 20_000, 5)
  recordNoqrGroupTiming(timing, 5_000, 1)

  const snapshot = snapshotNoqrTiming(timing, 120_000)
  assert.equal(snapshot.noqrAnsweredQuestionCount, 16)
  assert.equal(snapshot.noqrAverageQuestionDurationMs, 5_312.5)
  assert.equal(snapshot.noqrMaxQuestionDurationMs, 6_000)
  assert.equal(snapshot.noqrTotalDurationMs, 120_000)
})

test('T005-TIME02 非法耗时和题数安全归零，跨重答保持累计', () => {
  const timing = createNoqrTimingAccumulator()
  recordNoqrGroupTiming(timing, -10, 0)
  recordNoqrGroupTiming(timing, 3_000, 1)
  recordNoqrGroupTiming(timing, 7_000, 2)

  const snapshot = snapshotNoqrTiming(timing, -1)
  assert.equal(snapshot.noqrAnsweredQuestionCount, 3)
  assert.equal(snapshot.noqrAverageQuestionDurationMs, 3_333.3333333333335)
  assert.equal(snapshot.noqrMaxQuestionDurationMs, 3_500)
  assert.equal(snapshot.noqrTotalDurationMs, 0)
})

test('T005-TIME03 作业时长展示不输出原始毫秒', () => {
  assert.equal(formatNoqrDurationMs(850), '0分01秒')
  assert.equal(formatNoqrDurationMs(61_000), '1分01秒')
  assert.equal(formatNoqrDurationMs(3_723_000), '62分03秒')
  assert.equal(formatNoqrDurationMs(0), '--')
  assert.equal(formatNoqrDurationMs(-1), '--')
  assert.equal(formatNoqrDurationMs(Number.NaN), '--')
})

test('T005-TIME04 每个成功保存题位至少保持三秒节奏，慢响应不额外等待', () => {
  assert.equal(noqrPacingDelayMs(500, 1), 2_500)
  assert.equal(noqrPacingDelayMs(2_500, 1), 500)
  assert.equal(noqrPacingDelayMs(3_000, 1), 0)
  assert.equal(noqrPacingDelayMs(5_000, 1), 0)
  assert.equal(noqrPacingDelayMs(5_000, 10), 25_000)
  assert.equal(noqrPacingDelayMs(31_000, 10), 0)
  assert.equal(noqrPacingDelayMs(-1, 0), 3_000)
})

test('T005-TIME05 慢保存超过三秒后不再追加三秒节奏', () => {
  const singleQuestionSaveMs = 3_450
  const singleDelay = noqrPacingDelayMs(singleQuestionSaveMs, 1)
  assert.equal(singleDelay, 0)
  assert.equal(singleQuestionSaveMs + singleDelay, 3_450)

  const twoQuestionSlowGroupMs = 3_750
  const groupDelay = noqrPacingDelayMs(twoQuestionSlowGroupMs, 2)
  assert.equal(groupDelay, 2_250)
  assert.equal(twoQuestionSlowGroupMs + groupDelay, 6_000)
})

test('T005-TIME06 复合题十题位快速保存补足到约三十秒并按题位均摊', () => {
  const quickAnswerAndSaveMs = 1_250
  const pacingDelay = noqrPacingDelayMs(quickAnswerAndSaveMs, 10)
  const totalGroupMs = quickAnswerAndSaveMs + pacingDelay

  assert.equal(pacingDelay, 28_750)
  assert.equal(totalGroupMs, 30_000)

  const timing = createNoqrTimingAccumulator()
  recordNoqrGroupTiming(timing, totalGroupMs, 10)
  const snapshot = snapshotNoqrTiming(timing, totalGroupMs)
  assert.equal(snapshot.noqrAnsweredQuestionCount, 10)
  assert.equal(snapshot.noqrAverageQuestionDurationMs, 3_000)
  assert.equal(snapshot.noqrMaxQuestionDurationMs, 3_000)
  assert.equal(snapshot.noqrTotalDurationMs, 30_000)
})
