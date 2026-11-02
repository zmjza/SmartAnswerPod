import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'patchright'
import { PUBLIC_SUPABASE_ANON, PUBLIC_SUPABASE_URL } from '../electron/core/public-config.ts'
import {
  T005_DEFAULT_GOAL_FILE,
  T005CredentialError,
  readT005Credentials,
  selectT005Account,
  summarizeT005Credentials,
} from './helpers/t005-credentials.mjs'

const MODULE_FILE = fileURLToPath(import.meta.url)
const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PROFILE_ROOT = join(PROJECT_ROOT, '.playwright')
const MONITOR_KEY = '__t005RealProductMonitor'
const BANK_ANON = ['fixture', 'bank', 'readonly'].join('-')
const IS_MAIN = Boolean(process.argv[1]) && resolve(process.argv[1]) === MODULE_FILE

export const SUPPORTED_TEST_PHASES = Object.freeze([
  'login',
  'courses',
  'answer',
  'score',
  'stop',
  'concurrency',
])
export const SUPPORTED_DISPLAY_MODES = Object.freeze(['headless', 'visual'])
export const SUPPORTED_COURSE_SCOPES = Object.freeze(['selected', 'all'])
export const OBSERVED_ANSWER_WORK_TYPES = Object.freeze(['onlineWork', 'stageExam'])
export const SAFE_QUESTION_KINDS = Object.freeze([
  'single',
  'multiple',
  'judge',
  'english_grammar',
  'english_listening',
  'picker',
  'english_cloze',
  'english_reading',
])
export const REQUIRED_ENGLISH_QUESTION_KINDS = Object.freeze([
  'english_grammar',
  'english_listening',
  'picker',
  'english_cloze',
  'english_reading',
])
export const REQUIRED_NORMAL_QUESTION_KINDS = Object.freeze(['single', 'multiple', 'judge'])
export const REQUIRED_ENGLISH_QUESTION_SLOTS = Object.freeze({
  english_grammar: 10,
  english_listening: 5,
  picker: 10,
  english_cloze: 10,
  english_reading: 10,
})

const LOGIN_SUCCESS_PHASES = new Set([
  'home',
  'scanning_courses',
  'waiting_course_selection',
  'detecting',
  'opening_homework',
  'answer_boot',
  'answering',
  'waiting_save',
  'awaiting_advance',
  'submitting',
  'waiting_score',
  'retry_wait',
  'completed',
  'not_full',
])
const ACTIVE_BROWSER_PHASES = new Set([
  'launching_browser',
  'login_page',
  'logging_in',
  'home',
  'scanning_courses',
  'waiting_course_selection',
  'detecting',
  'opening_homework',
  'answer_boot',
  'answering',
  'waiting_save',
  'awaiting_advance',
  'submitting',
  'waiting_score',
  'retry_wait',
])
const CAPACITY_HOLDING_SLOTS = new Set(['launching', 'occupied', 'occupying_verify'])

export function recordDisplayEvidence(evidence, alias, student) {
  if (!(evidence instanceof Map) || !alias || student?.slot !== 'occupied') return false
  if (typeof student.browserWindowVisible !== 'boolean') return false
  const observed = evidence.get(alias) || new Set()
  observed.add(student.browserWindowVisible)
  evidence.set(alias, observed)
  return true
}

export function displayEvidenceCount(evidence, aliases, expectedVisible) {
  const expected = Boolean(expectedVisible)
  return (Array.isArray(aliases) ? aliases : [])
    .filter((alias) => evidence?.get(alias)?.has(expected))
    .length
}

export class T005HarnessError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'T005HarnessError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new T005HarnessError(code, message, details)
}

function normalizeEnum(value, allowed, fallback, code) {
  const normalized = String(value || fallback).trim().toLowerCase()
  if (!allowed.includes(normalized)) fail(code, 'Unsupported T005 real-product option')
  return normalized
}

function normalizeAccountParallel(value, phase) {
  if (phase !== 'concurrency') return 1
  if (value === undefined || value === null || String(value).trim() === '') return 2
  const configured = Number(value)
  if (!Number.isFinite(configured)) return 2
  return Math.min(8, Math.max(1, Math.trunc(configured)))
}

function normalizeBoolean(value, fallback, code) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const normalized = String(value).trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  if (normalized === '0' || normalized === 'false') return false
  fail(code, 'Unsupported boolean test option')
}

function normalizeStopAfterScoreRound(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const round = Number(value)
  if (!Number.isInteger(round) || round < 1 || round > 10) {
    fail('invalid_stop_after_score_round', 'Score stop round must be an integer from 1 to 10')
  }
  return round
}

function normalizeAliasList(value, phase, credentials, minimumAliases = 1) {
  const requested = String(value || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
  const aliases = requested.length
    ? requested
    : credentials.accounts.slice(0, minimumAliases).map((account) => account.alias)

  if (phase === 'concurrency' && aliases.length < minimumAliases) {
    fail(
      'concurrency_aliases_missing',
      `Concurrency phase requires at least ${minimumAliases} distinct account aliases`,
    )
  }
  if (phase !== 'concurrency' && aliases.length > 1) {
    fail('invalid_alias_list', 'Only the concurrency phase accepts multiple aliases')
  }
  if (new Set(aliases).size !== aliases.length) {
    fail('invalid_alias_list', 'Alias list contains duplicates')
  }

  return aliases.map((alias) => {
    try {
      const account = selectT005Account(credentials, alias)
      return {
        alias: account.alias,
        kind: account.kind,
        username: account.username,
        password: account.password,
      }
    } catch (error) {
      if (error instanceof T005CredentialError) fail(error.code, 'Requested account alias is unavailable')
      fail('account_not_found', 'Requested account alias is unavailable')
    }
  })
}

export function normalizeHarnessConfig(env = process.env, credentials) {
  const phase = normalizeEnum(env.KAIDA_T005_PHASE, SUPPORTED_TEST_PHASES, 'login', 'invalid_phase')
  const displayMode = normalizeEnum(
    env.KAIDA_DISPLAY_MODE,
    SUPPORTED_DISPLAY_MODES,
    'headless',
    'invalid_display_mode',
  )
  const courseScope = normalizeEnum(
    env.KAIDA_COURSE_SCOPE,
    SUPPORTED_COURSE_SCOPES,
    'selected',
    'invalid_course_scope',
  )
  const courseStrategy = normalizeEnum(
    env.KAIDA_T005_COURSE_STRATEGY,
    ['min-todo', 'max-todo'],
    'min-todo',
    'invalid_course_strategy',
  )
  const courseIndex = Math.max(0, Math.floor(Number(env.KAIDA_T005_COURSE_INDEX) || 0))
  const courseMatch = String(env.KAIDA_T005_COURSE_MATCH || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const accountParallel = normalizeAccountParallel(env.KAIDA_T005_ACCOUNT_PARALLEL, phase)
  const accounts = normalizeAliasList(
    env.KAIDA_TEST_ALIAS,
    phase,
    credentials,
    phase === 'concurrency' ? accountParallel + 1 : 1,
  )
  const bankSource = normalizeEnum(
    env.KAIDA_T005_BANK_SOURCE,
    ['empty', 'installed'],
    'empty',
    'invalid_bank_source',
  )
  const configuredMaxRuntime = Number(env.KAIDA_T005_MAX_RUNTIME_MS)
  const maxRuntimeMs = Number.isFinite(configuredMaxRuntime) && configuredMaxRuntime > 0
    ? Math.max(30_000, configuredMaxRuntime)
    : Number.POSITIVE_INFINITY
  const answerRoundLimit = Math.min(10, Math.max(1, Number(env.KAIDA_ANSWER_ROUND_LIMIT) || 10))
  const explicitScoreStopRound = normalizeStopAfterScoreRound(env.KAIDA_T005_STOP_AFTER_SCORE_ROUND)

  return {
    phase,
    displayMode,
    courseScope,
    courseStrategy,
    courseIndex,
    courseMatch,
    bankSource,
    accounts,
    accountParallel,
    courseParallel: Math.min(8, Math.max(1, Number(env.KAIDA_T005_COURSE_PARALLEL) || 2)),
    answerRoundLimit,
    logEnabled: normalizeBoolean(env.KAIDA_T005_LOG_ENABLED, true, 'invalid_log_enabled'),
    forceRetry: normalizeBoolean(env.KAIDA_T005_FORCE_RETRY, false, 'invalid_force_retry'),
    stopAfterScoreRound: explicitScoreStopRound ??
      (env.KAIDA_T005_STOP_AFTER_FIRST_SCORE === '1' ? 1 : null),
    requireNormalKinds: normalizeBoolean(
      env.KAIDA_T005_REQUIRE_NORMAL_KINDS,
      true,
      'invalid_require_normal_kinds',
    ),
    maxRuntimeMs,
  }
}

export function buildProductChildEnv(baseEnv, userDataDir, opts = {}) {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'DISPLAY',
    'XDG_CONFIG_HOME',
    'PLAYWRIGHT_BROWSERS_PATH',
  ]
  const env = {}
  for (const key of allowed) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key]
  }
  env.VITE_DEV_SERVER_URL = ''
  env.KAIDA_E2E_USERDATA = userDataDir
  if (opts.forceRetry === true) env.KAIDA_T005_FORCE_RETRY = '1'
  for (const key of [
    'KAIDA_E2E_ENV',
    'KAIDA_ACCOUNTS_JSON',
    'KAIDA_AUTO_DETECT',
    'KAIDA_E2E_STORE',
    'KAIDA_E2E_STORE_OUT',
    'KAIDA_E2E_STORE_ROUND',
    'KAIDA_E2E_SCHOOL_ORIGIN',
    'KAIDA_E2E_KEEP_BROWSERS',
    'KAIDA_E2E_TILE_BROWSERS',
    'KAIDA_E2E_MOCK_ACTIVE_COURSE',
    'KAIDA_E2E_MOCK_COURSES',
    'KAIDA_SUPABASE_URL',
    'KAIDA_SUPABASE_ANON',
    'KAIDA_SILICONFLOW_KEY',
    'KAIDA_EXCEL_PATH',
  ]) {
    env[key] = ''
  }
  return env
}

export async function createGetOnlyBankService(upstream = null) {
  const counts = { GET: 0, POST: 0, PATCH: 0, DELETE: 0, OTHER: 0 }
  const server = createServer(async (request, response) => {
    const method = String(request.method || 'GET').toUpperCase()
    if (Object.prototype.hasOwnProperty.call(counts, method)) counts[method]++
    else counts.OTHER++

    if (method !== 'GET') {
      response.writeHead(405, {
        'content-type': 'application/json; charset=utf-8',
        allow: 'GET',
      })
      response.end(JSON.stringify({ error: 'read_only' }))
      return
    }

    const pathname = (() => {
      try { return new URL(request.url || '/', 'http://127.0.0.1').pathname } catch { return '' }
    })()
    if (pathname !== '/rest/v1/questions') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'not_found' }))
      return
    }
    if (upstream) {
      try {
        const target = new URL(request.url || '/rest/v1/questions', upstream.base)
        const forwarded = await fetch(target, {
          method: 'GET',
          headers: {
            apikey: upstream.anon,
            Authorization: `Bearer ${upstream.anon}`,
            Accept: 'application/json',
          },
        })
        const payload = await forwarded.text()
        response.writeHead(forwarded.status, {
          'content-type': forwarded.headers.get('content-type') || 'application/json; charset=utf-8',
        })
        response.end(payload)
      } catch {
        response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'installed_bank_unavailable' }))
      }
      return
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end('[]')
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    fail('bank_start_failed', 'Local read-only bank service did not expose a port')
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    anon: BANK_ANON,
    hasUpstream: Boolean(upstream),
    stats() {
      const writeAttempts = counts.POST + counts.PATCH + counts.DELETE + counts.OTHER
      return { ...counts, writeAttempts }
    },
    close() {
      return new Promise((resolveClose) => {
        server.close(() => resolveClose())
        server.closeAllConnections?.()
      })
    },
  }
}

export async function readInstalledBankSettings() {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VITE_DEV_SERVER_URL: '' },
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const settings = await app.evaluate(({ app, safeStorage }) => {
      const { readFileSync } = process.getBuiltinModule('fs')
      const { join } = process.getBuiltinModule('path')
      try {
        const store = JSON.parse(safeStorage.decryptString(
          readFileSync(join(app.getPath('userData'), 'kaida-store.bin')),
        ))
        return {
          base: String(store?.settings?.supabase_url || ''),
          anon: String(store?.settings?.supabase_anon || ''),
        }
      } catch {
        return { base: '', anon: '' }
      }
    })
    try {
      const base = settings.base || PUBLIC_SUPABASE_URL
      const anon = settings.anon || PUBLIC_SUPABASE_ANON
      const origin = new URL(base).origin
      if (!origin.startsWith('https://') || !anon) {
        fail('installed_bank_unavailable', 'Installed bank settings are unavailable')
      }
      return { base: origin, anon }
    } catch (error) {
      if (error instanceof T005HarnessError) throw error
      fail('installed_bank_unavailable', 'Installed bank settings are invalid')
    }
  } finally {
    await app.close().catch(() => {})
  }
}

export function classifyAnswerWorkType(value) {
  return OBSERVED_ANSWER_WORK_TYPES.includes(value) ? value : 'unsupported'
}

export function noqrTestCourseTodoCount(course) {
  return (course?.groups || []).reduce(
    (count, group) => count + (group.rows || []).filter((homework) => homework.status === 'todo').length,
    0,
  )
}

export function noqrTestCourseRowCount(course) {
  return (course?.groups || []).reduce(
    (count, group) => count + (group.rows || []).length,
    0,
  )
}

