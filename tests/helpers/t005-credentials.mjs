import { readFileSync } from 'node:fs'

export const T005_GOAL_FILE_ENV = 'T005_GOAL_FILE'
export const T005_DEFAULT_GOAL_FILE = ''

export const T005_AI_KEY_ENV = 'KAIDA_SILICONFLOW_KEY'

export class T005CredentialError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'T005CredentialError'
    this.code = code
  }
}

function fail(code, message) {
  throw new T005CredentialError(code, message)
}

function cleanValue(raw) {
  let value = String(raw || '').trim().replace(/\\+$/, '').trim()
  if (
    (value.startsWith('`') && value.endsWith('`')) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  return value
}

function validateValue(value, code) {
  if (
    value.length < 4 ||
    /\s/.test(value) ||
    /[{}<>]/.test(value) ||
    /^(?:null|undefined|redacted|secret)$/i.test(value)
  ) {
    fail(code, 'Credential value is missing or unresolved')
  }
  return value
}

export function normalizeT005GoalText(text) {
  return String(text || '')
    .replace(/&#(?:x0*9|9);/gi, '\t')
    .replace(/\\+\r?\n/g, '\n')
    .replaceAll('\\_', '_')
}

function readAiKey(text) {
  const values = [...text.matchAll(
    /^\s*ai\s*(?:的\s*)?api[\s_-]*key\s*[：:=]\s*(.+?)\s*$/gim,
  )].map((match) => cleanValue(match[1]))
  if (!values.length) fail('ai_key_missing', 'AI key is missing from the goal file')
  const unique = [...new Set(values)]
  if (unique.length !== 1) fail('ai_key_conflict', 'AI key appears more than once with different values')
  const key = validateValue(unique[0], 'ai_key_invalid')
  if (key.length < 12) fail('ai_key_invalid', 'AI key is too short')
  return key
}

function parseAccountPairs(section) {
  return [...section.matchAll(
    /(?:^|\n)[ \t]*账号[ \t]*[：:][ \t]*([^\s\\]+)[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*密码[ \t]*[：:][ \t]*([^\s\\]+)/g,
  )].map((match) => ({
    username: validateValue(cleanValue(match[1]), 'account_invalid'),
    password: validateValue(cleanValue(match[2]), 'password_invalid'),
  }))
}

function dedupeAccountPairs(rows) {
  const unique = new Map()
  for (const row of rows) {
    const previous = unique.get(row.username)
    if (previous && previous.password !== row.password) {
      fail('account_conflict', 'Duplicate account has conflicting passwords')
    }
    if (!previous) unique.set(row.username, row)
  }
  if (!unique.size) fail('accounts_missing', 'Account list is empty')
  return [...unique.values()]
}

function numberedAlias(prefix, index) {
  return prefix + String(index + 1).padStart(2, '0')
}

export function parseT005Credentials(text) {
  const normalized = normalizeT005GoalText(text)
  const englishStart = normalized.search(/大学英语专属题型账号密码/)
  const normalStart = normalized.search(/正常题型账号密码/)
  if (englishStart < 0 || normalStart < 0 || normalStart <= englishStart) {
    fail('sections_missing', 'English or normal account section is missing')
  }

  const englishRows = dedupeAccountPairs(parseAccountPairs(normalized.slice(englishStart, normalStart)))
  const normalRows = dedupeAccountPairs(parseAccountPairs(normalized.slice(normalStart)))
  const english = englishRows.map((row, index) => ({
    ...row,
    alias: index === 0 ? 'NOQR-EN' : `NOQR-EN-${String(index + 1).padStart(2, '0')}`,
    kind: 'english',
  }))
  const normal = normalRows.map((row, index) => ({
    ...row,
    alias: numberedAlias('NOQR-', index),
    kind: 'normal',
  }))
  const seen = new Map()
  for (const account of [...english, ...normal]) {
    const previous = seen.get(account.username)
    if (previous) {
      fail(
        previous.password === account.password
          ? 'account_cross_section_duplicate'
          : 'account_cross_section_conflict',
        'The same account appears in both English and normal sections',
      )
    }
    seen.set(account.username, account)
  }

  return {
    aiKey: readAiKey(normalized),
    accounts: [...english, ...normal],
    english,
    normal,
  }
}

export function readT005Credentials(goalFile = process.env[T005_GOAL_FILE_ENV] || T005_DEFAULT_GOAL_FILE) {
  if (!String(goalFile || '').trim()) {
    fail('goal_file_missing', 'T005_GOAL_FILE is required to read runtime credentials')
  }
  let text
  try {
    text = readFileSync(goalFile, 'utf8')
  } catch {
    fail('goal_file_unreadable', 'The configured T005 goal file could not be read')
  }
  return parseT005Credentials(text)
}

export function selectT005Account(credentials, alias = 'NOQR-01') {
  const selectedAlias = String(alias || '').trim().toUpperCase()
  if (!/^NOQR-(?:EN(?:-\d{2})?|\d{2})$/.test(selectedAlias)) {
    fail('account_not_found', 'The requested account alias is not valid')
  }
  const account = credentials.accounts.find((row) => row.alias === selectedAlias)
  if (!account) fail('account_not_found', 'The requested account alias is not present in the goal file')
  return account
}

export function applyT005RuntimeConfig(credentials, env = process.env) {
  if (!credentials?.aiKey) fail('ai_key_missing', 'AI key is unavailable for runtime injection')
  // The key must stay in process memory and must never be serialized or logged.
  const hadPrevious = Object.prototype.hasOwnProperty.call(env, T005_AI_KEY_ENV)
  const previous = env[T005_AI_KEY_ENV]
  env[T005_AI_KEY_ENV] = credentials.aiKey
  return () => {
    if (hadPrevious) env[T005_AI_KEY_ENV] = previous
    else delete env[T005_AI_KEY_ENV]
  }
}

export function t005ElectronEnv(credentials, baseEnv = process.env) {
  if (!credentials?.aiKey) fail('ai_key_missing', 'AI key is unavailable for Electron launch')
  return { ...baseEnv, [T005_AI_KEY_ENV]: credentials.aiKey }
}

export function summarizeT005Credentials(credentials, alias = 'NOQR-01') {
  const selected = selectT005Account(credentials, alias)
  return {
    aiKeyLoaded: Boolean(credentials.aiKey),
    aiKeySkPrefix: credentials.aiKey.startsWith('sk-'),
    normalCount: credentials.normal.length,
    englishCount: credentials.english.length,
    aliases: credentials.accounts.map((account) => account.alias),
    selectedAlias: selected.alias,
    selectedKind: selected.kind,
    selectedCredentialPresent: Boolean(selected.username && selected.password),
  }
}
