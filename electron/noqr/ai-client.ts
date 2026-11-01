import {
  AI_MODELS,
  AI_SYSTEM_PROMPT,
  aiFailureReason,
  parseOptionTexts,
  rotatedAiModels,
  validateAiAnswer,
} from '../core/ai-parse.ts'
import { deferAiRequests, retryAfterMs, waitForAiRequestSlot } from '../core/ai-rate-limit.ts'
import { contentHash, type QType } from '../core/hash.ts'

export type NoqrAiAttempt = {
  model: string
  index: number
  total: number
  status: 'requesting' | 'failed'
  reason?: 'http' | 'invalid_json' | 'option_mismatch' | 'invalid_count' | 'timeout' | 'network'
  httpStatus?: number
}

export type NoqrAiAnswer = {
  hash: string
  texts: string[] | null
  model?: string
  failed: boolean
  skippedAsked?: boolean
  attempts: NoqrAiAttempt[]
}

export type NoqrAiGroupSlot = {
  id: string
  stem: string
  options: string[]
}

type ValidatedAiContent<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid_json' | 'option_mismatch' | 'invalid_count' }

type AiClientOptions = {
  apiKey?: () => string
  models?: readonly string[]
  fetchImpl?: typeof fetch
  waitSlot?: () => Promise<void>
}

function matchGroupSelection(texts: string[], slots: NoqrAiGroupSlot[]): Record<string, string> | null {
  if (new Set(slots.map((slot) => slot.id)).size !== slots.length) return null
  const selected: Record<string, string> = {}
  for (const text of texts) {
    const matches: { id: string; option: string }[] = []
    for (const slot of slots) {
      for (const option of slot.options) {
        if (text === `${slot.id} :: ${option}`) matches.push({ id: slot.id, option })
      }
    }
    if (matches.length !== 1 || selected[matches[0].id]) return null
    selected[matches[0].id] = matches[0].option
  }
  return Object.keys(selected).length === slots.length ? selected : null
}

export class NoqrAiClient {
  private readonly apiKey?: () => string
  private readonly models: readonly string[]
  private readonly fetchImpl: typeof fetch
  private readonly waitSlot: () => Promise<void>
  private readonly asked = new Set<string>()
  private readonly nextModelIndex = new Map<string, number>()

  constructor(options: AiClientOptions = {}) {
    this.apiKey = options.apiKey
    this.models = options.models?.length ? options.models : AI_MODELS
    this.fetchImpl = options.fetchImpl || fetch
    this.waitSlot = options.waitSlot || waitForAiRequestSlot
  }

  retryAsked(hash: string) {
    this.asked.delete(hash)
  }

