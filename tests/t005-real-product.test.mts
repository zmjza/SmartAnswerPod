import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as noqrView from '../electron/noqr/view.ts'
import { parseT005Credentials } from './helpers/t005-credentials.mjs'
import * as t005Harness from './t005-real-product.mjs'
import {
  OBSERVED_ANSWER_WORK_TYPES,
  SUPPORTED_COURSE_SCOPES,
  SUPPORTED_DISPLAY_MODES,
  SUPPORTED_TEST_PHASES,
  T005HarnessError,
  buildProductChildEnv,
  chooseNoqrTestCourse,
  classifyAnswerWorkType,
  createGetOnlyBankService,
  debugDiagnosticsForStudent,
  displayEvidenceCount,
  diagnosticsForStudent,
  isSiteGeneratedFinalDuplicate,
  missingEnglishQuestionKinds,
  normalHomeworkSlotFailure,
  normalHomeworkSlotFailures,
  noqrLoginReuseFailure,
  noqrPacingViolationCount,
  noqrScoreNetworkFailure,
  normalizeHarnessConfig,
  recordDisplayEvidence,
  safeDiagnosticCode,
  shouldFailTerminalBeforeTarget,
  summarizeStudentForLog,
} from './t005-real-product.mjs'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE_KEY = ['fixture', 'key', 'product'].join('-')
const ENGLISH_USER = 'fixture-product-english'
const ENGLISH_PASSWORD = ['fixture', 'pass', 'product-english'].join('-')
const NORMAL_USER = 'fixture-product-normal'
const NORMAL_PASSWORD = ['fixture', 'pass', 'product-normal'].join('-')
const SECOND_NORMAL_USER = 'fixture-product-normal-second'
const SECOND_NORMAL_PASSWORD = ['fixture', 'pass', 'product-normal-second'].join('-')
const THIRD_NORMAL_USER = 'fixture-product-normal-third'
const THIRD_NORMAL_PASSWORD = ['fixture', 'pass', 'product-normal-third'].join('-')

function fixtureGoalText() {
  return [
    `ai的apikey：${FIXTURE_KEY}`,
    '大学英语专属题型账号密码：',
    `账号：${ENGLISH_USER}`,
    `密码：${ENGLISH_PASSWORD}`,
    '',
    '正常题型账号密码：',
    `账号：${NORMAL_USER}`,
    `密码：${NORMAL_PASSWORD}`,
    '',
  ].join('\n')
}

function threeNormalAccountGoalText() {
  return [
    fixtureGoalText(),
    `账号：${SECOND_NORMAL_USER}`,
    `密码：${SECOND_NORMAL_PASSWORD}`,
    '',
    `账号：${THIRD_NORMAL_USER}`,
    `密码：${THIRD_NORMAL_PASSWORD}`,
    '',
  ].join('\n')
}

function manyNormalAccountGoalText(count: number) {
  const lines = [
    `ai的apikey：${FIXTURE_KEY}`,
    '大学英语专属题型账号密码：',
    `账号：${ENGLISH_USER}`,
    `密码：${ENGLISH_PASSWORD}`,
    '',
    '正常题型账号密码：',
  ]
  for (let index = 0; index < count; index++) {
    const suffix = String(index + 1).padStart(2, '0')
    lines.push(`账号：${['fixture', 'user', 'normal', suffix].join('-')}`)
    lines.push(`密码：${['fixture', 'pass', 'normal', suffix].join('-')}`)
    lines.push('')
  }
  return lines.join('\n')
}

test('T005-RP-01 exposes only the confirmed answer work-type whitelist', () => {
  assert.deepEqual([...OBSERVED_ANSWER_WORK_TYPES], ['onlineWork', 'stageExam'])
  assert.equal(classifyAnswerWorkType('onlineWork'), 'onlineWork')
  assert.equal(classifyAnswerWorkType('stageExam'), 'stageExam')
  assert.equal(classifyAnswerWorkType('otherWork'), 'unsupported')
})

test('T005-RP-01b repeated login submissions fail the real-product gate', () => {
  assert.equal(noqrLoginReuseFailure({ loginSubmissionRequests: 1 }, 1), '')
  assert.equal(noqrLoginReuseFailure({ loginSubmissionRequests: 3 }, 1), 'login_submission_repeated')
  assert.equal(noqrLoginReuseFailure({ loginSubmissionRequests: 2 }, 2), '')
  assert.equal(noqrLoginReuseFailure({ loginSubmissionRequests: 0 }, 1), '')
})

test('T005-RP-02 normalizes phases, aliases, display, and course scope strictly', () => {
  const credentials = parseT005Credentials(threeNormalAccountGoalText())
  for (const phase of SUPPORTED_TEST_PHASES) {
    const config = normalizeHarnessConfig({
      KAIDA_T005_PHASE: phase,
      KAIDA_TEST_ALIAS: phase === 'concurrency' ? 'NOQR-01,NOQR-02,NOQR-03' : 'NOQR-01',
    }, credentials)
    assert.equal(config.phase, phase)
    assert.equal(config.accounts.length, phase === 'concurrency' ? 3 : 1)
    assert.equal(config.maxRuntimeMs, Number.POSITIVE_INFINITY)
  }
  for (const displayMode of SUPPORTED_DISPLAY_MODES) {
    assert.equal(normalizeHarnessConfig({ KAIDA_DISPLAY_MODE: displayMode }, credentials).displayMode, displayMode)
  }
  for (const courseScope of SUPPORTED_COURSE_SCOPES) {
    assert.equal(normalizeHarnessConfig({ KAIDA_COURSE_SCOPE: courseScope }, credentials).courseScope, courseScope)
  }

  const config = normalizeHarnessConfig({
    KAIDA_TEST_ALIAS: 'NOQR-EN',
    KAIDA_DISPLAY_MODE: 'visual',
    KAIDA_COURSE_SCOPE: 'selected',
    KAIDA_T005_PHASE: 'courses',
  }, credentials)
  assert.deepEqual(config.accounts.map((account) => account.alias), ['NOQR-EN'])
  assert.equal(config.accounts[0].kind, 'english')
  assert.equal(config.displayMode, 'visual')
  assert.equal(config.courseScope, 'selected')
  assert.equal(config.phase, 'courses')
  assert.equal(config.bankSource, 'empty')
  assert.equal(config.logEnabled, true)

  assert.equal(normalizeHarnessConfig({
    KAIDA_T005_LOG_ENABLED: '0',
  }, credentials).logEnabled, false)
  assert.equal(normalizeHarnessConfig({
    KAIDA_T005_LOG_ENABLED: '1',
  }, credentials).logEnabled, true)

  assert.equal(normalizeHarnessConfig({
    KAIDA_T005_BANK_SOURCE: 'installed',
  }, credentials).bankSource, 'installed')

  const matched = normalizeHarnessConfig({
    KAIDA_T005_COURSE_MATCH: '  大学英语  ',
  }, credentials)
  assert.equal(matched.courseMatch, '大学英语')

  const concurrent = normalizeHarnessConfig({
    KAIDA_T005_PHASE: 'concurrency',
  }, credentials)
  assert.deepEqual(concurrent.accounts.map((account) => account.alias), ['NOQR-EN', 'NOQR-01', 'NOQR-02'])
  assert.equal(concurrent.accountParallel, 2)

  assert.throws(
    () => normalizeHarnessConfig({ KAIDA_T005_PHASE: 'unknown' }, credentials),
    (error) => error instanceof T005HarnessError && error.code === 'invalid_phase',
  )
  assert.throws(
    () => normalizeHarnessConfig({ KAIDA_TEST_ALIAS: 'NOQR-99' }, credentials),
    (error) => error instanceof T005HarnessError && error.code === 'account_not_found',
  )
  assert.throws(
    () => normalizeHarnessConfig({ KAIDA_DISPLAY_MODE: 'headed' }, credentials),
    (error) => error instanceof T005HarnessError && error.code === 'invalid_display_mode',
  )
  assert.throws(
    () => normalizeHarnessConfig({ KAIDA_COURSE_SCOPE: 'partial' }, credentials),
    (error) => error instanceof T005HarnessError && error.code === 'invalid_course_scope',
  )
  assert.throws(
    () => normalizeHarnessConfig({ KAIDA_T005_BANK_SOURCE: 'write' }, credentials),
    (error) => error instanceof T005HarnessError && error.code === 'invalid_bank_source',
  )
})

test('T005-RP-02b course match is applied before strategy and index', () => {
  const courses = [
    { key: 'a', name: '普通课程', groups: [{ rows: [{ status: 'todo' }, { status: 'todo' }, { status: 'todo' }] }] },
    { key: 'b', name: '大学英语（1）', groups: [{ rows: [{ status: 'todo' }] }] },
    { key: 'c', name: '大学英语（2）', groups: [{ rows: [{ status: 'todo' }, { status: 'todo' }] }] },
  ]
  assert.equal(chooseNoqrTestCourse(courses, {
    courseStrategy: 'max-todo',
    courseIndex: 0,
    courseMatch: '大学英语',
  })?.key, 'c')
  assert.equal(chooseNoqrTestCourse(courses, {
    courseStrategy: 'max-todo',
    courseIndex: 2,
    courseMatch: '大学英语',
  })?.key, 'b')
  assert.equal(chooseNoqrTestCourse(courses, {
    courseStrategy: 'max-todo',
    courseIndex: 0,
    courseMatch: '不存在',
  }), null)

  const completedEnglish = [{
    key: 'd',
    name: '大学英语（3）',
    groups: [{ rows: [{ status: 'done_100' }] }],
  }]
  assert.equal(chooseNoqrTestCourse(completedEnglish, {
    courseStrategy: 'max-todo',
    courseIndex: 0,
    courseMatch: '大学英语',
    forceRetry: false,
  }), null)
  assert.equal(chooseNoqrTestCourse(completedEnglish, {
    courseStrategy: 'max-todo',
    courseIndex: 0,
    courseMatch: '大学英语',
    forceRetry: true,
  })?.key, 'd')
})

