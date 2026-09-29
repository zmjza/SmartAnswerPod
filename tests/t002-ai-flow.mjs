import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints: ['electron/ai.ts'], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{
  name: 'local-settings', setup(plugin) {
    plugin.onResolve({ filter: /store$/ }, args => ({ path: args.path, namespace: 'local-store' }))
    plugin.onLoad({ filter: /.*/, namespace: 'local-store' }, () => ({ contents: "export const getSettings=()=>({siliconflow_key:'fake'})", loader: 'js' }))
  },
}] })
const ai = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const originalFetch = globalThis.fetch
const times = []
const models = []
const requestBodies = []
const timeoutDelays = []
let replies = []
const originalSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay >= 12_000) timeoutDelays.push(delay)
  return originalSetTimeout(callback, delay, ...args)
}
globalThis.fetch = async (_url, opts) => {
  times.push(Date.now())
  const body = JSON.parse(opts.body)
  models.push(body.model)
  requestBodies.push(body)
  return replies.shift() || new Response('down', { status: 503 })
}
try {
  replies = [
    new Response('limited', { status: 429, headers: { 'retry-after': '0' } }),
    Response.json({ choices: [{ message: { content: 'broken-json' } }] }),
    Response.json({ choices: [{ message: { content: '{"option_texts":["甲"]}' } }] }),
  ]
  const attempts = []
  const ok = await ai.askAi({ hash: 'question-one', qtype: 'single', stem: '测试单选', options: ['甲', '乙'], onAttempt: value => attempts.push(value) })
  assert.deepEqual(ok.texts, ['甲'])
  assert.equal(ok.attempts.length, 2)
  assert.deepEqual(ok.attempts.map(item => [item.reason, item.httpStatus]), [['http', 429], ['invalid_json', undefined]])
  assert.equal(new Set(models).size, 3, '模型降级应按不同模型顺序执行')
  assert.ok(requestBodies.every(body => body.enable_thinking === false), '答题模型应默认关闭思考模式')
  assert.ok(timeoutDelays.length > 0, '答题请求应设置超时')
  assert.ok(timeoutDelays.every(delay => delay === 60_000), '每次模型答题请求应等待一分钟')
  assert.equal(times.length, 3)
  assert.ok(times[1] - times[0] >= 4500, '429 冷却至少 5 秒')
  assert.ok(times[2] - times[1] >= 900, '普通请求全局节流至少接近 1000 毫秒')
  assert.equal(attempts.filter(item => item.status === 'failed').length, 2)

  const from = times.length
  const failed = await ai.askAi({ hash: 'question-two', qtype: 'multiple', stem: '测试多选', options: ['甲', '乙'] })
  assert.equal(failed.texts, null)
  assert.equal(failed.failed, true)
  assert.equal(failed.attempts.length, times.length - from)
  assert.ok(failed.attempts.length >= 10, '全部模型失败必须逐个尝试')
  assert.ok(times.slice(1).every((time, index) => time - times[index] >= 900), '所有学生共用的请求间隔应生效')
  const cached = await ai.askAi({ hash: 'question-two', qtype: 'multiple', stem: '测试多选', options: ['甲', '乙'] })
  assert.equal(cached.attempts.length, 0, '相同失败题不能立刻重复刷全部模型')
  console.log('T002 真实 AI 降级、全失败、全局节流和 429 冷却路径通过')
} finally {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
}
