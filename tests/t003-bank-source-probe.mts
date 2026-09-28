import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { contentHash } from '../electron/core/hash.ts'
import { PUBLIC_SUPABASE_ANON, PUBLIC_SUPABASE_URL } from '../electron/core/public-config.ts'

const stem = `codex-t003-source-probe-${randomUUID()}`
const options = ['probe-a', 'probe-b']
const hash = contentHash('single', stem, options)
const endpoint = `${PUBLIC_SUPABASE_URL}/rest/v1/questions`
const headers = {
  apikey: PUBLIC_SUPABASE_ANON, Authorization: `Bearer ${PUBLIC_SUPABASE_ANON}`,
  'Content-Type': 'application/json', Prefer: 'return=representation',
}
const request = (path: string, init: RequestInit = {}) => fetch(endpoint + path, {
  ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(10000),
})
let inserted = false
try {
  const response = await request('', {
    method: 'POST',
    body: JSON.stringify({
      qtype: 'single', stem, options, answer_texts: ['probe-b'], content_hash: hash,
      course_names: ['codex-t003-isolated'], source: 'reference', verified: true, conflict: false,
    }),
  })
 inserted = response.ok
 console.log(`reference source insert HTTP ${response.status}`)
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { code?: string }
    console.log(`reference source error code ${error.code || 'unavailable'}`)
  }
 if (inserted) {
    const read = await request(`?content_hash=eq.${hash}&select=source,answer_texts,verified`)
    assert.equal(read.ok, true)
    const rows = await read.json() as { source: string; answer_texts: string[]; verified: boolean }[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source, 'reference')
    assert.deepEqual(rows[0].answer_texts, ['probe-b'])
    assert.equal(rows[0].verified, true)
  }
} finally {
  if (inserted) {
    const deleted = await request(`?content_hash=eq.${hash}`, { method: 'DELETE' })
    assert.equal(deleted.ok, true, '隔离测试行删除失败')
    const read = await request(`?content_hash=eq.${hash}&select=id`)
    assert.equal(read.ok, true)
    assert.deepEqual(await read.json(), [], '隔离测试行仍在题库')
    console.log('reference source readback and cleanup passed')
  }
}