test('T005-RP-02A concurrency account limit defaults to two and stays within one to eight', () => {
  const credentials = parseT005Credentials(manyNormalAccountGoalText(9))
  const baseEnv = {
    KAIDA_T005_PHASE: 'concurrency',
    KAIDA_TEST_ALIAS: Array.from({ length: 9 }, (_, index) => `NOQR-${String(index + 1).padStart(2, '0')}`).join(','),
  }

  assert.equal(normalizeHarnessConfig(baseEnv, credentials).accountParallel, 2)
  assert.equal(normalizeHarnessConfig({
    ...baseEnv,
    KAIDA_T005_ACCOUNT_PARALLEL: '1',
  }, credentials).accountParallel, 1)
  assert.equal(normalizeHarnessConfig({
    ...baseEnv,
    KAIDA_T005_ACCOUNT_PARALLEL: '8',
  }, credentials).accountParallel, 8)
  assert.equal(normalizeHarnessConfig({
    ...baseEnv,
    KAIDA_T005_ACCOUNT_PARALLEL: '12',
  }, credentials).accountParallel, 8)
  assert.equal(normalizeHarnessConfig({
    ...baseEnv,
    KAIDA_T005_ACCOUNT_PARALLEL: '0',
  }, credentials).accountParallel, 1)
  assert.equal(normalizeHarnessConfig({
    KAIDA_T005_PHASE: 'answer',
    KAIDA_TEST_ALIAS: 'NOQR-01',
    KAIDA_T005_ACCOUNT_PARALLEL: '8',
  }, credentials).accountParallel, 1)
})

test('T005-RP-02C test-only score stop round is bounded and backward compatible', () => {
  const credentials = parseT005Credentials(fixtureGoalText())

  assert.equal(normalizeHarnessConfig({}, credentials).stopAfterScoreRound, null)
  assert.equal(normalizeHarnessConfig({
    KAIDA_T005_STOP_AFTER_SCORE_ROUND: '2',
  }, credentials).stopAfterScoreRound, 2)
  assert.equal(normalizeHarnessConfig({
    KAIDA_T005_STOP_AFTER_FIRST_SCORE: '1',
  }, credentials).stopAfterScoreRound, 1)
  assert.equal(normalizeHarnessConfig({}, credentials).requireNormalKinds, true)
  assert.equal(normalizeHarnessConfig({
    KAIDA_T005_REQUIRE_NORMAL_KINDS: '0',
  }, credentials).requireNormalKinds, false)
  assert.equal(normalizeHarnessConfig({
    KAIDA_T005_REQUIRE_NORMAL_KINDS: '1',
  }, credentials).requireNormalKinds, true)

  for (const value of ['0', '11', '1.5', 'second']) {
    assert.throws(
      () => normalizeHarnessConfig({
        KAIDA_T005_STOP_AFTER_SCORE_ROUND: value,
      }, credentials),
      (error) => error instanceof T005HarnessError && error.code === 'invalid_stop_after_score_round',
    )
  }
  assert.throws(
    () => normalizeHarnessConfig({
      KAIDA_T005_REQUIRE_NORMAL_KINDS: 'mixed',
    }, credentials),
    (error) => error instanceof T005HarnessError && error.code === 'invalid_require_normal_kinds',
  )
})

test('T005-RP-02B concurrency observation requires a queue and caps held account slots', () => {
  const aliases = ['NOQR-01', 'NOQR-02', 'NOQR-03']
  const inspect = t005Harness.inspectConcurrencySnapshot
  assert.equal(typeof inspect, 'function')

  const queued = inspect({
    running: true,
    machine: { browsers: 2 },
    students: [
      { name: aliases[0], slot: 'occupied', queued: false },
      { name: aliases[1], slot: 'occupied', queued: false },
      { name: aliases[2], slot: 'queued', queued: true },
    ],
  }, aliases, 2)
  assert.equal(queued.presentCount, 3)
  assert.equal(queued.heldCount, 2)
  assert.equal(queued.occupiedCount, 2)
  assert.equal(queued.queuedCount, 1)
  assert.equal(queued.withinLimit, true)
  assert.equal(queued.queueObserved, true)
  assert.equal(queued.ready, true)
  assert.equal(queued.browserCount, 2)

  const overLimit = inspect({
    running: true,
    machine: { browsers: 3 },
    students: aliases.map((name) => ({ name, slot: 'occupied', queued: false })),
  }, aliases, 2)
  assert.equal(overLimit.heldCount, 3)
  assert.equal(overLimit.occupiedCount, 3)
  assert.equal(overLimit.withinLimit, false)
  assert.equal(overLimit.ready, false)
  assert.equal(overLimit.browserCount, 3)

  const released = inspect({
    running: false,
    students: aliases.map((name) => ({ name, slot: 'released', queued: false })),
  }, aliases, 2)
  assert.equal(released.releasedCount, 3)
  assert.equal(released.allReleased, true)
})