export function chooseNoqrTestCourse(courses, opts) {
  const allCourses = Array.isArray(courses) ? [...courses] : []
  const candidates = (Array.isArray(courses) ? [...courses] : [])
    .filter((course) => noqrTestCourseTodoCount(course) > 0)
    .filter((course) => !opts.courseMatch || String(course?.name || '').includes(opts.courseMatch))
    .sort((left, right) => opts.courseStrategy === 'max-todo'
      ? noqrTestCourseTodoCount(right) - noqrTestCourseTodoCount(left) ||
        noqrTestCourseRowCount(right) - noqrTestCourseRowCount(left)
      : noqrTestCourseTodoCount(left) - noqrTestCourseTodoCount(right) ||
        noqrTestCourseRowCount(left) - noqrTestCourseRowCount(right))
  const selected = opts.courseIndex > 0 ? candidates[opts.courseIndex - 1] : candidates[0]
  if (opts.courseMatch) {
    if (selected) return selected
    // A completed course may temporarily expose no `todo` rows. Forced-retry
    // still needs to enter the matching course and let the real page load its
    // completed homework cards before deciding whether to retry.
    if (opts.forceRetry) {
      return allCourses.find((course) =>
        String(course?.name || '').includes(opts.courseMatch)) || null
    }
    return null
  }
  return selected ||
    (Array.isArray(courses) ? courses : []).find((course) =>
      (course?.groups || []).some((group) => (group.rows || []).length > 0)) ||
    (Array.isArray(courses) ? courses[0] : null) ||
    null
}

function safeToken(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : 'unknown'
}

function safeCount(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
}

function safeScore(value) {
  if (value === null || value === undefined || value === '') return null
  const score = Number(value)
  return Number.isFinite(score) ? score : null
}

export function noqrQuestionIdFingerprint(ids) {
  const pairs = (Array.isArray(ids) ? ids : [])
    .map((item) => [
      typeof item?.bigQuestionId === 'string' ? item.bigQuestionId.trim() : '',
      typeof item?.questionId === 'string' ? item.questionId.trim() : '',
    ])
    .filter(([bigQuestionId, questionId]) => bigQuestionId || questionId)
    .sort(([leftBig, leftQuestion], [rightBig, rightQuestion]) =>
      leftBig.localeCompare(rightBig) || leftQuestion.localeCompare(rightQuestion))
  if (!pairs.length) return null
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex')
}

export function analyzeNoqrSaveRequestLedger(entries) {
  const allowedKinds = new Set(['submit_one', 'submit_all'])
  const allowedOutcomes = new Set(['pending', 'accepted', 'rejected', 'failed', 'uncertain'])
  let pageAttributionMissingCount = 0
  const requests = (Array.isArray(entries) ? entries : [])
    .map((item) => {
      const kind = allowedKinds.has(item?.kind) ? item.kind : ''
      const contextSequence = Number(item?.contextSequence)
      const pageSequence = Number(item?.pageSequence)
      const pageRequestSequence = Number(item?.pageRequestSequence)
      const sequence = Number(item?.sequence)
      const monitorOffsetMs = Number(item?.monitorOffsetMs)
      if (!kind || !Number.isInteger(contextSequence) || contextSequence < 1 ||
        !Number.isInteger(pageSequence) || pageSequence < 1 ||
        !Number.isInteger(pageRequestSequence) || pageRequestSequence < 1 ||
        !Number.isInteger(sequence) || sequence < 1 ||
        !Number.isInteger(monitorOffsetMs) || monitorOffsetMs < 0) {
        pageAttributionMissingCount++
        return null
      }
      const fingerprint = typeof item?.questionFingerprint === 'string' &&
        /^[0-9a-f]{64}$/.test(item.questionFingerprint)
        ? item.questionFingerprint
        : null
      const attemptFingerprint = typeof item?.attemptFingerprint === 'string' &&
        /^[0-9a-f]{64}$/.test(item.attemptFingerprint)
        ? item.attemptFingerprint
        : null
      return {
        requestId: `${kind}:${contextSequence}:${sequence}`,
        kind,
        contextSequence,
        pageSequence,
        pageRequestSequence,
        sequence,
        monitorOffsetMs,
        questionFingerprint: fingerprint,
        attemptFingerprint,
        outcome: allowedOutcomes.has(item?.outcome) ? item.outcome : 'uncertain',
      }
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.contextSequence - right.contextSequence ||
      left.pageSequence - right.pageSequence ||
      left.pageRequestSequence - right.pageRequestSequence ||
      left.sequence - right.sequence ||
      left.kind.localeCompare(right.kind))

  const firstByContextQuestion = new Map()
  const duplicateAssociations = []
  for (const request of requests) {
    if (!request.questionFingerprint) continue
    const key = `${request.contextSequence}:${request.attemptFingerprint || 'unscoped'}:${request.questionFingerprint}`
    const firstRequestId = firstByContextQuestion.get(key)
    if (firstRequestId) {
      duplicateAssociations.push({
        questionFingerprint: request.questionFingerprint,
        firstRequestId,
        repeatedRequestId: request.requestId,
      })
    } else {
      firstByContextQuestion.set(key, request.requestId)
    }
  }

  const contextPageCounts = new Map()
  for (const request of requests) {
    const key = `${request.contextSequence}:${request.pageSequence}`
    const current = contextPageCounts.get(key)
    if (current) current.requestCount++
    else {
      contextPageCounts.set(key, {
        contextSequence: request.contextSequence,
        pageSequence: request.pageSequence,
        requestCount: 1,
      })
    }
  }
  const fingerprintCounts = new Map()
  for (const request of requests) {
    if (!request.questionFingerprint) continue
    const current = fingerprintCounts.get(request.questionFingerprint)
    if (current) current.requestCount++
    else {
      fingerprintCounts.set(request.questionFingerprint, {
        questionFingerprint: request.questionFingerprint,
        requestCount: 1,
      })
    }
  }

  const unassociatedCount = requests.filter((item) => !item.questionFingerprint).length
  const uniqueQuestionKeys = new Set(
    requests
      .filter((item) => item.questionFingerprint)
      .map((item) =>
        `${item.contextSequence}:${item.attemptFingerprint || 'unscoped'}:${item.questionFingerprint}`),
  )
  const duplicateQuestionRequestCount = duplicateAssociations.length
  const failureCode = duplicateQuestionRequestCount > 0
    ? 'duplicate_save_question_request'
    : pageAttributionMissingCount > 0
      ? 'save_page_attribution_missing'
      : unassociatedCount > 0
        ? 'save_question_association_missing'
        : ''
  return {
    requestCount: requests.length,
    pageAttributionMissingCount,
    associatedCount: requests.length - unassociatedCount,
    unassociatedCount,
    acceptedCount: requests.filter((item) => item.outcome === 'accepted').length,
    uniqueQuestionCount: uniqueQuestionKeys.size,
    duplicateQuestionRequestCount,
    duplicateAssociations,
    contextPageDistribution: [...contextPageCounts.values()],
    questionFingerprintDistribution: [...fingerprintCounts.values()],
    hardFailure: Boolean(failureCode),
    failureCode,
    requests,
  }
}

export function isSiteGeneratedFinalDuplicate(audit, saveClickAttempts, saveRequestRetries) {
  const clicks = safeCount(saveClickAttempts)
  const retries = safeCount(saveRequestRetries)
  if (audit?.failureCode !== 'duplicate_save_question_request' || retries > 0) return false
  if (clicks !== safeCount(audit.uniqueQuestionCount)) return false
  const requests = (Array.isArray(audit.requests) ? [...audit.requests] : [])
    .sort((left, right) =>
      safeCount(left.monitorOffsetMs) - safeCount(right.monitorOffsetMs) ||
      safeCount(left.contextSequence) - safeCount(right.contextSequence) ||
      safeCount(left.pageSequence) - safeCount(right.pageSequence) ||
      safeCount(left.sequence) - safeCount(right.sequence))
  if (!requests.length || requests.some((request) =>
    !request.attemptFingerprint || request.outcome !== 'accepted')) return false

  const attempts = new Map()
  for (const request of requests) {
    const key = `${request.contextSequence}:${request.attemptFingerprint}`
    const group = attempts.get(key) || []
    group.push(request)
    attempts.set(key, group)
  }
  if (!attempts.size) return false
  if (safeCount(audit.requestCount) !== safeCount(audit.uniqueQuestionCount) + attempts.size) {
    return false
  }

  let duplicateCount = 0
  for (const group of attempts.values()) {
    if (group.length < 3) return false
    const counts = new Map()
    for (const request of group) {
      if (!request.questionFingerprint) return false
      counts.set(request.questionFingerprint, (counts.get(request.questionFingerprint) || 0) + 1)
    }
    const repeated = [...counts.values()].filter((count) => count === 2)
    if (repeated.length !== 1 || [...counts.values()].some((count) => count > 2)) return false

    const previous = group.at(-2)
    const last = group.at(-1)
    if (
      previous.contextSequence !== last.contextSequence ||
      previous.pageSequence !== last.pageSequence ||
      previous.attemptFingerprint !== last.attemptFingerprint ||
      previous.kind !== last.kind ||
      previous.questionFingerprint !== last.questionFingerprint
    ) {
      return false
    }
    duplicateCount++
  }
  return duplicateCount === safeCount(audit.duplicateQuestionRequestCount)
}

export function shouldFailTerminalBeforeTarget({
  terminalCode,
  terminalEnded,
  terminalNeedsAttention,
  allowTerminal,
  allowExplicitStop,
  targetReached,
}) {
  if (!terminalCode) return false
  if (targetReached && terminalCode === 'product_round_ended') return false
  if (allowTerminal && ['product_round_ended', 'product_not_full'].includes(terminalCode)) return false
  if (allowExplicitStop && terminalCode === 'product_stopped') return false
  if (!terminalEnded && !terminalNeedsAttention) return false
  return true
}

export function noqrScoreNetworkFailure(network, siteGeneratedFinalDuplicate, expectedFinishRequests = 1) {
  const expectedFinishes = Math.max(1, Math.trunc(Number(expectedFinishRequests) || 1))
  const finishRequests = safeCount(network?.mutationRequests?.finish)
  const finishAccepted = safeCount(network?.mutationAccepted?.finish)
  if (finishRequests !== expectedFinishes || finishAccepted !== expectedFinishes) {
    return 'finish_request_count_mismatch'
  }
  if (safeCount(network?.mutationRequests?.submit_one) + safeCount(network?.mutationRequests?.submit_all) === 0 ||
    safeCount(network?.mutationAccepted?.submit_one) + safeCount(network?.mutationAccepted?.submit_all) === 0) {
    return 'save_network_evidence_missing'
  }
  if (safeCount(network?.mutationFailures) > 0 || safeCount(network?.mutationUncertain) > 0) {
    return 'mutation_network_uncertain'
  }
  if (safeCount(network?.mutationDuplicateBodyRequests?.finish) > 0) {
    return 'duplicate_finish_request'
  }
  const duplicateSaveBodies =
    safeCount(network?.mutationDuplicateBodyRequests?.submit_all) +
    safeCount(network?.mutationDuplicateBodyRequests?.submit_one)
  if (duplicateSaveBodies > 0 && !siteGeneratedFinalDuplicate) {
    return 'duplicate_save_request'
  }
  const ledgers = network?.mutationRequestLedger
  for (const kind of ['submit_one', 'submit_all', 'finish']) {
    const expected = safeCount(network?.mutationRequests?.[kind])
    const actual = Array.isArray(ledgers?.[kind]) ? ledgers[kind].length : 0
    if (actual !== expected) return 'mutation_request_ledger_incomplete'
  }
  const ledgerEntries = ['submit_one', 'submit_all', 'finish']
    .flatMap((kind) => Array.isArray(ledgers?.[kind]) ? ledgers[kind] : [])
  if (ledgerEntries.some((entry) => entry?.outcome === 'pending')) return 'mutation_request_pending'
  if (ledgerEntries.some((entry) => entry?.outcome !== 'accepted')) return 'mutation_network_uncertain'
  return null
}

export function expectedNoqrScoreFinishRequests(config, outcome) {
  const observed = Array.isArray(outcome?.scoreRoundHistory)
    ? outcome.scoreRoundHistory.length
    : 0
  if (observed > 0) return observed
  return Math.max(1, Math.trunc(Number(config?.stopAfterScoreRound) || 1))
}

export function noqrPacingViolationCount(entries, minimumMsPerQuestion = 1_500) {
  const minimum = Math.max(0, Math.trunc(Number(minimumMsPerQuestion) || 0))
  const groups = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.outcome !== 'accepted' || !entry?.questionFingerprint) continue
    const key = [
      safeCount(entry.contextSequence),
      safeCount(entry.pageSequence),
      entry.attemptFingerprint || 'unscoped',
    ].join(':')
    const group = groups.get(key) || []
    group.push(entry)
    groups.set(key, group)
  }
  let violations = 0
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) =>
      safeCount(left.monitorOffsetMs) - safeCount(right.monitorOffsetMs) ||
      safeCount(left.sequence) - safeCount(right.sequence))
    const seen = new Set()
    const distinct = []
    for (const entry of ordered) {
      if (seen.has(entry.questionFingerprint)) continue
      seen.add(entry.questionFingerprint)
      distinct.push(entry)
    }
    for (let index = 1; index < distinct.length; index++) {
      const interval = safeCount(distinct[index].monitorOffsetMs) -
        safeCount(distinct[index - 1].monitorOffsetMs)
      // A single short gap can follow a slow lookup/response from the prior
      // question, even though the next question still receives its own pacing
      // wait. Reject only a sub-500ms burst or two consecutive fast gaps.
      if (interval < minimum / 2) {
        violations++
        continue
      }
      if (index >= 2) {
        const window = safeCount(distinct[index].monitorOffsetMs) -
          safeCount(distinct[index - 2].monitorOffsetMs)
        if (window < minimum * 2) violations++
      }
    }
  }
  return violations
}

export function noqrLoginReuseFailure(network, accountCount) {
  const submissions = safeCount(network?.loginSubmissionRequests)
  const allowed = Math.max(1, Math.floor(Number(accountCount) || 1))
  return submissions > allowed ? 'login_submission_repeated' : ''
}

