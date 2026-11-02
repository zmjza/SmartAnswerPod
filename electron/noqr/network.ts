import type { Page, Request, Response } from 'patchright'
import { NOQR_MUTATION_RESPONSE_HARD_WAIT_MS } from './limits.ts'
import { NOQR_API } from './selectors.ts'

export type NoqrMutationKind = 'submit_one' | 'submit_all' | 'finish'

export type NoqrMutationRequest = {
  kind: NoqrMutationKind
  sequence: number
  url: string
  startedAt: number
  request: Request
  body: Record<string, unknown>
}

export type NoqrMutationResult = NoqrMutationRequest & {
  response?: Response
  httpStatus?: number
  payload?: unknown
  responseText?: string
  endedAt?: number
  requestError?: string
  stopped?: boolean
}

const ENDPOINT_KIND = new Map<string, NoqrMutationKind>([
  [NOQR_API.submitOne, 'submit_one'],
  [NOQR_API.submitAll, 'submit_all'],
  [NOQR_API.finish, 'finish'],
])

function mutationKind(url: string): NoqrMutationKind | null {
  for (const [suffix, kind] of ENDPOINT_KIND) {
    if (new URL(url).pathname.endsWith(suffix)) return kind
  }
  return null
}

function requestBody(request: Request): Record<string, unknown> | null {
  try {
    const body = request.postDataJSON()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    try {
      const body = JSON.parse(request.postData() || '{}')
      return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
    } catch {
      return null
    }
  }
}

/**
 * Passive network observer. It never rewrites requests or responses and keeps
 * only the fields needed to correlate one page action with one mutation.
 */
export class NoqrMutationObserver {
  private sequence = 0
  private readonly page: Page
  private readonly requests: NoqrMutationRequest[] = []
  private readonly results = new Map<Request, NoqrMutationResult>()
  private readonly requestWaiters = new Set<() => void>()
  private readonly responseWaiters = new Set<() => void>()
  private disposed = false

  constructor(page: Page) {
    this.page = page
    this.page.on('request', this.onRequest)
    this.page.on('response', this.onResponse)
    this.page.on('requestfailed', this.onRequestFailed)
  }

  marker() {
    return this.sequence
  }

  findRequest(opts: {
    after: number
    kinds: NoqrMutationKind[]
    workId: string
    matches?: (request: NoqrMutationRequest) => boolean
  }): NoqrMutationRequest | null {
    const allowed = new Set(opts.kinds)
    return this.requests.find((item) => {
      if (item.sequence <= opts.after || !allowed.has(item.kind)) return false
      this.hydrateRequest(item)
      return String(item.body.workId || '') === opts.workId &&
        (!opts.matches || opts.matches(item))
    }) || null
  }

  findRequestAfter(opts: {
    after: number
    kinds: NoqrMutationKind[]
  }): NoqrMutationRequest | null {
    const allowed = new Set(opts.kinds)
    const found = this.requests.find((item) =>
      item.sequence > opts.after &&
      allowed.has(item.kind)) || null
    if (found) this.hydrateRequest(found)
    return found
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.page.off('request', this.onRequest)
    this.page.off('response', this.onResponse)
    this.page.off('requestfailed', this.onRequestFailed)
    this.notifyAll()
  }

  async waitForRequest(opts: {
    after: number
    kinds: NoqrMutationKind[]
    workId: string
    stopRequested: () => boolean
    onWaiting?: (elapsedMs: number) => void
  }): Promise<NoqrMutationRequest | null> {
    const allowed = new Set(opts.kinds)
    const startedAt = Date.now()
    while (!this.disposed) {
      const found = this.findRequest({ after: opts.after, kinds: [...allowed], workId: opts.workId })
      if (found) return found
      if (opts.stopRequested()) return null
      opts.onWaiting?.(Date.now() - startedAt)
      await this.waitForChange()
    }
    return null
  }

  async waitForResult(request: NoqrMutationRequest, opts: {
    stopRequested: () => boolean
    onWaiting?: (elapsedMs: number) => void
    hardDeadlineMs?: number
  }): Promise<NoqrMutationResult> {
    const startedAt = Date.now()
    const hardDeadlineMs = Math.max(
      50,
      Number(opts.hardDeadlineMs) || NOQR_MUTATION_RESPONSE_HARD_WAIT_MS,
    )
    while (!this.disposed) {
      const result = this.results.get(request.request)
      if (result?.endedAt) return result
      if (opts.stopRequested()) {
        return {
          ...request,
          requestError: '任务已停止，请求结果不确定',
          endedAt: Date.now(),
          stopped: true,
        }
      }
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs >= hardDeadlineMs) {
        return {
          ...request,
          requestError: '请求响应读取超过安全上限，结果不确定',
          endedAt: Date.now(),
        }
      }
      opts.onWaiting?.(elapsedMs)
      // Stop state is a pollable signal, so every result wait must wake even
      // when the page emits no further network event.
      await this.waitForChangeWithin(250)
    }
    return {
      ...request,
      requestError: '页面在请求完成前关闭',
      stopped: opts.stopRequested(),
    }
  }

  private onRequest = (request: Request) => {
    if (request.method().toUpperCase() !== 'POST') return
    const kind = mutationKind(request.url())
    if (!kind) return
    const body = requestBody(request) || {}
    const item: NoqrMutationRequest = {
      kind,
      sequence: ++this.sequence,
      url: request.url(),
      startedAt: Date.now(),
      request,
      body,
    }
    this.requests.push(item)
    this.results.set(request, item)
    this.notifyAll()
  }

  private hydrateRequest(item: NoqrMutationRequest) {
    if (Object.keys(item.body).length > 0) return
    const body = requestBody(item.request)
    if (body) item.body = body
  }

  private onResponse = (response: Response) => {
    const current = this.results.get(response.request())
    if (!current) return
    void (async () => {
      try {
        await response.finished()
        const responseText = await response.text().catch(() => '')
        let payload: unknown
        try {
          payload = responseText ? JSON.parse(responseText) : null
        } catch {
          payload = null
        }
        this.results.set(response.request(), {
          ...current,
          response,
          httpStatus: response.status(),
          payload,
          responseText,
          endedAt: Date.now(),
        })
      } catch (error) {
        this.results.set(response.request(), {
          ...current,
          response,
          httpStatus: response.status(),
          requestError: error instanceof Error ? error.message : '响应读取失败',
          endedAt: Date.now(),
        })
      }
      this.notifyAll()
    })()
  }

  private onRequestFailed = (request: Request) => {
    const current = this.results.get(request)
    if (!current || current.endedAt) return
    this.results.set(request, {
      ...current,
      requestError: request.failure()?.errorText || '请求失败',
      endedAt: Date.now(),
    })
    this.notifyAll()
  }

  private waitForChange() {
    return new Promise<void>((resolve) => this.requestWaiters.add(resolve))
  }

  private waitForChangeWithin(timeoutMs: number) {
    return new Promise<void>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.requestWaiters.delete(finish)
        resolve()
      }
      timer = setTimeout(finish, timeoutMs)
      this.requestWaiters.add(finish)
    })
  }

  private notifyAll() {
    const waiters = [...this.requestWaiters, ...this.responseWaiters]
    this.requestWaiters.clear()
    this.responseWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}
