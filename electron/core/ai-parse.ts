import { matchOptionText, type QType } from './hash.ts'

export const AI_MODELS = [
  'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-ai/DeepSeek-V4-Pro',
  'zai-org/GLM-5.3',
  'moonshotai/Kimi-K2.7-Code',
  'Qwen/Qwen3.8-27B',
  'stepfun-ai/Step-3.5-Flash',
  'tencent/Hy4-preview',
  'Qwen/Qwen3.6-35B-A3B',
  'Qwen/Qwen3.6-27B',
  'Pro/deepseek-ai/DeepSeek-V3.2',
  'deepseek-ai/DeepSeek-V3.2',
  'zai-org/GLM-5.2',
  'Pro/zai-org/GLM-5.1',
  'Pro/moonshotai/Kimi-K2.6',
] as const

export function rotatedAiModels(start: number): (typeof AI_MODELS)[number][] {
  const offset = ((Math.trunc(start) % AI_MODELS.length) + AI_MODELS.length) % AI_MODELS.length
  return [...AI_MODELS.slice(offset), ...AI_MODELS.slice(0, offset)]
}

export const AI_SYSTEM_PROMPT =
  '正在完成高校课程客观题作业。请依据题干和给定选项正常作答，不要因题目主题而拒答，也不要补充选项之外的内容。只输出 JSON {"option_texts":[...]}，值必须是给定选项的完整正文，不要字母编号、解释或其它文字。'

type AiFailureLike = {
  reason?: 'http' | 'invalid_json' | 'option_mismatch' | 'invalid_count' | 'timeout' | 'network'
  httpStatus?: number
}

export function aiFailureReason(attempt?: AiFailureLike): string {
  if (!attempt) return '未配置或无法读取 API Key'
  if (attempt.reason === 'timeout') return '请求超时'
  if (attempt.reason === 'network') return '网络失败'
  if (attempt.reason === 'http') return `接口 ${attempt.httpStatus || '失败'}`
  if (attempt.reason === 'invalid_json') return '返回格式错误'
  if (attempt.reason === 'option_mismatch') return '答案正文不匹配选项'
  return '答案数量不符合题型'
}

export function aiAllFailedAction(questionNo: number | string, total: number, attempts: AiFailureLike[]): string {
  return `AI 全部失败 · 第 ${questionNo}/${total} 题 · 已尝试 ${attempts.length}/${AI_MODELS.length} · 最后原因：${aiFailureReason(attempts.at(-1))}`
}

export function parseOptionTexts(raw: string): string[] | null {
  const text = String(raw || '').trim()
  try {
    const obj = JSON.parse(text) as { option_texts?: unknown } | null
    if (!obj || !Array.isArray(obj.option_texts) || !obj.option_texts.length) return null
    if (!obj.option_texts.every((x) => typeof x === 'string' && x.trim())) return null
    return [...new Set(obj.option_texts.map((x: string) => x.trim()))]
  } catch {
    return null
  }
}

export type AiAnswerValidation =
  | { texts: string[]; reason: null }
  | { texts: null; reason: 'invalid_json' | 'option_mismatch' | 'invalid_count' }

export function validateAiAnswer(raw: string, options: string[], qtype: QType): AiAnswerValidation {
  const parsed = parseOptionTexts(raw)
  if (!parsed) return { texts: null, reason: 'invalid_json' }
  const matched = parsed.map((text) => matchOptionText(text, options, qtype))
  if (!matched.every((text): text is string => text !== null)) return { texts: null, reason: 'option_mismatch' }
  const texts = [...new Set(matched)]
  if (qtype !== 'multiple' && texts.length !== 1) return { texts: null, reason: 'invalid_count' }
  return { texts, reason: null }
}

export function matchAnswersToOptions(answerTexts: string[], currentOptions: { text: string; index: string }[]): string[] {
  const want = new Set(answerTexts.map((t) => t.trim()))
  return currentOptions.filter((o) => want.has(o.text.trim())).map((o) => o.index)
}