export function safeDiagnosticCode(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim()
  if (!raw) return 'operation_failed'
  if (/^等待交卷成功页面证据/.test(raw)) return 'finish_success_wait'
  if (/课程(?:检测)?已隔离/.test(raw)) return 'course_isolated'
  if (/作业.*已隔离/.test(raw)) return 'homework_isolated'
  const isolatedReason = raw.match(/已隔离\s*[·:：]\s*(.+)$/)
  if (isolatedReason) return safeDiagnosticCode(isolatedReason[1])
  const selectionDetail = raw.match(/\b(selection_mismatch_expected_[a-z0-9_]+_actual_[a-z0-9_]+)\b/i)
  if (selectionDetail) return `save_answer_${selectionDetail[1].toLowerCase()}`
  const cardMissing = raw.match(/\b(answer_card_missing_[0-9_]+)\b/i)
  if (cardMissing) return cardMissing[1].toLowerCase()
  const exact = [
    [/答题启动页连续空白/, 'answer_boot_blank_exhausted'],
    [/答题启动空白，返回重进/, 'answer_boot_blank_reenter'],
    [/答题页缺少答题卡入口|答题页缺少交卷按钮/, 'answer_page_contract_missing'],
    [/选项选中状态与目标不一致/, 'option_state_mismatch'],
    [/保存请求结果不确定|保存结果不确定/, 'save_uncertain'],
    [/保存请求 workId|保存请求.*workId/, 'save_work_id_mismatch'],
    [/保存请求缺少作答唯一标记/, 'save_flag_missing'],
    [/整组保存答案/, 'save_group_answer_mismatch'],
    [/selection_order_mismatch/, 'save_answer_order_mismatch'],
    [/selection_count_mismatch/, 'save_answer_count_mismatch'],
    [/selection_offset_plus_one/, 'save_answer_offset_plus_one'],
    [/selection_offset_minus_one/, 'save_answer_offset_minus_one'],
    [/selection_values_mismatch/, 'save_answer_values_mismatch'],
    [/selection_format_mismatch/, 'save_answer_format_mismatch'],
    [/selection_shape_mismatch/, 'save_answer_shape_mismatch'],
    [/单题保存 answerSelected|answerSelected 与当前页面目标不一致/, 'save_answer_mismatch'],
    [/保存响应未通过 HTTP|答案保存失败/, 'save_response_rejected'],
    [/等待页面推进/, 'save_advance_wait'],
    [/答案已保存但页面未推进/, 'save_advance_not_observed'],
    [/等待保存请求/, 'save_request_wait'],
    [/未观察到保存请求，重新点击/, 'save_request_retry'],
    [/保存点击\s*1\/3/, 'save_click_1'],
    [/保存点击\s*2\/3/, 'save_click_2'],
    [/保存点击\s*3\/3/, 'save_click_3'],
    [/答题卡仍有/, 'answer_card_incomplete'],
    [/答题卡漏题，回跳补答/, 'answer_card_repair_started'],
    [/答题卡中找不到漏题题号/, 'answer_card_repair_target_missing'],
    [/答题卡跳转后未到达目标题/, 'answer_card_jump_target_missing'],
    [/答题卡审计超过总时限/, 'answer_card_audit_timeout'],
    [/交卷按钮已处于禁用/, 'finish_button_disabled'],
    [/最终交卷响应未通过 HTTP/, 'finish_response_rejected'],
    [/交卷请求未确认/, 'finish_request_missing'],
    [/交卷响应成功，但成功提示或按钮禁用证据不完整/, 'finish_success_evidence_missing'],
    [/交卷成功后没有返回作业区|交卷成功后缺少返回按钮/, 'finish_return_failed'],
    [/未知题型或控件/, 'question_unknown_type'],
    [/当前答题页没有可识别题目/, 'question_unreadable'],
    [/当前答题页题组读取失败/, 'question_read_failed'],
    [/题目单元数量应为/, 'question_unit_count_mismatch'],
    [/题目单元.*(?:缺少|序号|重复|为空)|复合题缺少共享材料/, 'question_group_contract_invalid'],
    [/选项缺失或损坏|选项正文重复|选项索引重复/, 'question_option_invalid'],
    [/题库命中题型与当前页面不一致|题型不匹配/, 'question_qtype_mismatch'],
    [/听力题库缺少|听力题库缺失/, 'listening_bank_missing'],
    [/题库读取失败/, 'bank_read_failed'],
    [/题库答案无法唯一映射|AI 答案无法唯一映射/, 'answer_mapping_failed'],
    [/AI 答案不可用|AI 答案缺项|复合题 AI 答案/, 'ai_answer_failed'],
    [/作答记录接口为空/, 'history_api_empty'],
    [/作答记录接口返回格式错误|作答记录接口失败|作答记录接口与当前作业身份不一致/, 'history_api_error'],
    [/没有可确认的已完成有效分数/, 'history_no_valid_score'],
    [/作答记录页连续刷新/, 'history_blank_exhausted'],
    [/最新作答记录未能与页面分数交叉核对/, 'history_dom_mismatch'],
    [/交卷后未出现新的有效作答记录/, 'history_new_record_missing'],
    [/交卷后作业卡已变化/, 'history_homework_changed'],
    [/最新分数尚未批阅/, 'history_score_pending'],
    [/重答次数用尽/, 'retry_rounds_exhausted'],
    [/目标作业卡已变化/, 'homework_card_changed'],
    [/目标作业缺少.*按钮/, 'homework_button_missing'],
    [/目标作业.*按钮不可用/, 'homework_button_disabled'],
    [/课程菜单中找不到本轮目标课程/, 'course_menu_target_missing'],
    [/工作区|作业区|形考作业页/, 'course_work_page_contract'],
    [/课程已隔离/, 'course_isolated'],
    [/作业.*已隔离|已隔离/, 'homework_isolated'],
    [/运行结束/, 'run_terminal'],
    [/题干|选项|题目|question/i, 'question_text'],
    [/题库|AI 答案|answerSelected/, 'question_or_answer'],
  ]
  for (const [pattern, code] of exact) {
    if (pattern.test(raw)) return code
  }
  return sanitizeDiagnosticText(raw)
}

export function diagnosticShape(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim()
  if (!raw) return 'empty'
  if (/答题卡.*(?:关闭|弹层)/.test(raw)) return 'answer_card_close'
  if (/答题卡.*(?:结构|连续|自动恢复|完整加载|等待)/.test(raw)) return 'answer_card_structure'
  if (/答题卡.*(?:入口|按钮)/.test(raw)) return 'answer_card_contract'
  if (/答题页.*(?:空白|加载|骨架|恢复)/.test(raw)) return 'answer_page_blank'
  if (/当前答题页|题组读取|题目.*读取/.test(raw)) return 'question_read'
  if (/救?人工|需人工|异常中断|已保留/.test(raw)) return 'answer_interrupted'
  if (/交卷|Finish|finish/i.test(raw)) return 'submit'
  if (/空白|加载|骨架|skeleton/i.test(raw)) return 'blank'
  if (/页面|工作区|作业区|作业卡|课程/.test(raw)) return 'page_contract'
  if (/worktype|stageexam|onlinework|题型/i.test(raw)) return 'work_type'
  if (/保存|提交|submit/i.test(raw)) return 'save'
  return 'operation'
}

function sanitizeDiagnosticText(value) {
  const raw = String(value || '')
  if (!raw) return 'operation_failed'
  const knownCode = raw.match(/\b(blank_page|page_error|auth_blocked|login_failed|credentials_missing|timeout)\b/i)
  if (knownCode) return knownCode[1].toLowerCase()
  if (/worktype|stageexam|onlinework|work_type|客观题|题型/i.test(raw)) return 'unsupported_work_type'
  if (/企业微信|二维码|扫码|人工认证|auth blocked/i.test(raw)) return 'auth_blocked'
  if (/账号或密码|登录失败|凭据/i.test(raw)) return 'login_failed'
  if (/等待浏览器名额|排队中/i.test(raw)) return 'waiting_slot'
  if (/浏览器已启动/i.test(raw)) return 'browser_started'
  if (/打开.*登录入口/i.test(raw)) return 'login_page'
  if (/登录中|等待登录响应/i.test(raw)) return 'login_in_progress'
  if (/登录成功|进入首页/i.test(raw)) return 'login_succeeded'
  if (/点击形考作业|已读取.*课程|读取.*课程/i.test(raw)) return 'course_scan'
  if (/等待形考作业页/i.test(raw)) return 'course_page_wait'
  if (/等待作业卡|检测作业/i.test(raw)) return 'homework_detection'
  if (/打开作业|答题页加载/i.test(raw)) return 'answer_open'
  if (/题库命中|AI 完成|作答中|等待答案保存|等待页面推进/i.test(raw)) return 'answer_progress'
  if (/交卷中|等待交卷/i.test(raw)) return 'submit_in_progress'
  if (/等待作答记录|等待出分|等待重答/i.test(raw)) return 'score_wait'
  if (/骨架|空白|加载|skeleton/i.test(raw)) return 'blank_or_loading'
  if (/课程菜单|作业卡|开始作答|作答记录|按钮|页面|首页|形考作业|课程标题/i.test(raw)) return 'page_contract'
  if (/context|target closed|browser.*(?:error|fail|closed)|launch.*(?:error|fail)|浏览器.*(?:异常|失败|关闭)/i.test(raw)) return 'browser_error'
  if (/超时|timed?\s*out|timeout/i.test(raw)) return 'timeout'
  if (/网络|HTTP|fetch|响应|请求|network/i.test(raw)) return 'network_or_response'
  if (/保存|提交|交卷|submit/i.test(raw)) return 'submit_or_save'
  if (/停止|abort|cancel/i.test(raw)) return 'stopped'
  if (/答案|题干|选项|题目|question/i.test(raw)) return 'question_or_answer'
  if (/作业|课程|homework|course/i.test(raw)) return 'course_or_homework_flow'
  return 'operation_failed'
}

function safeStateToken(value) {
  const raw = String(value || '').trim()
  const mapped = new Map([
    ['待检测', 'pending'],
    ['检测中', 'detecting'],
    ['作答中', 'answering'],
    ['已完成', 'completed'],
    ['完成', 'completed'],
    ['本轮可做作业已完成', 'completed'],
    ['无作业', 'empty'],
    ['尚无作业', 'empty'],
    ['暂无作业', 'empty'],
    ['尚未完成', 'incomplete'],
    ['暂不可完成', 'unavailable'],
    ['分数待确认', 'score_unavailable'],
    ['待回写', 'pending_writeback'],
    ['有失败待处理', 'failed'],
    ['检测失败', 'detection_failed'],
  ])
  if (mapped.has(raw)) return mapped.get(raw)
  return /^[a-z][a-z0-9_]{0,39}$/.test(raw) ? raw : 'unknown'
}

function incrementCount(target, key) {
  target[key] = (target[key] || 0) + 1
}