test('T005-RP-03 local bank service is GET-only and counts every write method', async () => {
  const bank = await createGetOnlyBankService()
  try {
    const get = await fetch(`${bank.origin}/rest/v1/questions?content_hash=eq.fixture`)
    assert.equal(get.status, 200)
    assert.deepEqual(await get.json(), [])

    for (const method of ['POST', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await fetch(`${bank.origin}/rest/v1/questions`, {
        method,
        body: method === 'DELETE' || method === 'OPTIONS' ? undefined : '{}',
      })
      assert.equal(response.status, 405)
    }

    const stats = bank.stats()
    assert.equal(stats.GET, 1)
    assert.equal(stats.POST, 1)
    assert.equal(stats.PATCH, 1)
    assert.equal(stats.DELETE, 1)
    assert.equal(stats.OTHER, 1)
    assert.equal(stats.writeAttempts, 4)
  } finally {
    await bank.close()
  }
})

test('T005-RP-03b read-only bank proxy forwards GET only and never sends writes upstream', async () => {
  const upstreamCounts = { GET: 0, POST: 0 }
  const upstream = createServer((request, response) => {
    if (request.method === 'GET') upstreamCounts.GET++
    else upstreamCounts.POST++
    response.writeHead(request.method === 'GET' ? 200 : 500, {
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(request.method === 'GET' ? '[{"id":"fixture"}]' : '{}')
  })
  await new Promise((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const bank = await createGetOnlyBankService({
    base: `http://127.0.0.1:${address.port}`,
    anon: 'fixture-upstream-key',
  })
  try {
    const get = await fetch(`${bank.origin}/rest/v1/questions?select=id&limit=1`)
    assert.equal(get.status, 200)
    assert.deepEqual(await get.json(), [{ id: 'fixture' }])
    const post = await fetch(`${bank.origin}/rest/v1/questions`, {
      method: 'POST',
      body: '{}',
    })
    assert.equal(post.status, 405)
    assert.deepEqual(upstreamCounts, { GET: 1, POST: 0 })
    assert.deepEqual(bank.stats(), {
      GET: 1,
      POST: 1,
      PATCH: 0,
      DELETE: 0,
      OTHER: 0,
      writeAttempts: 1,
    })
  } finally {
    await bank.close()
    await new Promise((resolveClose) => upstream.close(resolveClose))
  }
})

test('T005-RP-04 child environment cannot inherit credentials or fixture routing', () => {
  const env = buildProductChildEnv({
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    SAFE_FLAG: '1',
    KAIDA_SILICONFLOW_KEY: 'inherited-key',
    KAIDA_SUPABASE_URL: 'https://inherited.example',
    KAIDA_SUPABASE_ANON: 'inherited-anon',
    KAIDA_ACCOUNTS_JSON: '/tmp/inherited.json',
    KAIDA_E2E_ENV: '/tmp/inherited-env.json',
    KAIDA_E2E_SCHOOL_ORIGIN: 'http://127.0.0.1:9',
    KAIDA_E2E_KEEP_BROWSERS: '1',
    KAIDA_E2E_MOCK_COURSES: '1',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:9',
  }, '/project/.playwright/profile')
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/tmp/home')
  assert.equal(env.SAFE_FLAG, undefined)
  assert.equal(env.KAIDA_E2E_USERDATA, '/project/.playwright/profile')
  for (const key of [
    'KAIDA_SILICONFLOW_KEY',
    'KAIDA_SUPABASE_URL',
    'KAIDA_SUPABASE_ANON',
    'KAIDA_ACCOUNTS_JSON',
    'KAIDA_E2E_ENV',
    'KAIDA_E2E_SCHOOL_ORIGIN',
    'KAIDA_E2E_KEEP_BROWSERS',
    'KAIDA_E2E_MOCK_COURSES',
    'VITE_DEV_SERVER_URL',
  ]) {
    assert.equal(env[key], '')
  }
  assert.equal(env.KAIDA_T005_FORCE_RETRY, undefined)
  const forced = buildProductChildEnv({
    PATH: '/usr/bin',
    KAIDA_T005_FORCE_RETRY: '0',
  }, '/project/.playwright/profile', { forceRetry: true })
  assert.equal(forced.KAIDA_T005_FORCE_RETRY, '1')
})

test('T005-RP-05 log summaries contain only aliases, enums, booleans, and counts', () => {
  const summary = summarizeStudentForLog('NOQR-01', {
    studentNo: NORMAL_USER,
    name: 'raw-student-name',
    headline: 'raw-question-or-course-text',
    phase: 'answering',
    account: 'auto_answering',
    slot: 'occupied',
    configLocked: true,
    awaitingCourseSelection: false,
    bankCount: 2,
    aiCount: 1,
    logs: [
      '答题卡漏题，回跳补答 · 单选题@1#1',
      '等待保存响应 3 秒',
    ],
    selectedCourseNames: ['private-course-name'],
    selectedCourseKeys: ['private-course-key'],
    courses: [{
      name: 'private-course-name',
      status: '作答中',
      groups: [{
        rows: [{
          name: 'private-homework',
          status: 'answering',
          score: 88,
          attempt: 1,
          noqrAnsweredQuestionCount: 4,
          noqrAverageQuestionDurationMs: 12_000,
          noqrMaxQuestionDurationMs: 18_000,
          noqrTotalDurationMs: 75_000,
        }],
      }],
    }],
  })
  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes(NORMAL_USER), false)
  assert.equal(serialized.includes('private-course'), false)
  assert.equal(serialized.includes('private-homework'), false)
  assert.equal(serialized.includes('raw-question'), false)
  assert.equal(summary.alias, 'NOQR-01')
  assert.equal(summary.phase, 'answering')
  assert.equal(summary.bankCount, 2)
  assert.equal(summary.homeworkCount, 1)
  assert.equal(summary.timedHomeworkCount, 1)
  assert.equal(summary.timingMissingHomeworkCount, 0)
  assert.equal(summary.maxAverageQuestionDurationSeconds, 12)
  assert.equal(summary.maxQuestionDurationSeconds, 18)
  assert.equal(summary.maxHomeworkDurationSeconds, 75)
  assert.equal(summary.repairLogCount, 1)
  assert.equal(serialized.includes('单选题@1#1'), false)
})

test('T005-RP-06 source never routes, mocks, or rewrites the real school domain', () => {
  const source = readFileSync(join(PROJECT_ROOT, 'tests/t005-real-product.mjs'), 'utf8')
  assert.equal(/\b(?:page|context|browserContext|route)\.route\s*\(/.test(source), false)
  assert.equal(/route\.fulfill|route\.abort|route\.continue/.test(source), false)
  assert.equal(source.includes('https://coursework.shou.org.cn/'), false)
  assert.match(source, /safeStorage/)
  assert.match(source, /window\.kaida/)
  assert.match(source, /#btn-primary-action/)
  assert.match(source, /#play-text/)
  assert.match(source, /#course-list \.course-item/)
  assert.match(source, /#tool-stop|#btn-stop-all/)
  assert.equal(/globalThis\.kaida\.(?:startStudent|setSelectedCourses|startSelectedCourses)\s*\(/.test(source), false)
  const entryCatch = source.slice(source.lastIndexOf('entry().catch'))
  assert.equal(entryCatch.includes('error.message'), false)
  assert.match(entryCatch, /diagnostics/)
})

test('T005-RP-07 preflight exits before bank/browser startup and leaks no credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't005-real-product-preflight-'))
  const goalFile = join(dir, 'goal-objective.md')
  writeFileSync(goalFile, fixtureGoalText())
  const profileRoot = join(PROJECT_ROOT, '.playwright')
  const profileCount = () => existsSync(profileRoot)
    ? readdirSync(profileRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('t005-real-product-')).length
    : 0
  const before = profileCount()
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolveRun, rejectRun) => {
      execFile(
        process.execPath,
        ['--experimental-strip-types', 'tests/t005-real-product.mjs', '--preflight'],
        {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            T005_GOAL_FILE: goalFile,
            KAIDA_TEST_ALIAS: 'NOQR-EN',
            KAIDA_DISPLAY_MODE: 'visual',
            KAIDA_COURSE_SCOPE: 'selected',
            KAIDA_T005_PHASE: 'answer',
            KAIDA_SILICONFLOW_KEY: '',
            NODE_NO_WARNINGS: '1',
          },
          timeout: 30_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            rejectRun(new Error(`preflight failed: ${stderr || stdout || error.message}`))
            return
          }
          resolveRun({ stdout, stderr })
        },
      )
    })

    const report = JSON.parse(result.stdout.trim().split('\n').at(-1) || '')
    assert.equal(report.ok, true)
    assert.equal(report.phase, 'preflight')
    assert.deepEqual(report.aliases, ['NOQR-EN'])
    assert.equal(report.displayMode, 'visual')
    assert.equal(report.courseScope, 'selected')
    assert.equal(report.testPhase, 'answer')
    assert.equal(report.aiKeyLoaded, true)
    assert.equal(report.browserStarted, false)
    assert.equal(report.bankStarted, false)
    assert.equal(report.profileCreated, false)
    assert.equal(report.bankMode, 'get_only_empty')
    assert.equal(report.schoolRouting, 'passthrough')
    assert.deepEqual(report.acceptedAnswerWorkTypes, ['onlineWork', 'stageExam'])
    assert.equal(result.stderr, '')
    const combined = result.stdout + result.stderr
    for (const secret of [FIXTURE_KEY, ENGLISH_USER, ENGLISH_PASSWORD, NORMAL_USER, NORMAL_PASSWORD]) {
      assert.equal(combined.includes(secret), false, 'preflight output leaked credential material')
    }
    assert.equal(profileCount(), before, 'preflight created a product profile')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T005-RP-08 terminal diagnostics are useful but contain no raw product text', () => {
  const diagnostics = diagnosticsForStudent('NOQR-01', {
    phase: 'unsupported',
    account: 'round_ended',
    slot: 'released',
    action: `课程 ${NORMAL_USER} 读取失败 https://coursework.shou.org.cn/course?id=${NORMAL_USER}`,
    logs: [
      `题干 private-question-stem`,
      `课程 private-course-name 作业 private-homework-name workType=otherWork`,
      `账号或密码错误 ${NORMAL_USER}`,
    ],
  })
  assert.equal(diagnostics.alias, 'NOQR-01')
  assert.equal(diagnostics.phase, 'unsupported')
  assert.equal(diagnostics.terminalCode, 'product_unsupported')
  assert.match(diagnostics.lastAction, /^[a-z_]+$/)
  assert.ok(diagnostics.lastLogs.length > 0)
  assert.ok(diagnostics.lastLogs.every((entry) => /^[a-z_]+$/.test(entry)))
  const serialized = JSON.stringify(diagnostics)
  for (const privateText of [
    NORMAL_USER,
    'private-question-stem',
    'private-course-name',
    'private-homework-name',
    'coursework.shou.org.cn',
  ]) {
    assert.equal(serialized.includes(privateText), false)
  }
  const notFull = diagnosticsForStudent('NOQR-01', {
    phase: 'not_full',
    account: 'round_ended',
    slot: 'released',
  })
  assert.equal(notFull.terminalCode, 'product_not_full')
})

test('T005-RP-09 debug diagnostics preserve failure stages without raw business text', () => {
  const student = {
    phase: 'unsupported',
    account: 'round_ended',
    slot: 'released',
    action: `作业已隔离 · ${NORMAL_USER}`,
    bankCount: 2,
    aiCount: 1,
    logs: [
      `开始作业 1/2 · private-homework-name`,
      '答题启动空白，返回重进 1/3',
      '等待保存请求 6 秒',
      '保存请求缺少作答唯一标记',
      '答题卡结构不足：已加载 20/45，已答 20，识别题型 3',
      `课程 private-course-name 作业 private-homework-name 作答记录接口失败 https://coursework.shou.org.cn/?id=${NORMAL_USER}`,
      `题干 private-question-stem`,
    ],
    courseLogs: [{
      courseName: 'private-course-name',
      homeworkName: 'private-homework-name',
      level: 'error',
      reason: `课程检测已隔离 · private-course-name 请求失败 https://coursework.shou.org.cn/?id=${NORMAL_USER}`,
    }],
    courses: [{
      name: 'private-course-name',
      status: '有失败待处理',
      groups: [{
        rows: [
          { name: 'private-homework-name', status: 'submit_failed', score: 88 },
          { name: 'another-private-homework', status: 'done_100', score: 100 },
        ],
      }],
    }],
    selectedCourseKeys: ['private-course-key'],
    questionKindCounts: {
      single: 2,
      english_listening: 1,
      private_kind: 99,
    },
  }
  const debug = debugDiagnosticsForStudent('NOQR-01', student)
  assert.equal(debug.alias, 'NOQR-01')
  assert.equal(debug.phase, 'unsupported')
  assert.equal(debug.lastActionCode, 'homework_isolated')
  assert.ok(debug.logCodes.includes('answer_boot_blank_reenter'))
  assert.ok(debug.logCodes.includes('save_request_wait'))
  assert.ok(debug.logCodes.includes('save_flag_missing'))
  assert.ok(debug.logCodes.includes('history_api_error'))
  assert.ok(debug.logCodes.includes('question_text'))
  assert.deepEqual(debug.answerCardShape, {
    loaded: 20,
    expected: 45,
    answered: 20,
    recognizedSections: 3,
  })
  assert.equal(debug.courseStateCounts.failed, 1)
  assert.equal(debug.homeworkStateCounts.submit_failed, 1)
  assert.equal(debug.homeworkStateCounts.done_100, 1)
  assert.deepEqual(debug.questionKindCounts, {
    single: 2,
    english_listening: 1,
  })
  assert.equal(debug.bankCount, 2)
  assert.equal(debug.aiCount, 1)
  assert.equal(debug.selectedCourseCount, 1)
  assert.deepEqual(debug.courseFailureReasons, [
    '课程检测已隔离 · [课程] 请求失败 [地址已隐藏]',
  ])
  const serialized = JSON.stringify(debug)
  for (const privateText of [
    NORMAL_USER,
    'private-question-stem',
    'private-course-name',
    'private-homework-name',
    'private-course-key',
    'coursework.shou.org.cn',
  ]) {
    assert.equal(serialized.includes(privateText), false)
  }
})

test('T005-RP-09A course diagnostics preserve normal detection and completion states', () => {
  const student = {
    courses: [
      { name: 'course-1', status: '本轮可做作业已完成', groups: [] },
      { name: 'course-2', status: '尚无作业', groups: [] },
      { name: 'course-3', status: '无作业', groups: [] },
      { name: 'course-4', status: '尚未完成', groups: [] },
      { name: 'course-5', status: '暂不可完成', groups: [] },
      { name: 'course-6', status: '分数待确认', groups: [] },
      { name: 'course-7', status: '检测失败', groups: [] },
      { name: 'course-8', status: '待检测', groups: [] },
      { name: 'course-9', status: '检测中', groups: [] },
    ],
  }
  const debug = debugDiagnosticsForStudent('NOQR-01', student)
  assert.deepEqual(debug.courseStateCounts, {
    completed: 1,
    empty: 2,
    incomplete: 1,
    unavailable: 1,
    score_unavailable: 1,
    detection_failed: 1,
    pending: 1,
    detecting: 1,
  })
})

test('T005-RP-09B diagnostics distinguish answer-card timeout from generic page failures', () => {
  assert.equal(
    safeDiagnosticCode('答题卡审计超过总时限，已保留当前页面并停止当前作业'),
    'answer_card_audit_timeout',
  )
  assert.equal(
    safeDiagnosticCode('答案已保存但页面未推进，已保留当前答题页并停止当前作业'),
    'save_advance_not_observed',
  )
})

test('T005-RP-09A English score evidence requires all five saved question kinds', () => {
  const complete = {
    english_grammar: 10,
    english_listening: 5,
    picker: 10,
    english_cloze: 10,
    english_reading: 10,
  }
  assert.deepEqual(missingEnglishQuestionKinds(complete), [])
  assert.deepEqual(missingEnglishQuestionKinds({
    ...complete,
    picker: 0,
    english_reading: undefined,
  }), ['picker', 'english_reading'])
})

test('T005-RP-09A2 Normal score evidence requires one homework covering single, multiple, and judge', () => {
  const complete = {
    homeworkQuestionKindSlotCounts: [{
      index: 3,
      questionKindSlotCounts: { single: 10, multiple: 10, judge: 5 },
    }],
  }
  assert.equal(normalHomeworkSlotFailure(complete), null)
  assert.deepEqual(normalHomeworkSlotFailures([
    { alias: 'NOQR-01', kind: 'normal' },
    { alias: 'NOQR-EN', kind: 'english' },
  ], [complete, {}]), [])
  const split = {
    homeworkQuestionKindSlotCounts: [
      { index: 0, questionKindSlotCounts: { single: 5, multiple: 5 } },
      { index: 1, questionKindSlotCounts: { judge: 5 } },
    ],
  }
  const failure = normalHomeworkSlotFailure(split)
  assert.equal(failure?.code, 'normal_question_slots_missing')
  assert.deepEqual(normalHomeworkSlotFailures([
    { alias: 'NOQR-01', kind: 'normal' },
  ], [split]), [{
    alias: 'NOQR-01',
    code: 'normal_question_slots_missing',
    missingKinds: [],
    evidence: [
      { index: 0, questionKindSlotCounts: { single: 5, multiple: 5 } },
      { index: 1, questionKindSlotCounts: { judge: 5 } },
    ],
  }])

  const accountSweepOnlySingle = {
    homeworkQuestionKindSlotCounts: [{
      index: 0,
      questionKindSlotCounts: { single: 10 },
    }],
    questionKindSlotCounts: { single: 10 },
  }
  assert.deepEqual(normalHomeworkSlotFailures([
    { alias: 'NOQR-01', kind: 'normal' },
  ], [accountSweepOnlySingle], false), [])
  assert.deepEqual(normalHomeworkSlotFailures([
    { alias: 'NOQR-01', kind: 'normal' },
  ], [{
    homeworkQuestionKindSlotCounts: [],
    questionKindSlotCounts: {},
  }], false), [{
    alias: 'NOQR-01',
    code: 'normal_question_slots_missing',
    missingKinds: ['single', 'multiple', 'judge'],
    evidence: [],
  }])
})

test('T005-RP-09B English score gate requires saved slot evidence, not group counts', () => {
  const groupCounts = {
    english_grammar: 20,
    english_listening: 2,
    picker: 2,
    english_cloze: 1,
    english_reading: 2,
  }
  assert.equal(typeof t005Harness.englishHomeworkSlotFailure, 'function')
  const groupOnlyFailure = t005Harness.englishHomeworkSlotFailure({
    questionKindCounts: groupCounts,
  })
  assert.equal(groupOnlyFailure?.code, 'english_question_slots_missing')
  assert.deepEqual(groupOnlyFailure?.evidence?.homeworks, [])

  const minimumSlots = {
    english_grammar: 10,
    english_listening: 5,
    picker: 10,
    english_cloze: 10,
    english_reading: 10,
  }
  assert.equal(t005Harness.englishHomeworkSlotFailure({
    homeworkQuestionKindSlotCounts: [{
      index: 0,
      questionKindSlotCounts: minimumSlots,
    }],
  }), null)

  const accumulatedSlots = {
    english_grammar: 20,
    english_listening: 10,
    picker: 20,
    english_cloze: 10,
    english_reading: 10,
  }
  assert.equal(t005Harness.englishHomeworkSlotFailure({
    homeworkQuestionKindSlotCounts: [{
      index: 0,
      questionKindSlotCounts: accumulatedSlots,
    }],
  }), null)
  const accumulated = t005Harness.englishQuestionSlotEvidence(accumulatedSlots)
  assert.equal(accumulated.meetsMinimum, true)
  assert.equal(accumulated.totalSlots, 70)
  assert.deepEqual(accumulated.surplus, [
    { kind: 'english_grammar', expected: 10, actual: 20, delta: 10 },
    { kind: 'english_listening', expected: 5, actual: 10, delta: 5 },
    { kind: 'picker', expected: 10, actual: 20, delta: 10 },
  ])

  const incomplete = t005Harness.englishQuestionSlotEvidence({
    ...minimumSlots,
    english_listening: 4,
    picker: 9,
  })
  assert.equal(incomplete.meetsMinimum, false)
  assert.deepEqual(incomplete.insufficient, [
    { kind: 'english_listening', expected: 5, actual: 4, delta: -1 },
    { kind: 'picker', expected: 10, actual: 9, delta: -1 },
  ])

  const source = readFileSync(join(PROJECT_ROOT, 'tests/t005-real-product.mjs'), 'utf8')
  assert.equal(source.includes('englishHomeworkSlotFailures(config.accounts, summaries)'), true)
  assert.equal(/missingEnglishQuestionKinds\(summaries\[/.test(source), false)
})

test('T005-RP-09D English slot summaries expose surplus without hiding minimum evidence', () => {
  const summary = summarizeStudentForLog('NOQR-EN', {
    phase: 'completed',
    account: 'round_ended',
    slot: 'released',
    questionKindSlotCounts: {
      english_grammar: 20,
      english_listening: 10,
      picker: 20,
      english_cloze: 10,
      english_reading: 10,
    },
  })
  assert.equal(summary.englishQuestionSlotEvidence.meetsMinimum, true)
  assert.equal(summary.englishQuestionSlotEvidence.totalSlots, 70)
  assert.deepEqual(summary.englishQuestionSlotEvidence.surplus, [
    { kind: 'english_grammar', expected: 10, actual: 20, delta: 10 },
    { kind: 'english_listening', expected: 5, actual: 10, delta: 5 },
    { kind: 'picker', expected: 10, actual: 20, delta: 10 },
  ])
})

test('T005-RP-09E English hard gate requires one complete homework, not a run-level aggregate', () => {
  const student = {
    phase: 'completed',
    account: 'round_ended',
    slot: 'released',
    questionKindSlotCounts: {
      english_grammar: 10,
      english_listening: 5,
      picker: 10,
      english_cloze: 10,
      english_reading: 10,
    },
    courses: [{
      name: 'fixture-course',
      status: '已完成',
      groups: [{
        title: '网上记分作业',
        rows: [
          {
            name: 'fixture-homework-a',
            status: 'done_100',
            questions: [],
            questionKindSlotCounts: {
              english_grammar: 10,
              english_listening: 5,
              picker: 10,
            },
          },
          {
            name: 'fixture-homework-b',
            status: 'done_100',
            questions: [],
            questionKindSlotCounts: {
              english_cloze: 10,
              english_reading: 10,
            },
          },
        ],
      }],
    }],
  }
  const split = summarizeStudentForLog('NOQR-EN', student)
  assert.equal(split.englishQuestionSlotEvidence.meetsMinimum, true)
  assert.equal(typeof t005Harness.englishHomeworkSlotFailure, 'function')
  const splitFailure = t005Harness.englishHomeworkSlotFailure(split)
  assert.equal(splitFailure?.code, 'english_question_slots_missing')
  assert.deepEqual(splitFailure?.evidence?.homeworks.map((item: { index: number }) => item.index), [0, 1])

  const complete = summarizeStudentForLog('NOQR-EN', {
    ...student,
    courses: [{
      ...student.courses[0],
      groups: [{
        ...student.courses[0].groups[0],
        rows: [
          {
            ...student.courses[0].groups[0].rows[0],
            questionKindSlotCounts: {
              english_grammar: 10,
              english_listening: 5,
              picker: 10,
              english_cloze: 10,
              english_reading: 10,
            },
          },
          student.courses[0].groups[0].rows[1],
        ],
      }],
    }],
  })
  assert.equal(t005Harness.englishHomeworkSlotFailure(complete), null)
})

test('T005-RP-09F English slot gate covers every score return path', () => {
  assert.equal(typeof t005Harness.englishHomeworkSlotFailures, 'function')
  const failures = t005Harness.englishHomeworkSlotFailures([
    { alias: 'NOQR-01', kind: 'normal' },
    { alias: 'NOQR-EN', kind: 'english' },
  ], [
    { homeworkQuestionKindSlotCounts: [] },
    { homeworkQuestionKindSlotCounts: [] },
  ])
  assert.deepEqual(failures.map((item: { alias: string }) => item.alias), ['NOQR-EN'])
  const source = readFileSync(join(PROJECT_ROOT, 'tests/t005-real-product.mjs'), 'utf8')
  assert.equal(
    (source.match(/\n\s+assertEnglishHomeworkSlotEvidence\(config, summaries\)/g) || []).length,
    2,
  )
})

test('T005-RP-09C saved slot counters add actual group unit totals only', () => {
  assert.equal(typeof noqrView.recordNoqrSavedQuestionKindSlots, 'function')
  const counts = noqrView.emptyNoqrQuestionKindCounts()
  noqrView.recordNoqrSavedQuestionKindSlots(counts, 'english_grammar', 1)
  noqrView.recordNoqrSavedQuestionKindSlots(counts, 'english_listening', 5)
  noqrView.recordNoqrSavedQuestionKindSlots(counts, 'english_reading', 5)
  noqrView.recordNoqrSavedQuestionKindSlots(counts, 'english_reading', 5)
  noqrView.recordNoqrSavedQuestionKindSlots(counts, 'private_kind', 99)
  noqrView.recordNoqrSavedQuestionKindSlots(counts, 'picker', 0)
  assert.deepEqual(counts, {
    english_grammar: 1,
    english_listening: 5,
    english_reading: 10,
  })
})

test('T005-RP-10 safe diagnostic codes cover save, submit, history, and page recovery failures', () => {
  const cases = new Map([
    ['答题启动页连续空白，已停止当前作业', 'answer_boot_blank_exhausted'],
    ['保存请求结果不确定，已停止当前作业', 'save_uncertain'],
    ['保存响应未通过 HTTP 与业务校验', 'save_response_rejected'],
    ['作答记录接口为空但页面无明确空态', 'history_api_empty'],
    ['交卷后未出现新的有效作答记录，分数不确定', 'history_new_record_missing'],
    ['最终交卷响应未通过 HTTP 与业务校验', 'finish_response_rejected'],
    ['等待交卷成功页面证据 5 秒', 'finish_success_wait'],
    ['目标作业卡已变化，禁止按旧位置点击', 'homework_card_changed'],
    ['选项选中状态与目标不一致', 'option_state_mismatch'],
    ['答题卡漏题，回跳补答 · 多选题#10', 'answer_card_repair_started'],
    ['答题卡中找不到漏题题号', 'answer_card_repair_target_missing'],
    ['答题卡跳转后未到达目标题：多选题#10', 'answer_card_jump_target_missing'],
    ['未知业务原文', 'operation_failed'],
  ])
  for (const [raw, expected] of cases) {
    assert.equal(safeDiagnosticCode(raw), expected)
  }
})

test('T005-RP-10a needs-user diagnostics preserve the precise safe failure code', () => {
  const student = {
    phase: 'needs_user',
    account: 'needs_verify',
    slot: 'occupied',
    action: '交卷响应成功，但成功提示或按钮禁用证据不完整',
    logs: ['交卷响应成功，但成功提示或按钮禁用证据不完整'],
  }
  const diagnostics = t005Harness.diagnosticsForStudent('NOQR-01', student)
  assert.equal(diagnostics.lastAction, 'finish_success_evidence_missing')
  const debug = t005Harness.debugDiagnosticsForStudent('NOQR-01', student)
  assert.equal(debug.lastActionCode, 'finish_success_evidence_missing')
  assert.deepEqual(debug.logCodes, ['finish_success_evidence_missing'])
})

test('T005-RP-10b a reached target wins over a simultaneous terminal snapshot', () => {
  const base = {
    terminalCode: 'product_round_ended',
    terminalEnded: true,
    terminalNeedsAttention: false,
    allowTerminal: false,
  }
  assert.equal(shouldFailTerminalBeforeTarget({ ...base, targetReached: true }), false)
  assert.equal(shouldFailTerminalBeforeTarget({
    ...base,
    terminalCode: 'product_not_full',
    targetReached: true,
  }), true)
  assert.equal(shouldFailTerminalBeforeTarget({ ...base, targetReached: false }), true)
  assert.equal(shouldFailTerminalBeforeTarget({
    ...base,
    terminalNeedsAttention: true,
    targetReached: false,
  }), true)
  assert.equal(shouldFailTerminalBeforeTarget({
    ...base,
    allowTerminal: true,
    targetReached: false,
  }), false)
  assert.equal(shouldFailTerminalBeforeTarget({
    ...base,
    terminalCode: 'product_needs_user',
    terminalNeedsAttention: true,
    allowTerminal: true,
    targetReached: false,
  }), true)
  assert.equal(shouldFailTerminalBeforeTarget({
    ...base,
    terminalCode: 'product_stopped',
    allowTerminal: true,
    allowExplicitStop: true,
    targetReached: false,
  }), false)
  assert.equal(shouldFailTerminalBeforeTarget({
    ...base,
    terminalCode: 'product_stopped',
    allowTerminal: true,
    targetReached: false,
  }), true)
  assert.equal(shouldFailTerminalBeforeTarget({
    ...base,
    terminalCode: null,
    targetReached: false,
  }), false)
})

test('T005-RP-11 save request ledger binds safe question fingerprints to request sequences', () => {
  const privateBigId = 'private-big-question-id'
  const privateQuestionId = 'private-question-id'
  const privateBody = 'private-request-body'
  const firstFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: privateBigId, questionId: privateQuestionId },
  ])
  const reorderedFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { questionId: privateQuestionId, bigQuestionId: privateBigId },
  ])
  const secondFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-2', questionId: 'private-question-id-2' },
  ])

  assert.match(firstFingerprint, /^[0-9a-f]{64}$/)
  assert.equal(reorderedFingerprint, firstFingerprint)
  assert.notEqual(secondFingerprint, firstFingerprint)

  const summary = t005Harness.analyzeNoqrSaveRequestLedger([
    {
      requestId: 'submit_one:1:2',
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 2,
      sequence: 2,
      monitorOffsetMs: 2_000,
      questionFingerprint: secondFingerprint,
      outcome: 'accepted',
      rawQuestionId: privateQuestionId,
      requestBody: privateBody,
      account: NORMAL_USER,
    },
    {
      requestId: 'submit_one:1:1',
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 1,
      sequence: 1,
      monitorOffsetMs: 1_000,
      questionFingerprint: firstFingerprint,
      attemptFingerprint: null,
      outcome: 'accepted',
      rawQuestionId: privateBigId,
      requestBody: privateBody,
      account: NORMAL_USER,
    },
  ])

  assert.deepEqual(summary.requests, [
    {
      requestId: 'submit_one:1:1',
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 1,
      sequence: 1,
      monitorOffsetMs: 1_000,
      questionFingerprint: firstFingerprint,
      attemptFingerprint: null,
      outcome: 'accepted',
    },
    {
      requestId: 'submit_one:1:2',
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 2,
      sequence: 2,
      monitorOffsetMs: 2_000,
      questionFingerprint: secondFingerprint,
      attemptFingerprint: null,
      outcome: 'accepted',
    },
  ])
  assert.equal(summary.requestCount, 2)
  assert.equal(summary.associatedCount, 2)
  assert.equal(summary.unassociatedCount, 0)
  assert.equal(summary.acceptedCount, 2)
  assert.equal(summary.uniqueQuestionCount, 2)
  assert.equal(summary.duplicateQuestionRequestCount, 0)
  assert.equal(summary.hardFailure, false)
  assert.equal(summary.failureCode, '')

  const serialized = JSON.stringify(summary)
  for (const privateText of [privateBigId, privateQuestionId, privateBody, NORMAL_USER]) {
    assert.equal(serialized.includes(privateText), false)
  }
})

