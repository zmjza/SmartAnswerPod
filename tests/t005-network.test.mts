import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { Page, Request } from 'patchright'
import { NoqrNetworkActivity } from '../electron/noqr/session.ts'

class FakePage extends EventEmitter {}

function fakeRequest(path: string, index: number): Request {
  return {
    url: () => `https://coursework.shou.org.cn${path}`,
    method: () => 'GET',
    resourceType: () => 'fetch',
    index,
  } as unknown as Request
}

test('T005-NET01 同一端点第三次慢请求不能提前按心跳刷新', async () => {
  const page = new FakePage() as unknown as Page
  const network = new NoqrNetworkActivity(
    page,
    'https://coursework.shou.org.cn',
    40,
  )
  try {
    const first = fakeRequest('/api/status?courseId=course-a', 1)
    page.emit('request', first)
    page.emit('requestfinished', first)
    const second = fakeRequest('/api/status?courseId=course-a', 2)
    page.emit('request', second)
    page.emit('requestfinished', second)

    const slow = fakeRequest('/api/status?courseId=course-a', 3)
    page.emit('request', slow)
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(network.isBusinessActive(), false, '第三个慢请求刚开始时不应立刻冒充业务活动')
    assert.equal(network.isActive(), true, '慢请求必须仍被视为活动网络')

    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(network.isBusinessActive(), true, '持续慢请求必须升级为业务活动')
    page.emit('requestfinished', slow)
    assert.equal(network.isActive(), false)
    assert.equal(network.isBusinessActive(), false)
  } finally {
    network.dispose()
  }
})
