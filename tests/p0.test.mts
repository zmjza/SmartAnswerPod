import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contentHash, mergeCourseNames, sameCourseNames, hasReadableQuestionText } from '../electron/core/hash.ts'
import { SlotPool } from '../electron/core/slot-pool.ts'
import { maxAttemptsThisRun } from '../electron/core/attempts.ts'
import { BANK_ANSWER_DELAY_MAX_MS, BANK_ANSWER_DELAY_MIN_MS, SUBMIT, MAX_ANSWER_REPAIR_ATTEMPTS, answerRepairExhaustedAction, bankAnswerDelayMs, historyDisplayState, isDoneByAnswer, judgeListRow, newestHistory, answerMatches, newSubmission, isUnansweredConfirm, questionCompletionConfirmed } from '../electron/core/homework.ts'
import { ACCOUNT, HOMEWORK, QUESTION, SLOT, isKnownAccount, isKnownHomework, isKnownQuestion, isKnownSlot, slotCountsInToolbar } from '../electron/core/states.ts'
import { isAnswerPath, isPreviewPath } from '../electron/core/selectors.ts'
import { AI_MODELS, AI_SYSTEM_PROMPT, aiAllFailedAction, parseOptionTexts, rotatedAiModels, validateAiAnswer } from '../electron/core/ai-parse.ts'
import { parseBankJson, upsertBank } from '../electron/core/json-bank.ts'
import { parseCsv } from '../electron/core/excel.ts'
import { parsePastedAccounts } from '../electron/core/excel.ts'
import { pageForCourse, pageSlice, pageCountForCourses } from '../electron/core/course-pager.ts'
import { overflowStudentIndexes, visibleStudentIndexes } from '../src/student-switcher.ts'
import { qrDialogLooksOpen, qrSnapshotMatches, verificationFailure } from '../electron/core/qr.ts'
import { canClickDoHomework } from '../src/verify-gate.ts'
import { mapWithConcurrency, concurrencyChangeLocked, concurrencySnapshot } from '../electron/core/concurrency.ts'
import { upsertCourse, upsertHomework, courseOutcome, recordQuestion, homeworkScoreLabel, emptyExtractStats, addExtractStats, extractCompletionLabel } from '../electron/core/live-view.ts'
import { mergeAccountWriteback, writebackDisposition } from '../electron/core/writeback.ts'
import { removeRejectedAnswer } from '../electron/core/bank-delete.ts'
import { reviewCorrectness, reviewMutation, reviewUpsertRequiresRetry, reviewedTotalScore, uniqueCorruptedTextMatch } from '../electron/core/review-match.ts'
import { shouldInspectHistory } from '../electron/core/homework.ts'
import { canExtractReviewedQuestion } from '../electron/core/review-match.ts'
import { withTimeout } from '../electron/core/timeout.ts'
import { progressActionLabel } from '../electron/core/progress-label.ts'
import { AI_MIN_REQUEST_INTERVAL_MS, AI_RATE_LIMIT_COOLDOWN_MS, createRequestPacer, retryAfterMs } from '../electron/core/ai-rate-limit.ts'
import { selectedRunReadiness, selectCoursesForRun } from '../electron/core/course-scope.ts'
import { connectivitySummary, classifyConnectivityFailure, runConnectivityChecks } from '../electron/core/connectivity.ts'
import { recommendConcurrency } from '../electron/core/machine.ts'
import { runtimeLogLevel, sanitizeRuntimeLogText } from '../electron/core/runtime-log.ts'
import { bankAccessAttempt } from '../electron/core/bank-access.ts'
import { buildBankQuery } from '../electron/core/bank-query.ts'
import { normalizeGoalText, parseGoalAccounts } from './helpers/goal-accounts.mjs'
import { isFinishedExtractJobStatus } from './helpers/extract-status.mjs'
import { browserBoundsVisible, browserVisibilityFromNativeState } from '../electron/core/window-bounds.ts'

test('目标文件账号解析会清理 Markdown 行尾反斜杠并按账号去重', () => {
  assert.equal(normalizeGoalText('sb\\_publishable\\\n下一行'), 'sb_publishable\n下一行')
  const accounts = parseGoalAccounts([
    '1）账号：20260000000001\\',
    '密码：demo-pass-1\\',
    '2）账号：20260000000002\\',
    'demo-pass-2\\',
    '3）账号：20260000000001\\',
    '密码：demo-pass-1\\',
  ].join('\n'))
  assert.deepEqual(accounts, [
    { name: '测试学生1', username: '20260000000001', password: 'demo-pass-1' },
    { name: '测试学生2', username: '20260000000002', password: 'demo-pass-2' },
  ])
})

test('提取收口把明确跳过的作业视为已终结', () => {
  assert.equal(isFinishedExtractJobStatus('extracting_done'), true)
  assert.equal(isFinishedExtractJobStatus('skip_non_objective'), true)
  assert.equal(isFinishedExtractJobStatus('skip_weight0'), true)
  assert.equal(isFinishedExtractJobStatus('extracting'), false)
  assert.equal(isFinishedExtractJobStatus('todo'), false)
})

test('无头窗口只有最小化或完整移出屏幕才算隐藏', () => {
  assert.equal(browserBoundsVisible({ windowState: 'minimized' }), false)
  assert.equal(browserBoundsVisible({ windowState: 'normal', left: -32000, top: -32000, width: 800, height: 600 }), false)
  assert.equal(browserBoundsVisible({ windowState: 'normal', left: 40, top: 60, width: 1280, height: 800 }), true)
})

test('macOS 原生隐藏状态优先于被系统夹回屏幕的 CDP 边界', () => {
  const clamped = { windowState: 'normal', left: -466, top: 30, width: 800, height: 600 }
  assert.equal(browserVisibilityFromNativeState(true, clamped), false)
  assert.equal(browserVisibilityFromNativeState(false, clamped), true)
  assert.equal(browserVisibilityFromNativeState(null, clamped), true)
})