test('T005-RP-12 a repeated save question fingerprint is a hard request-level failure', () => {
  const fingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id', questionId: 'private-question-id' },
  ])
  const summary = t005Harness.analyzeNoqrSaveRequestLedger([
    {
      requestId: 'submit_one:1:1',
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 1,
      sequence: 1,
      monitorOffsetMs: 1_000,
      questionFingerprint: fingerprint,
      outcome: 'accepted',
    },
    {
      requestId: 'submit_one:1:2',
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 2,
      sequence: 2,
      monitorOffsetMs: 2_000,
      questionFingerprint: fingerprint,
      outcome: 'accepted',
    },
  ])

  assert.equal(summary.duplicateQuestionRequestCount, 1)
  assert.deepEqual(summary.duplicateAssociations, [{
    questionFingerprint: fingerprint,
    firstRequestId: 'submit_one:1:1',
    repeatedRequestId: 'submit_one:1:2',
  }])
  assert.equal(summary.hardFailure, true)
  assert.equal(summary.failureCode, 'duplicate_save_question_request')
})

test('T005-RP-12b only a final accepted duplicate after one click per question is site-generated', () => {
  const firstFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-1', questionId: 'private-question-id-1' },
  ])
  const finalFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-2', questionId: 'private-question-id-2' },
  ])
  const entry = (sequence, fingerprint, outcome = 'accepted') => ({
    requestId: `submit_one:1:${sequence}`,
    kind: 'submit_one',
    contextSequence: 1,
    pageSequence: 1,
    pageRequestSequence: sequence,
    sequence,
    monitorOffsetMs: sequence * 1_000,
    questionFingerprint: fingerprint,
    attemptFingerprint: 'd'.repeat(64),
    outcome,
  })
  const audit = t005Harness.analyzeNoqrSaveRequestLedger([
    entry(1, firstFingerprint),
    entry(2, finalFingerprint),
    entry(3, finalFingerprint),
  ])

  assert.equal(isSiteGeneratedFinalDuplicate(audit, 2, 0), true)
  assert.equal(isSiteGeneratedFinalDuplicate(audit, 3, 1), false)
  assert.equal(isSiteGeneratedFinalDuplicate(audit, 3, 0), false)
  assert.equal(isSiteGeneratedFinalDuplicate({
    ...audit,
    requests: [entry(1, finalFingerprint), audit.requests[1], entry(3, firstFingerprint)],
  }, 2, 0), false)
})