  private async request<T>(
    hash: string,
    prompt: string,
    onAttempt: ((attempt: NoqrAiAttempt) => void) | undefined,
    validate: (content: string) => ValidatedAiContent<T>,
    stopRequested?: () => boolean,
  ): Promise<{
    value: T | null
    model?: string
    attempts: NoqrAiAttempt[]
    failedReason?: string
    stopped: boolean
  }> {
    let key = ''
    try {
      key = this.apiKey ? this.apiKey() : (await import('../store.ts')).getSettings().siliconflow_key
    } catch {
      key = ''
    }
    if (!key) return { value: null, attempts: [], failedReason: aiFailureReason(), stopped: false }

    const attempts: NoqrAiAttempt[] = []
    const models = rotatedAiModels(this.nextModelIndex.get(hash) || 0)
      .filter((model) => this.models.includes(model))
    const candidates = models.length
      ? models
      : [...this.models].slice(((this.nextModelIndex.get(hash) || 0) % this.models.length))

    for (let index = 0; index < candidates.length; index++) {
      if (stopRequested?.()) {
        return { value: null, attempts, stopped: true }
      }
      const model = candidates[index]
      await this.waitSlot()
      if (stopRequested?.()) {
        return { value: null, attempts, stopped: true }
      }
      const requesting: NoqrAiAttempt = {
        model,
        index: index + 1,
        total: this.models.length,
        status: 'requesting',
      }
      onAttempt?.(requesting)

      const controller = new AbortController()
      let timedOut = false
      let abortedByStop = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, 60_000)
      const stopPoll = stopRequested
        ? setInterval(() => {
            if (!stopRequested()) return
            abortedByStop = true
            controller.abort()
          }, 50)
        : undefined
      try {
        const response = await this.fetchImpl('https://api.siliconflow.cn/v1/chat/completions', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            enable_thinking: false,
            messages: [
              { role: 'system', content: AI_SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
          }),
        })
        if (!response.ok) {
          if (response.status === 429) deferAiRequests(Math.max(5_000, retryAfterMs(response.headers.get('retry-after'))))
          const failed: NoqrAiAttempt = {
            model,
            index: index + 1,
            total: this.models.length,
            status: 'failed',
            reason: 'http',
            httpStatus: response.status,
          }
          attempts.push(failed)
          onAttempt?.(failed)
          continue
        }
        let payload: { choices?: { message?: { content?: string } }[] }
        try {
          payload = await response.json() as { choices?: { message?: { content?: string } }[] }
        } catch {
          const failed: NoqrAiAttempt = {
            model,
            index: index + 1,
            total: this.models.length,
            status: 'failed',
            reason: 'invalid_json',
          }
          attempts.push(failed)
          onAttempt?.(failed)
          continue
        }
        const content = payload?.choices?.[0]?.message?.content
        if (typeof content !== 'string' || !content.trim()) {
          const failed: NoqrAiAttempt = {
            model,
            index: index + 1,
            total: this.models.length,
            status: 'failed',
            reason: 'invalid_json',
          }
          attempts.push(failed)
          onAttempt?.(failed)
          continue
        }
        const validated = validate(content)
        if (!validated.ok) {
          const failed: NoqrAiAttempt = {
            model,
            index: index + 1,
            total: this.models.length,
            status: 'failed',
            reason: validated.reason,
          }
          attempts.push(failed)
          onAttempt?.(failed)
          continue
        }
        this.nextModelIndex.set(hash, (this.models.indexOf(model) + 1) % this.models.length)
        return { value: validated.value, model, attempts, stopped: false }
      } catch (error) {
        const stopped = abortedByStop || Boolean(stopRequested?.())
        const reason = timedOut ? 'timeout' : 'network'
        const failed: NoqrAiAttempt = {
          model,
          index: index + 1,
          total: this.models.length,
          status: 'failed',
          reason,
        }
        attempts.push(failed)
        onAttempt?.(failed)
        if (stopped) return { value: null, attempts, stopped: true }
      } finally {
        clearTimeout(timer)
        if (stopPoll) clearInterval(stopPoll)
      }
    }
    return { value: null, attempts, failedReason: aiFailureReason(attempts.at(-1)), stopped: false }
  }

  async answerQuestion(opts: {
    qtype: QType
    stem: string
    options: string[]
    onAttempt?: (attempt: NoqrAiAttempt) => void
    stopRequested?: () => boolean
  }): Promise<NoqrAiAnswer> {
    const hash = contentHash(opts.qtype, opts.stem, opts.options)
    if (!opts.options.length || !opts.stem.trim()) {
      return { hash, texts: null, failed: true, attempts: [] }
    }
    if (this.asked.has(hash)) {
      return { hash, texts: null, failed: true, skippedAsked: true, attempts: [] }
    }

    const prompt = [
      '这是高校课程客观题作业。请只根据题干和给定选项选择正确答案。',
      `题型:${opts.qtype}`,
      `题干:${opts.stem}`,
      '选项:',
      opts.options.map((text, index) => `${index}. ${text}`).join('\n'),
      '只输出 JSON {"option_texts":["正确选项正文"]}',
    ].join('\n')
    const response = await this.request(
      hash,
      prompt,
      opts.onAttempt,
      (content) => {
        const validated = validateAiAnswer(content, opts.options, opts.qtype)
        return validated.texts
          ? { ok: true, value: validated.texts }
          : { ok: false, reason: validated.reason }
      },
      opts.stopRequested,
    )
    if (response.stopped || opts.stopRequested?.()) {
      return { hash, texts: null, failed: true, attempts: response.attempts }
    }
    if (!response.value) {
      this.asked.add(hash)
      return { hash, texts: null, failed: true, attempts: response.attempts }
    }
    this.asked.add(hash)
    return { hash, texts: response.value, model: response.model, failed: false, attempts: response.attempts }
  }

  async answerGroup(opts: {
    shared: string
    slots: NoqrAiGroupSlot[]
    onAttempt?: (attempt: NoqrAiAttempt) => void
    stopRequested?: () => boolean
  }): Promise<{ selected: Record<string, string> | null; model?: string; attempts: NoqrAiAttempt[]; failedReason?: string }> {
    if (!opts.shared.trim() || !opts.slots.length ||
        opts.slots.some((slot) => !slot.id.trim() || !slot.stem.trim() || !slot.options.length) ||
        new Set(opts.slots.map((slot) => slot.id)).size !== opts.slots.length) {
      return { selected: null, attempts: [], failedReason: '复合题答案槽位不完整' }
    }
    const options = opts.slots.flatMap((slot) => slot.options.map((text) => `${slot.id} :: ${text}`))
    const identity = [
      opts.shared,
      ...opts.slots.map((slot) => `${slot.id}\n${slot.stem}`),
    ].join('\n')
    const hash = contentHash('multiple', identity, options)
    if (this.asked.has(hash)) {
      return { selected: null, attempts: [], failedReason: '该题已失败，等待人工重试' }
    }
    const prompt = [
      '这是高校课程英语复合客观题作业。请只根据共享材料、各子题和给定选项作答。',
      `共享材料:${opts.shared}`,
      '每个编号恰选一个答案，完整返回所有编号。',
      opts.slots.map((slot) => `${slot.id}. ${slot.stem}`).join('\n'),
      '可选项:',
      options.join('\n'),
      '只输出 JSON {"option_texts":["编号 :: 完整选项正文"]}',
    ].join('\n')
    const response = await this.request(
      hash,
      prompt,
      opts.onAttempt,
      (content) => {
        const texts = parseOptionTexts(content)
        const selected = texts ? matchGroupSelection(texts, opts.slots) : null
        return selected
          ? { ok: true, value: selected }
          : { ok: false, reason: 'option_mismatch' }
      },
      opts.stopRequested,
    )
    if (response.stopped || opts.stopRequested?.()) {
      return { selected: null, attempts: response.attempts, failedReason: '任务已停止' }
    }
    if (!response.value) {
      this.asked.add(hash)
      return { selected: null, attempts: response.attempts, failedReason: response.failedReason }
    }
    return { selected: response.value, model: response.model, attempts: response.attempts }
  }
}