test('损坏或缺失题干选项不得查库、交给 AI 或入库', () => {
  const replacement = String.fromCodePoint(0xfffd)
  assert.equal(hasReadableQuestionText('正常题目', ['正确', '错误']), true)
  assert.equal(hasReadableQuestionText('题目' + replacement, ['正确', '错误']), false)
  assert.equal(hasReadableQuestionText('正常题目', ['选项' + replacement, '乙']), false)
  assert.equal(hasReadableQuestionText('', ['甲', '乙']), false)
  assert.equal(hasReadableQuestionText('正常题目', []), false)
  assert.equal(hasReadableQuestionText('正常题目', ['甲', '  ']), false)
})

test('外部请求忽略取消时硬超时仍会返回，避免单题永久卡住', async () => {
  let timedOut = false
  await assert.rejects(withTimeout(new Promise<never>(() => {}), 10, () => { timedOut = true }), /操作超时/)
  assert.equal(timedOut, true)
})

test('题目只有答案完整写入且右侧已做提亮才允许继续', () => {
  assert.equal(questionCompletionConfirmed('0,2', ['2', '0'], true), true)
  assert.equal(questionCompletionConfirmed('0', ['0', '2'], true), false)
  assert.equal(questionCompletionConfirmed('0,2', ['0', '2'], false), false)
  assert.equal(questionCompletionConfirmed('', ['0'], true), false)
})

test('AI 使用统一高校作业提示词并限制固定格式', () => {
  assert.match(AI_SYSTEM_PROMPT, /高校课程/)
  assert.match(AI_SYSTEM_PROMPT, /给定选项/)
  assert.match(AI_SYSTEM_PROMPT, /不要因题目主题而拒答/)
  assert.match(AI_SYSTEM_PROMPT, /不要补充选项之外/)
  assert.match(AI_SYSTEM_PROMPT, /option_texts/)
})

test('AI 降级模型按稳定顺序去重并覆盖新增候选', () => {
  assert.deepEqual(AI_MODELS, [
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
  ])
  assert.equal(new Set(AI_MODELS).size, AI_MODELS.length)
})

test('同一道 AI 错题下一轮从后续模型开始，避免重复同一答案', () => {
  assert.deepEqual(rotatedAiModels(0).slice(0, 3), AI_MODELS.slice(0, 3))
  assert.deepEqual(rotatedAiModels(1).slice(0, 3), [AI_MODELS[1], AI_MODELS[2], AI_MODELS[3]])
  assert.deepEqual(rotatedAiModels(AI_MODELS.length - 1).slice(0, 3), [AI_MODELS.at(-1), AI_MODELS[0], AI_MODELS[1]])
})

test('全部 AI 模型失败时生成可直接展示在主界面的明确原因', () => {
  assert.equal(
    aiAllFailedAction(20, 50, [
      { reason: 'timeout' },
      { reason: 'http', httpStatus: 429 },
    ]),
    'AI 全部失败 · 第 20/50 题 · 已尝试 2/14 · 最后原因：接口 429',
  )
  assert.equal(
    aiAllFailedAction(3, 10, []),
    'AI 全部失败 · 第 3/10 题 · 已尝试 0/14 · 最后原因：未配置或无法读取 API Key',
  )
})

test('漏题最多补答三十轮，耗尽后明确显示并安全停止', () => {
  assert.equal(MAX_ANSWER_REPAIR_ATTEMPTS, 30)
  assert.equal(
    answerRepairExhaustedAction(['20', '26'], ['AI 全部失败：最后原因为请求超时']),
    '补答已达 30 轮仍失败 · 第 20、26题未完成 · AI 全部失败：最后原因为请求超时 · 已安全停止，未提交',
  )
})

test('主界面进度不会给已经含题号的失败原因重复追加题号', () => {
  assert.equal(
    progressActionLabel('AI 全部失败 · 第 20/50 题 · 已尝试 14/14 · 最后原因：请求超时', 20, 50),
    'AI 全部失败 · 第 20/50 题 · 已尝试 14/14 · 最后原因：请求超时',
  )
  assert.equal(progressActionLabel('AI 回填', 20, 50), 'AI 回填 · 第 20/50 题')
})

test('AI 请求在所有学生之间共享最小间隔，限流后追加冷却', async () => {
  let now = 1_000
  const waits: number[] = []
  const pacer = createRequestPacer(750, () => now, async (ms) => { waits.push(ms); now += ms })
  await pacer.wait()
  await pacer.wait()
  pacer.defer(5_000)
  await pacer.wait()
  assert.deepEqual(waits, [750, 5_000])
  assert.equal(AI_MIN_REQUEST_INTERVAL_MS, 1_000)
  assert.equal(AI_RATE_LIMIT_COOLDOWN_MS, 5_000)
})

test('题库命中后按一到三秒随机节奏进入下一题', () => {
  assert.equal(BANK_ANSWER_DELAY_MIN_MS, 1_000)
  assert.equal(BANK_ANSWER_DELAY_MAX_MS, 3_000)
  assert.equal(bankAnswerDelayMs(() => 0), 1_000)
  assert.equal(bankAnswerDelayMs(() => 0.5), 2_000)
  assert.equal(bankAnswerDelayMs(() => 0.9999), 2_999)
})

test('批阅列表没有总分时可按每题实得分求和，并在新一轮保留上次分数', () => {
  assert.equal(reviewedTotalScore(['2.5', '0', '2.50 分']), 5)
  assert.equal(reviewedTotalScore(['2.5', '']), null)
  assert.equal(reviewedTotalScore([]), null)
  assert.equal(
    homeworkScoreLabel({ attempt: 2, score: null, lastAttempt: 1, lastScore: 97.5, status: 'answering' }),
    '第 2 次 · 本次得分：尚未出分 · 上次 97.5 分',
  )
})

test('AI 限流 Retry-After 支持秒数并忽略无效值', () => {
  assert.equal(retryAfterMs('3'), 3_000)
  assert.equal(retryAfterMs('bad'), 0)
  assert.equal(retryAfterMs(null), 0)
})

test('可选课程只生成选中课程队列，全部模式保留全部课程', () => {
  const courses = [{ name: '甲' }, { name: '乙' }, { name: '丙' }]
  assert.deepEqual(selectCoursesForRun(courses, 'all', []), courses)
  assert.deepEqual(selectCoursesForRun(courses, 'selected', ['丙', '甲']), [{ name: '甲' }, { name: '丙' }])
  assert.deepEqual(selectCoursesForRun(courses, 'selected', []), [])
})