function sanitizedCourseFailureReason(value, student) {
  let text = String(value || '')
    .replace(/https?:\/\/\S+/gi, '[地址已隐藏]')
    .replace(/\b\d{6,}\b/g, '[编号已隐藏]')
  const courseNames = (Array.isArray(student?.courses) ? student.courses : [])
    .map((course) => String(course?.name || '').trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  const homeworkNames = (Array.isArray(student?.courses) ? student.courses : [])
    .flatMap((course) => Array.isArray(course?.groups) ? course.groups : [])
    .flatMap((group) => Array.isArray(group?.rows) ? group.rows : [])
    .map((row) => String(row?.name || '').trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  for (const name of courseNames) text = text.split(name).join('[课程]')
  for (const name of homeworkNames) text = text.split(name).join('[作业]')
  return text.replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function safeQuestionKindCounts(value) {
  const result = {}
  for (const kind of SAFE_QUESTION_KINDS) {
    const count = safeCount(value?.[kind])
    if (count > 0) result[kind] = count
  }
  return result
}

export function missingEnglishQuestionKinds(value) {
  const counts = safeQuestionKindCounts(value)
  return REQUIRED_ENGLISH_QUESTION_KINDS.filter((kind) => safeCount(counts[kind]) === 0)
}

export function englishQuestionSlotEvidence(value) {
  const counts = safeQuestionKindCounts(value)
  const insufficient = []
  const surplus = []
  for (const [kind, expected] of Object.entries(REQUIRED_ENGLISH_QUESTION_SLOTS)) {
    const actual = safeCount(counts[kind])
    const delta = actual - expected
    if (delta < 0) insufficient.push({ kind, expected, actual, delta })
    if (delta > 0) surplus.push({ kind, expected, actual, delta })
  }
  return {
    counts,
    totalSlots: REQUIRED_ENGLISH_QUESTION_KINDS
      .reduce((total, kind) => total + safeCount(counts[kind]), 0),
    minimumTotalSlots: Object.values(REQUIRED_ENGLISH_QUESTION_SLOTS)
      .reduce((total, expected) => total + expected, 0),
    insufficient,
    surplus,
    meetsMinimum: insufficient.length === 0,
  }
}

export function englishHomeworkSlotFailure(student) {
  const homeworks = (Array.isArray(student?.homeworkQuestionKindSlotCounts)
    ? student.homeworkQuestionKindSlotCounts
    : []).map((item, fallbackIndex) => ({
    index: Number.isInteger(Number(item?.index)) ? Number(item.index) : fallbackIndex,
    answeredQuestionCount: safeCount(item?.answeredQuestionCount),
    ...englishQuestionSlotEvidence(item?.questionKindSlotCounts),
  }))
  if (homeworks.some((homework) => homework.meetsMinimum)) return null
  return {
    code: 'english_question_slots_missing',
    missingKinds: [...new Set(homeworks.flatMap((homework) =>
      homework.insufficient.map((item) => item.kind)))],
    evidence: { homeworks },
  }
}

export function englishHomeworkSlotFailures(accounts, summaries) {
  return (Array.isArray(accounts) ? accounts : []).flatMap((account, index) => {
    if (account?.kind !== 'english') return []
    const failure = englishHomeworkSlotFailure(summaries?.[index])
    return failure ? [{ alias: account.alias, ...failure }] : []
  })
}

export function answerCardShapeDiagnostic(rawLogs) {
  let shape = null
  let observedSignature = ''
  let expectedSignature = ''
  for (const raw of Array.isArray(rawLogs) ? rawLogs : []) {
    const observed = String(raw || '').match(/答题卡观测签名：([^；]+)/)
    const expected = String(raw || '').match(/答题卡期望签名：([^；]+)/)
    if (observed) observedSignature = observed[1]
    if (expected) expectedSignature = expected[1]
    const expanded = String(raw || '').match(
      /答题卡结构不足：已加载 (\d+)\/(\d+)，已答 (\d+)，识别题型 (\d+)，结构化组 (\d+)\/(\d+)，匹配行 (\d+)\/(\d+)，保存组 (\d+)\/(\d+)，父题组 (\d+)，未映射行 (\d+)/,
    )
    if (expanded && !shape) {
      shape = {
        loaded: Number(expanded[1]),
        expected: Number(expanded[2]),
        answered: Number(expanded[3]),
        recognizedSections: Number(expanded[4]),
        matchedGroups: Number(expanded[5]),
        expectedGroups: Number(expanded[6]),
        matchedRows: Number(expanded[7]),
        visibleRows: Number(expanded[8]),
        savedGroups: Number(expanded[9]),
        expectedSavedGroups: Number(expanded[10]),
        parentOnlyGroups: Number(expanded[11]),
        unmatchedVisibleRows: Number(expanded[12]),
      }
    }
    if (!shape) {
      const matched = String(raw || '').match(
        /答题卡结构不足：已加载 (\d+)\/(\d+)，已答 (\d+)，识别题型 (\d+)/,
      )
      if (matched) {
        shape = {
          loaded: Number(matched[1]),
          expected: Number(matched[2]),
          answered: Number(matched[3]),
          recognizedSections: Number(matched[4]),
        }
      }
    }
  }
  if (shape) {
    return {
      ...shape,
      ...(observedSignature ? { observedSignature } : {}),
      ...(expectedSignature ? { expectedSignature } : {}),
    }
  }
  return null
}

export function debugDiagnosticsForStudent(alias, student) {
  const base = diagnosticsForStudent(alias, student)
  const rawLogs = [
    ...(Array.isArray(student?.logs) ? student.logs : []),
    ...(Array.isArray(student?.courseLogs) ? student.courseLogs.map((entry) => entry?.reason) : []),
  ].filter(Boolean)
  const courseStateCounts = {}
  const homeworkStateCounts = {}
  const courseFailureReasons = (Array.isArray(student?.courseLogs) ? student.courseLogs : [])
    .filter((entry) => entry?.level === 'error')
    .map((entry) => sanitizedCourseFailureReason(entry?.reason, student))
    .filter(Boolean)
    .slice(-10)
  for (const course of Array.isArray(student?.courses) ? student.courses : []) {
    incrementCount(courseStateCounts, safeStateToken(course?.status))
    for (const group of Array.isArray(course?.groups) ? course.groups : []) {
      for (const row of Array.isArray(group?.rows) ? group.rows : []) {
        incrementCount(homeworkStateCounts, safeStateToken(row?.status))
      }
    }
  }
  return {
    ...base,
    lastActionCode: safeDiagnosticCode(student?.action),
    lastActionShape: diagnosticShape(student?.action),
    logCodes: rawLogs.slice(-30).map(safeDiagnosticCode),
    logShapes: rawLogs.slice(-30).map(diagnosticShape),
    answerCardShape: answerCardShapeDiagnostic(rawLogs),
    courseStateCounts,
    homeworkStateCounts,
    courseFailureReasons,
    bankCount: safeCount(student?.bankCount),
    aiCount: safeCount(student?.aiCount),
    questionKindCounts: safeQuestionKindCounts(student?.questionKindCounts),
    questionKindSlotCounts: safeQuestionKindCounts(student?.questionKindSlotCounts),
    selectedCourseCount: Array.isArray(student?.selectedCourseKeys) ? student.selectedCourseKeys.length : 0,
    courseCount: Array.isArray(student?.courses) ? student.courses.length : 0,
    homeworkCount: homeworkRows(student).length,
  }
}

function terminalCodeFor(student) {
  if (student?.phase === 'unsupported') return 'product_unsupported'
  if (student?.phase === 'stopped' || student?.account === 'stopped') return 'product_stopped'
  if (student?.phase === 'login_failed' || student?.account === 'login_failed') return 'product_login_failed'
  if (student?.phase === 'needs_user' || student?.account === 'needs_verify') return 'product_needs_user'
  if (student?.phase === 'not_full') return 'product_not_full'
  if (student?.phase === 'round_ended' || student?.account === 'round_ended') return 'product_round_ended'
  return null
}

export function diagnosticsForStudent(alias, student) {
  const rawLogs = [
    ...(Array.isArray(student?.logs) ? student.logs : []),
    ...(Array.isArray(student?.courseLogs) ? student.courseLogs.map((entry) => entry?.reason) : []),
  ].filter(Boolean).slice(-8)
  const lastLogs = [...new Set(rawLogs.map(sanitizeDiagnosticText))].slice(-5)
  return {
    alias: /^NOQR-(?:EN(?:-\d{2})?|\d{2})$/.test(alias) ? alias : 'unknown',
    present: Boolean(student),
    phase: safeToken(student?.phase),
    accountState: safeToken(student?.account),
    slot: safeToken(student?.slot),
    configLocked: Boolean(student?.configLocked),
    queued: Boolean(student?.queued),
    terminalCode: terminalCodeFor(student),
    lastAction: safeDiagnosticCode(student?.action),
    lastLogs: lastLogs.length ? lastLogs : ['operation_failed'],
  }
}

function homeworkRows(student) {
  const rows = []
  for (const course of Array.isArray(student?.courses) ? student.courses : []) {
    for (const group of Array.isArray(course?.groups) ? course.groups : []) {
      for (const row of Array.isArray(group?.rows) ? group.rows : []) rows.push(row)
    }
  }
  return rows
}

export function noqrScoreRoundEvidence(student) {
  return homeworkRows(student).flatMap((row, homeworkIndex) => {
    const attempt = safeCount(row?.attempt)
    const score = safeScore(row?.score)
    return attempt > 0 && score !== null
      ? [{ homeworkIndex, attempt, score }]
      : []
  })
}

export function noqrScoreRoundReached(student, targetRound) {
  const round = Number(targetRound)
  if (!Number.isInteger(round) || round < 1) return false
  return noqrScoreRoundEvidence(student).some((item) => item.attempt >= round)
}

export function noqrScoreHistoryReached(history, aliases, targetRound) {
  const round = Number(targetRound)
  const expectedAliases = Array.isArray(aliases) ? aliases.filter(Boolean) : []
  if (!Number.isInteger(round) || round < 1 || !expectedAliases.length) return false
  const rows = Array.isArray(history) ? history : []
  return expectedAliases.every((alias) =>
    rows.filter((item) => item?.alias === alias).length >= round)
}

export function summarizeStudentForLog(alias, student) {
  const homeworks = homeworkRows(student)
  const attemptedScored = homeworks.filter((row) =>
    safeCount(row?.attempt) > 0 && safeScore(row?.score) !== null)
  const scores = attemptedScored.map((row) => safeScore(row.score)).filter((score) => score !== null)
  const skippedFullScoreCount = homeworks.filter((row) =>
    row?.status === 'skip_full_score' && safeScore(row?.score) === 100).length
  const timed = attemptedScored.filter((row) =>
    safeCount(row?.noqrAnsweredQuestionCount) > 0 &&
    safeCount(row?.noqrAverageQuestionDurationMs) > 0 &&
    safeCount(row?.noqrMaxQuestionDurationMs) > 0 &&
    safeCount(row?.noqrTotalDurationMs) > 0)
  const diagnostics = diagnosticsForStudent(alias, student)
  const questionKindSlotCounts = safeQuestionKindCounts(student?.questionKindSlotCounts)
  const homeworkQuestionKindSlotCounts = homeworks.map((row, index) => ({
    index,
    answeredQuestionCount: safeCount(row?.noqrAnsweredQuestionCount),
    questionKindSlotCounts: safeQuestionKindCounts(row?.questionKindSlotCounts),
  })).filter((row) => row.answeredQuestionCount > 0 ||
    Object.keys(row.questionKindSlotCounts).length > 0)
  return {
    alias: /^NOQR-(?:EN(?:-\d{2})?|\d{2})$/.test(alias) ? alias : 'unknown',
    phase: safeToken(student?.phase),
    accountState: safeToken(student?.account),
    slot: safeToken(student?.slot),
    configLocked: Boolean(student?.configLocked),
    queued: Boolean(student?.queued),
    awaitingCourseSelection: Boolean(student?.awaitingCourseSelection),
    browserWindowVisible: typeof student?.browserWindowVisible === 'boolean'
      ? student.browserWindowVisible
      : null,
    courseCount: Array.isArray(student?.courses) ? student.courses.length : 0,
    homeworkCount: homeworks.length,
    terminalHomeworkCount: homeworks.filter((row) => row?.status === 'done_100' || row?.status === 'not_full_next_time').length,
    bankCount: safeCount(student?.bankCount),
    aiCount: safeCount(student?.aiCount),
    saveClickAttempts: safeCount(student?.saveClickAttempts),
    saveRequestRetries: safeCount(student?.saveRequestRetries),
    questionKindCounts: safeQuestionKindCounts(student?.questionKindCounts),
    questionKindSlotCounts,
    englishQuestionSlotEvidence: englishQuestionSlotEvidence(questionKindSlotCounts),
    homeworkQuestionKindSlotCounts,
    scoreRounds: noqrScoreRoundEvidence(student),
    progressCount: safeCount(student?.bankCount) + safeCount(student?.aiCount),
    repairLogCount: (Array.isArray(student?.logs) ? student.logs : [])
      .filter((line) => /答题卡漏题，回跳补答/.test(String(line || ''))).length,
    scoredHomeworkCount: scores.length,
    skippedFullScoreCount,
    timedHomeworkCount: timed.length,
    timingMissingHomeworkCount: attemptedScored.length - timed.length,
    fullScoreCount: scores.filter((score) => score === 100).length,
    maxScore: scores.length ? Math.max(...scores) : null,
    maxAverageQuestionDurationSeconds: timed.length
      ? Math.round(Math.max(...timed.map((row) => safeCount(row.noqrAverageQuestionDurationMs))) / 1000)
      : 0,
    maxQuestionDurationSeconds: timed.length
      ? Math.round(Math.max(...timed.map((row) => safeCount(row.noqrMaxQuestionDurationMs))) / 1000)
      : 0,
    maxHomeworkDurationSeconds: timed.length
      ? Math.round(Math.max(...timed.map((row) => safeCount(row.noqrTotalDurationMs))) / 1000)
      : 0,
    terminalCode: diagnostics.terminalCode,
    lastAction: diagnostics.lastAction,
    lastLogs: diagnostics.lastLogs,
  }
}

export function preflightSummary(config, credentials) {
  const selected = summarizeT005Credentials(credentials, config.accounts[0].alias)
  return {
    ok: true,
    phase: 'preflight',
    aliases: config.accounts.map((account) => account.alias),
    accountKinds: config.accounts.map((account) => account.kind),
    accountCount: config.accounts.length,
    normalAccountCount: credentials.normal.length,
    englishAccountCount: credentials.english.length,
    aiKeyLoaded: selected.aiKeyLoaded,
    aiKeySkPrefix: selected.aiKeySkPrefix,
    displayMode: config.displayMode,
    courseScope: config.courseScope,
    courseMatchSet: Boolean(config.courseMatch),
    testPhase: config.phase,
    answerRoundLimit: config.answerRoundLimit,
    forceRetry: config.forceRetry,
    stopAfterScoreRound: config.stopAfterScoreRound,
    logEnabled: config.logEnabled,
    browserStarted: false,
    bankStarted: false,
    profileCreated: false,
    bankMode: config.bankSource === 'installed' ? 'get_only_installed_proxy' : 'get_only_empty',
    schoolRouting: 'passthrough',
    monitorMode: 'passive_request_events_only',
    safeStorage: 'required',
    acceptedAnswerWorkTypes: [...OBSERVED_ANSWER_WORK_TYPES],
  }
}

export async function installPassiveNetworkMonitor(app) {
  await app.evaluate(async ({ app }, payload) => {
    const key = payload.key
    if (globalThis[key]?.installed) return
    const allowedWorkTypes = new Set(payload.allowedWorkTypes)
    const { createRequire } = process.getBuiltinModule('module')
    const { existsSync } = process.getBuiltinModule('fs')
    const { createHash } = process.getBuiltinModule('crypto')
    const { chromium } = createRequire(app.getAppPath() + '/package.json')('patchright')
    const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex')
    const questionFingerprint = (body) => {
      const ids = Array.isArray(body?.answers)
        ? body.answers
        : body?.answer && typeof body.answer === 'object'
          ? [body.answer]
          : [body]
      const pairs = ids
        .map((answer) => [
          typeof answer?.bigQuestionId === 'string' ? answer.bigQuestionId.trim() : '',
          typeof answer?.questionId === 'string' ? answer.questionId.trim() : '',
        ])
        .filter(([bigQuestionId, questionId]) => bigQuestionId || questionId)
        .sort(([leftBig, leftQuestion], [rightBig, rightQuestion]) =>
          leftBig.localeCompare(rightBig) || leftQuestion.localeCompare(rightQuestion))
      return pairs.length ? sha256(JSON.stringify(pairs)) : null
    }
    const attemptFingerprint = (body) => {
      const workId = typeof body?.workId === 'string' ? body.workId.trim() : ''
      const homeWorkUniqueFlag = typeof body?.homeWorkUniqueFlag === 'string'
        ? body.homeWorkUniqueFlag.trim()
        : ''
      const paperStructUniqueFlag = typeof body?.paperStructUniqueFlag === 'string'
        ? body.paperStructUniqueFlag.trim()
        : ''
      if (!workId) return null
      return sha256(JSON.stringify([workId, homeWorkUniqueFlag, paperStructUniqueFlag]))
    }
    const bundled = chromium.executablePath()
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const browserExecutable = existsSync(bundled)
      ? 'bundled'
      : existsSync(systemChrome)
        ? 'system'
        : 'missing'
    if (browserExecutable === 'system') chromium.executablePath = () => systemChrome
    const state = {
      installed: true,
      monitoringStartedAt: Date.now(),
      browserContexts: 0,
      browserExecutable,
      answerPageRequests: 0,
      activeAnswerPages: 0,
      maxActiveAnswerPages: 0,
      answerWorkTypes: [],
      unsupportedAnswerWorkTypeCount: 0,
      loginSubmissionRequests: 0,
      loginSubmissionResponses: 0,
      loginSubmissionFailures: 0,
      mutationRequests: {
        submit_one: 0,
        submit_all: 0,
        finish: 0,
      },
      mutationAccepted: {
        submit_one: 0,
        submit_all: 0,
        finish: 0,
      },
      mutationFailures: 0,
      mutationUncertain: 0,
      mutationContextSequence: 0,
      mutationRequestLedger: {
        submit_one: [],
        submit_all: [],
        finish: [],
      },
      mutationBodyFingerprints: {
        submit_one: Object.create(null),
        submit_all: Object.create(null),
        finish: Object.create(null),
      },
      mutationDuplicateBodyRequests: {
        submit_one: 0,
        submit_all: 0,
        finish: 0,
      },
      mutationMaxDurationMs: {
        submit_one: 0,
        submit_all: 0,
        finish: 0,
      },
    }
    globalThis[key] = state
    const activeAnswerPages = new Set()
    const trackedPages = new WeakSet()
    const pageSequences = new WeakMap()
    const pageSaveRequestSequences = new WeakMap()
    const mutationRequests = new WeakMap()
    const mutationKind = (url) => {
      const pathname = url.pathname.replace(/\/+$/, '')
      if (pathname.endsWith('/SubmitJsonAsync')) return 'submit_one'
      if (pathname.endsWith('/SubmitAllJsonAsync')) return 'submit_all'
      if (pathname.endsWith('/FinishJsonAsync')) return 'finish'
      return ''
    }
    const loginSubmission = (request) => {
      if (request.method().toUpperCase() === 'GET') return false
      try {
        const url = new URL(request.url())
        if (url.hostname !== 'coursework.shou.org.cn') return false
        return /login|auth|session|token|account/i.test(url.pathname)
      } catch {
        return false
      }
    }
    const setAnswerPageActive = (page, active) => {
      if (active) activeAnswerPages.add(page)
      else activeAnswerPages.delete(page)
      state.activeAnswerPages = activeAnswerPages.size
      state.maxActiveAnswerPages = Math.max(state.maxActiveAnswerPages, state.activeAnswerPages)
    }
    const trackPage = (page) => {
      page.on('close', () => setAnswerPageActive(page, false))
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return
        try {
          const pathname = new URL(frame.url()).pathname.replace(/\/+$/, '')
          setAnswerPageActive(page, pathname === '/course_work_detail/index.html')
        } catch {
          setAnswerPageActive(page, false)
        }
      })
    }
    const registerPage = (page, contextPageState) => {
      if (!page || trackedPages.has(page)) return
      trackedPages.add(page)
      pageSequences.set(page, ++contextPageState.nextPageSequence)
      trackPage(page)
    }
    const original = chromium.launchPersistentContext
    chromium.launchPersistentContext = async function (...args) {
      const context = await original.apply(this, args)
      state.browserContexts++
      const contextSequence = ++state.mutationContextSequence
      const contextPageState = { nextPageSequence: 0 }
      for (const page of context.pages()) registerPage(page, contextPageState)
      context.on('page', (page) => registerPage(page, contextPageState))
      context.on('request', (request) => {
        if (loginSubmission(request)) state.loginSubmissionRequests++
        try {
          const url = new URL(request.url())
          const kind = mutationKind(url)
          if (kind) {
            state.mutationRequests[kind]++
            const sequence = state.mutationRequests[kind]
            const requestPage = (() => {
              try { return request.frame().page() } catch { return null }
            })()
            registerPage(requestPage, contextPageState)
            const pageSequence = requestPage ? pageSequences.get(requestPage) || 0 : 0
            let pageRequestSequence = 0
            if ((kind === 'submit_one' || kind === 'submit_all') && requestPage) {
              pageRequestSequence = (pageSaveRequestSequences.get(requestPage) || 0) + 1
              pageSaveRequestSequences.set(requestPage, pageRequestSequence)
            }
            const ledgerEntry = {
              requestId: `${kind}:${contextSequence}:${sequence}`,
              kind,
              contextSequence,
              pageSequence,
              pageRequestSequence,
              sequence,
              monitorOffsetMs: Math.max(0, Date.now() - state.monitoringStartedAt),
              questionFingerprint: null,
              attemptFingerprint: null,
              outcome: 'pending',
            }
            state.mutationRequestLedger[kind].push(ledgerEntry)
            mutationRequests.set(request, {
              kind,
              startedAt: Date.now(),
              ledgerEntry,
            })
            try {
              const body = request.postData() || ''
              const key = sha256(body)
              const previous = state.mutationBodyFingerprints[kind][key] || 0
              if (previous > 0) state.mutationDuplicateBodyRequests[kind]++
              state.mutationBodyFingerprints[kind][key] = previous + 1
            } catch {
              state.mutationDuplicateBodyRequests[kind] += 0
            }
            try {
              const body = JSON.parse(request.postData() || '{}')
              ledgerEntry.questionFingerprint = questionFingerprint(body)
              ledgerEntry.attemptFingerprint = attemptFingerprint(body)
            } catch {
              // The association audit fails closed when no safe question identity can be recorded.
            }
          }
          if (url.pathname.replace(/\/+$/, '') !== '/course_work_detail/index.html') return
          state.answerPageRequests++
          setAnswerPageActive(request.frame().page(), true)
          const value = url.searchParams.get('workType')
          if (allowedWorkTypes.has(value)) {
            if (!state.answerWorkTypes.includes(value)) state.answerWorkTypes.push(value)
          } else {
            state.unsupportedAnswerWorkTypeCount++
          }
        } catch {
          state.unsupportedAnswerWorkTypeCount++
        }
      })
      context.on('response', (response) => {
        const request = response.request()
        if (loginSubmission(request)) state.loginSubmissionResponses++
        const mutation = mutationRequests.get(request)
        if (!mutation) return
        void (async () => {
          const durationMs = Math.max(0, Date.now() - mutation.startedAt)
          state.mutationMaxDurationMs[mutation.kind] = Math.max(
            state.mutationMaxDurationMs[mutation.kind],
            durationMs,
          )
          const body = await response.text().catch(() => '')
          let accepted = false
          try {
            const payload = body ? JSON.parse(body) : null
            accepted = response.status() >= 200 &&
              response.status() < 300 &&
              payload?.success === true &&
              payload?.result?.status === 'success'
          } catch {
            state.mutationUncertain++
            mutation.ledgerEntry.outcome = 'uncertain'
            return
          }
          if (accepted) {
            state.mutationAccepted[mutation.kind]++
            mutation.ledgerEntry.outcome = 'accepted'
          } else {
            state.mutationFailures++
            mutation.ledgerEntry.outcome = 'rejected'
          }
        })()
      })
      context.on('requestfailed', (request) => {
        if (loginSubmission(request)) state.loginSubmissionFailures++
        const mutation = mutationRequests.get(request)
        if (mutation) {
          state.mutationUncertain++
          mutation.ledgerEntry.outcome = 'failed'
        }
      })
      return context
    }
  }, { key: MONITOR_KEY, allowedWorkTypes: [...OBSERVED_ANSWER_WORK_TYPES] })
}

export async function readPassiveNetworkSummary(app) {
  return app.evaluate((_electronApi, payload) => {
    const state = globalThis[payload.key]
    const allowedWorkTypes = new Set(payload.allowedWorkTypes)
    const allowedOutcomes = new Set(['pending', 'accepted', 'rejected', 'failed', 'uncertain'])
    const readLedger = (kind) => (Array.isArray(state?.mutationRequestLedger?.[kind])
      ? state.mutationRequestLedger[kind]
      : [])
      .map((item) => {
        const contextSequence = Number(item?.contextSequence)
        const pageSequence = Number(item?.pageSequence)
        const pageRequestSequence = Number(item?.pageRequestSequence)
        const sequence = Number(item?.sequence)
        const monitorOffsetMs = Number(item?.monitorOffsetMs)
        if (!Number.isInteger(contextSequence) || contextSequence < 1 ||
          !Number.isInteger(pageSequence) || pageSequence < 0 ||
          !Number.isInteger(pageRequestSequence) || pageRequestSequence < 0 ||
          !Number.isInteger(sequence) || sequence < 1 ||
          !Number.isInteger(monitorOffsetMs) || monitorOffsetMs < 0) return null
        return {
          requestId: `${kind}:${contextSequence}:${sequence}`,
          kind,
          contextSequence,
          pageSequence,
          pageRequestSequence,
          sequence,
          monitorOffsetMs,
          questionFingerprint: typeof item?.questionFingerprint === 'string' &&
            /^[0-9a-f]{64}$/.test(item.questionFingerprint)
            ? item.questionFingerprint
            : null,
          attemptFingerprint: typeof item?.attemptFingerprint === 'string' &&
            /^[0-9a-f]{64}$/.test(item.attemptFingerprint)
            ? item.attemptFingerprint
            : null,
          outcome: allowedOutcomes.has(item?.outcome) ? item.outcome : 'uncertain',
        }
      })
      .filter(Boolean)
    const duplicateQuestionRequests = (entries) => {
      const seen = new Set()
      let duplicates = 0
      for (const entry of entries) {
        if (!entry.questionFingerprint) continue
        const key = `${entry.contextSequence}:${entry.attemptFingerprint || 'unscoped'}:${entry.questionFingerprint}`
        if (seen.has(key)) duplicates++
        else seen.add(key)
      }
      return duplicates
    }
    const uniqueQuestionRequests = (entries) => new Set(
      entries
        .filter((entry) => entry.questionFingerprint)
        .map((entry) =>
          `${entry.contextSequence}:${entry.attemptFingerprint || 'unscoped'}:${entry.questionFingerprint}`),
    ).size
    const mutationRequestLedger = {
      submit_one: readLedger('submit_one'),
      submit_all: readLedger('submit_all'),
      finish: readLedger('finish'),
    }
    return {
      browserContexts: Number(state?.browserContexts) || 0,
      browserExecutable: state?.browserExecutable === 'system' || state?.browserExecutable === 'bundled'
        ? state.browserExecutable
        : 'missing',
      answerPageRequests: Number(state?.answerPageRequests) || 0,
      maxActiveAnswerPages: Number(state?.maxActiveAnswerPages) || 0,
      answerWorkTypes: Array.isArray(state?.answerWorkTypes)
        ? state.answerWorkTypes.filter((value) => allowedWorkTypes.has(value))
        : [],
      unsupportedAnswerWorkTypeCount: Number(state?.unsupportedAnswerWorkTypeCount) || 0,
      loginSubmissionRequests: Number(state?.loginSubmissionRequests) || 0,
      loginSubmissionResponses: Number(state?.loginSubmissionResponses) || 0,
      loginSubmissionFailures: Number(state?.loginSubmissionFailures) || 0,
      mutationRequests: {
        submit_one: Number(state?.mutationRequests?.submit_one) || 0,
        submit_all: Number(state?.mutationRequests?.submit_all) || 0,
        finish: Number(state?.mutationRequests?.finish) || 0,
      },
      mutationAccepted: {
        submit_one: Number(state?.mutationAccepted?.submit_one) || 0,
        submit_all: Number(state?.mutationAccepted?.submit_all) || 0,
        finish: Number(state?.mutationAccepted?.finish) || 0,
      },
      mutationFailures: Number(state?.mutationFailures) || 0,
      mutationUncertain: Number(state?.mutationUncertain) || 0,
      mutationRequestLedger,
      mutationDuplicateBodyRequests: {
        submit_one: Number(state?.mutationDuplicateBodyRequests?.submit_one) || 0,
        submit_all: Number(state?.mutationDuplicateBodyRequests?.submit_all) || 0,
        finish: Number(state?.mutationDuplicateBodyRequests?.finish) || 0,
      },
      mutationDuplicateQuestionRequests: {
        submit_one: duplicateQuestionRequests(mutationRequestLedger.submit_one),
        submit_all: duplicateQuestionRequests(mutationRequestLedger.submit_all),
        finish: duplicateQuestionRequests(mutationRequestLedger.finish),
      },
      mutationUniqueQuestionRequests: {
        submit_one: uniqueQuestionRequests(mutationRequestLedger.submit_one),
        submit_all: uniqueQuestionRequests(mutationRequestLedger.submit_all),
        finish: uniqueQuestionRequests(mutationRequestLedger.finish),
      },
      mutationMaxDurationMs: {
        submit_one: Number(state?.mutationMaxDurationMs?.submit_one) || 0,
        submit_all: Number(state?.mutationMaxDurationMs?.submit_all) || 0,
        finish: Number(state?.mutationMaxDurationMs?.finish) || 0,
      },
    }
  }, {
    key: MONITOR_KEY,
    allowedWorkTypes: [...OBSERVED_ANSWER_WORK_TYPES],
  })
}

function safeProfilePath(profileDir) {
  const root = PROFILE_ROOT + sep
  const resolved = resolve(profileDir)
  if (!resolved.startsWith(root)) fail('profile_path_invalid', 'T005 profile path is outside the project')
  return resolved
}

function removeProfile(profileDir) {
  const safe = safeProfilePath(profileDir)
  rmSync(safe, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

async function rendererCall(product, source) {
  return product.app.evaluate(({ BrowserWindow }, script) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script), source)
}

async function waitForLocatorEnabled(locator, page, timeoutMs = 30_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) return
    await page.waitForTimeout(100)
  }
  fail('ui_control_unavailable', 'A required product control did not become usable')
}

