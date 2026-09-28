import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import { assertNoSecretKey, decryptFromFile, encryptToFile } from './secrets'
import { normalizeRunLimit } from './core/attempts'
import { PUBLIC_SUPABASE_ANON, PUBLIC_SUPABASE_URL } from './core/public-config'
import type { BankAccessState } from './core/bank-access'
type DisplayMode = 'headless' | 'visual'
type WorkMode = 'answer' | 'extract'
type CourseScope = 'all' | 'selected'

export type Settings = {
  siliconflow_key: string
  supabase_url: string
  supabase_anon: string
  account_parallel: number
  course_parallel: number
  browser_visible_default: boolean
  log_enabled: boolean
}

export type LocalAccount = {
  local_id: string
  name: string
  username: string
  password: string
  display_mode: DisplayMode
  work_mode: WorkMode
  course_scope: CourseScope
  answer_round_limit: number
  major?: string
  campus?: string
}

export type WritebackItem = {
  local_id: string
  course_name?: string
  homework_id: string
  preview_href?: string
  history_href: string
  need_insert_hashes: string[]
  need_delete_hashes: string[]
  candidates?: {
    no: string
    hash: string
    source: '题库答题' | 'AI 答题' | '空过'
    qtype: 'single' | 'multiple' | 'judge' | 'unknown'
    stem: string
    options: string[]
    selected: string[]
  }[]
  created_at: string
}

export type ExtractWritebackCandidate = {
  qtype: 'single' | 'multiple' | 'judge'
  stem: string
  options: string[]
  answer_texts: string[]
}

export type ExtractWritebackItem = {
  local_id: string
  course_name: string
  homework_id: string
  history_href: string
  candidates: ExtractWritebackCandidate[]
  created_at: string
}

export class ExtractWritebackSaveError extends Error {
  constructor() {
    super('提取题库待写入记录未能安全保存，停止本学生')
    this.name = 'ExtractWritebackSaveError'
  }
}

type Blob = {
  settings: Settings
  accounts: LocalAccount[]
  writeback: WritebackItem[]
  extract_writeback: ExtractWritebackItem[]
  reference_hashes?: string[]
  bank_access?: BankAccessState
}

const emptySettings = (): Settings => ({
  siliconflow_key: '',
  supabase_url: PUBLIC_SUPABASE_URL,
  supabase_anon: PUBLIC_SUPABASE_ANON,
  account_parallel: 2,
  course_parallel: 2,
  browser_visible_default: false,
  log_enabled: true,
})

function filePath() {
  return join(app.getPath('userData'), 'kaida-store.bin')
}

function load(): Blob {
  return decryptFromFile<Blob>(filePath(), { settings: emptySettings(), accounts: [], writeback: [], extract_writeback: [] })
}

export function getSettings(): Settings {
  return { ...emptySettings(), ...load().settings }
}

export function getBankAccessState(): BankAccessState {
  const state = load().bank_access
  return {
    failedAttempts: Math.max(0, Math.min(5, Number(state?.failedAttempts) || 0)),
    lockedUntil: Math.max(0, Number(state?.lockedUntil) || 0),
  }
}

export function saveBankAccessState(bank_access: BankAccessState) {
  const cur = load()
  return encryptToFile(filePath(), { ...cur, bank_access })
}

export function saveSettings(partial: Partial<Settings>): { ok: boolean; error?: string } {
  const cur = load()
  const next = { ...cur.settings, ...partial }
  if (!partial.siliconflow_key || partial.siliconflow_key === '********') next.siliconflow_key = cur.settings.siliconflow_key
  if (!partial.supabase_anon || partial.supabase_anon === '********') next.supabase_anon = cur.settings.supabase_anon
  try {
    assertNoSecretKey(next.supabase_anon)
    assertNoSecretKey(next.supabase_url)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '非法 Key' }
  }
  next.account_parallel = Math.min(8, Math.max(1, Number(next.account_parallel) || 2))
  next.course_parallel = Math.min(8, Math.max(1, Number(next.course_parallel) || 2))
  return encryptToFile(filePath(), { ...cur, settings: next })
}