test('同名不同课程 ID 只执行选中的课程', () => {
  const courses = [{ key: 'course:1:', name: '形势与政策' }, { key: 'course:2:', name: '形势与政策' }]
  assert.deepEqual(selectCoursesForRun(courses, 'selected', ['course:2:']), [courses[1]])
})

test('可选课程必须等全部目标学生扫描完成，并且至少选中一门才可开始', () => {
  assert.equal(selectedRunReadiness([
    { awaiting: true, selectedCount: 1 },
    { awaiting: false, selectedCount: 0 },
  ]), 'scanning')
  assert.equal(selectedRunReadiness([
    { awaiting: true, selectedCount: 0 },
    { awaiting: true, selectedCount: 0 },
  ]), 'empty')
  assert.equal(selectedRunReadiness([
    { awaiting: true, selectedCount: 2 },
    { awaiting: true, selectedCount: 0 },
  ]), 'ready')
})

test('AI 连通性失败原因和总览按真实结果分类', () => {
  assert.equal(classifyConnectivityFailure({ status: 401 }), '鉴权失败')
  assert.equal(classifyConnectivityFailure({ status: 429, retryAfterMs: 5000 }), '限流 · 等待 5 秒')
  assert.equal(classifyConnectivityFailure({ status: 404 }), '模型不存在')
  assert.equal(classifyConnectivityFailure({ error: 'timeout' }), '超时')
  assert.equal(connectivitySummary([{ ok: true }, { ok: true }, { ok: true }, { ok: false }, { ok: false }, { ok: false }]), '请注意，部分模型不可用')
  assert.equal(connectivitySummary([{ ok: true }, { ok: true }, { ok: false }, { ok: false }]), '请检查 API 配置或模型状态')
  assert.equal(connectivitySummary([{ ok: true }, { ok: false }]), '请检查 API 配置或模型状态')
  assert.equal(connectivitySummary([]), 'AI 服务不可用')
})

test('AI 连通性按受控并发逐项推送排队、检测和结果状态', async () => {
  let active = 0
  let peak = 0
  const snapshots: string[][] = []
  const results = await runConnectivityChecks(
    ['甲', '乙', '丙', '丁'],
    2,
    async (model) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 4))
      active--
      return { model, ok: model !== '丙', status: model === '丙' ? 'failed' : 'success', elapsedMs: 4 }
    },
    (items) => snapshots.push(items.map((item) => item.status)),
  )
  assert.equal(peak, 2)
  assert.deepEqual(results.map((item) => item.model), ['甲', '乙', '丙', '丁'])
  assert.deepEqual(snapshots[0], ['queued', 'queued', 'queued', 'queued'])
  assert.ok(snapshots.some((items) => items.filter((status) => status === 'running').length === 2))
  assert.deepEqual(snapshots.at(-1), ['success', 'success', 'failed', 'success'])
})

test('运行中拒绝并发热改并保持启动时快照', () => {
  const current = { account_parallel: 2, course_parallel: 3 }
  assert.equal(concurrencyChangeLocked(current, { account_parallel: 1 }, true), true)
  assert.equal(concurrencyChangeLocked(current, { course_parallel: 3, log_enabled: false }, true), false)
  assert.equal(concurrencyChangeLocked(current, { account_parallel: 1 }, false), false)
  const snapshot = concurrencySnapshot(current)
  current.account_parallel = 8
  assert.deepEqual(snapshot, { account_parallel: 2, course_parallel: 3 })
})

test('并发推荐使用主机余量和浏览器样本且不超过产品上限', () => {
  assert.deepEqual(recommendConcurrency({
    cores: 8, cpuPct: 95, totalMemBytes: 16e9, freeMemBytes: 8e9, appMemBytes: 300e6, pressure: '过高',
  }), { account: 1, course: 1, browserBytes: 512 * 1024 * 1024, sampled: false })
  const sampled = recommendConcurrency({
    cores: 12, cpuPct: 20, totalMemBytes: 32e9, freeMemBytes: 20e9, appMemBytes: 300e6, browserAverageBytes: 256e6, pressure: '正常',
  })
  assert.equal(sampled.sampled, true)
  assert.ok(sampled.account >= 1 && sampled.account <= 8)
  assert.ok(sampled.course >= 1 && sampled.course <= 6)
  assert.equal(sampled.browserBytes, 256e6)
})

test('同题同课程重复提取只计去重，不需要再次写课程名', () => {
 assert.equal(sameCourseNames(['课程A'], ['课程A']), true)
 assert.equal(sameCourseNames(['课程A', '课程B'], ['课程B', '课程A']), true)
 assert.equal(sameCourseNames(['课程A'], ['课程B']), false)
})

test('当前账号并行数量决定工作台直接可见学生行数', () => {
  assert.deepEqual(visibleStudentIndexes(5, 2, 3), [0, 1, 2])
  assert.deepEqual(visibleStudentIndexes(5, 4, 3), [2, 3, 4])
})

test('旧损坏候选只在题型、选项、所选答案和题干残片全卷唯一时恢复', () => {
  const replacement = String.fromCodePoint(0xfffd)
  const candidate = { qtype: 'judge' as const, stem: '企业' + replacement.repeat(3) + '管理有效', options: ['正确', '错误'], selected: ['正确'] }
  const correct = { qtype: 'judge' as const, stem: '企业有管理有效', options: ['错误', '正确'], selected: ['正确'] }
  const other = { qtype: 'judge' as const, stem: '企业无管理有效', options: ['正确', '错误'], selected: ['错误'] }
  assert.equal(uniqueCorruptedTextMatch(candidate, [correct, other]), correct)
  assert.equal(uniqueCorruptedTextMatch(candidate, [correct, { ...correct }]), null, '多条相同候选不得猜')
  assert.equal(uniqueCorruptedTextMatch({ ...candidate, stem: '正常题干' }, [correct]), null, '正常文本不走旧记录恢复')
})

