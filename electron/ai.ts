import { AI_MODELS, AI_SYSTEM_PROMPT, rotatedAiModels, validateAiAnswer } from './core/ai-parse'
import { getSettings } from './store'
import type { QType } from './core/hash'
import { withTimeout } from './core/timeout'
import { AI_RATE_LIMIT_COOLDOWN_MS, deferAiRequests, retryAfterMs, waitForAiRequestSlot } from './core/ai-rate-limit'

const asked = new Set<string>()
const nextModelIndex = new Map<string, number>()

export function resetAsked() {
  asked.clear()
}

export function retryAsked(hash: string) {
  asked.delete(hash)
}

export type AiAttempt = {
  model: string
  index: number
  total: number
  status: 'requesting' | 'failed'
  reason?: 'http' | 'invalid_json' | 'option_mismatch' | 'invalid_count' | 'timeout' | 'network'
  httpStatus?: number
}

export type AiGroupSlot = { id: string; stem: string; options: string[] }

export function validateGroupSelection(texts: string[], slots: Pick<AiGroupSlot, 'id' | 'options'>[]): Record<string, string> | null {
  if (texts.length !== slots.length || new Set(slots.map((slot) => slot.id)).size !== slots.length) return null
  const selected: Record<string, string> = {}
  for (const text of texts) {
    const slot = slots.find((item) => item.options.some((option) => text === `${item.id} :: ${option}`))
    if (!slot || selected[slot.id]) return null
    selected[slot.id] = slot.options.find((option) => text === `${slot.id} :: ${option}`)!
  }
  return Object.keys(selected).length === slots.length ? selected : null
}

export async function askAiGroup(opts: {
  hash: string
  shared: string
  slots: AiGroupSlot[]
  onAttempt?: (attempt: AiAttempt) => void
}): Promise<{ selected: Record<string, string> | null; model?: string; attempts: AiAttempt[] }> {
  if (!opts.slots.length || opts.slots.some((slot) => !slot.id || !slot.stem || !slot.options.length))
    return { selected: null, attempts: [] }
  const options = opts.slots.flatMap((slot) => slot.options.map((text) => `${slot.id} :: ${text}`))
  const stem = `${opts.shared}\n每个编号恰选一个答案，完整返回所有编号。\n` +
    opts.slots.map((slot) => `${slot.id}. ${slot.stem}`).join('\n')
  const response = await askAi({
    hash: opts.hash, qtype: 'multiple', stem, options, preLabeledOptions: true, onAttempt: opts.onAttempt,
  })
  return { selected: response.texts ? validateGroupSelection(response.texts, opts.slots) : null,
    model: response.model, attempts: response.attempts }
}

export async function askAi(opts: {
  hash: string
  qtype: string
  stem: string
  options: string[]
  preLabeledOptions?: boolean
  onAttempt?: (attempt: AiAttempt) => void
}): Promise<{ texts: string[] | null; model?: string; failed: boolean; attempts: AiAttempt[] }> {
  if (asked.has(opts.hash)) return { texts: null, failed: true, attempts: [] }
  const { siliconflow_key } = getSettings()
  if (!siliconflow_key) {
    asked.add(opts.hash)
    return { texts: null, failed: true, attempts: [] }
  }
  const attempts: AiAttempt[] = []
  const prompt =
    '这是高校课程客观题作业。请只根据题干和给定选项选择正确答案。' +
    '\n题型:' +
    opts.qtype +
    '\n题干:' +
    opts.stem +
    '\n选项:\n' +
    opts.options.map((t, i) => opts.preLabeledOptions ? t : i + '. ' + t).join('\n') +
    '\n只输出 JSON {\"option_texts\":[\"正确选项正文\"]}'
  const models = rotatedAiModels(nextModelIndex.get(opts.hash) || 0)
  for (let index = 0; index < models.length; index++) {
    const model = models[index]
    await waitForAiRequestSlot()
    opts.onAttempt?.({ model, index: index + 1, total: AI_MODELS.length, status: 'requesting' })
    const ctrl = new AbortController()
    try {
      const response = fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + siliconflow_key,
          'Content-Type': 'application/json',
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          temperature: 0,
          enable_thinking: false,
          messages: [
            { role: 'system', content: AI_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        }),
      }).then(async (res) => ({ res, data: res.ok ? await res.json() as { choices?: { message?: { content?: string } }[] } : null }))
      const { res, data } = await withTimeout(response, 60_000, () => ctrl.abort())
      if (!res.ok) {
        if (res.status === 429) {
          deferAiRequests(Math.max(retryAfterMs(res.headers.get('retry-after')), AI_RATE_LIMIT_COOLDOWN_MS))
        }
        const attempt: AiAttempt = { model, index: index + 1, total: AI_MODELS.length, status: 'failed', reason: 'http', httpStatus: res.status }
        attempts.push(attempt)
        opts.onAttempt?.(attempt)
        continue
      }
      const qtype = opts.qtype as QType
      const validated = validateAiAnswer(data?.choices?.[0]?.message?.content || '', opts.options, qtype)
      if (!validated.texts) {
        const attempt: AiAttempt = { model, index: index + 1, total: AI_MODELS.length, status: 'failed', reason: validated.reason }
        attempts.push(attempt)
        opts.onAttempt?.(attempt)
        continue
      }
      nextModelIndex.set(opts.hash, (AI_MODELS.indexOf(model) + 1) % AI_MODELS.length)
      return { texts: validated.texts, model, failed: false, attempts }
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network'
      const attempt: AiAttempt = { model, index: index + 1, total: AI_MODELS.length, status: 'failed', reason }
      attempts.push(attempt)
      opts.onAttempt?.(attempt)
      continue
    }
  }
  asked.add(opts.hash)
  return { texts: null, failed: true, attempts }
}
