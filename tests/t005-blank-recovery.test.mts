import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NOQR_BLANK_GRACE_MS,
  NOQR_BLANK_MAX_ACTIVE_WAIT_MS,
  NOQR_BLANK_MAX_HEARTBEAT_WAIT_MS,
  NoqrBlankRecoveryGate,
} from '../electron/noqr/blank-recovery.ts'
import {
  NOQR_ANSWER_BOOT_HARD_WAIT_MS,
  NOQR_ANSWER_CARD_HARD_WAIT_MS,
  NOQR_ANSWER_PAGE_ADVANCE_HARD_WAIT_MS,
  NOQR_HISTORY_RESPONSE_HARD_WAIT_MS,
  NOQR_MUTATION_RESPONSE_HARD_WAIT_MS,
  NOQR_RETURN_HARD_WAIT_MS,
  NOQR_SUBMIT_HARD_WAIT_MS,
} from '../electron/noqr/limits.ts'

test('T005-BLANK01 非答题空白默认等待 60 秒，重复活动 90 秒、活动请求 120 秒有界恢复', () => {
  assert.equal(NOQR_BLANK_GRACE_MS, 60_000)
  assert.equal(NOQR_BLANK_MAX_HEARTBEAT_WAIT_MS, 90_000)
  assert.equal(NOQR_BLANK_MAX_ACTIVE_WAIT_MS, 120_000)
  const gate = new NoqrBlankRecoveryGate({ graceMs: 100, refreshBudget: 1 })
  assert.equal(gate.graceMs, 100)
  assert.equal(gate.refreshBudget, 1)
})

test('T005-BLANK01b 答题页安全上限只用于安全停止，默认不短于真实慢响应', () => {
  for (const value of [
    NOQR_ANSWER_BOOT_HARD_WAIT_MS,
    NOQR_ANSWER_CARD_HARD_WAIT_MS,
    NOQR_ANSWER_PAGE_ADVANCE_HARD_WAIT_MS,
    NOQR_HISTORY_RESPONSE_HARD_WAIT_MS,
    NOQR_MUTATION_RESPONSE_HARD_WAIT_MS,
    NOQR_RETURN_HARD_WAIT_MS,
    NOQR_SUBMIT_HARD_WAIT_MS,
  ]) {
    assert.equal(value, 240_000)
  }
})

test('T005-BLANK02 空白无活动未满宽限不刷新，满宽限只刷新一次', () => {
  const gate = new NoqrBlankRecoveryGate({ graceMs: 120, refreshBudget: 2 })

  assert.equal(gate.observe({
    now: 1_000,
    activityVersion: 0,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 1_119,
    activityVersion: 0,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 1_120,
    activityVersion: 0,
    empty: true,
    active: false,
  }).action, 'refresh')

  assert.equal(gate.observe({
    now: 1_239,
    activityVersion: 0,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 1_240,
    activityVersion: 0,
    empty: true,
    active: false,
  }).action, 'refresh')
  assert.equal(gate.observe({
    now: 1_360,
    activityVersion: 0,
    empty: true,
    active: false,
  }).action, 'stop')
})