test('历史页题干损坏时只在唯一匹配下校对', () => {
  const replacement = String.fromCodePoint(0xfffd)
  const candidate = { qtype: 'judge' as const, stem: '企业管理有效', options: ['正确', '错误'], selected: ['正确'] }
  const damaged = { qtype: 'judge' as const, stem: '企业' + replacement.repeat(2) + '管理有效', options: ['错误', '正确'], selected: ['正确'] }
  assert.equal(uniqueCorruptedTextMatch(candidate, [damaged]), damaged)
  assert.equal(uniqueCorruptedTextMatch(candidate, [damaged, { ...damaged }]), null, '多条损坏候选不得猜')
})

test('批阅标记出现红叉时必须判错，不能被额外绿勾覆盖', () => {
  assert.equal(reviewCorrectness(false, false), null)
  assert.equal(reviewCorrectness(true, false), true)
  assert.equal(reviewCorrectness(false, true), false)
  assert.equal(reviewCorrectness(true, true), false)
})

test('批阅回写五种情况必须走各自分支', () => {
  assert.equal(reviewMutation('AI 答题', true), 'upsert')
  assert.equal(reviewMutation('AI 答题', false), 'none')
  assert.equal(reviewMutation('题库答题', true), 'none')
  assert.equal(reviewMutation('题库答题', false), 'delete')
  assert.equal(reviewMutation('空过', false), 'none')
})

test('本轮回写冲突算已处理，只有写入失败才原地重试', () => {
  assert.equal(reviewUpsertRequiresRetry('added'), false)
  assert.equal(reviewUpsertRequiresRetry('merged'), false)
  assert.equal(reviewUpsertRequiresRetry('conflict'), false)
  assert.equal(reviewUpsertRequiresRetry('failed'), true)
  assert.equal(writebackDisposition(1, false), 'retry')
  assert.equal(writebackDisposition(0, false), 'done')
  assert.equal(writebackDisposition(1, true), 'stopped')
})

test('本次得分保留零分和小数，未批阅不冒充零分，新轮不显示旧分数', () => {
  assert.equal(homeworkScoreLabel({ status: 'todo' }), '本次得分：尚未作答')
  assert.equal(homeworkScoreLabel({ attempt: 1, score: 97.5, status: 'pending_writeback' }), '第 1 次 · 本次得分：97.5 分')
  assert.equal(homeworkScoreLabel({ attempt: 1, score: 0, status: 'reviewing' }), '第 1 次 · 本次得分：0 分')
  assert.equal(homeworkScoreLabel({ attempt: 2, score: null, status: 'waiting_grade' }), '第 2 次 · 本次得分：等待批阅')
  assert.equal(homeworkScoreLabel({ attempt: 2, score: null, status: 'answering' }), '第 2 次 · 本次得分：尚未出分')
  assert.equal(homeworkScoreLabel({ attempt: 1, score: null, status: 'skip_bank_miss' }), '本次得分：尚未作答')
})

test('错题删除必须确认旧答案消失，不能把 HTTP 成功当删除成功', async () => {
  const wrong = { qtype: 'single' as const, answer_texts: ['错误答案'] }
  assert.equal(await removeRejectedAnswer(['错误答案'], async () => wrong, async () => true), false)
  let calls = 0
  assert.equal(await removeRejectedAnswer(['错误答案'], async () => ++calls === 1 ? wrong : null, async () => true), true)
  assert.equal(await removeRejectedAnswer(['错误答案'], async () => { throw new Error('网络中断') }, async () => true), false)
  let removed = false
  assert.equal(await removeRejectedAnswer(['错误答案'], async () => ({ ...wrong, answer_texts: ['已纠正答案'] }), async () => { removed = true; return true }), true)
  assert.equal(removed, false, '其它学生已经纠正的答案不能误删')
})

test('全部作业收尾才算课程完成，逐题快照不重复计数', () => {
  assert.equal(courseOutcome(['done_100', 'todo']), '尚未完成')
  assert.equal(courseOutcome(['done_100', 'pending_writeback']), '待回写')
  assert.equal(courseOutcome(['done_100', 'submit_failed']), '有失败待处理')
  assert.equal(courseOutcome(['done_100', 'skip_bank_miss']), '有失败待处理')
  assert.equal(courseOutcome(['done_100', 'skip_full_score']), '本轮可做作业已完成')
  assert.equal(courseOutcome(['done_100', 'skip_attempts_exhausted']), '暂不可完成')
  assert.equal(courseOutcome(['skip_out_of_window']), '暂不可完成')
  assert.equal(isKnownHomework('skip_bank_miss'), true)
  const row = upsertHomework([], 'onlineHomework', '测试作业', 'answering')[0].rows[0]
  recordQuestion(row, { no: 1, stem: '测试题', source: 'AI' }, 10)
  assert.equal(row.questions.length, 1)
  assert.equal(row.questionTotal, 10)
  recordQuestion(row, { no: 1, stem: '测试题', source: '题库' }, 10)
  assert.equal(row.questions.length, 1)
  assert.equal(row.questions[0].source, '题库')
})

test('多账号补偿保留另一个账号新写入的待回写', () => {
  const a = { local_id: 'a', revision: 1 }
  const b = { local_id: 'b', revision: 2 }
  const afterA = mergeAccountWriteback([a, b], 'a', [])
  assert.deepEqual(afterA, [b])
  const newA = { local_id: 'a', revision: 3 }
  assert.deepEqual(mergeAccountWriteback([...afterA, newA], 'b', []), [newA])
  assert.throws(() => mergeAccountWriteback([a, b], 'a', [b]))
})

test('答案确认必须完整匹配，拒绝漏选、多选和旧答案', () => {
  assert.equal(answerMatches('2,0', ['0', '2']), true)
  assert.equal(answerMatches('0', ['0', '2']), false)
  assert.equal(answerMatches('0,1,2', ['0', '2']), false)
  assert.equal(answerMatches('1', ['0']), false)
  assert.equal(answerMatches('0', ['0']), true)
  assert.equal(answerMatches('', []), false)
})

test('提交确认必须识别未作答警告，不能把漏题当正常确认提交', () => {
  assert.equal(isUnansweredConfirm('你有部分题目没有作答,未作答的题目被视为错误，您确定要提交作业吗？'), true)
  assert.equal(isUnansweredConfirm('作业提交后将不可修改，您确定要提交作业吗？'), false)
})