async function clickPrimaryAction(product) {
  const button = product.page.locator('#btn-primary-action')
  await waitForLocatorEnabled(button, product.page)
  await button.click()
}

async function selectStudentInUi(product, alias) {
  const page = product.page
  const direct = page.locator('#student-switcher .student-pill').filter({ hasText: alias }).first()
  if (await direct.isVisible().catch(() => false)) {
    await direct.click()
  } else {
    const more = page.locator('#student-more button').first()
    if (!(await more.count())) fail('student_switch_ui_missing', 'Student switcher is unavailable')
    await more.click()
    const option = page.locator('#student-more .source-popover button').filter({ hasText: alias }).first()
    await waitForLocatorEnabled(option, page)
    await option.click()
  }
  await page.locator('#student-name').filter({ hasText: alias }).waitFor({ state: 'visible', timeout: 30_000 })
}

async function findCourseCardIndexes(product, courseName) {
  return product.page.locator('#course-list .course-item').evaluateAll((nodes, target) =>
    nodes.flatMap((node, index) =>
      [...node.querySelectorAll('span')].some((span) => (span.textContent || '').trim() === target)
        ? [index]
        : []),
  courseName)
}

async function clickCourseCard(product, courseName, occurrence = 1) {
  const page = product.page
  const previous = page.getByRole('button', { name: '上一页课程' })
  for (let index = 0; index < 20 && await previous.isEnabled().catch(() => false); index++) {
    await previous.click()
    await page.waitForTimeout(50)
  }
  let seen = 0
  for (let index = 0; index < 30; index++) {
    const cardIndexes = await findCourseCardIndexes(product, courseName)
    for (const cardIndex of cardIndexes) {
      seen++
      if (seen === occurrence) {
        await page.locator('#course-list .course-item').nth(cardIndex).click()
        return
      }
    }
    const next = page.getByRole('button', { name: '下一页课程' })
    if (!(await next.isEnabled().catch(() => false))) break
    await next.click()
    await page.waitForTimeout(50)
  }
  fail('course_card_not_found', 'Selected course card did not appear in the product UI')
}