test('T005-RP-12c duplicate question scope includes answer attempt', () => {
  const fingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id', questionId: 'private-question-id' },
  ])
  const entry = (sequence: number, attemptFingerprint: string) => ({
    kind: 'submit_one',
    contextSequence: 1,
    pageSequence: 1,
    pageRequestSequence: sequence,
    sequence,
    monitorOffsetMs: sequence * 3_000,
    questionFingerprint: fingerprint,
    attemptFingerprint,
    outcome: 'accepted',
  })
  const summary = t005Harness.analyzeNoqrSaveRequestLedger([
    entry(1, 'a'.repeat(64)),
    entry(2, 'b'.repeat(64)),
  ])
  assert.equal(summary.uniqueQuestionCount, 2)
  assert.equal(summary.duplicateQuestionRequestCount, 0)
  assert.equal(summary.hardFailure, false)
})

test('T005-RP-12e low-score retry rounds may reuse question IDs without a duplicate failure', () => {
  const firstQuestion = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-1', questionId: 'private-question-id-1' },
  ])
  const secondQuestion = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-2', questionId: 'private-question-id-2' },
  ])
  const entry = (
    sequence: number,
    questionFingerprint: string,
    attemptFingerprint: string,
  ) => ({
    kind: 'submit_one',
    contextSequence: 1,
    pageSequence: 1,
    pageRequestSequence: sequence,
    sequence,
    monitorOffsetMs: sequence * 3_000,
    questionFingerprint,
    attemptFingerprint,
    outcome: 'accepted',
  })
  const roundOne = 'a'.repeat(64)
  const roundTwo = 'b'.repeat(64)
  const summary = t005Harness.analyzeNoqrSaveRequestLedger([
    entry(1, firstQuestion, roundOne),
    entry(2, secondQuestion, roundOne),
    entry(3, firstQuestion, roundTwo),
    entry(4, secondQuestion, roundTwo),
  ])

  assert.equal(summary.requestCount, 4)
  assert.equal(summary.uniqueQuestionCount, 4)
  assert.equal(summary.duplicateQuestionRequestCount, 0)
  assert.equal(summary.hardFailure, false)
})