test('实时视图收到课程和作业状态后分别更新两栏', () => {
  const courses = upsertCourse([], '课程甲', '待检测')
  const detected = upsertCourse(courses, '课程甲', '已检测')
  assert.deepEqual(detected, [{ name: '课程甲', status: '已检测' }])

  const groups = upsertHomework([], 'onlineHomework', '作业一', 'previewing')
  const answering = upsertHomework(groups, 'onlineHomework', '作业一', 'answering', [
    { no: 1, stem: '示例题', source: '题库' },
  ])
  assert.equal(answering[0].rows[0].status, 'answering')
  assert.deepEqual(answering[0].rows[0].questions, [{ no: 1, stem: '示例题', source: '题库' }])
})

test('实时视图按课程隔离作业和来源计数', () => {
  let groups = upsertHomework([], 'onlineHomework', '作业甲', 'answering', [
    { no: 1, stem: '甲题', source: 'AI' },
  ])
  groups = upsertHomework(groups, 'phasedTest', '测验乙', 'waiting_grade')
  assert.deepEqual(groups.map((group) => group.title), ['网上记分作业', '阶段性测验'])
  assert.equal(groups[0].rows[0].questions[0].source, 'AI')
  assert.equal(groups[1].rows[0].status, 'waiting_grade')
})

test('提取统计按作业明细逐项汇总', () => {
  const total = emptyExtractStats()
  addExtractStats(total, { added: 2, merged: 3, skipped: 4, conflict: 5, failed: 6 })
  addExtractStats(total, { added: 1, merged: 0, skipped: 2, conflict: 1, failed: 0 })
  assert.deepEqual(total, { added: 3, merged: 3, skipped: 6, conflict: 6, failed: 6 })
})

test('提取结束有失败或待补偿时不能显示完全成功', () => {
  assert.equal(extractCompletionLabel(emptyExtractStats(), 0, 0), '题库提取完成')
  assert.equal(extractCompletionLabel({ added: 0, merged: 0, skipped: 0, conflict: 0, failed: 1 }, 0, 0), '题库提取结束 · 有待处理项')
  assert.equal(extractCompletionLabel(emptyExtractStats(), 1, 0), '题库提取结束 · 有待处理项')
  assert.equal(extractCompletionLabel(emptyExtractStats(), 0, 1), '题库提取结束 · 有待处理项')
})

test('提取模式检查所有有预览地址的作业，答题模式仍遵守作答条件', () => {
  assert.equal(shouldInspectHistory({ needDo: false, previewHref: '/full-score', status: 'skip_full_score' }, 'extract'), true)
  assert.equal(shouldInspectHistory({ needDo: false, previewHref: '/out-of-window', status: 'skip_out_of_window' }, 'extract'), true)
  assert.equal(shouldInspectHistory({ needDo: false, previewHref: '/attempts', status: 'skip_attempts_exhausted' }, 'extract'), true)
  assert.equal(shouldInspectHistory({ needDo: false, previewHref: '/weight0', status: 'skip_weight0' }, 'extract'), false)
  assert.equal(shouldInspectHistory({ needDo: false, previewHref: '/subjective', status: 'skip_non_objective' }, 'extract'), false)
  assert.equal(shouldInspectHistory({ needDo: false, previewHref: '/non-objective' }, 'answer'), false)
  assert.equal(shouldInspectHistory({ needDo: true, previewHref: '' }, 'extract'), false)
})

test('没有历史查看链接时提取和答题都不能把作业当成可处理', () => {
  assert.equal(shouldInspectHistory({ needDo: true, previewHref: '', status: 'skip_no_history' }, 'extract'), false)
  assert.equal(shouldInspectHistory({ needDo: true, previewHref: '', status: 'skip_no_history' }, 'answer'), false)
})

test('提取模式拒绝损坏或缺答案的正确题，避免进入失败补偿队列', () => {
  const base = { qtype: 'single' as const, stem: '完整题干', options: ['甲', '乙'], correct: true as const }
  assert.equal(canExtractReviewedQuestion(base, ['甲']), true)
  assert.equal(canExtractReviewedQuestion({ ...base, stem: '损坏' + String.fromCodePoint(0xfffd) }, ['甲']), false)
  assert.equal(canExtractReviewedQuestion(base, []), false)
})

test('T-I1 选项打乱仍同一 hash', () => {
  const a = contentHash('single', '1. 用以区别企业的标志是', ['A) 盈利性', 'B) 经济性', 'C) 社会性', 'D) 法定性'])
  const b = contentHash('single', '用以区别企业的标志是', ['社会性', '法定性', '盈利性', '经济性'])
  assert.equal(a, b)
})

test('T-I2 同一题两门课只一行且 course_names 含两课名', () => {
  const item = { qtype: 'single' as const, stem: '用以区别企业的标志是', options: ['盈利性', '经济性', '社会性', '法定性'], answer_texts: ['盈利性'], course_name: '工商企业经营管理' }
  const r1 = upsertBank([], item)
  const r2 = upsertBank(r1.rows, { ...item, course_name: '形势与政策 (1)' })
  assert.equal(r2.rows.length, 1)
  assert.deepEqual(r2.rows[0].course_names, ['工商企业经营管理', '形势与政策 (1)'])
  assert.equal(r2.kind, 'merged')
  assert.equal(mergeCourseNames(['A'], 'A').length, 1)
})

test('T-I3 已验证答案升级未验证导入题', () => {
  const item = { qtype: 'single' as const, stem: '示例题', options: ['甲', '乙'], answer_texts: ['甲'], course_name: '课程A', source: 'import' as const }
  const imported = upsertBank([], item).rows
  const reviewed = upsertBank(imported, { ...item, answer_texts: ['乙'], source: 'ai_verified' as const, course_name: '课程B' })
  assert.equal(reviewed.kind, 'merged')
  assert.deepEqual(reviewed.rows[0].answer_texts, ['乙'])
  assert.equal(reviewed.rows[0].verified, true)
  assert.equal(reviewed.rows[0].source, 'ai_verified')
  assert.deepEqual(reviewed.rows[0].course_names, ['课程A', '课程B'])
})

