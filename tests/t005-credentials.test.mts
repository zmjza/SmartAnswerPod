import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  T005_DEFAULT_GOAL_FILE,
  T005CredentialError,
  applyT005RuntimeConfig,
  parseT005Credentials,
  selectT005Account,
  t005ElectronEnv,
} from './helpers/t005-credentials.mjs'

const FIXTURE_KEY = ['fixture', 'key', 'alpha'].join('-')
const ENGLISH_USER = 'fixture-english-001'
const ENGLISH_PASSWORD = ['fixture', 'pass', 'english'].join('-')
const NORMAL_ONE_USER = 'fixture-normal-001'
const NORMAL_ONE_PASSWORD = ['fixture', 'pass', 'normal1'].join('-')
const NORMAL_TWO_USER = 'fixture-normal-002'
const NORMAL_TWO_PASSWORD = ['fixture', 'pass', 'normal2'].join('-')
const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function fixtureGoalText() {
  return [
    '以下是提供真机测试的资料：',
    `ai的apikey：${FIXTURE_KEY}`,
    '大学英语专属题型账号密码：',
    `账号：${ENGLISH_USER}`,
    `密码：${ENGLISH_PASSWORD}`,
    '',
    '正常题型账号密码（优先选择无限制的作业）：',
    `账号：${NORMAL_ONE_USER}`,
    `密码：${NORMAL_ONE_PASSWORD}`,
    '',
    `账号：${NORMAL_TWO_USER}`,
    `密码：${NORMAL_TWO_PASSWORD}`,
    '',
    `账号：${NORMAL_ONE_USER}`,
    `密码：${NORMAL_ONE_PASSWORD}`,
    '',
  ].join('\n')
}

test('T005-CRED-01 parses AI key and assigns stable de-identified account aliases', () => {
  assert.equal(T005_DEFAULT_GOAL_FILE, '')
  const credentials = parseT005Credentials(fixtureGoalText())
  assert.equal(credentials.aiKey, FIXTURE_KEY)
  assert.deepEqual(credentials.accounts.map((account) => account.alias), ['NOQR-EN', 'NOQR-01', 'NOQR-02'])
  assert.deepEqual(credentials.accounts.map((account) => account.kind), ['english', 'normal', 'normal'])
  assert.equal(credentials.normal.length, 2)
  assert.equal(credentials.english.length, 1)
  assert.equal(selectT005Account(credentials).alias, 'NOQR-01')
  assert.equal(selectT005Account(credentials, 'NOQR-EN').kind, 'english')

  const entityTab = parseT005Credentials(
    fixtureGoalText().replace(`账号：${NORMAL_ONE_USER}`, `账号：${NORMAL_ONE_USER}&#x9;`),
  )
  assert.equal(selectT005Account(entityTab, 'NOQR-01').username, NORMAL_ONE_USER)
})

test('T005-CRED-02 runtime injection is in-memory and restores the previous environment', () => {
  const credentials = parseT005Credentials(fixtureGoalText())
  const env = { KAIDA_SILICONFLOW_KEY: 'previous-runtime-key' }
  const restore = applyT005RuntimeConfig(credentials, env)
  assert.equal(env.KAIDA_SILICONFLOW_KEY, FIXTURE_KEY)
  restore()
  assert.equal(env.KAIDA_SILICONFLOW_KEY, 'previous-runtime-key')

  const base = { SAFE_FLAG: '1' }
  const electronEnv = t005ElectronEnv(credentials, base)
  assert.equal(electronEnv.KAIDA_SILICONFLOW_KEY, FIXTURE_KEY)
  assert.equal(base.KAIDA_SILICONFLOW_KEY, undefined)
})

test('T005-CRED-03 rejects missing, unresolved, ambiguous, and unknown credentials without echoing values', () => {
  const unresolvedKey = ['{{', 'fixture', 'unresolved', '}}'].join('')
  const invalidKey = fixtureGoalText().replace(FIXTURE_KEY, unresolvedKey)
  assert.throws(
    () => parseT005Credentials(invalidKey),
    (error) => error instanceof T005CredentialError
      && error.code === 'ai_key_invalid'
      && !error.message.includes(unresolvedKey),
  )

  const conflictPassword = ['fixture', 'pass', 'conflict'].join('-')
  const conflicting = fixtureGoalText().replace(
    `账号：${NORMAL_ONE_USER}\n密码：${NORMAL_ONE_PASSWORD}`,
    `账号：${NORMAL_ONE_USER}\n密码：${conflictPassword}`,
  )
  assert.throws(
    () => parseT005Credentials(conflicting),
    (error) => error instanceof T005CredentialError
      && error.code === 'account_conflict'
      && !error.message.includes(NORMAL_ONE_USER)
      && !error.message.includes(conflictPassword),
  )

  const crossSection = fixtureGoalText().replace(
    `账号：${NORMAL_ONE_USER}\n密码：${NORMAL_ONE_PASSWORD}`,
    `账号：${ENGLISH_USER}\n密码：${ENGLISH_PASSWORD}`,
  )
  assert.throws(
    () => parseT005Credentials(crossSection),
    (error) => error instanceof T005CredentialError
      && error.code === 'account_cross_section_duplicate'
      && !error.message.includes(ENGLISH_USER)
      && !error.message.includes(ENGLISH_PASSWORD),
  )

  const credentials = parseT005Credentials(fixtureGoalText())
  assert.throws(
    () => selectT005Account(credentials, 'NOQR-99'),
    (error) => error instanceof T005CredentialError && error.code === 'account_not_found',
  )
})

test('T005-CRED-04 recon preflight is offline and emits no credential material', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't005-credentials-'))
  const goalFile = join(dir, 'goal-objective.md')
  const profileRoot = join(PROJECT_ROOT, '.playwright')
  const profileCount = () => existsSync(profileRoot)
    ? readdirSync(profileRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('t005-recon-')).length
    : 0
  const profilesBefore = profileCount()
  writeFileSync(goalFile, fixtureGoalText())
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolveRun, rejectRun) => {
      execFile(
        process.execPath,
        ['--experimental-strip-types', 'tests/t005-real-recon.mjs', '--preflight', '--account=NOQR-EN'],
        {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            T005_GOAL_FILE: goalFile,
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

    const output = result.stdout.trim().split('\n').at(-1) || ''
    const report = JSON.parse(output)
    assert.equal(report.ok, true)
    assert.equal(report.phase, 'preflight')
    assert.equal(report.aiKeyLoaded, true)
    assert.equal(report.normalCount, 2)
    assert.equal(report.englishCount, 1)
    assert.deepEqual(report.aliases, ['NOQR-EN', 'NOQR-01', 'NOQR-02'])
    assert.equal(report.selectedAlias, 'NOQR-EN')
    assert.equal(report.selectedKind, 'english')
    assert.equal(result.stderr, '')
    assert.equal(profileCount(), profilesBefore, 'preflight created a browser profile')
    const combined = result.stdout + result.stderr
    for (const secret of [
      FIXTURE_KEY,
      ENGLISH_USER,
      ENGLISH_PASSWORD,
      NORMAL_ONE_USER,
      NORMAL_ONE_PASSWORD,
      NORMAL_TWO_USER,
      NORMAL_TWO_PASSWORD,
    ]) {
      assert.equal(combined.includes(secret), false, 'preflight output leaked credential material')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