async function verifyEncryptedProductConfig(app, expected) {
  return app.evaluate(({ app, safeStorage }, payload) => {
    const { existsSync, readFileSync } = process.getBuiltinModule('fs')
    const { join } = process.getBuiltinModule('path')
    const file = join(app.getPath('userData'), 'kaida-store.bin')
    if (!existsSync(file)) {
      return {
        encryptionAvailable: false,
        keyMatches: false,
        bankMatches: false,
        accountsMatch: false,
        workModesMatch: false,
        displayMatches: false,
        courseScopeMatches: false,
        plaintextLeak: false,
      }
    }
    const raw = readFileSync(file)
    let store
    let encryptionAvailable = false
    try {
      encryptionAvailable = safeStorage.isEncryptionAvailable()
      if (!encryptionAvailable) throw new Error('unavailable')
      store = JSON.parse(safeStorage.decryptString(raw))
    } catch {
      return {
        encryptionAvailable,
        keyMatches: false,
        bankMatches: false,
        accountsMatch: false,
        workModesMatch: false,
        displayMatches: false,
        courseScopeMatches: false,
        plaintextLeak: false,
      }
    }
    const accounts = Array.isArray(store?.accounts) ? store.accounts : []
    const settings = store?.settings || {}
    const plaintext = raw.toString('utf8')
    const secretForms = [
      payload.key,
      payload.bankAnon,
      ...payload.accounts.flatMap((account) => [account.username, account.password]),
    ].filter(Boolean)
    return {
      encryptionAvailable,
      keyMatches: settings.siliconflow_key === payload.key,
      bankMatches: settings.supabase_url === payload.bankOrigin && settings.supabase_anon === payload.bankAnon,
      accountsMatch: accounts.length === payload.accounts.length &&
        payload.accounts.every((expectedAccount) =>
          accounts.some((stored) =>
            stored.username === expectedAccount.username &&
            stored.password === expectedAccount.password &&
            stored.name === expectedAccount.alias)),
      workModesMatch: payload.accounts.every((expectedAccount) =>
        accounts.some((stored) => stored.username === expectedAccount.username && stored.work_mode === 'noqr')),
      displayMatches: payload.accounts.every((expectedAccount) =>
        accounts.some((stored) => stored.username === expectedAccount.username && stored.display_mode === payload.displayMode)),
      courseScopeMatches: payload.accounts.every((expectedAccount) =>
        accounts.some((stored) => stored.username === expectedAccount.username && stored.course_scope === payload.courseScope)),
      plaintextLeak: secretForms.some((value) => plaintext.includes(value)),
    }
  }, expected)
}

async function configureIsolatedProduct(product, config, credentials, bank) {
  const payload = {
    settings: {
      siliconflow_key: credentials.aiKey,
      supabase_url: bank.origin,
      supabase_anon: bank.anon,
      account_parallel: config.accountParallel,
      course_parallel: config.courseParallel,
      browser_visible_default: config.displayMode === 'visual',
      log_enabled: config.logEnabled,
    },
    accounts: config.accounts,
    displayMode: config.displayMode,
    courseScope: config.courseScope,
    answerRoundLimit: config.answerRoundLimit,
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const bridgeReady = await rendererCall(product,
      'Boolean(globalThis.kaida?.saveSettings && globalThis.kaida?.snapshot)').catch(() => false)
    if (bridgeReady) break
    await product.page.waitForTimeout(100)
  }
  const setupSource = `(async (value) => {
    if (!globalThis.kaida?.saveSettings) return { ok: false, step: 'bridge_missing' }
    const saved = await globalThis.kaida.saveSettings(value.settings)
    if (!saved.ok) return { ok: false, step: 'save_settings' }

    const ids = {}
    for (const account of value.accounts) {
      let rows = await window.kaida.listAccounts()
      let current = rows.find((row) => row.account === account.username)
      if (current) {
        const updated = await window.kaida.updateAccount(current.local_id, {
          name: account.alias,
          password: account.password,
        })
        if (!updated.ok) return { ok: false, step: 'update_account' }
      } else {
        const added = await window.kaida.addAccount({
          name: account.alias,
          username: account.username,
          password: account.password,
        })
        if (!added.ok) return { ok: false, step: 'add_account' }
      }
      rows = await window.kaida.listAccounts()
      current = rows.find((row) => row.account === account.username)
      if (!current) return { ok: false, step: 'read_account' }
      ids[account.alias] = current.local_id
    }

    for (const account of value.accounts) {
      const id = ids[account.alias]
      const mode = await window.kaida.setWorkMode(id, 'noqr')
      if (!mode.ok) return { ok: false, step: 'work_mode' }
      const display = await window.kaida.setDisplay(id, value.displayMode)
      if (!display.ok) return { ok: false, step: 'display_mode' }
      const scope = await window.kaida.setCourseScope(id, value.courseScope)
      if (!scope.ok) return { ok: false, step: 'course_scope' }
      const rounds = await window.kaida.setAnswerRoundLimit(id, value.answerRoundLimit)
      if (!rounds.ok) return { ok: false, step: 'answer_round_limit' }
    }
    return { ok: true, ids }
  })(${JSON.stringify(payload)})`
  const setup = await rendererCall(product, setupSource)

  if (!setup?.ok) fail('product_config_failed', `Product configuration failed at ${setup?.step || 'unknown'}`)

  const encrypted = await verifyEncryptedProductConfig(product.app, {
    key: credentials.aiKey,
    bankOrigin: bank.origin,
    bankAnon: bank.anon,
    accounts: config.accounts,
    displayMode: config.displayMode,
    courseScope: config.courseScope,
  })
  if (
    !encrypted.encryptionAvailable ||
    !encrypted.keyMatches ||
    !encrypted.bankMatches ||
    !encrypted.accountsMatch ||
    !encrypted.workModesMatch ||
    !encrypted.displayMatches ||
    !encrypted.courseScopeMatches ||
    encrypted.plaintextLeak
  ) {
    fail('safe_storage_verification_failed', 'Encrypted product configuration verification failed')
  }
  return setup.ids
}

async function launchIsolatedProduct(config, credentials, bank) {
  mkdirSync(PROFILE_ROOT, { recursive: true })
  const profileDir = mkdtempSync(join(PROFILE_ROOT, 't005-real-product-'))
  safeProfilePath(profileDir)
  let app
  try {
    app = await electron.launch({
      args: ['.'],
      env: buildProductChildEnv(process.env, profileDir, { forceRetry: config.forceRetry }),
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.kaida), null, { timeout: 30_000 })
    const product = { app, page, profileDir, ids: {}, displayEvidence: new Map() }
    await installPassiveNetworkMonitor(app)
    product.ids = await configureIsolatedProduct(product, config, credentials, bank)
    return product
  } catch (error) {
    if (app) await app.close().catch(() => {})
    removeProfile(profileDir)
    throw error
  }
}

async function readSnapshot(product) {
  return rendererCall(product, 'globalThis.kaida.snapshot()')
}

function studentForAlias(snapshot, alias) {
  return (Array.isArray(snapshot?.students) ? snapshot.students : [])
    .find((student) => student?.name === alias)
}

export function inspectConcurrencySnapshot(snapshot, aliases, accountParallel) {
  const requestedAliases = Array.isArray(aliases) ? aliases : []
  const limit = normalizeAccountParallel(accountParallel, 'concurrency')
  const students = requestedAliases.map((alias) => studentForAlias(snapshot, alias))
  const present = students.filter(Boolean)
  const heldCount = present.filter((student) => CAPACITY_HOLDING_SLOTS.has(student.slot)).length
  const occupiedCount = present.filter((student) => student.slot === 'occupied').length
  const queuedCount = present.filter((student) => student.slot === 'queued' || student.queued === true).length
  const releasedCount = present.filter((student) => student.slot === 'released').length
  return {
    limit,
    browserCount: Math.max(0, Number(snapshot?.machine?.browsers) || 0),
    presentCount: present.length,
    heldCount,
    occupiedCount,
    queuedCount,
    releasedCount,
    withinLimit: heldCount <= limit,
    queueObserved: queuedCount > 0,
    ready: requestedAliases.length > 0 &&
      present.length === requestedAliases.length &&
      heldCount === limit &&
      queuedCount > 0 &&
      heldCount <= limit,
    allReleased: requestedAliases.length > 0 &&
      present.length === requestedAliases.length &&
      releasedCount === requestedAliases.length,
  }
}

function snapshotDiagnostics(config, snapshot) {
  const includeDebug = process.env.KAIDA_T005_DEBUG_DIAGNOSTICS === '1'
  return {
    running: Boolean(snapshot?.running),
    students: config.accounts.map((account) => {
      const student = studentForAlias(snapshot, account.alias)
      return {
        ...diagnosticsForStudent(account.alias, student),
        ...(includeDebug ? { debug: debugDiagnosticsForStudent(account.alias, student) } : {}),
      }
    }),
  }
}

function logEvent(event) {
  console.log(JSON.stringify(event))
}

async function startViaPrimaryAction(product) {
  await clickPrimaryAction(product)
}

async function stopAliases(product, aliases) {
  if (!product?.app || !product?.page) return
  const source = `(async ({ ids }) => {
    for (const id of ids) await window.kaida.stop(id)
  })(${JSON.stringify({ ids: aliases.map((alias) => product.ids[alias]) })})`
  await rendererCall(product, source).catch(() => {})
}

async function stopViaUi(product, accounts) {
  const selector = accounts.length === 1 ? '#tool-stop' : '#btn-stop-all'
  const button = product.page.locator(selector)
  await waitForLocatorEnabled(button, product.page)
  await button.click()
}