test('T-I4 两个已验证答案不同保留旧答案并标记冲突', () => {
  const item = { qtype: 'single' as const, stem: '冲突题', options: ['甲', '乙'], answer_texts: ['甲'], source: 'extract' as const }
  const before = upsertBank([], item).rows
  const conflict = upsertBank(before, { ...item, answer_texts: ['乙'], source: 'ai_verified' as const })
  assert.equal(conflict.kind, 'conflict')
  assert.deepEqual(conflict.rows[0].answer_texts, ['甲'])
  assert.equal(conflict.rows[0].verified, true)
  assert.equal(conflict.rows[0].conflict, true)
})

test('已验证旧答案与未验证 JSON 导入答案不同时保留旧答案并标记冲突', () => {
  const verified = { qtype: 'single' as const, stem: '导入冲突题', options: ['甲', '乙'], answer_texts: ['甲'], source: 'extract' as const }
  const before = upsertBank([], verified).rows
  const conflict = upsertBank(before, { ...verified, answer_texts: ['乙'], source: 'import' as const, course_name: '导入课程' })
  assert.equal(conflict.kind, 'conflict')
  assert.deepEqual(conflict.rows[0].answer_texts, ['甲'])
  assert.equal(conflict.rows[0].verified, true)
  assert.equal(conflict.rows[0].conflict, true)
  assert.deepEqual(conflict.rows[0].course_names, ['导入课程'])
})

test('题库 JSON 导入逐项跳过缺字段、空值、未知题型和损坏文本', () => {
  const valid = { qtype: 'single', stem: '有效题', options: ['甲', '乙'], answer_texts: ['甲'] }
  const parsed = parseBankJson(JSON.stringify([
    valid,
    { ...valid, stem: '' },
    { ...valid, qtype: 'essay' },
    { ...valid, options: [] },
    { ...valid, answer_texts: [] },
    { ...valid, stem: '损坏�题干' },
    { ...valid, answer_texts: ['不存在的选项'] },
    { ...valid, answer_texts: ['甲', '乙'] },
  ]))
  assert.deepEqual(parsed.items, [valid])
  assert.equal(parsed.skipped, 7)
  assert.throws(() => parseBankJson('{'), /JSON/)
  assert.throws(() => parseBankJson('{}'), /JSON 需为题目数组/)
})

test('T-D2 名额暂停不补位', () => {
  const p = new SlotPool(2)
  assert.equal(p.request('a'), 'launching')
  p.occupy('a')
  assert.equal(p.request('b'), 'launching')
  p.occupyingVerify('b')
  assert.equal(p.request('c'), 'queued')
  assert.equal(p.toolbarCount(), 2)
  assert.equal(p.promoteQueued(), null)
  assert.equal(p.get('c'), 'queued')
  assert.equal(slotCountsInToolbar('occupying_verify'), true)
  assert.equal(slotCountsInToolbar('queued'), false)
})

test('T-D2b 释放后才把排队号提升，验证中不补位', () => {
  const p = new SlotPool(2)
  assert.equal(p.request('a'), 'launching')
  p.occupy('a')
  assert.equal(p.request('b'), 'launching')
  p.occupyingVerify('b')
  assert.equal(p.request('c'), 'queued')
  p.release('a')
  assert.equal(p.promoteQueued(), 'c')
  assert.equal(p.get('c'), 'launching')
  assert.equal(p.get('b'), 'occupying_verify')
  assert.equal(p.promoteQueued(), null)
})

test('T-K1 提交点 ok 不点 cancel', () => {
  assert.equal(SUBMIT.ok, '.xcConfirm a.sgBtn.ok')
  assert.equal(SUBMIT.cancel, '.xcConfirm a.sgBtn.cancel')
  assert.notEqual(SUBMIT.ok, SUBMIT.cancel)
})

test('T-K3 次数闸门', () => {
  assert.equal(maxAttemptsThisRun({ replyCountHidden: -1, visible: '1/无限制', used: 1 }), 10)
  assert.equal(maxAttemptsThisRun({ replyCountHidden: -1, visible: '1/无限制', used: 1, runLimit: 2 }), 2)
  assert.equal(maxAttemptsThisRun({ replyCountHidden: 3, visible: '0/3', used: 0, cap: 3 }), 1)
  assert.equal(maxAttemptsThisRun({ replyCountHidden: 8, visible: '2/8', used: 2, cap: 8, runLimit: 2 }), 2)
  assert.equal(maxAttemptsThisRun({ replyCountHidden: 8, visible: '2/8', used: 2, cap: 8 }), 6)
  assert.equal(maxAttemptsThisRun({ replyCountHidden: 5, visible: '4/5', used: 4, cap: 5 }), 1)
})

test('批阅必须以最新历史记录为准', () => {
  const latest = newestHistory([
    { status: '已批阅', score: 100, submittedAt: '2026/9/18 10:00:00', hasContinue: false, hasHistoryView: true },
    { status: '未完成提交', score: null, submittedAt: '2026/9/18 11:05:00', hasContinue: true, hasHistoryView: false },
  ])
  assert.equal(latest?.status, '未完成提交')
})

test('历史成绩只读弹窗区分未批阅、未完成、仅续做和无查看入口', () => {
  assert.equal(historyDisplayState({ status: '已批阅', score: 95, submittedAt: '2026/9/19 10:00', hasContinue: false, hasHistoryView: true, historyHref: '/history.aspx?id=1' }), 'viewable')
  assert.equal(historyDisplayState({ status: '未批阅', score: null, submittedAt: '2026/9/19 10:00', hasContinue: false, hasHistoryView: false }), 'ungraded')
  assert.equal(historyDisplayState({ status: '未完成提交', score: null, submittedAt: '2026/9/19 10:00', hasContinue: true, hasHistoryView: false }), 'unfinished')
  assert.equal(historyDisplayState({ status: '已保存', score: null, submittedAt: '2026/9/19 10:00', hasContinue: true, hasHistoryView: false }), 'continue_only')
  assert.equal(historyDisplayState({ status: '已批阅', score: 95, submittedAt: '2026/9/19 10:00', hasContinue: false, hasHistoryView: false }), 'no_view')
})

