import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const NOQR_PREFIX = 'electron/noqr/'
const COORDINATOR = 'electron/workbench-coordinator.ts'

const LEGACY_BUSINESS_FILES = new Set([
  'electron/runner.ts',
  'electron/answer.ts',
  'electron/submit.ts',
  'electron/review.ts',
  'electron/detect.ts',
  'electron/login.ts',
  'electron/page-tools.ts',
  'electron/core/selectors.ts',
])

const FORBIDDEN_NOQR_IMPORTS = new Set([
  'electron/runner',
  'electron/answer',
  'electron/submit',
  'electron/review',
  'electron/detect',
  'electron/login',
  'electron/page-tools',
  'electron/bank',
  'electron/ai',
  'electron/progress',
  'electron/core/selectors',
  'electron/core/writeback',
  'electron/core/bank-delete',
])

const FORBIDDEN_BANK_APIS = [
  'lookupByHash',
  'upsertQuestion',
  'deleteByHash',
  'reviewResults',
  'extractReviewedQuestions',
  'protectReferenceHash',
  'saveWriteback',
  'saveExtractWriteback',
]

const QUESTION_WRITE_PATTERNS = [
  /\bfrom\s*\(\s*['"`]questions['"`]\s*\)\s*\.\s*(?:insert|update|upsert|delete)\b/i,
  /\bfetch\s*\([\s\S]{0,500}?\/rest\/v1\/questions[\s\S]{0,700}?method\s*:\s*['"`](?:POST|PATCH|DELETE)['"`]/i,
  /\bmethod\s*:\s*['"`](?:POST|PATCH|DELETE)['"`][\s\S]{0,700}?\/rest\/v1\/questions/i,
]

type SourceMap = Record<string, string>

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function importSpecifiers(source: string): string[] {
  const specs = new Set<string>()
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specs.add(match[1])
    }
  }
  return [...specs]
}

function normalizeTarget(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier.replaceAll('\\', '/')
  return posix
    .normalize(posix.join(posix.dirname(file), specifier))
    .replace(/\.(?:ts|tsx|mts|js|mjs|cjs)$/, '')
}

function isNoqrTarget(target: string): boolean {
  return target === NOQR_PREFIX.slice(0, -1) || target.startsWith(NOQR_PREFIX)
}

function questionWriteDetected(source: string): boolean {
  return QUESTION_WRITE_PATTERNS.some((pattern) => pattern.test(source))
}

export function scanNoqrBoundary(sources: SourceMap): string[] {
  const issues: string[] = []

  for (const [file, source] of Object.entries(sources)) {
    const code = withoutComments(source)
    const targets = importSpecifiers(source).map((specifier) => normalizeTarget(file, specifier))

    if (LEGACY_BUSINESS_FILES.has(file)) {
      if (/\bnoqr\b/i.test(code)) {
        issues.push(`${file}: 旧 answer/extract 业务文件不得出现 noqr 分支`)
      }
      if (targets.some(isNoqrTarget)) {
        issues.push(`${file}: 旧业务文件不得 import electron/noqr`)
      }
    }

    if (file.startsWith(NOQR_PREFIX)) {
      for (const target of targets) {
        if (FORBIDDEN_NOQR_IMPORTS.has(target)) {
          issues.push(`${file}: noqr 不得 import 旧业务 ${target}`)
        }
      }
      for (const api of FORBIDDEN_BANK_APIS) {
        if (new RegExp(`\\b${api}\\b`).test(code)) {
          issues.push(`${file}: noqr 不得调用题库写/旧状态 API ${api}`)
        }
      }
      if (questionWriteDetected(code)) {
        issues.push(`${file}: noqr 不得向 questions 发起 POST/PATCH/DELETE`)
      }
    }

    if (file !== COORDINATOR && targets.some(isNoqrTarget) && targets.includes('electron/runner')) {
      issues.push(`${file}: 只有 workbench-coordinator 可同时引用旧 runner 和 noqr`)
    }
  }

  return issues
}

function readSourceTree(rootRelative: string): SourceMap {
  const root = join(REPO_ROOT, rootRelative)
  if (!existsSync(root)) return {}
  const sources: SourceMap = {}

  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const fullPath = join(directory, name)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (!/\.(?:ts|mts)$/.test(name)) continue
      const repoPath = relative(REPO_ROOT, fullPath).split(sep).join('/')
      sources[repoPath] = readFileSync(fullPath, 'utf8')
    }
  }

  walk(root)
  return sources
}

test('T005-I01 当前真实源码基线满足 noqr 静态隔离', () => {
  assert.deepEqual(scanNoqrBoundary(readSourceTree('electron')), [])
})

test('T005-I02 旧 answer/extract 业务出现 noqr 引用会被静态检查拒绝', () => {
  const issues = scanNoqrBoundary({
    'electron/runner.ts': "import { runNoqr } from './noqr/run.ts'\nexport const mode = 'noqr'\n",
  })
  assert.ok(issues.some((issue) => issue.includes('electron/runner.ts')))
})

test('T005-I03 noqr 反向 import 旧业务会被静态检查拒绝', () => {
  const issues = scanNoqrBoundary({
    'electron/noqr/answer.ts': "import { lookupByHash } from '../bank.ts'\n",
  })
  assert.ok(issues.some((issue) => issue.includes('electron/bank')))
})

test('T005-I04 noqr 调用题库写 API 或 Supabase 写请求会被静态检查拒绝', () => {
  const apiIssues = scanNoqrBoundary({
    'electron/noqr/answer.ts': 'export async function writeBank() { return upsertQuestion({}) }\n',
  })
  assert.ok(apiIssues.some((issue) => issue.includes('upsertQuestion')))

  const networkIssues = scanNoqrBoundary({
    'electron/noqr/answer.ts': "fetch('/rest/v1/questions', { method: 'POST', body: '{}' })\n",
  })
  assert.ok(networkIssues.some((issue) => issue.includes('POST/PATCH/DELETE')))

  const supabaseIssues = scanNoqrBoundary({
    'electron/noqr/answer.ts': "supabase.from('questions').upsert({ id: 'fake' })\n",
  })
  assert.ok(supabaseIssues.some((issue) => issue.includes('POST/PATCH/DELETE')))
})

test('T005-I05 组合根可桥接两侧，其他文件同时引用两侧会被拒绝', () => {
  const coordinatorSources = {
    'electron/workbench-coordinator.ts': "import './runner.ts'\nimport './noqr/run.ts'\n",
    'electron/noqr/run.ts': 'export const run = () => undefined\n',
  }
  assert.deepEqual(scanNoqrBoundary(coordinatorSources), [])

  const leakageIssues = scanNoqrBoundary({
    ...coordinatorSources,
    'electron/main.ts': "import './runner.ts'\nimport './noqr/run.ts'\n",
  })
  assert.ok(leakageIssues.some((issue) => issue.includes('electron/main.ts')))
})

test('T005-I06 旧 runner 只接受 answer/extract 工作模式，不回退渲染 noqr', () => {
  const runner = readFileSync(join(REPO_ROOT, 'electron/runner.ts'), 'utf8')
  const coordinator = readFileSync(join(REPO_ROOT, COORDINATOR), 'utf8')

  assert.match(runner, /type LegacyWorkMode/)
  assert.match(runner, /workMode:\s*LegacyWorkMode/)
  assert.doesNotMatch(runner, /workMode:\s*LocalAccount\[['"]work_mode['"]\]/)
  assert.match(runner, /normalizeLegacyWorkMode/)
  assert.match(
    coordinator,
    /if\s*\(\s*mode\s*===\s*['"]noqr['"]\s*\)[\s\S]{0,700}?return null/,
    'noqr 独立视图缺失时必须明确返回空，不得回退旧视图',
  )
})