test('T005-RP-12f each scored attempt may have one site-final duplicate', () => {
  const firstQuestion = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-1', questionId: 'private-question-id-1' },
  ])
  const finalQuestion = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-2', questionId: 'private-question-id-2' },
  ])
  let sequence = 0
  const entries = ['a', 'b', 'c'].flatMap((attempt) => [
    [firstQuestion, attempt],
    [finalQuestion, attempt],
    [finalQuestion, attempt],
  ].map(([fingerprint, scopedAttempt], index) => ({
    kind: index === 0 ? 'submit_one' : 'submit_all',
    contextSequence: 1,
    pageSequence: 1,
    pageRequestSequence: ++sequence,
    sequence,
    monitorOffsetMs: sequence * 3_000,
    questionFingerprint: fingerprint,
    attemptFingerprint: String(scopedAttempt).repeat(64),
    outcome: 'accepted',
  })))
  const audit = t005Harness.analyzeNoqrSaveRequestLedger(entries)

  assert.equal(audit.uniqueQuestionCount, 6)
  assert.equal(audit.duplicateQuestionRequestCount, 3)
  assert.equal(isSiteGeneratedFinalDuplicate(audit, 6, 0), true)
  assert.equal(isSiteGeneratedFinalDuplicate(audit, 6, 1), false)
  assert.equal(isSiteGeneratedFinalDuplicate(audit, 7, 0), false)

  const repeatedWithinAttempt = [...entries]
  repeatedWithinAttempt[1] = {
    ...repeatedWithinAttempt[1],
    kind: 'submit_all',
    questionFingerprint: firstQuestion,
  }
  const invalid = t005Harness.analyzeNoqrSaveRequestLedger(repeatedWithinAttempt)
  assert.equal(isSiteGeneratedFinalDuplicate(invalid, 6, 0), false)

  const crossKind = [...entries]
  crossKind[8] = { ...crossKind[8], kind: 'submit_one' }
  const crossKindAudit = t005Harness.analyzeNoqrSaveRequestLedger(crossKind)
  assert.equal(isSiteGeneratedFinalDuplicate(crossKindAudit, 6, 0), false)
})

test('T005-RP-12d site-final duplicate uses real request time, not page sort order', () => {
  const firstFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-1', questionId: 'private-question-id-1' },
  ])
  const finalFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-2', questionId: 'private-question-id-2' },
  ])
  const attemptFingerprint = 'c'.repeat(64)
  const entry = (sequence: number, pageSequence: number, fingerprint: string, offsetMs: number) => ({
    kind: 'submit_one',
    contextSequence: 1,
    pageSequence,
    pageRequestSequence: sequence,
    sequence,
    monitorOffsetMs: offsetMs,
    questionFingerprint: fingerprint,
    attemptFingerprint,
    outcome: 'accepted',
  })
  const audit = t005Harness.analyzeNoqrSaveRequestLedger([
    entry(1, 2, firstFingerprint, 1_000),
    entry(2, 2, firstFingerprint, 2_000),
    entry(3, 1, finalFingerprint, 4_000),
  ])

  assert.equal(isSiteGeneratedFinalDuplicate(audit, 2, 0), false)
})

test('T005-RP-13 accepted save requests without a safe question fingerprint fail closed', () => {
  const summary = t005Harness.analyzeNoqrSaveRequestLedger([
    {
      requestId: 'submit_one:1:1',
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 1,
      sequence: 1,
      monitorOffsetMs: 1_000,
      questionFingerprint: null,
      outcome: 'accepted',
    },
  ])

  assert.equal(summary.unassociatedCount, 1)
  assert.equal(summary.hardFailure, true)
  assert.equal(summary.failureCode, 'save_question_association_missing')
})

test('T005-RP-14 passive monitor exposes only safe request-ledger fields and enforces duplicates', () => {
  const source = readFileSync(join(PROJECT_ROOT, 'tests/t005-real-product.mjs'), 'utf8')
  assert.match(source, /mutationRequestLedger/)
  assert.match(source, /requestId/)
  assert.match(source, /questionFingerprint/)
  assert.match(source, /pageSequence/)
  assert.match(source, /pageRequestSequence/)
  assert.match(source, /monitorOffsetMs/)
  assert.match(source, /duplicate_save_question_request/)
  assert.match(source, /save_question_association_missing/)
})

