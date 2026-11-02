import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as credentialHelpers from './helpers/t005-credentials.mjs'
import { readT005Credentials } from './helpers/t005-credentials.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const goalEnvExportName = Object.keys(credentialHelpers)
  .find((name) => name.endsWith('_ENV') && name !== 'T005_AI_KEY_ENV')
if (!goalEnvExportName) throw new Error('T005 goal-file environment name is unavailable')
const goalEnvName = credentialHelpers[goalEnvExportName]
if (typeof goalEnvName !== 'string' || !goalEnvName) {
  throw new Error('T005 goal-file environment variable is unavailable')
}
const goalFile = process.env[goalEnvName] || credentialHelpers.T005_DEFAULT_GOAL_FILE
const credentials = readT005Credentials(goalFile)
const aliases = String(process.env.KAIDA_T005_SURVEY_ALIASES || '')
  .split(',')
  .map((item) => item.trim().toUpperCase())
  .filter(Boolean)
const selectedAliases = aliases.length ? aliases : credentials.accounts.map((account) => account.alias)
const parallel = Math.min(3, Math.max(1, Number(process.env.KAIDA_T005_SURVEY_PARALLEL) || 2))
const outputDir = join('/tmp', `t005-account-survey-${Date.now()}`)
mkdirSync(outputDir, { recursive: true })

function safeEnums(text) {
  const states = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('{"event":"product_state"')) continue
    try {
      const value = JSON.parse(line)
      if (value?.alias && value?.phase) states.push(value)
    } catch {
      // Ignore malformed or truncated diagnostic lines.
    }
  }
  return states
}

async function runAlias(alias) {
  const logPath = join(outputDir, `${alias}.log`)
  const stream = createWriteStream(logPath, { flags: 'w' })
  const env = {
    ...process.env,
    [goalEnvName]: goalFile,
    KAIDA_T005_PHASE: 'courses',
    KAIDA_TEST_ALIAS: alias,
    KAIDA_DISPLAY_MODE: 'headless',
    KAIDA_COURSE_SCOPE: 'selected',
    KAIDA_T005_COURSE_PARALLEL: '2',
    KAIDA_T005_ACCOUNT_PARALLEL: '1',
    KAIDA_T005_BANK_SOURCE: 'empty',
    KAIDA_T005_MAX_RUNTIME_MS: '900000',
    KAIDA_T005_LOG_ENABLED: '1',
    KAIDA_T005_DEBUG_DIAGNOSTICS: '1',
  }
  delete env.KAIDA_T005_FORCE_RETRY
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    'tests/t005-real-product.mjs',
  ], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(stream, { end: false })
  child.stderr.pipe(stream, { end: false })
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
  })
  await new Promise((resolveEnd) => stream.end(resolveEnd))
  const text = readFileSync(logPath, 'utf8')
  const states = safeEnums(text)
  const last = states.at(-1)
  const evidence = [...states].reverse().find((state) =>
    state?.debug &&
    (Object.keys(state.debug.courseStateCounts || {}).length > 0 ||
      Object.keys(state.debug.homeworkStateCounts || {}).length > 0)) || last
  const courseStateCounts = evidence?.debug?.courseStateCounts || {}
  const homeworkStateCounts = evidence?.debug?.homeworkStateCounts || {}
  const failedCourseStates = ['detection_failed', 'failed', 'unknown']
    .reduce((total, key) => total + (Number(courseStateCounts[key]) || 0), 0)
  const complete = text.split(/\r?\n/).some((line) =>
    line.startsWith('{"phase":"complete"') && line.includes('"coursesObserved":true'))
  const courses = Number(evidence?.debug?.courseCount) || Number(evidence?.courseCount) || 0
  return {
    alias,
    ok: exitCode === 0 && complete && courses > 0 && failedCourseStates === 0,
    exitCode,
    courses,
    homeworks: Number(evidence?.debug?.homeworkCount) || Number(evidence?.homeworkCount) || 0,
    courseStateCounts,
    homeworkStateCounts,
    failedCourseStates,
    phase: typeof last?.phase === 'string' ? last.phase : 'unknown',
    terminalCode: typeof last?.terminalCode === 'string' ? last.terminalCode : null,
    logPath,
  }
}

async function runPool() {
  const results = []
  let next = 0
  async function worker() {
    while (next < selectedAliases.length) {
      const index = next++
      const alias = selectedAliases[index]
      process.stderr.write(`[survey] start ${alias}\n`)
      const result = await runAlias(alias)
      results[index] = result
      console.log(JSON.stringify({ event: 'account_survey', ...result }))
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, selectedAliases.length) }, worker))
  return results
}

const results = await runPool()
const failed = results.filter((result) => !result?.ok)
console.log(JSON.stringify({
  phase: 'account_survey_complete',
  ok: failed.length === 0,
  accountCount: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  outputDir,
}))
if (failed.length) process.exitCode = 1