test('课程日志分级并过滤完整地址、token 和密钥形态', () => {
  assert.equal(runtimeLogLevel('正在读取题目'), 'running')
  assert.equal(runtimeLogLevel('校对完成'), 'success')
  assert.equal(runtimeLogLevel('等待批阅'), 'warning')
  assert.equal(runtimeLogLevel('写入失败'), 'error')
  const clean = sanitizeRuntimeLogText('访问 https://example.test/path?xhtoken=secret token=abc sk-test-secret')
  assert.equal(clean.includes('https://'), false)
  assert.equal(clean.includes('secret'), false)
  assert.equal(clean.includes('sk-test'), false)
})

test('提交证据排除新建未交卷记录和日期格式变化', () => {
  const old = { status: '已批阅', score: 90, submittedAt: '2026/9/19 10:00:00', hasContinue: false, hasHistoryView: true }
  const unfinished = { ...old, status: '未完成提交', submittedAt: '2026/9/19 11:00:00', hasContinue: true, hasHistoryView: false }
  assert.equal(newSubmission([old, unfinished], ['2026-09-19 10:00:00']), null)
  assert.equal(newSubmission([{ ...unfinished, status: '未提交记录', hasContinue: false }], [old.submittedAt]), null)
  const submitted = { ...old, submittedAt: unfinished.submittedAt }
  assert.equal(newSubmission([unfinished, submitted], [old.submittedAt]), submitted)
})

test('状态码未另造', () => {
  for (const s of SLOT) assert.equal(isKnownSlot(s), true)
  for (const s of ACCOUNT) assert.equal(isKnownAccount(s), true)
  for (const s of HOMEWORK) assert.equal(isKnownHomework(s), true)
  for (const s of QUESTION) assert.equal(isKnownQuestion(s), true)
  assert.equal(isKnownAccount('授权直通'), false)
  assert.equal(isKnownQuestion('notdo'), false)
})

test('T-H 不把 notdo 当已做；预览路径不混', () => {
  assert.equal(isDoneByAnswer(''), false)
  assert.equal(isDoneByAnswer('0'), true)
  assert.equal(isDoneByAnswer('0,2'), true)
  assert.equal(isPreviewPath('/study/assignment-preview.aspx'), true)
  assert.equal(isAnswerPath('/study/assignment/preview.aspx'), true)
  assert.equal(isPreviewPath('/study/assignment/preview.aspx'), false)
  assert.equal(judgeListRow('客观题', 0).status, 'skip_weight0')
  assert.equal(judgeListRow('主观题', 20).needDo, false)
  assert.equal(judgeListRow('客观题', 20).needDo, true)
})

test('T-J1 只认 option_texts', () => {
  assert.deepEqual(parseOptionTexts('{"option_texts":["盈利性"]}'), ['盈利性'])
  assert.equal(parseOptionTexts('A'), null)
  assert.equal(parseOptionTexts('{"answer":"A"}'), null)
  assert.equal(parseOptionTexts('{"option_texts":[null]}'), null)
  assert.equal(parseOptionTexts('{"option_texts":[1]}'), null)
  assert.equal(parseOptionTexts('{"option_texts":["正确", ""]}'), null)
  assert.equal(parseOptionTexts('说明 {"option_texts":["正确"]}'), null)
  assert.deepEqual(parseOptionTexts('{"option_texts":["正确","正确"]}'), ['正确'])
})

test('AI 正文校验按规范化选项匹配，失败原因可区分', () => {
  assert.deepEqual(validateAiAnswer('{"option_texts":["A. 甲"]}', ['甲', '乙'], 'single'), { texts: ['甲'], reason: null })
  assert.deepEqual(validateAiAnswer('{"option_texts":["A. 甲","甲"]}', ['甲', '乙'], 'single'), { texts: ['甲'], reason: null })
  assert.deepEqual(validateAiAnswer('A', ['甲', '乙'], 'single'), { texts: null, reason: 'invalid_json' })
  assert.deepEqual(validateAiAnswer('{"option_texts":["丙"]}', ['甲', '乙'], 'single'), { texts: null, reason: 'option_mismatch' })
  assert.deepEqual(validateAiAnswer('{"option_texts":["甲","乙"]}', ['甲', '乙'], 'single'), { texts: null, reason: 'invalid_count' })
})

test('T-B3 Excel 三列跳过表头，假数据不用真学号', () => {
  const rows = parseCsv('姓名,账号,密码\n张同学,000000000001,pass1\n李同学,000000000002,pass2\n')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, '张同学')
  assert.equal(rows[0].username, '000000000001')
  assert.equal(rows[1].name, '李同学')
  assert.equal(rows.every((r) => !/贾李鹏|202583/.test(r.username + r.name)), true)
})

test('学生切换默认一颗胶囊，其余进三点', () => {
  assert.deepEqual(visibleStudentIndexes(1, 0), [0])
  assert.deepEqual(visibleStudentIndexes(2, 1), [1])
  assert.deepEqual(visibleStudentIndexes(3, 0), [0])
  assert.deepEqual(visibleStudentIndexes(3, 2), [2])
  assert.deepEqual(visibleStudentIndexes(10, 9), [9])
  assert.deepEqual(overflowStudentIndexes(3, [0]), [1, 2])
  assert.deepEqual(overflowStudentIndexes(3, [2]), [0, 1])
  assert.deepEqual(overflowStudentIndexes(10, [9]), [0, 1, 2, 3, 4, 5, 6, 7, 8])
})

test('空壳对话框不算扫码，要看见标题或二维码容器', () => {
  const vis = { display: 'block', visibility: 'visible', opacity: '1', width: 400, height: 300 }
  assert.equal(qrDialogLooksOpen({ ...vis, text: '微信扫码验证', qrVisible: false }), true)
  assert.equal(qrDialogLooksOpen({ ...vis, text: '请使用微信扫码进行验证\n未扫码', qrVisible: true }), true)
  assert.equal(qrDialogLooksOpen({ ...vis, text: '', qrVisible: false }), false)
  assert.equal(qrDialogLooksOpen({ display: 'none', visibility: 'visible', opacity: '1', width: 400, height: 300, text: '微信扫码验证', qrVisible: true }), false)
  assert.equal(qrDialogLooksOpen({ ...vis, text: '微信扫码验证', qrVisible: false, top: -400, left: 0, vw: 1280, vh: 800 }), false)
})