test('T005-RP-15 save request ledger preserves safe context-page-time attribution and distributions', () => {
  const privateUrl = 'https://private.example.test/course/private-id?token=private'
  const privateBody = 'private-request-body'
  const privateQuestionText = 'private-question-text'
  const firstFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-1', questionId: 'private-question-id-1' },
  ])
  const secondFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-2', questionId: 'private-question-id-2' },
  ])
  const thirdFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-3', questionId: 'private-question-id-3' },
  ])
  const fourthFingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id-4', questionId: 'private-question-id-4' },
  ])
  const privateEntry = {
    requestUrl: privateUrl,
    pageUrl: privateUrl,
    requestBody: privateBody,
    rawQuestionId: 'private-question-id-1',
    account: NORMAL_USER,
    questionText: privateQuestionText,
  }

  const summary = t005Harness.analyzeNoqrSaveRequestLedger([
    {
      ...privateEntry,
      kind: 'submit_one',
      contextSequence: 2,
      pageSequence: 2,
      pageRequestSequence: 1,
      sequence: 4,
      monitorOffsetMs: 9_000,
      questionFingerprint: fourthFingerprint,
      outcome: 'accepted',
    },
    {
      ...privateEntry,
      kind: 'submit_all',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 2,
      sequence: 1,
      monitorOffsetMs: 3_000,
      questionFingerprint: secondFingerprint,
      outcome: 'accepted',
    },
    {
      ...privateEntry,
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 2,
      pageRequestSequence: 1,
      sequence: 2,
      monitorOffsetMs: 5_000,
      questionFingerprint: thirdFingerprint,
      outcome: 'accepted',
    },
    {
      ...privateEntry,
      kind: 'submit_one',
      contextSequence: 2,
      pageSequence: 1,
      pageRequestSequence: 1,
      sequence: 3,
      monitorOffsetMs: 8_000,
      questionFingerprint: firstFingerprint,
      outcome: 'accepted',
    },
    {
      ...privateEntry,
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 1,
      sequence: 1,
      monitorOffsetMs: 1_000,
      questionFingerprint: firstFingerprint,
      attemptFingerprint: null,
      outcome: 'accepted',
    },
  ])

  assert.deepEqual(summary.requests, [
    {
      requestId: 'submit_one:1:1',
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 1,
      sequence: 1,
      monitorOffsetMs: 1_000,
      questionFingerprint: firstFingerprint,
      attemptFingerprint: null,
      outcome: 'accepted',
    },
    {
      requestId: 'submit_all:1:1',
      kind: 'submit_all',
      contextSequence: 1,
      pageSequence: 1,
      pageRequestSequence: 2,
      sequence: 1,
      monitorOffsetMs: 3_000,
      questionFingerprint: secondFingerprint,
      attemptFingerprint: null,
      outcome: 'accepted',
    },
    {
      requestId: 'submit_one:1:2',
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 2,
      pageRequestSequence: 1,
      sequence: 2,
      monitorOffsetMs: 5_000,
      questionFingerprint: thirdFingerprint,
      attemptFingerprint: null,
      outcome: 'accepted',
    },
    {
      requestId: 'submit_one:2:3',
      kind: 'submit_one',
      contextSequence: 2,
      pageSequence: 1,
      pageRequestSequence: 1,
      sequence: 3,
      monitorOffsetMs: 8_000,
      questionFingerprint: firstFingerprint,
      attemptFingerprint: null,
      outcome: 'accepted',
    },
    {
      requestId: 'submit_one:2:4',
      kind: 'submit_one',
      contextSequence: 2,
      pageSequence: 2,
      pageRequestSequence: 1,
      sequence: 4,
      monitorOffsetMs: 9_000,
      questionFingerprint: fourthFingerprint,
      attemptFingerprint: null,
      outcome: 'accepted',
    },
  ])
  assert.deepEqual(summary.contextPageDistribution, [
    { contextSequence: 1, pageSequence: 1, requestCount: 2 },
    { contextSequence: 1, pageSequence: 2, requestCount: 1 },
    { contextSequence: 2, pageSequence: 1, requestCount: 1 },
    { contextSequence: 2, pageSequence: 2, requestCount: 1 },
  ])
  assert.deepEqual(summary.questionFingerprintDistribution, [
    { questionFingerprint: firstFingerprint, requestCount: 2 },
    { questionFingerprint: secondFingerprint, requestCount: 1 },
    { questionFingerprint: thirdFingerprint, requestCount: 1 },
    { questionFingerprint: fourthFingerprint, requestCount: 1 },
  ])
  assert.equal(summary.requestCount, 5)
  assert.equal(summary.uniqueQuestionCount, 5)
  assert.equal(summary.duplicateQuestionRequestCount, 0)
  assert.equal(summary.hardFailure, false)
  for (const request of summary.requests) {
    assert.equal(Number.isInteger(request.monitorOffsetMs), true)
  }

  const serialized = JSON.stringify(summary)
  for (const privateText of [
    privateUrl,
    privateBody,
    privateQuestionText,
    NORMAL_USER,
    'private-big-question-id-1',
    'private-question-id-1',
  ]) {
    assert.equal(serialized.includes(privateText), false)
  }
})

test('T005-RP-16 repeated fingerprints fail within one context across pages but not across contexts', () => {
  const fingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id', questionId: 'private-question-id' },
  ])
  const entry = (contextSequence: number, pageSequence: number, sequence: number, offsetMs: number) => ({
    kind: 'submit_one',
    contextSequence,
    pageSequence,
    pageRequestSequence: 1,
    sequence,
    monitorOffsetMs: offsetMs,
    questionFingerprint: fingerprint,
    outcome: 'accepted',
  })

  const sameContext = t005Harness.analyzeNoqrSaveRequestLedger([
    entry(1, 1, 1, 1_000),
    entry(1, 2, 2, 2_000),
  ])
  assert.equal(sameContext.duplicateQuestionRequestCount, 1)
  assert.deepEqual(sameContext.duplicateAssociations, [{
    questionFingerprint: fingerprint,
    firstRequestId: 'submit_one:1:1',
    repeatedRequestId: 'submit_one:1:2',
  }])
  assert.equal(sameContext.hardFailure, true)
  assert.equal(sameContext.failureCode, 'duplicate_save_question_request')

  const separateContexts = t005Harness.analyzeNoqrSaveRequestLedger([
    entry(1, 1, 1, 1_000),
    entry(2, 1, 2, 2_000),
  ])
  assert.equal(separateContexts.duplicateQuestionRequestCount, 0)
  assert.deepEqual(separateContexts.duplicateAssociations, [])
  assert.equal(separateContexts.hardFailure, false)
  assert.equal(separateContexts.failureCode, '')
})

test('T005-RP-17 save requests without complete page attribution fail closed', () => {
  const fingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id', questionId: 'private-question-id' },
  ])
  const summary = t005Harness.analyzeNoqrSaveRequestLedger([
    {
      kind: 'submit_one',
      contextSequence: 1,
      pageSequence: 0,
      pageRequestSequence: 1,
      sequence: 1,
      monitorOffsetMs: 1_000,
      questionFingerprint: fingerprint,
      outcome: 'accepted',
    },
  ])

  assert.equal(summary.requestCount, 0)
  assert.equal(summary.pageAttributionMissingCount, 1)
  assert.equal(summary.hardFailure, true)
  assert.equal(summary.failureCode, 'save_page_attribution_missing')
})

test('T005-RP-18 passive network summary preserves safe attribution and strips request details', async () => {
  const privateUrl = 'https://private.example.test/course/private-id?token=private'
  const privateBody = 'private-request-body'
  const privateAccount = NORMAL_USER
  const privateQuestionText = 'private-question-text'
  const fingerprint = t005Harness.noqrQuestionIdFingerprint([
    { bigQuestionId: 'private-big-question-id', questionId: 'private-question-id' },
  ])
  const state = {
    browserContexts: 1,
    browserExecutable: 'bundled',
    mutationRequests: { submit_one: 1, submit_all: 0, finish: 0 },
    mutationAccepted: { submit_one: 1, submit_all: 0, finish: 0 },
    mutationRequestLedger: {
      submit_one: [{
        requestId: 'submit_one:1:1',
        kind: 'submit_one',
        contextSequence: 1,
        pageSequence: 2,
        pageRequestSequence: 3,
        sequence: 1,
        monitorOffsetMs: 4_000,
        questionFingerprint: fingerprint,
        outcome: 'accepted',
        requestUrl: privateUrl,
        pageUrl: privateUrl,
        requestBody: privateBody,
        account: privateAccount,
        questionText: privateQuestionText,
      }],
      submit_all: [],
      finish: [],
    },
    mutationDuplicateBodyRequests: { submit_one: 0, submit_all: 0, finish: 0 },
    mutationMaxDurationMs: { submit_one: 0, submit_all: 0, finish: 0 },
  }
  const fakeApp = {
    async evaluate(callback: (electronApi: unknown, payload: { key: string }) => unknown,
      payload: { key: string }) {
      globalThis[payload.key] = state
      try {
        return await callback(null, payload)
      } finally {
        delete globalThis[payload.key]
      }
    },
  }

  const summary = await t005Harness.readPassiveNetworkSummary(fakeApp)
  assert.deepEqual(summary.mutationRequestLedger.submit_one, [{
    requestId: 'submit_one:1:1',
    kind: 'submit_one',
    contextSequence: 1,
    pageSequence: 2,
    pageRequestSequence: 3,
    sequence: 1,
    monitorOffsetMs: 4_000,
    questionFingerprint: fingerprint,
    attemptFingerprint: null,
    outcome: 'accepted',
  }])
  const serialized = JSON.stringify(summary)
  for (const privateText of [
    privateUrl,
    privateBody,
    privateAccount,
    privateQuestionText,
    'private-big-question-id',
    'private-question-id',
  ]) {
    assert.equal(serialized.includes(privateText), false)
  }
})

