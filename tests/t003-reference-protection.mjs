import assert from 'node:assert/strict'
import { build } from 'esbuild'

let stored
let failSave = false
const built = await build({
  entryPoints: ['electron/store.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'store-boundaries', setup(plugin) {
    plugin.onResolve({ filter: /^(electron|[.]\/secrets|node:fs)$/ }, (args) => ({ path: args.path, namespace: 'mock' }))
    plugin.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
      contents: args.path === 'electron'
        ? "export const app = { getPath: () => '/isolated' }"
        : args.path === 'node:fs'
          ? "export const existsSync = () => globalThis.__stored !== undefined"
          : "export const assertNoSecretKey = () => {}; export const decryptFromFile = (_path, fallback) => globalThis.__unreadable ? fallback : globalThis.__stored || fallback; export const encryptToFile = (_path, data) => { if (globalThis.__failSave) return { ok: false }; globalThis.__stored = structuredClone(data); return { ok: true } }",
      loader: 'js',
    }))
  } }],
})
const store = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
globalThis.__stored = stored
globalThis.__failSave = failSave
assert.equal(store.isReferenceHashProtected('hash-1'), false)
assert.equal(store.protectReferenceHash('hash-1'), true)
stored = structuredClone(globalThis.__stored)
globalThis.__stored = structuredClone(stored)
assert.equal(store.isReferenceHashProtected('hash-1'), true)
assert.equal(store.protectReferenceHash('hash-1'), true)
assert.deepEqual(globalThis.__stored.reference_hashes, ['hash-1'])
failSave = true
globalThis.__failSave = failSave
assert.equal(store.protectReferenceHash('hash-2'), false)
assert.equal(store.isReferenceHashProtected('hash-2'), false)
globalThis.__unreadable = true
assert.throws(() => store.isReferenceHashProtected('hash-1'), /无法读取/)
assert.equal(store.protectReferenceHash('hash-3'), false)
console.log('T003 参考答案保护持久化通过')