test('T005-BLANK03 活动请求和业务进度会重置无活动计时', () => {
  const gate = new NoqrBlankRecoveryGate({ graceMs: 100, refreshBudget: 1 })
  gate.observe({ now: 0, activityVersion: 1, empty: true, active: false })

  assert.equal(gate.observe({
    now: 60,
    activityVersion: 2,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 159,
    activityVersion: 2,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 160,
    activityVersion: 2,
    empty: true,
    active: false,
  }).action, 'refresh')

  const activeGate = new NoqrBlankRecoveryGate({ graceMs: 100, refreshBudget: 1 })
  activeGate.observe({ now: 0, activityVersion: 1, empty: true, active: false })
  assert.equal(activeGate.observe({
    now: 90,
    activityVersion: 1,
    empty: true,
    active: true,
  }).action, 'wait')
  assert.equal(activeGate.observe({
    now: 150,
    activityVersion: 1,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(activeGate.observe({
    now: 250,
    activityVersion: 1,
    empty: true,
    active: false,
  }).action, 'refresh')
})

test('T005-BLANK04 业务就绪会清空空白计时，不继承旧倒计时', () => {
  const gate = new NoqrBlankRecoveryGate({ graceMs: 100, refreshBudget: 1 })
  gate.observe({ now: 0, activityVersion: 1, empty: true, active: false })
  assert.equal(gate.observe({
    now: 80,
    activityVersion: 2,
    empty: false,
    active: false,
    ready: true,
  }).action, 'ready')

  assert.equal(gate.observe({
    now: 90,
    activityVersion: 2,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 189,
    activityVersion: 2,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 190,
    activityVersion: 2,
    empty: true,
    active: false,
  }).action, 'refresh')
})

test('T005-BLANK05 停止优先于空白恢复，0 刷新预算直接收口', () => {
  const gate = new NoqrBlankRecoveryGate({ graceMs: 0, refreshBudget: 0 })
  assert.equal(gate.observe({
    now: 0,
    activityVersion: 0,
    empty: true,
    active: false,
    stopRequested: true,
  }).action, 'stop')
  assert.equal(gate.observe({
    now: 0,
    activityVersion: 0,
    empty: true,
    active: false,
  }).action, 'stop')
})

test('T005-BLANK06 持续心跳不能永久阻止非答题页恢复', () => {
  const gate = new NoqrBlankRecoveryGate({
    graceMs: 1_000,
    refreshBudget: 1,
    maxHeartbeatWaitMs: 5_000,
  })
  for (let now = 0; now < 4_999; now += 500) {
    assert.equal(gate.observe({
      now,
      activityVersion: now / 500,
      empty: true,
      active: false,
    }).action, now === 0 ? 'wait' : 'wait')
  }
  assert.equal(gate.observe({
    now: 5_000,
    activityVersion: 10,
    empty: true,
    active: false,
  }).action, 'refresh')
})

test('T005-BLANK07 真实活动请求仍优先于心跳上限，不能在请求进行中刷新', () => {
  const gate = new NoqrBlankRecoveryGate({
    graceMs: 100,
    refreshBudget: 1,
    maxHeartbeatWaitMs: 500,
  })
  gate.observe({ now: 0, activityVersion: 0, empty: true, active: false })
  assert.equal(gate.observe({
    now: 600,
    activityVersion: 1,
    empty: true,
    active: true,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 650,
    activityVersion: 1,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 750,
    activityVersion: 1,
    empty: true,
    active: false,
  }).action, 'refresh')
})

test('T005-BLANK08 超过心跳上限的慢请求完成后重新等待完整静默宽限', () => {
  const gate = new NoqrBlankRecoveryGate({
    graceMs: 100,
    refreshBudget: 1,
    maxHeartbeatWaitMs: 500,
  })
  gate.observe({ now: 0, activityVersion: 0, empty: true, active: false })
  assert.equal(gate.observe({
    now: 600,
    activityVersion: 1,
    empty: true,
    active: true,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 650,
    activityVersion: 2,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 700,
    activityVersion: 2,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 750,
    activityVersion: 2,
    empty: true,
    active: false,
  }).action, 'refresh')
})

test('T005-BLANK09 永不结束的活动请求达到活动上限后必须有界恢复', () => {
  const gate = new NoqrBlankRecoveryGate({
    graceMs: 100,
    refreshBudget: 1,
    maxHeartbeatWaitMs: 500,
    maxActiveWaitMs: 500,
  })
  assert.equal(gate.observe({
    now: 0,
    activityVersion: 0,
    empty: true,
    active: false,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 600,
    activityVersion: 1,
    empty: true,
    active: true,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 1_100,
    activityVersion: 1,
    empty: true,
    active: true,
  }).action, 'refresh')
  assert.equal(gate.observe({
    now: 1_200,
    activityVersion: 2,
    empty: true,
    active: true,
  }).action, 'stop')
})

test('T005-BLANK10 接近心跳上限后才开始的慢请求仍获得完整活动等待时间', () => {
  const gate = new NoqrBlankRecoveryGate({
    graceMs: 100,
    refreshBudget: 1,
    maxHeartbeatWaitMs: 500,
    maxActiveWaitMs: 1_000,
  })
  gate.observe({ now: 0, activityVersion: 0, empty: true, active: false })
  for (let now = 100; now < 490; now += 100) {
    gate.observe({ now, activityVersion: now / 100, empty: true, active: false })
  }
  assert.equal(gate.observe({
    now: 490,
    activityVersion: 6,
    empty: true,
    active: true,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 1_489,
    activityVersion: 6,
    empty: true,
    active: true,
  }).action, 'wait')
  assert.equal(gate.observe({
    now: 1_490,
    activityVersion: 6,
    empty: true,
    active: true,
  }).action, 'refresh')
})