test('T005-RP-19 score network gate requires exactly one accepted Finish and no pending mutation', () => {
  const acceptedLedgerEntry = (kind: string) => ({ kind, outcome: 'accepted' })
  const network = (overrides: Record<string, unknown> = {}) => ({
    mutationRequests: { submit_one: 1, submit_all: 0, finish: 1 },
    mutationAccepted: { submit_one: 1, submit_all: 0, finish: 1 },
    mutationFailures: 0,
    mutationUncertain: 0,
    mutationDuplicateBodyRequests: { submit_one: 0, submit_all: 0, finish: 0 },
    mutationRequestLedger: {
      submit_one: [acceptedLedgerEntry('submit_one')],
      submit_all: [],
      finish: [acceptedLedgerEntry('finish')],
    },
    ...overrides,
  })

  assert.equal(noqrScoreNetworkFailure(network(), false), null)
  assert.equal(noqrScoreNetworkFailure(network({
    mutationRequests: { submit_one: 1, submit_all: 0, finish: 2 },
    mutationAccepted: { submit_one: 1, submit_all: 0, finish: 2 },
    mutationRequestLedger: {
      submit_one: [acceptedLedgerEntry('submit_one')],
      submit_all: [],
      finish: [acceptedLedgerEntry('finish'), acceptedLedgerEntry('finish')],
    },
  }), false), 'finish_request_count_mismatch')
  assert.equal(noqrScoreNetworkFailure(network({
    mutationDuplicateBodyRequests: { submit_one: 0, submit_all: 0, finish: 1 },
  }), false), 'duplicate_finish_request')
  assert.equal(noqrScoreNetworkFailure(network({
    mutationRequestLedger: {
      submit_one: [acceptedLedgerEntry('submit_one')],
      submit_all: [],
      finish: [{ kind: 'finish', outcome: 'pending' }],
    },
  }), false), 'mutation_request_pending')
  assert.equal(noqrScoreNetworkFailure(network({
    mutationRequestLedger: {
      submit_one: [],
      submit_all: [],
      finish: [acceptedLedgerEntry('finish')],
    },
  }), false), 'mutation_request_ledger_incomplete')
  assert.equal(noqrScoreNetworkFailure(network({
    mutationDuplicateBodyRequests: { submit_one: 0, submit_all: 1, finish: 0 },
  }), false), 'duplicate_save_request')
  const siteFinalCompositeDuplicate = network({
    mutationRequests: { submit_one: 0, submit_all: 2, finish: 1 },
    mutationAccepted: { submit_one: 0, submit_all: 2, finish: 1 },
    mutationDuplicateBodyRequests: { submit_one: 0, submit_all: 1, finish: 0 },
    mutationRequestLedger: {
      submit_one: [],
      submit_all: [acceptedLedgerEntry('submit_all'), acceptedLedgerEntry('submit_all')],
      finish: [acceptedLedgerEntry('finish')],
    },
  })
  assert.equal(noqrScoreNetworkFailure(siteFinalCompositeDuplicate, false), 'duplicate_save_request')
  assert.equal(noqrScoreNetworkFailure(siteFinalCompositeDuplicate, true), null)
})

test('T005-RP-19b score network gate can verify the expected reanswer round count', () => {
  const acceptedLedgerEntry = (kind: string) => ({ kind, outcome: 'accepted' })
  const twoRounds = {
    mutationRequests: { submit_one: 2, submit_all: 0, finish: 2 },
    mutationAccepted: { submit_one: 2, submit_all: 0, finish: 2 },
    mutationFailures: 0,
    mutationUncertain: 0,
    mutationDuplicateBodyRequests: { submit_one: 0, submit_all: 0, finish: 0 },
    mutationRequestLedger: {
      submit_one: [acceptedLedgerEntry('submit_one'), acceptedLedgerEntry('submit_one')],
      submit_all: [],
      finish: [acceptedLedgerEntry('finish'), acceptedLedgerEntry('finish')],
    },
  }

  assert.equal(noqrScoreNetworkFailure(twoRounds, false, 2), null)
  assert.equal(noqrScoreNetworkFailure(twoRounds, false), 'finish_request_count_mismatch')
  assert.equal(t005Harness.expectedNoqrScoreFinishRequests({
    stopAfterScoreRound: 2,
  }, {
    scoreRoundHistory: [
      { homeworkIndex: 0, attempt: 1, score: 100 },
      { homeworkIndex: 1, attempt: 1, score: 91 },
      { homeworkIndex: 1, attempt: 2, score: 91 },
    ],
  }), 3)
  assert.equal(t005Harness.expectedNoqrScoreFinishRequests({
    stopAfterScoreRound: 2,
  }, { scoreRoundHistory: [] }), 2)
})

test('T005-RP-21 score-round evidence reaches the second scored attempt without raw identity', () => {
  const student = {
    courses: [{
      name: 'private-course-name',
      groups: [{
        rows: [
          { name: 'private-homework-a', attempt: 1, score: 91 },
          { name: 'private-homework-b', attempt: 2, score: 100 },
          { name: 'private-homework-c', attempt: 3, score: null },
        ],
      }],
    }],
  }

  assert.equal(t005Harness.noqrScoreRoundReached(student, 1), true)
  assert.equal(t005Harness.noqrScoreRoundReached(student, 2), true)
  assert.equal(t005Harness.noqrScoreRoundReached(student, 3), false)
  assert.deepEqual(t005Harness.noqrScoreRoundEvidence(student), [
    { homeworkIndex: 0, attempt: 1, score: 91 },
    { homeworkIndex: 1, attempt: 2, score: 100 },
  ])
  assert.equal(JSON.stringify(t005Harness.noqrScoreRoundEvidence(student)).includes('private-'), false)
})

test('T005-RP-21b score stop counts cumulative score events across homework attempts', () => {
  const history = [
    { alias: 'NOQR-EN', homeworkIndex: 0, attempt: 1, score: 100 },
    { alias: 'NOQR-EN', homeworkIndex: 1, attempt: 1, score: 91 },
    { alias: 'NOQR-EN', homeworkIndex: 1, attempt: 2, score: 91 },
  ]

  assert.equal(t005Harness.noqrScoreHistoryReached(history, ['NOQR-EN'], 1), true)
  assert.equal(t005Harness.noqrScoreHistoryReached(history, ['NOQR-EN'], 2), true)
  assert.equal(t005Harness.noqrScoreHistoryReached(history, ['NOQR-EN'], 3), true)
  assert.equal(t005Harness.noqrScoreHistoryReached(history, ['NOQR-EN'], 4), false)
  assert.equal(t005Harness.noqrScoreHistoryReached(history, ['NOQR-EN', 'NOQR-EN-02'], 3), false)
})

test('T005-RP-22 display evidence survives terminal release and counts only occupied browsers', () => {
  const evidence = new Map<string, Set<boolean>>()
  assert.equal(recordDisplayEvidence(evidence, 'NOQR-EN', {
    slot: 'queued',
    browserWindowVisible: null,
  }), false)
  assert.equal(recordDisplayEvidence(evidence, 'NOQR-EN', {
    slot: 'occupied',
    browserWindowVisible: false,
  }), true)
  assert.equal(recordDisplayEvidence(evidence, 'NOQR-EN', {
    slot: 'released',
    browserWindowVisible: null,
  }), false)
  assert.equal(displayEvidenceCount(evidence, ['NOQR-EN'], false), 1)
  assert.equal(displayEvidenceCount(evidence, ['NOQR-EN'], true), 0)

  const concurrent = new Map<string, Set<boolean>>()
  recordDisplayEvidence(concurrent, 'NOQR-01', {
    slot: 'occupied',
    browserWindowVisible: false,
  })
  recordDisplayEvidence(concurrent, 'NOQR-02', {
    slot: 'occupied',
    browserWindowVisible: false,
  })
  recordDisplayEvidence(concurrent, 'NOQR-03', {
    slot: 'queued',
    browserWindowVisible: null,
  })
  assert.equal(displayEvidenceCount(concurrent, ['NOQR-01', 'NOQR-02', 'NOQR-03'], false), 2)
  assert.equal(displayEvidenceCount(concurrent, ['NOQR-01'], true), 0)
})

test('T005-RP-20 pacing audit tolerates one fast gap after a slow phase but rejects sustained bursts', () => {
  const scope = {
    kind: 'submit_one',
    contextSequence: 1,
    pageSequence: 1,
    attemptFingerprint: 'a'.repeat(64),
  }
  const entry = (sequence: number, monitorOffsetMs: number) => ({
    ...scope,
    pageRequestSequence: sequence,
    sequence,
    monitorOffsetMs,
    questionFingerprint: sequence.toString(16).padStart(64, '0'),
    outcome: 'accepted',
  })

  assert.equal(noqrPacingViolationCount([
    entry(1, 1_000),
    entry(2, 3_000),
    entry(3, 6_000),
  ], 2_500), 0)
  assert.equal(noqrPacingViolationCount([
    entry(1, 1_000),
    entry(2, 4_000),
    entry(3, 6_000),
  ], 2_500), 0)
  assert.equal(noqrPacingViolationCount([
    entry(1, 1_000),
    entry(2, 4_000),
    entry(3, 6_000),
    entry(4, 8_000),
  ], 2_500), 1)
  assert.equal(noqrPacingViolationCount([
    entry(1, 1_000),
    entry(2, 2_000),
    entry(3, 4_000),
  ], 2_500), 2)
  assert.equal(noqrPacingViolationCount([
    entry(1, 1_000),
    entry(2, 4_000),
    { ...entry(3, 2_000), contextSequence: 2, pageSequence: 1 },
    { ...entry(4, 5_000), contextSequence: 2, pageSequence: 1 },
    { ...entry(5, 8_000), contextSequence: 2, pageSequence: 1 },
  ], 2_500), 0)
})