export function listAccounts(): LocalAccount[] {
  return load().accounts.map((account) => ({
    ...account,
    course_scope: account.course_scope === 'selected' ? 'selected' : 'all',
    answer_round_limit: normalizeRunLimit(account.answer_round_limit),
  }))
}

export function addAccount(row: { name: string; username: string; password: string }): LocalAccount {
  const cur = load()
  const acc: LocalAccount = {
    local_id: randomUUID(),
    name: row.name,
    username: row.username,
    password: row.password,
    display_mode: cur.settings.browser_visible_default ? 'visual' : 'headless',
    work_mode: 'answer',
    course_scope: 'all',
    answer_round_limit: 10,
  }
  cur.accounts.push(acc)
  encryptToFile(filePath(), cur)
  return acc
}

export function removeAccount(local_id: string) {
  const cur = load()
  cur.accounts = cur.accounts.filter((a) => a.local_id !== local_id)
  encryptToFile(filePath(), cur)
}

export function patchAccount(local_id: string, patch: Partial<LocalAccount>) {
  const cur = load()
  if (patch.answer_round_limit !== undefined) patch.answer_round_limit = normalizeRunLimit(patch.answer_round_limit)
  cur.accounts = cur.accounts.map((a) => (a.local_id === local_id ? { ...a, ...patch } : a))
  encryptToFile(filePath(), cur)
}

export function getWriteback(local_id?: string): WritebackItem[] {
  const all = load().writeback
  return local_id ? all.filter((w) => w.local_id === local_id) : all
}

export function saveWriteback(items: WritebackItem[]) {
  const cur = load()
  const result = encryptToFile(filePath(), { ...cur, writeback: items })
  if (!result.ok) throw new Error('待回写记录未能安全保存，停止本学生')
}

export function getExtractWriteback(local_id?: string): ExtractWritebackItem[] {
  const all = load().extract_writeback || []
  return local_id ? all.filter((item) => item.local_id === local_id) : all
}

export function saveExtractWriteback(items: ExtractWritebackItem[]) {
  const cur = load()
  const result = encryptToFile(filePath(), { ...cur, extract_writeback: items })
  if (!result.ok) throw new ExtractWritebackSaveError()
}

export function isReferenceHashProtected(hash: string): boolean {
  if (!hash || !existsSync(filePath())) return false
  const fallback = {} as Blob
  const cur = decryptFromFile(filePath(), fallback)
  if (cur === fallback || !cur.settings || !Array.isArray(cur.accounts) || !Array.isArray(cur.writeback) ||
      (cur.reference_hashes !== undefined && !Array.isArray(cur.reference_hashes))) {
    throw new Error('参考答案保护记录无法读取')
  }
  return (cur.reference_hashes || []).includes(hash)
}

export function protectReferenceHash(hash: string): boolean {
  if (!hash) return false
  try { isReferenceHashProtected(hash) } catch { return false }
  const cur = load()
  if (cur.reference_hashes?.includes(hash)) return true
  const result = encryptToFile(filePath(), { ...cur, reference_hashes: [...(cur.reference_hashes || []), hash] })
  if (!result.ok) return false
  try { return isReferenceHashProtected(hash) } catch { return false }
}

export function profileDir(local_id: string) {
  return join(app.getPath('userData'), 'pw-profiles', local_id)
}

export function publicAccount(a: LocalAccount) {
  const u = a.username
  const masked = u.length >= 8 ? u.slice(0, 4) + '****' + u.slice(-4) : '****'
  return {
    local_id: a.local_id,
    name: a.name,
    studentNo: masked,
    display_mode: a.display_mode,
    work_mode: a.work_mode,
    course_scope: a.course_scope === 'selected' ? 'selected' : 'all',
    answer_round_limit: normalizeRunLimit(a.answer_round_limit),
    major: a.major || '',
    campus: a.campus || '',
  }
}