async function pollProduct(product, config, check, opts = {}) {
  const startedAt = Date.now()
  const lastProgress = new Map()
  const lastDebugIsolation = new Map()
  const includeDebug = process.env.KAIDA_T005_DEBUG_DIAGNOSTICS === '1'
  for (;;) {
    const snapshot = await readSnapshot(product)
    for (const account of config.accounts) {
      const student = studentForAlias(snapshot, account.alias)
      recordDisplayEvidence(product.displayEvidence, account.alias, student)
      const summary = summarizeStudentForLog(account.alias, student)
      const key = JSON.stringify(summary)
      if (lastProgress.get(account.alias) !== key) {
        lastProgress.set(account.alias, key)
        logEvent({
          event: 'product_state',
          ...summary,
          ...(includeDebug
            ? { debug: debugDiagnosticsForStudent(account.alias, student) }
            : {}),
        })
      }
      if (includeDebug && ['unsupported', 'needs_user'].includes(student?.phase)) {
        const debug = debugDiagnosticsForStudent(account.alias, student)
        const debugKey = JSON.stringify(debug.logCodes)
        if (lastDebugIsolation.get(account.alias) !== debugKey) {
          lastDebugIsolation.set(account.alias, debugKey)
          logEvent({ event: 'debug_isolation', ...debug })
        }
      }
    }
    const result = await check(snapshot)
    for (const account of config.accounts) {
      const student = studentForAlias(snapshot, account.alias)
      const terminalCode = terminalCodeFor(student)
      const terminalNeedsAttention = terminalCode === 'product_login_failed' || terminalCode === 'product_needs_user'
      const terminalEnded = student?.slot === 'released' || snapshot.running === false
      if (shouldFailTerminalBeforeTarget({
        terminalCode,
        terminalEnded,
        terminalNeedsAttention,
        allowTerminal: opts.allowTerminal === true,
        allowExplicitStop: opts.allowExplicitStop === true,
        targetReached: Boolean(result),
      })) {
        const diagnostics = snapshotDiagnostics(config, snapshot)
        logEvent({ event: 'terminal_before_target', code: terminalCode, ...diagnostics })
        fail(terminalCode, 'Product ended before reaching the target state', diagnostics)
      }
    }
    if (result) return { snapshot, result, elapsedMs: Date.now() - startedAt }
    if (
      opts.allowReleased !== true &&
      snapshot.running === false &&
      config.accounts.every((account) => studentForAlias(snapshot, account.alias)?.slot === 'released')
    ) {
      const diagnostics = snapshotDiagnostics(config, snapshot)
      logEvent({ event: 'released_before_target', code: 'phase_ended_before_target', ...diagnostics })
      fail('phase_ended_before_target', 'T005 real-product phase ended before reaching its target state', diagnostics)
    }
    if (Number.isFinite(config.maxRuntimeMs) && Date.now() - startedAt > config.maxRuntimeMs) {
      fail('phase_timeout', 'T005 real-product phase timed out')
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
}

async function waitForLogin(product, config) {
  return pollProduct(product, config, (snapshot) => config.accounts.every((account) => {
    const student = studentForAlias(snapshot, account.alias)
    return student && (LOGIN_SUCCESS_PHASES.has(student.phase) || student.account === 'logged_in')
  }))
}

async function waitForCourses(product, config) {
  return pollProduct(product, config, (snapshot) => config.accounts.every((account) => {
    const student = studentForAlias(snapshot, account.alias)
    return student && Array.isArray(student.courses) && student.courses.length > 0
  }))
}

async function waitForSelectionGate(product, config) {
  return pollProduct(product, config, (snapshot) => config.accounts.every((account) =>
    Boolean(studentForAlias(snapshot, account.alias)?.awaitingCourseSelection)))
}

async function selectFirstCourses(product, config) {
  const selectionDeadline = Date.now() + 120_000
  let snapshot = await readSnapshot(product)
  let plans = []
  for (;;) {
    plans = config.accounts.map((account) => {
      const student = studentForAlias(snapshot, account.alias)
      const courses = student?.courses || []
      const candidates = courses
        .filter((row) => noqrTestCourseTodoCount(row) > 0)
        .filter((row) => !config.courseMatch || row.name.includes(config.courseMatch))
        .sort((left, right) => config.courseStrategy === 'max-todo'
          ? noqrTestCourseTodoCount(right) - noqrTestCourseTodoCount(left) ||
            noqrTestCourseRowCount(right) - noqrTestCourseRowCount(left)
          : noqrTestCourseTodoCount(left) - noqrTestCourseTodoCount(right) ||
            noqrTestCourseRowCount(left) - noqrTestCourseRowCount(right))
      return {
        account,
        student,
        courses,
        candidates,
        course: chooseNoqrTestCourse(courses, config),
      }
    })
    if (plans.every((plan) => plan.course) || Date.now() >= selectionDeadline) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    snapshot = await readSnapshot(product)
  }
  const targets = []
  for (const { account, student, courses, candidates, course } of plans) {
    logEvent({
      phase: 'course_candidates',
      alias: account.alias,
      strategy: config.courseStrategy,
      courseMatchSet: Boolean(config.courseMatch),
      courses: courses.map((row) => ({
        name: String(row?.name || '').slice(0, 80),
        todoCount: noqrTestCourseTodoCount(row),
        rowCount: noqrTestCourseRowCount(row),
      })),
      candidates: candidates.map((row, index) => ({
        index: index + 1,
        todoCount: noqrTestCourseTodoCount(row),
        rowCount: noqrTestCourseRowCount(row),
      })),
    })
    if (config.courseMatch && !course) {
      fail('course_match_not_found', 'No course matched the requested test-only selector')
    }
    if (!course?.key || !course?.name) fail('course_selection_failed', 'No selectable course appeared in the product')
    const courseIndex = (student?.courses || []).indexOf(course)
    const occurrence = (student?.courses || [])
      .slice(0, courseIndex + 1)
      .filter((candidate) => candidate.name === course.name).length
    targets.push({ alias: account.alias, key: course.key, name: course.name, occurrence })
  }

  for (const target of targets) {
    await selectStudentInUi(product, target.alias)
    await clickCourseCard(product, target.name, target.occurrence)
    const startedAt = Date.now()
    for (;;) {
      const current = studentForAlias(await readSnapshot(product), target.alias)
      if ((current?.selectedCourseKeys || []).includes(target.key)) break
      if (Date.now() - startedAt > 30_000) {
        fail('course_selection_failed', 'Course click did not update the product selection state')
      }
      await product.page.waitForTimeout(100)
    }
  }
}

async function startSelectedCourses(product) {
  const label = (await product.page.locator('#play-text').textContent().catch(() => '')) || ''
  if (!label.includes('开始执行')) {
    fail('course_selection_start_failed', 'Product primary action did not enter the selected-course start state')
  }
  await clickPrimaryAction(product)
}

async function prepareSelectedCourses(product, config) {
  await waitForSelectionGate(product, config)
  await selectFirstCourses(product, config)
  await startSelectedCourses(product)
}

async function stopAndWaitReleased(product, config) {
  const current = await readSnapshot(product)
  if (
    current.running === false &&
    config.accounts.every((account) => studentForAlias(current, account.alias)?.slot === 'released')
  ) {
    return { snapshot: current, elapsedMs: 0 }
  }
  await stopViaUi(product, config.accounts)
  return pollProduct(
    product,
    config,
    (snapshot) =>
      snapshot.running === false &&
      config.accounts.every((account) => studentForAlias(snapshot, account.alias)?.slot === 'released'),
    { allowReleased: true, allowTerminal: true, allowExplicitStop: true },
  )
}

async function assertNoqrTimingUi(product, config) {
  if (config.phase !== 'score' || config.accounts.length !== 1) return false
  await selectStudentInUi(product, config.accounts[0].alias)
  const panels = product.page.locator('[data-noqr-timing]')
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
    if (await panels.count() > 0 && await panels.first().isVisible().catch(() => false)) break
    await product.page.waitForTimeout(100)
  }
  if (await panels.count() === 0 || !(await panels.first().isVisible().catch(() => false))) {
    fail('timing_ui_missing', 'Completed homework did not render the no-QR timing panel')
  }
  const text = (await panels.first().textContent().catch(() => '')) || ''
  const values = text.match(/\d+分\d{2}秒/g) || []
  if (!/平均每题/.test(text) || !/最长单题/.test(text) || !/作业总时长/.test(text) || values.length !== 3) {
    fail('timing_ui_invalid', 'No-QR timing panel did not render three minute-second metrics')
  }
  return true
}

export function normalHomeworkSlotFailure(student) {
  const homeworks = Array.isArray(student?.homeworkQuestionKindSlotCounts)
    ? student.homeworkQuestionKindSlotCounts
    : []
  if (homeworks.some((item) => {
    const counts = safeQuestionKindCounts(item?.questionKindSlotCounts)
    return REQUIRED_NORMAL_QUESTION_KINDS.every((kind) => safeCount(counts[kind]) > 0)
  })) return null
  return {
    code: 'normal_question_slots_missing',
    missingKinds: REQUIRED_NORMAL_QUESTION_KINDS.filter((kind) =>
      !homeworks.some((item) => safeCount(item?.questionKindSlotCounts?.[kind]) > 0)),
    evidence: homeworks.map((item) => ({
      index: safeCount(item?.index),
      questionKindSlotCounts: safeQuestionKindCounts(item?.questionKindSlotCounts),
    })),
  }
}

export function normalHomeworkSlotFailures(accounts, summaries, requireNormalKinds = true) {
  return (Array.isArray(accounts) ? accounts : []).flatMap((account, index) => {
    if (account?.kind !== 'normal') return []
    const summary = summaries?.[index]
    if (requireNormalKinds === false) {
      const hasNormalSlot = REQUIRED_NORMAL_QUESTION_KINDS.some((kind) =>
        safeCount(summary?.questionKindSlotCounts?.[kind]) > 0)
      if (hasNormalSlot) return []
      return [{
        alias: account.alias,
        code: 'normal_question_slots_missing',
        missingKinds: [...REQUIRED_NORMAL_QUESTION_KINDS],
        evidence: [],
      }]
    }
    const failure = normalHomeworkSlotFailure(summary)
    return failure ? [{ alias: account.alias, ...failure }] : []
  })
}

function assertEnglishHomeworkSlotEvidence(config, summaries) {
  const failures = englishHomeworkSlotFailures(config.accounts, summaries)
  if (!failures.length) return
  const { code, ...details } = failures[0]
  fail(
    code,
    'English score phase did not prove the minimum saved question slots for every required kind',
    details,
  )
}

function assertNormalHomeworkSlotEvidence(config, summaries) {
  const failures = normalHomeworkSlotFailures(
    config.accounts,
    summaries,
    config.requireNormalKinds,
  )
  if (!failures.length) return
  const { code, ...details } = failures[0]
  fail(
    code,
    config.requireNormalKinds === false
      ? 'Account sweep did not save any normal question slots'
      : 'Normal score phase did not prove single, multiple, and judge saved question slots',
    details,
  )
}

async function runConfiguredPhase(product, config) {
  if (config.phase === 'concurrency' && config.accounts.length <= config.accountParallel) {
    fail(
      'concurrency_queue_not_observable',
      'Concurrency phase requires more account aliases than the configured account parallel limit',
    )
  }
  await startViaPrimaryAction(product)

  if (config.phase === 'login') {
    await waitForLogin(product, config)
    await stopAndWaitReleased(product, config)
    return { loginObserved: true }
  }

  if (config.phase === 'courses') {
    await waitForCourses(product, config)
    if (config.courseScope === 'selected') {
      await waitForSelectionGate(product, config)
      await selectFirstCourses(product, config)
    }
    const stopped = await stopAndWaitReleased(product, config)
    const student = studentForAlias(stopped.snapshot, config.accounts[0].alias)
    const summary = summarizeStudentForLog(config.accounts[0].alias, student)
    if (!config.logEnabled) {
      if (!summary.lastLogs.length) {
        fail('log_summary_missing', 'Detailed logs are disabled but the status summary was not retained')
      }
      if (Array.isArray(student?.courseLogs) && student.courseLogs.length > 0) {
        fail('course_logs_not_disabled', 'Detailed logs are disabled but course logs were still recorded')
      }
    }
    return {
      coursesObserved: true,
      selectedCourseCount: config.courseScope === 'selected' ? 1 : null,
      logEnabled: config.logEnabled,
      logSummaryRetained: summary.lastLogs.length > 0,
      courseLogCount: Array.isArray(student?.courseLogs) ? student.courseLogs.length : 0,
    }
  }

  if (config.phase === 'stop') {
    await pollProduct(product, config, (snapshot) => config.accounts.every((account) => {
      const student = studentForAlias(snapshot, account.alias)
      return student?.slot === 'occupied' && ACTIVE_BROWSER_PHASES.has(student.phase)
    }))
    await stopAndWaitReleased(product, config)
    return { stopReleased: true }
  }

  if (config.phase === 'concurrency') {
    if (config.accountParallel !== 2) {
      fail('concurrency_parallel_not_two', 'Concurrency acceptance requires accountParallel=2')
    }
    const aliases = config.accounts.map((account) => account.alias)
    let queuedObserved = false
    let maxHeld = 0
    let maxBrowsers = 0
    await pollProduct(product, config, (snapshot) => {
      const state = inspectConcurrencySnapshot(snapshot, aliases, config.accountParallel)
      queuedObserved ||= state.queueObserved
      maxHeld = Math.max(maxHeld, state.heldCount)
      maxBrowsers = Math.max(maxBrowsers, state.browserCount)
      if (!state.withinLimit) {
        fail(
          'account_parallel_exceeded',
          'Concurrent account slots exceeded the configured account parallel limit',
          { limit: state.limit, heldCount: state.heldCount },
        )
      }
      return state.ready
    })
    const stopped = await stopAndWaitReleased(product, config)
    const finalState = inspectConcurrencySnapshot(stopped.snapshot, aliases, config.accountParallel)
    if (!finalState.allReleased) {
      fail('concurrency_stop_not_released', 'Concurrency phase did not release every account slot after stop')
    }
    if (!queuedObserved || maxHeld !== 2) {
      fail('concurrency_queue_not_observed', 'Concurrency phase did not observe two occupied and one queued account')
    }
    if (maxBrowsers !== 2) {
      fail('concurrency_browser_count_mismatch', 'Concurrency phase did not hold exactly two live browsers')
    }
    if (finalState.browserCount !== 0) {
      fail('concurrency_browsers_not_released', 'Concurrency phase left browsers alive after stop')
    }
    return {
      concurrentAccounts: config.accounts.length,
      accountParallel: config.accountParallel,
      queuedObserved,
      maxHeld,
      maxBrowsers,
      finalBrowsers: finalState.browserCount,
      allReleased: finalState.allReleased,
    }
  }

  if (config.courseScope === 'selected') await prepareSelectedCourses(product, config)

  if (config.phase === 'answer') {
    const progress = await pollProduct(product, config, (snapshot) => config.accounts.every((account) => {
      const student = studentForAlias(snapshot, account.alias)
      return Number(student?.bankCount || 0) + Number(student?.aiCount || 0) > 0
    }))
    await stopAndWaitReleased(product, config)
    return { answerProgressObserved: true, elapsedMs: progress.elapsedMs }
  }

  if (config.stopAfterScoreRound) {
    const scoreRoundHistory = new Map()
    const rememberScoreRounds = (snapshot) => {
      for (const account of config.accounts) {
        const student = studentForAlias(snapshot, account.alias)
        for (const item of noqrScoreRoundEvidence(student)) {
          const key = `${account.alias}:${item.homeworkIndex}:${item.attempt}`
          if (!scoreRoundHistory.has(key)) {
            scoreRoundHistory.set(key, {
              sequence: scoreRoundHistory.size + 1,
              alias: account.alias,
              homeworkIndex: item.homeworkIndex,
              attempt: item.attempt,
              score: item.score,
            })
          }
        }
      }
    }
    const scored = await pollProduct(product, config, (snapshot) => {
      rememberScoreRounds(snapshot)
      const history = [...scoreRoundHistory.values()]
      const targetReached = noqrScoreHistoryReached(
        history,
        config.accounts.map((account) => account.alias),
        config.stopAfterScoreRound,
      )
      if (targetReached) return { kind: 'score_round_reached' }
      const hasScored = noqrScoreHistoryReached(
        history,
        config.accounts.map((account) => account.alias),
        1,
      )
      const terminalAfterFirstScore = hasScored && config.accounts.every((account) => {
        const student = studentForAlias(snapshot, account.alias)
        return student?.phase === 'not_full' ||
          student?.phase === 'round_ended' ||
          student?.account === 'round_ended'
      })
      return terminalAfterFirstScore ? { kind: 'terminal_after_first_score' } : false
    }, { allowTerminal: true })
    const stopped = await stopAndWaitReleased(product, config)
    rememberScoreRounds(stopped.snapshot)
    const summaries = config.accounts.map((account) =>
      summarizeStudentForLog(account.alias, studentForAlias(stopped.snapshot, account.alias)))
    assertEnglishHomeworkSlotEvidence(config, summaries)
    assertNormalHomeworkSlotEvidence(config, summaries)
    const history = [...scoreRoundHistory.values()]
    const retryObserved = config.accounts.every((account) => {
      const rounds = history.filter((item) => item.alias === account.alias)
      const byHomework = new Map()
      for (const item of rounds) {
        const rows = byHomework.get(item.homeworkIndex) || []
        rows.push(item)
        byHomework.set(item.homeworkIndex, rows)
      }
      return [...byHomework.values()].some((rows) => {
        const ordered = rows.sort((left, right) => left.attempt - right.attempt)
        return ordered[0]?.score < 100 && ordered.some((item) => item.attempt > ordered[0].attempt)
      })
    })
    return {
      scoreObserved: true,
      stopAfterScoreRound: config.stopAfterScoreRound,
      scoreRoundReached: scored.result.kind === 'score_round_reached',
      terminalAfterFirstScore: scored.result.kind === 'terminal_after_first_score',
      reanswerObserved: retryObserved,
      scoreRoundHistory: history,
      summaries,
    }
  }

  const finished = await pollProduct(product, config, (snapshot) =>
    snapshot.running === false &&
    config.accounts.every((account) => studentForAlias(snapshot, account.alias)?.slot === 'released'),
  { allowReleased: true, allowTerminal: true })
  const summaries = config.accounts.map((account) =>
    summarizeStudentForLog(account.alias, studentForAlias(finished.snapshot, account.alias)))
  if (!summaries.every((summary) => summary.scoredHomeworkCount > 0)) {
    fail('score_missing', 'No read-only score was produced by the real-product score phase')
  }
  for (const [index, account] of config.accounts.entries()) {
    if (summaries[index]?.timedHomeworkCount === 0 || summaries[index]?.timingMissingHomeworkCount > 0) {
      fail(
        'timing_evidence_missing',
        'Score phase did not record the three timing metrics for every completed homework',
        {
          alias: account.alias,
          timedHomeworkCount: summaries[index]?.timedHomeworkCount || 0,
          timingMissingHomeworkCount: summaries[index]?.timingMissingHomeworkCount || 0,
        },
      )
    }
  }
  assertEnglishHomeworkSlotEvidence(config, summaries)
  assertNormalHomeworkSlotEvidence(config, summaries)
  const timingUiObserved = await assertNoqrTimingUi(product, config)
  return { scoreObserved: true, timingUiObserved, summaries }
}

async function closeProduct(product, aliases) {
  if (!product) return
  await stopAliases(product, aliases)
  await product.app.close().catch(() => {})
  removeProfile(product.profileDir)
}

async function runHarness(config, credentials) {
  const startedAt = Date.now()
  let bank
  let product
  try {
    const installedBank = config.bankSource === 'installed'
      ? await readInstalledBankSettings()
      : null
    bank = await createGetOnlyBankService(installedBank)
    product = await launchIsolatedProduct(config, credentials, bank)
    logEvent({
      phase: 'setup',
      aliases: config.accounts.map((account) => account.alias),
      accountCount: config.accounts.length,
      accountParallel: config.accountParallel,
      displayMode: config.displayMode,
      courseScope: config.courseScope,
      courseMatchSet: Boolean(config.courseMatch),
      testPhase: config.phase,
      answerRoundLimit: config.answerRoundLimit,
      forceRetry: config.forceRetry,
      stopAfterScoreRound: config.stopAfterScoreRound,
      logEnabled: config.logEnabled,
      encryptedConfig: true,
      bankMode: bank.hasUpstream ? 'get_only_installed_proxy' : 'get_only_empty',
    })

    let outcome
    try {
      outcome = await runConfiguredPhase(product, config)
    } catch (error) {
      const failureNetwork = await readPassiveNetworkSummary(product.app).catch(() => null)
      if (failureNetwork) {
        logEvent({
          phase: 'failure_network',
          aliases: config.accounts.map((account) => account.alias),
          testPhase: config.phase,
          answerPageRequests: failureNetwork.answerPageRequests,
          mutationRequests: failureNetwork.mutationRequests,
          mutationAccepted: failureNetwork.mutationAccepted,
          mutationFailures: failureNetwork.mutationFailures,
          mutationUncertain: failureNetwork.mutationUncertain,
          mutationRequestLedger: failureNetwork.mutationRequestLedger,
          mutationMaxDurationMs: failureNetwork.mutationMaxDurationMs,
        })
      }
      throw error
    }
    const bankStats = bank.stats()
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    const network = await readPassiveNetworkSummary(product.app)
    const saveRequests = network.mutationRequests.submit_one + network.mutationRequests.submit_all
    const saveAccepted = network.mutationAccepted.submit_one + network.mutationAccepted.submit_all
    const saveRequestLedger = [
      ...network.mutationRequestLedger.submit_one,
      ...network.mutationRequestLedger.submit_all,
    ]
    const saveRequestAudit = analyzeNoqrSaveRequestLedger(saveRequestLedger)
    if (bankStats.POST || bankStats.PATCH || bankStats.DELETE || bankStats.OTHER) {
      fail('bank_write_detected', 'Read-only bank service received a non-GET request')
    }
    if (network.unsupportedAnswerWorkTypeCount > 0) {
      fail('unsupported_work_type_observed', 'Answer page used a workType outside the confirmed whitelist')
    }
    const loginReuseFailure = noqrLoginReuseFailure(network, config.accounts.length)
    if (loginReuseFailure) {
      fail(
        loginReuseFailure,
        'The same product run submitted login credentials more times than accounts',
        {
          accountCount: config.accounts.length,
          loginSubmissionRequests: network.loginSubmissionRequests,
        },
      )
    }
    if ((config.phase === 'answer' || config.phase === 'score') && network.answerPageRequests === 0) {
      fail('answer_page_not_observed', 'Answer phase did not reach a real answer page')
    }
    if ((config.phase === 'answer' || config.phase === 'score') && bankStats.GET === 0) {
      fail('bank_get_missing', 'Answer phase did not issue the required read-only bank GET')
    }
    if (config.phase === 'concurrency') {
      if (
        config.accountParallel !== 2 ||
        outcome.maxBrowsers !== 2 ||
        network.browserContexts < 2 ||
        network.browserContexts > config.accounts.length
      ) {
        fail('concurrency_browser_evidence_mismatch', 'Concurrency phase browser evidence does not match accountParallel=2', {
          accountParallel: config.accountParallel,
          maxBrowsers: outcome.maxBrowsers,
          browserContexts: network.browserContexts,
          accountCount: config.accounts.length,
        })
      }
      if (outcome.finalBrowsers !== 0) {
        fail('concurrency_browser_release_missing', 'Concurrency phase did not release both browser contexts')
      }
    }
    if (config.phase !== 'login') {
      const expectedVisible = config.displayMode === 'visual'
      const visibilityObserved = displayEvidenceCount(
        product.displayEvidence,
        config.accounts.map((account) => account.alias),
        expectedVisible,
      )
      const requiredVisibilityCount = config.phase === 'concurrency'
        ? config.accountParallel
        : config.accounts.length
      if (visibilityObserved < requiredVisibilityCount) {
        fail('display_mode_not_observed', 'Product browser visibility did not match the configured display mode', {
          mode: config.displayMode,
          expected: requiredVisibilityCount,
          observed: visibilityObserved,
        })
      }
    }
    if (saveRequestLedger.length !== saveRequests) {
      fail('save_request_ledger_incomplete', 'Save request counts and request-level ledger disagree', {
        saveRequests,
        ledgerRequests: saveRequestLedger.length,
      })
    }
    let siteGeneratedFinalDuplicate = false
    if (saveRequestAudit.hardFailure) {
      const debugSnapshot = await readSnapshot(product)
      const debugDiagnostics = config.accounts.map((account) =>
        debugDiagnosticsForStudent(account.alias, studentForAlias(debugSnapshot, account.alias)))
      const saveClickAttempts = config.accounts.reduce((total, account) =>
        total + safeCount(studentForAlias(debugSnapshot, account.alias)?.saveClickAttempts), 0)
      const saveRequestRetries = config.accounts.reduce((total, account) =>
        total + safeCount(studentForAlias(debugSnapshot, account.alias)?.saveRequestRetries), 0)
      siteGeneratedFinalDuplicate = isSiteGeneratedFinalDuplicate(
        saveRequestAudit,
        saveClickAttempts,
        saveRequestRetries,
      )
      if (siteGeneratedFinalDuplicate) {
        logEvent({
          event: 'site_generated_final_duplicate',
          failureCode: saveRequestAudit.failureCode,
          saveClickAttempts,
          saveRequestRetries,
          uniqueQuestionCount: saveRequestAudit.uniqueQuestionCount,
          requestCount: saveRequestAudit.requestCount,
        })
      } else {
        fail(
          saveRequestAudit.failureCode,
          saveRequestAudit.failureCode === 'duplicate_save_question_request'
            ? 'Answer phase observed a repeated question in the same browser context'
            : saveRequestAudit.failureCode === 'save_page_attribution_missing'
              ? 'A save request lacked safe context, page, sequence, or monitor-offset attribution'
              : 'A save request lacked a safe question identity association',
          { requestAudit: saveRequestAudit, debugDiagnostics },
        )
      }
    }
    if (config.phase === 'score') {
      const scoreNetworkFailure = noqrScoreNetworkFailure(
        network,
        siteGeneratedFinalDuplicate,
        expectedNoqrScoreFinishRequests(config, outcome),
      )
      if (scoreNetworkFailure) {
        const reasons = {
          save_network_evidence_missing: 'Score phase did not capture an accepted save request',
          finish_request_count_mismatch: 'Score phase FinishJsonAsync requests did not match the scored round count',
          mutation_network_uncertain: 'Score phase contained failed, rejected, uncertain, or incomplete mutation requests',
          duplicate_save_request: 'Answer phase observed a repeated save body',
          duplicate_finish_request: 'Score phase observed a repeated Finish request body',
          mutation_request_pending: 'A mutation request was still pending when the score phase ended',
        }
        fail(
          scoreNetworkFailure,
          reasons[scoreNetworkFailure] || 'Score phase mutation evidence failed its gate',
        )
      }
      const pacingViolations = noqrPacingViolationCount(saveRequestLedger, 1_500)
      if (pacingViolations > 0) {
        const pacingEvidence = saveRequestLedger
          .filter((entry) => entry?.outcome === 'accepted' && entry?.questionFingerprint)
          .map((entry) => ({
            requestId: entry.requestId,
            kind: entry.kind,
            contextSequence: entry.contextSequence,
            pageSequence: entry.pageSequence,
            attemptFingerprint: entry.attemptFingerprint,
            questionFingerprint: entry.questionFingerprint,
            monitorOffsetMs: entry.monitorOffsetMs,
          }))
        fail(
          'pacing_interval_too_short',
          'Successful distinct questions advanced faster than the normal pacing floor',
          { pacingViolations, pacingEvidence },
        )
      }
    }

    logEvent({
      phase: 'complete',
      testPhase: config.phase,
      layer: config.displayMode === 'visual' ? 'E5' : 'E4',
      fixtureRouting: false,
      productEntry: 'primary_action',
      schoolHost: 'coursework.shou.org.cn',
      aliases: config.accounts.map((account) => account.alias),
      elapsedMs: Date.now() - startedAt,
      answerRoundLimit: config.answerRoundLimit,
      forceRetry: config.forceRetry,
      stopAfterScoreRound: config.stopAfterScoreRound,
      bank: bankStats,
      answerPageRequests: network.answerPageRequests,
      maxActiveAnswerPages: network.maxActiveAnswerPages,
      answerWorkTypes: network.answerWorkTypes,
      browserContexts: network.browserContexts,
      browserExecutable: network.browserExecutable,
      loginSubmissionRequests: network.loginSubmissionRequests,
      loginSubmissionResponses: network.loginSubmissionResponses,
      loginSubmissionFailures: network.loginSubmissionFailures,
      mutationRequests: network.mutationRequests,
      mutationAccepted: network.mutationAccepted,
      mutationFailures: network.mutationFailures,
      mutationUncertain: network.mutationUncertain,
      mutationDuplicateBodyRequests: network.mutationDuplicateBodyRequests,
      mutationDuplicateQuestionRequests: network.mutationDuplicateQuestionRequests,
      mutationUniqueQuestionRequests: network.mutationUniqueQuestionRequests,
      mutationRequestLedger: network.mutationRequestLedger,
      saveRequestAudit,
      pacingViolationCount: noqrPacingViolationCount(saveRequestLedger, 1_500),
      mutationMaxDurationMs: network.mutationMaxDurationMs,
      encryptedConfig: true,
      logEnabled: config.logEnabled,
      outcome,
    })
    return { ok: true, ...outcome }
  } finally {
    try {
      await closeProduct(product, config.accounts.map((account) => account.alias))
    } finally {
      if (bank) await bank.close().catch(() => {})
    }
  }
}

function parseCli(argv) {
  const options = { preflight: false }
  for (const arg of argv) {
    if (arg === '--preflight') {
      options.preflight = true
      continue
    }
    fail('cli_invalid', 'Unknown T005 real-product option')
  }
  return options
}

async function entry() {
  const options = parseCli(process.argv.slice(2))
  const goalFile = process.env.T005_GOAL_FILE || T005_DEFAULT_GOAL_FILE
  const credentials = readT005Credentials(goalFile)
  const config = normalizeHarnessConfig(process.env, credentials)
  if (options.preflight) {
    console.log(JSON.stringify(preflightSummary(config, credentials)))
    return
  }
  await runHarness(config, credentials)
}

if (IS_MAIN) {
  entry().catch((error) => {
    const code = error instanceof T005HarnessError || error instanceof T005CredentialError
      ? error.code
      : 'harness_failed'
    const diagnostics = error instanceof T005HarnessError ? error.details : undefined
    console.error(JSON.stringify({
      ok: false,
      phase: 'real_product',
      code,
      ...(diagnostics ? { diagnostics } : {}),
    }))
    process.exitCode = 1
  })
}