test('扫码成功后二维码容器仍在，但不再阻塞验证收口', () => {
  const vis = { display: 'block', visibility: 'visible', opacity: '1', width: 400, height: 300, qrVisible: true }
  assert.equal(qrDialogLooksOpen({ ...vis, text: '微信扫码验证成功！进入作答' }), false)
})

test('程序内二维码只对当前学生课程作业和版本有效', () => {
  const snapshot = { localId: 'student-a', courseName: '课程甲', homeworkName: '作业一', version: 2 }
  assert.equal(qrSnapshotMatches(snapshot, snapshot), true)
  assert.equal(qrSnapshotMatches(snapshot, { ...snapshot, version: 1 }), false)
  assert.equal(qrSnapshotMatches(snapshot, { ...snapshot, homeworkName: '作业二' }), false)
  assert.equal(qrSnapshotMatches(snapshot, { ...snapshot, localId: 'student-b' }), false)
})

test('验证完毕必须由主进程复核真实页面，二维码仍在或门户未就绪都不放行', () => {
  assert.equal(verificationFailure('homework', { qrOpen: true, portalReady: false }), '作业二维码仍在，请扫码后再确认')
  assert.equal(verificationFailure('homework', { qrOpen: false, portalReady: false }), null)
  assert.equal(verificationFailure('portal', { qrOpen: false, portalReady: false }), '登录验证尚未完成')
  assert.equal(verificationFailure('portal', { qrOpen: false, portalReady: true }), null)
})

test('查看题库密码连续错误五次冻结六十秒，成功或冻结到期后清零', () => {
  const start = 1_000_000
  let state = { failedAttempts: 0, lockedUntil: 0 }
  for (let i = 1; i <= 4; i++) {
    const result = bankAccessAttempt(state, false, start + i)
    state = result.state
    assert.equal(result.ok, false)
    assert.equal(result.remainingAttempts, 5 - i)
    assert.equal(result.lockedUntil, 0)
  }
  const fifth = bankAccessAttempt(state, false, start + 5)
  assert.equal(fifth.state.failedAttempts, 5)
  assert.equal(fifth.lockedUntil, start + 60_005)
  assert.equal(bankAccessAttempt(fifth.state, true, start + 30_000).ok, false)
  const after = bankAccessAttempt(fifth.state, true, start + 61_000)
  assert.equal(after.ok, true)
  assert.deepEqual(after.state, { failedAttempts: 0, lockedUntil: 0 })
})

test('题库列表查询始终使用服务端分页并覆盖课程、题干、选项和答案搜索', () => {
  const query = buildBankQuery({ page: 2, pageSize: 25, courseName: '课程甲', searchMode: 'fuzzy', searchText: '关键字' })
  assert.equal(query.from, 25)
  assert.equal(query.to, 49)
  assert.match(query.path, /select=id%2Cqtype%2Cstem%2Coptions%2Canswer_texts%2Ccourse_names%2Cupdated_at/)
  assert.match(query.path, /course_names=cs./)
  assert.match(query.path, /stem.ilike/)
  assert.match(query.path, /options-%3E%3E0.ilike/)
  assert.match(query.path, /answer_texts-%3E%3E0.ilike/)
  assert.match(query.path, /course_names-%3E%3E0.ilike/)
})

test('未验证同一学生只允许一次点击做作业', () => {
  assert.equal(canClickDoHomework(false, 0), true)
  assert.equal(canClickDoHomework(false, 1), false)
  assert.equal(canClickDoHomework(false, 2), false)
  assert.equal(canClickDoHomework(true, 99), true)
})

test('课程并发上限同时运行且保持输入顺序', async () => {
  let active = 0
  let maxActive = 0
  const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, value === 1 ? 10 : 1))
    active--
    return value * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8])
  assert.equal(maxActive, 2)
})

test('CHG-026 粘贴导入识别逗号、Tab、空格、换行和表头并保留错误行', () => {
  const parsed = parsePastedAccounts('姓名\t账号\t密码\n张三\t1001\tpass 1\n李四,1002,pass2\n王五，1003，pass3\n赵六 1004 pass4\n坏行 1005')
  assert.deepEqual(parsed.rows, [
    { name: '张三', username: '1001', password: 'pass 1' },
    { name: '李四', username: '1002', password: 'pass2' },
    { name: '王五', username: '1003', password: 'pass3' },
    { name: '赵六', username: '1004', password: 'pass4' },
  ])
  assert.equal(parsed.errors.length, 1)
  assert.equal(parsed.errors[0].reason, '缺少密码')
})

test('CHG-026 课程分页计算边界并能定位当前课程所在页', () => {
  const names = ['课程一', '课程二', '课程三', '课程四', '课程五']
  assert.equal(pageCountForCourses(names, 2), 3)
  assert.deepEqual(pageSlice(names, 2, 2), ['课程三', '课程四'])
  assert.equal(pageForCourse(names, 2, '课程五'), 3)
  assert.equal(pageForCourse(names, 2, '不存在'), 1)
})

test('CHG-026 粘贴导入标记空行和空字段，确认前不产生账号记录', () => {
  const parsed = parsePastedAccounts('姓名,账号,密码\n\n张三,1001,pass1\n李四,,pass2')
  assert.deepEqual(parsed.rows, [{ name: '张三', username: '1001', password: 'pass1' }])
  assert.deepEqual(parsed.errors.map((item) => item.reason), ['空行', '存在空字段'])
  assert.equal(parsed.errors[0].line, 2)
})

test('CHG-026 粘贴导入处理 CSV 引号并拒绝多余字段', () => {
  const parsed = parsePastedAccounts('姓名,账号,密码\n"张,三",1001,pass1\n李四,1002,pass2,多余字段')
  assert.deepEqual(parsed.rows, [{ name: '张,三', username: '1001', password: 'pass1' }])
  assert.match(parsed.errors[0]?.reason || '', /格式错误/)
})
