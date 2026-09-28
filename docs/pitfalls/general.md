# 通用避坑

## 浏览器推荐不能用页面 JS 堆冒充浏览器内存

- 现象：浏览器池已真实运行且浏览器数正确，但推荐值一直显示保守的 512MB，recommendationSampled 为 false。
- 根因：performance.memory.usedJSHeapSize 只代表页面 JavaScript 堆；当前 Chromium 环境中该字段为 0 或不可用，不能代表浏览器进程内存。持久化上下文的 Patchright 客户端还可能不暴露所属 Browser 的进程 PID。
- 正确做法：按学生独立的 user-data-dir 从系统进程表定位 Chromium 根进程，汇总根进程及子进程 RSS；采样失败时保留未采样状态和保守回退值，不把 0 当成有效样本。
- 验证方式：node --experimental-strip-types tests/e2e-browser-pool.mjs 真实启动 3 个目标账号，输出账号并发 2、浏览器数 2、目标账号排队 1、recommendationSampled=true 和真实 browserAverage；npm run test:p0 与 npm run build 同时通过。
- 禁止事项：不要只读取页面 performance.memory；不要把 0、固定演示值或上一次样本伪装成当前浏览器样本；不要把排队账号纳入浏览器内存平均值。
- 相关文件或命令：electron/pool.ts、electron/core/machine.ts、tests/e2e-browser-pool.mjs。
- 适用范围：浏览器池占用、工作台本机状态和推荐账号/课程并发。
- 来源：2026-09-22 浏览器池真实 E2E 首次失败、RSS 根因修复与复测。

## 题库查看门禁测试必须提供标准输入

- 现象：直接运行题库查看 E2E 时，Node 报未收敛的顶层 await，测试没有进入题库页面。
- 根因：tests/e2e-bank.mjs 按顺序从标准输入读取三个门禁密码；无交互启动没有提供输入，Promise 一直等待。
- 正确做法：测试启动后通过 PTY 标准输入提供密码；密码只进入测试进程内存，不写命令输出、文档或日志。
- 验证方式：题库查看 E2E 输出密码数量、冻结持久化、冻结到期和删除回读结果，并以退出码 0 收口。
- 禁止事项：不要把门禁密码硬编码进测试脚本；不要把一次缺少 stdin 的测试基础设施失败记成产品功能失败。
- 相关文件或命令：tests/e2e-bank.mjs、npm run test:e2e:bank。
- 适用范围：需要真实查看题库密码门禁的 Electron 产品 E2E。
- 来源：2026-09-21 题库查看真机测试首次失败与提供标准输入后的复测。

## 历史状态探针不能写死作业名称

- 现象：真实历史探针已读取到候选状态，但点击历史成绩按钮时因固定作业名称不存在而超时退出。
- 根因：探针用演示作业名定位卡片，没有复用同一轮真实课程快照中已经发现的课程和作业对象。
- 正确做法：先从真实快照或历史读取结果获得课程名、作业名和状态，再用对应课程卡片内的历史成绩按钮完成 UI 断言；找不到候选时保持待测，不改写为通过。
- 验证方式：本轮探针输出 viewable 66 / unfinished 33 / no_view 19，但固定名称定位超时；工作台动态作业定位仍通过并完成 no_view disabled 断言。
- 禁止事项：禁止使用固定演示作业名代替真实快照；禁止把 API/IPC 读取成功当成页面按钮已点击；禁止因状态数据存在就提前标绿对应 UI 分支。
- 相关文件或命令：tests/e2e-workbench.mjs、electron/runner.ts、liran_docs/09-真机实测.md。
- 适用范围：历史成绩异常状态的真实页面复测。
- 来源：2026-09-22 真机探针失败与工作台动态定位复测。

## 课程选择 E2E 不能用 IPC 替代页面点击

- 现象：主进程快照显示已选课程和队列范围正确，但人工观察产品窗口仍停在“等待选择课程”，无法证明用户实际点击了课程卡片和开始按钮。
- 根因：测试直接调用 setSelectedCourses 和 startSelectedCourses，绕过了 HomeView 的学生切换、课程卡片和主按钮。
- 正确做法：使用产品内置 Patchright 点击学生切换菜单、课程卡片和“开始执行”，再用主进程快照断言队列和终态；IPC 只用于准备配置或读取权威结果。
- 验证方式：tests/e2e-course-selection.mjs 输出 independentSelections、multiSelect、unselectedExcluded、queueScoped、stoppedAndEditable、rescanClearsSelection 和 partialStudentSkipped 均为 true。
- 禁止事项：不要把直接 IPC 成功当作 UI 按钮已接线；不要在等待选课闸门处关闭应用后标记选课完成。
- 相关文件或命令：src/views/HomeView.vue、tests/e2e-course-selection.mjs。
- 适用范围：所有需要证明四页可见按钮真实动作的产品 E2E。
- 来源：2026-09-22 用户截图反馈、真实 UI E2E 补强与复测。

## 可选课程状态必须与选择结果同步，停止后才恢复编辑

- 现象：多学生已成功保存各自选中课程，但未选课程仍保留检测状态；任务停止后再次清空或调整本轮选择又被“当前不在课程选择阶段”拒绝。
- 根因：选课接口只更新 selectedCourseNames，没有同步课程行状态；编辑门禁又只接受 awaitingCourseSelection，漏掉任务完全停止后的可编辑状态。
- 正确做法：在主进程唯一选课入口同步未选课程为“本轮未选择”，重新选中时恢复为“已检测”；运行中继续拒绝修改，只有等待选课或全局任务已停止时允许编辑。
- 验证方式：构建后运行 node tests/e2e-course-selection.mjs，必须同时通过多学生独立选择、未选课程排除、选中课程队列范围和停止后恢复编辑；再运行 node tests/e2e-run-lock.mjs 确认运行中 UI 与 IPC 仍锁定。
- 禁止事项：禁止只在 Vue 中改颜色而不更新主进程权威快照；禁止为通过测试放宽运行中锁；禁止停止后仍要求旧的等待器存在。
- 相关文件或命令：electron/runner.ts、tests/e2e-course-selection.mjs、tests/e2e-run-lock.mjs。
- 适用范围：答题和提取题库的可选课程模式、多学生课程范围和停止恢复。
- 来源：2026-09-21 产品 Electron E2E 稳定复现、根因修复与复测。

## 多账号产品 E2E 不能持续打印完整状态树

- 现象：多账号真实提取测试运行一段时间后 Node 进程 CPU 为 0、没有新结果，误判为产品卡题。
- 根因：测试每轮把所有学生、课程、作业明细完整序列化输出，stdout 管道被填满后测试进程阻塞。
- 正确做法：断言继续使用完整内存状态，日志只输出学生序号、状态、动作、进度和五项汇总；只在状态摘要变化时打印。
- 验证方式：7 个唯一账号运行时输出持续可消费，最终能收到提取汇总，不因日志背压中断。
- 禁止事项：禁止在轮询日志中输出完整课程/作业树、账号标识或任何凭据。
- 相关文件或命令：\`tests/e2e-product.mjs\`。
- 适用范围：多账号 Electron 产品 E2E。
- 来源：2026-09-21 7 账号无头提取测试发现 stdout 背压。

## 题库导入真机脚本必须复用本机安全配置回退

- 现象：题库查看测试能读取本机 Supabase 配置，题库导入测试却在启动时提示配置缺失，尚未进入导入流程。
- 根因：导入测试脚本只读取环境变量和目标文件，没有复用 Electron `safeStorage` 中已保存的设置。
- 正确做法：按已有题库查看测试顺序读取环境变量/目标文件；缺失时短暂启动 Electron，在主进程解密本机设置后只把必要配置留在测试内存，随后关闭配置进程。
- 验证方式：不提供环境变量时运行 `npm run test:e2e:bank-import`，真实完成导入、去重、冲突、失败统计和批次清理回读。
- 禁止事项：禁止把 URL、Key 写入仓库、命令输出、日志或文档；禁止为测试复制一套明文配置文件。
- 相关文件或命令：`tests/e2e-bank.mjs`、`tests/e2e-bank-import.mjs`、`npm run test:e2e:bank-import`。
- 适用范围：所有依赖本机 Supabase 安全配置的 Electron 真机测试。
- 来源：2026-09-21 真实题库导入真机测试启动失败与修复后复测。

## macOS 无头显隐不能只靠 CDP 最小化或负坐标

> 历史废弃规则：本节记录旧方案及其失败背景。当前产品禁止用任何窗口显隐模拟无头，执行规则见“真实 headless 与 headed 必须分别启动”。

- 现象：界面显示“无头浏览器”，Chrome for Testing 仍有一部分窗口留在屏幕内；CDP 请求最小化无效，移到极大负坐标后又被 macOS 夹回可见区域。
- 根因：页面级 CDP 不能调用 `SystemInfo.getProcessInfo`，因此取不到浏览器根 PID；macOS 还会修正 Chrome 窗口边界，CDP 边界不能代表应用是否真正隐藏。
- 正确做法：从浏览器级 CDP 会话取得根 PID，使用 `System Events` 按 unix id 修改该进程的 `visible`，再读取真实隐藏结果；CDP 边界只作为非 macOS 或原生调用失败时的回退。
- 验证方式：一个账号分别完成无头和可视化全量提取，运行中真实显隐采样全部一致；同一根 PID 完成 `headless → visual → headless`，浏览器不重启。
- 禁止事项：禁止仅改变按钮文字；禁止按应用名隐藏所有 Chrome；禁止把排队账号计为浏览器窗口；禁止用页面级 CDP 查询浏览器进程。
- 相关文件或命令：`electron/core/native-window.ts`、`electron/core/window-bounds.ts`、`electron/pool.ts`、`tests/e2e-display-toggle.mjs`、`tests/e2e-product.mjs`。
- 适用范围：macOS 的持久化 Chrome for Testing 无头/可视化切换。
- 来源：2026-09-21 真实 Electron 产品 E2E、CDP 边界采样和同进程切换验证。

## Markdown 行尾续行符不能作为账号密码正文保存

- 现象：从 Goal 文档导入的账号和多数密码末尾多出一个反斜杠，所有账号均登录失败。
- 根因：Goal 文档使用反斜杠续行；测试入口以 `[^\s]+` 直接捕获字段，把换行前的反斜杠一并写入安全存储。
- 正确做法：解析前只清理紧邻换行的 Markdown 续行符，再解析账号块；兼容有无“密码：”标签，并按账号去重。
- 验证方式：P0 使用假账号覆盖行尾反斜杠、缺少密码标签和重复账号；真实产品 E2E 重新导入后不得再出现末尾反斜杠。
- 禁止事项：禁止直接用宽泛的 `[^\s]+` 把文档字段原样写入账号存储；禁止在日志中打印解析后的真实账号或密码。
- 相关文件或命令：`tests/helpers/goal-accounts.mjs`、`tests/e2e-product.mjs`、`npm run test:p0`。
- 适用范围：从 Markdown Goal 或需求文档读取真机测试凭据的测试入口。
- 来源：2026-09-21 多账号真实产品 E2E 登录失败与字符码点检查。

## Vue 响应式代理不能直接跨 Electron IPC

- 现象：题库单删或批删确认后一直停在“正在删除并回读”，主进程没有收到删除请求。
- 根因：渲染层把 Vue `ref` 中的响应式数组代理直接传给 `ipcRenderer.invoke`，Electron 结构化克隆抛出 `An object could not be cloned.`。
- 正确做法：跨 IPC 前复制成普通数组或普通对象，并在调用处使用 `try/catch/finally` 恢复忙碌状态和显示错误。
- 验证方式：真实 Electron 依次完成单删取消、单删确认、批删取消和批删确认；Supabase 删除后回读不存在，按钮不再永久忙碌。
- 禁止事项：不要把 Vue Proxy、Set、Map 或含不可克隆成员的响应式对象直接传给 Electron IPC。
- 相关文件或命令：`src/views/BankView.vue`、`tests/e2e-bank.mjs`、`npm run test:e2e:bank`。
- 适用范围：所有渲染进程到主进程的 IPC 参数。
- 来源：真实 Electron E2E 与错误复现。

## 待回写题干含替换字符不能猜测匹配

- 现象：当前账号的两条待回写候选题干包含 U+FFFD，真实历史页对应相近文本为正常汉字，精确 hash 无法匹配。另一个候选的题干选项可精确匹配，不能归为同一原因。
- 根因：已确认存储候选文本损坏导致身份不同；损坏最初发生在站点、浏览器读取还是保存前，信息不全，待进一步验证。
- 正确做法：作答前拦截缺失或含替换字符的题干选项，云端写入口同样拦截；旧候选保留待处理。
- 验证方式：2026-09-19 产品浏览器只读探针检查当前账号的三个残留项；离线回归覆盖题干、选项损坏及空文本。
- 禁止事项：不能删除替换字符再计算身份，不能按相似度或旧题号猜测后删库、入库或清除待回写。
- 相关文件或命令：electron/core/hash.ts、electron/answer.ts、electron/bank.ts、npm run test:p0。
- 适用范围：自动答题与题库写入；旧候选修复尚未完成。
- 来源：真实只读验证和代码检查。

## 批阅页单多选与判断选项容器不同

- 现象：历史读到 56 题，32 条待回写候选全部匹配失败。
- 根因：只查询 e-checking-a 判断容器，漏掉单选多选的 e-choice-a，选项集合为空导致 hash 不同。
- 正确做法：限定题目内部同时支持这两个已实测容器，所选仍用 checked。
- 验证方式：真实只读探针修正后同一试卷匹配 32/32；本地 DOM 测试覆盖两种容器。
- 禁止事项：不要把判断题样本结构推广成所有题型；不要以空选项计算有效题库身份。
- 相关文件或命令：electron/review.ts、electron/core/selectors.ts、tests/answer-writeback.mts。
- 适用范围：自动校对及独立提取。
- 来源：真实产品浏览器只读检查。

## 删除请求成功不代表错答案已消失

- 现象：HTTP 成功但旧行仍在时，原实现会把错答案删除记为成功，下一轮可能重复命中。
- 根因：deleteByHash 仅检查 res.ok，未读取数据库确认。此为已证实代码缺口，尚不能断言是用户 97.5 分的唯一原因。
- 正确做法：按 hash 与被判错答案版本删除后读回确认；网络异常保留待删除并禁用旧答案，其他学生已纠正版本不误删。
- 验证方式：P0 覆盖无效删除、读取失败、删除后不存在及并发纠正；真实云端删除闭环待测。
- 禁止事项：禁止仅凭 HTTP 2xx 解除待回写，或未经校对只因未满分删除题目。
- 相关文件或命令：electron/core/bank-delete.ts、electron/bank.ts、npm run test:p0。
- 适用范围：校对删错、待回写补偿。
- 来源：代码检查与离线回归。

## 新时间记录不一定是成功交卷

- 现象：历史列表新出现“未完成提交”或“未提交记录”，旧判定仅比较时间字符串即视为交卷成功。
- 根因：历史列表包含草稿，且同一时间可有斜杠/横线两种格式；校对还可能改读尚未刷新的预览页。
- 正确做法：排除续做和未交卷记录，比较解析后的时间，只用本次新提交记录校对，保留实际找到记录的页面引用。
- 验证方式：新增提交证据回归通过；真实站点新判定仍待新版运行。
- 禁止事项：禁止把新建草稿或日期格式变化当作成功提交。
- 相关文件或命令：electron/core/homework.ts、electron/submit.ts、electron/runner.ts、npm run test:p0。
- 适用范围：提交确认和批阅。
- 来源：页面结构、代码排查、离线回归。

## CDP 答案兜底需正确转义并释放会话

- 现象：主世界读取失败后，CDP 兜底仍读不到已填写的判断值 0。
- 根因：拼接选择器时双引号进入 JavaScript 字符串却未转义，Runtime.evaluate 表达式语法错误；每次还创建了未 detach 的 CDP 会话。
- 正确做法：选择器完整构建后以 JSON.stringify 转义嵌入表达式，finally 释放会话。
- 验证方式：tests/answer-writeback.mts 强制主读取返回空，修复前断言失败，修复后读取 0 通过；多选延迟、额外选项仍通过。
- 禁止事项：不要把 Runtime.evaluate 错误返回当作学生尚未作答的证据。
- 相关文件或命令：electron/page-tools.ts；node --experimental-strip-types tests/answer-writeback.mts。
- 适用范围：Patchright 与页面主世界答案读取。
- 来源：本地真实 Chromium DOM 集成回归，不替代站点 E2E。

## 并发回写不能保存旧全量队列

- 现象：两个账号并发补偿时，一个账号保存会覆盖另一个账号的新待回写项。
- 根因：flushWriteback 在网络操作前读取全量队列，异步结束后原样替换全量。
- 正确做法：保存前重读当前队列，只替换本账号的补偿结果；读取合并写入之间不 await。
- 验证方式：P0 交错账号更新回归通过，22/22；真实并发回写尚待实测。
- 禁止事项：禁止用网络操作前的跨账号快照覆盖当前存储。
- 相关文件或命令：electron/core/writeback.ts、electron/runner.ts、tests/p0.test.mts。
- 适用范围：多账号待回写补偿。
- 来源：代码检查和离线回归。

## AI 答案解析不能强制转字符串

- 现象：option_texts 含 null 时旧解析器返回字符串 null；夹带说明文字也被截取 JSON 接受。
- 根因：String 转换与截取首尾大括号掩盖了协议错误。
- 正确做法：严格解析完整 JSON，仅接受非空字符串数组；单选和判断只允许一个答案，非法结果继续模型降级。
- 验证方式：tests/p0.test.mts 的 T-J1 已先失败再通过，21/21。
- 禁止事项：不要把数字、对象或 null 强转成答案正文。
- 相关文件或命令：electron/core/ai-parse.ts、electron/ai.ts、npm run test:p0。
- 适用范围：硅基流动回答解析。
- 来源：离线复现与代码检查，尚未对更新后的解析器进行真实模型链路复测。

## 非空答案不能证明完整回填

- 现象：多选只写入部分选项或保留旧答案时，非空检查仍会宣布成功。
- 根因：answer.ts 只通过 waitAnswer 判断非空，未比较期望集合。
- 正确做法：按选项正文解析目标 index 集合；多选逐次等待写入，最终精确集合匹配；写入超时停止该份作业。
- 验证方式：P0 完整集合回归通过；真实站点复测仍待执行。
- 禁止事项：不要把点击失败当作模型失败而空过，也不要用非空值替代完整答案校验。
- 相关文件或命令：electron/answer.ts、electron/page-tools.ts、npm run test:p0。
- 适用范围：单选、多选、判断逐题回填。
- 来源：代码检查与离线测试。

## 补答后必须重建整卷复核计划

- 现象：提交前发现漏题并成功补答后，最终复核仍按补答前的空答案计划判失败。
- 根因：复核计划在补答前只构建一次，题目结果已更新但期望 index 集合没有同步重建。
- 正确做法：每轮补答后按最新选项正文和当前页面 data-index 重建复核计划，再核对隐藏答案与右侧 active。
- 验证方式：本地 Chromium 回归先构建空计划，再更新为 AI 答题正文，确认计划从空集合变为当前 index。
- 禁止事项：禁止补答后复用旧计划；禁止只检查答案非空而不核对完整集合。
- 相关文件或命令：electron/answer.ts、electron/page-tools.ts、tests/answer-writeback.mts。
- 适用范围：作答页提交前补答与整卷复核。
- 来源：代码检查与红绿回归。

## 未作答警告是拦截信号，不是第二次正常确认

- 现象：右侧题号仍有未提亮项时，站点弹出“部分题目没有作答”，旧流程继续点确定并提交漏题卷。
- 根因：把异常未作答警告误当成固定的第二次正常确认。
- 正确做法：提交前双检 `[name=answer]` 和 `a.e-item.active`；若警告仍出现，点绿色取消并返回补答，历史不得新增。
- 验证方式：P0 识别两种弹窗正文；产品 E2E 需验证警告场景取消后无历史新记录。
- 禁止事项：禁止在未作答警告上点确定；禁止只凭第一次本地复核就忽略站点警告。
- 相关文件或命令：electron/core/homework.ts、electron/submit.ts、liran_docs/09-真机实测.md。
- 适用范围：自动答题提交链路。
- 来源：用户真实站点截图、代码修复与离线测试。

## 回填说明

暂无历史坑。

原因：本项目在建立知识库时为空目录；无 git 仓库、无提交、无业务功能、无测试/部署记录、无开发文档；当前对话没有已验证的技术坑。禁止编造条目。后续新坑按 README 格式追加到本文件，或在出现明确模块后再拆文件并更新索引。

## 作业页没有原生 radio/checkbox

- 现象：用 `input[type=radio]` / `checkbox` 统计或勾选，结果是 0，点了也不保存。
- 根因：选项是自定义 `li.e-a`，点击后由 `previewnew.js` 写 `[name=answer]` 再 POST。
- 正确做法：点 `li.e-a[data-index]`，以该题 `form [name=answer]` 是否变成期望值判断成功。
- 验证方式：`document.querySelectorAll('input[type=radio]').length === 0`，且点击后 answer 有值。
- 禁止事项：不要自己改 class 冒充已选；不要编造接口字段。
- 相关文件或命令：`开大自动答题页面结构.md`；`/study/js/assignment/previewnew.js`
- 适用范围：`assignment/preview.aspx` 在线作业作答页
- 来源：验证

## course_parallel 不能只并发扫课

- 现象：课程检测使用 `Promise.all`，但检测完成后的作答循环仍逐份执行，同一账号无法按配置同时推进多门作业。
- 根因：答题循环使用嵌套 `for` 串行消费 `DetectedCourse.homeworks`，配置只影响检测阶段。
- 正确做法：把待做作业展平后用受限并发调度；同一账号共享扫码闸门和浏览器上下文，扫码期间仍占位。
- 验证方式：离线并发自检同时运行数不超过配置上限且结果保持输入顺序；真实运行需在扫码场景复测同号多作业。
- 禁止事项：不要为每份作业新开浏览器；不要让验证中的账号释放名额。
- 相关文件或命令：`electron/core/concurrency.ts`、`electron/runner.ts`、`npm run test:p0`
- 适用范围：同一学生账号的课程并发作答
- 来源：文件 / 验证

## history.aspx 的题目对错与标准答案要分开读取

- 现象：只读取用户当前选择，无法区分 AI 答错、题库答错，也无法可靠回写标准答案。
- 根因：批改页把用户选择放在 li.e-a.checked，题目对错放在 .e-q-right 或 .e-q-wrong，标准答案放在 .e-a-ans .e-ans-ref .e-a-g p.checked，三者不是同一个节点。
- 正确做法：按 .e-q-body 读取题型、题干、选项、用户选择、对错标记和标准答案；用题型+规范化题干+排序选项集合生成同一 content_hash，再按正文回填。
- 验证方式：真实产品 Playwright E2E 读取到 20、30、31、35、60 题页面；现场同时存在 .e-q-right 与 .e-q-wrong，判断题标准答案可读为「正确」或「错误」。
- 禁止事项：不要用题目 id 当题号主键；不要用颜色、分数、字母下标猜标准答案；缺对错或标准答案时必须待回写。
- 相关文件或命令：docs/page-structures/作答历史查看页.md、electron/review.ts、tests/e2e-scenter.mts
- 适用范围：TASK-L01、独立提取题库、AI 答题校对
- 来源：真实产品 Playwright E2E / 脱敏 DOM

## 已验证校对结果必须升级未验证导入题

- 现象：题库先导入了一条未验证答案，后续 AI 作答并在 history.aspx 校对正确后，旧答案仍保持未验证，下一轮继续按旧状态命中。
- 根因：去重 upsert 只合并 course_names，没有区分未验证稿与已批阅校对结果。
- 正确做法：已验证的 extract/ai_verified 结果可以升级未验证行的 answer_texts、source 和 verified；两个已验证答案不一致时保留旧答案并设置 conflict=true。
- 验证方式：npm run test:p0 的 T-I3、T-I4；确认旧答案不同的未验证行被升级，已验证冲突行不被覆盖。
- 禁止事项：不要让未验证导入题永久压住已批阅答案；不要用新未验证导入覆盖已验证答案。
- 相关文件或命令：electron/core/json-bank.ts、electron/bank.ts、tests/p0.test.mts
- 适用范围：JSON 导入、独立提取、自动答题后的 AI 校对
- 来源：文件 / 测试

## 主界面课程和作业不能继续使用静态演示数据

- 现象：学生卡已经更新，但左侧“我的课程”和中间作业栏仍显示固定演示课程或作业，用户无法判断真实检测进度。
- 根因：主进程快照已有学生状态，但课程检测完成后的课程/作业分组没有同步到快照，渲染层两栏仍读取静态演示数据；多课程交错更新时也可能把另一门课程的作业显示到当前选中课程。
- 正确做法：主进程维护课程、作业分组、作业状态、题目来源和当前活跃课程；状态变化时立即推送完整快照；渲染层按学生和课程 ID 读取对应数据，只有完全没有真实快照时才使用脱敏演示数据。
- 验证方式：npm run test:p0 20/20；npx vue-tsc --noEmit；npx vite build；git diff --check -- 。独立 Electron 冒烟未形成有效运行态证据，不能替代真实产品 Playwright E2E。
- 禁止事项：不要让静态课程或静态作业覆盖真实快照；不要用最近一次更新的课程代替当前选中课程；不要把未验证的独立冒烟结果写成真实 E2E 通过。
- 相关文件或命令：electron/core/live-view.ts、electron/runner.ts、src/useKaida.ts、src/views/HomeView.vue、src/types/shell.ts、tests/p0.test.mts。
- 适用范围：TASK-C01、TASK-C02、TASK-F01、TASK-T01；适用于所有主界面实时状态展示。
- 来源：本轮文件检查、P0 测试和运行态排查。

## 云端 questions 的 PATCH 失败必须进入待回写

- 现象：Supabase 已有题目时，课程名追加、已验证升级或 conflict 标记的 PATCH 失败，程序仍返回 merged/conflict，导致本机不再保留待回写候选。
- 根因：旧实现忽略 PATCH 的 HTTP 结果和网络异常。
- 正确做法：PATCH 必须返回成功标志；失败统一返回 failed，由自动校对或导入流程保留待回写/失败计数。
- 验证方式：检查 electron/bank.ts 的 patch 返回值分支；再用真实 Supabase 网络失败场景确认候选仍进入待回写。
- 禁止事项：不要把 HTTP 非 2xx 当成写入成功；不要在未确认云端写入时允许下一轮继续依赖该结果。
- 相关文件或命令：electron/bank.ts、electron/runner.ts、npm run test:p0
- 适用范围：题库去重、AI 校对入库、独立提取、待回写补偿
- 来源：文件 / 验证

## Electron UI 不能只依赖远程 Tailwind CDN

- 现象：题库导入页和设置页的 Vue 文本仍在，但卡片、按钮、间距、颜色和布局全部退化成无样式 HTML。
- 根因：页面模板使用 Tailwind 工具类，入口只加载 CDN；Electron 或网络受限时 CDN 未执行，项目没有本地工具类产物。
- 正确做法：把 Tailwind 配置和 PostCSS 放进项目，扫描 index.html 与 src/**/*.{vue,ts}，由 src/styles/tailwind.css 在构建时生成工具类；Stitch 局部动画样式继续单独加载。
- 验证方式：npm run build 通过；检查 dist/assets/*.css 含 .rounded-3xl、.grid-cols-4 等实际页面工具类；检查 index.html 不再包含 cdn.tailwindcss.com。
- 禁止事项：不要为了恢复样式删除真实 Vue 接线或退回静态演示页；不要重新把生产 UI 依赖远程 CDN；不要把真实 Key、账号密码或题库数据写入构建产物。
- 相关文件或命令：index.html、src/main.ts、src/styles/tailwind.css、tailwind.config.cjs、postcss.config.cjs、npm run build。
- 适用范围：Electron 四页真实前端，尤其题库导入页和设置页。
- 来源：文件 / 构建验证

## 逐题事件与界面快照必须一致

- 现象：事件显示正在答题，但课程行和作业列表一直不变，旧事件计数与新快照互相覆盖。
- 根因：answerPage 发事件时未更新 StudentView，main 立即广播旧快照；渲染层又混入旧计数。
- 正确做法：逐题确认后先更新权威课程/作业快照，再广播；渲染只订阅快照。
- 验证方式：逐题快照回归通过，真实站点界面仍待复测。
- 禁止事项：不要以渲染层保留非零旧值掩盖主进程数据不同步。
- 相关文件或命令：electron/runner.ts、electron/answer.ts、src/useKaida.ts、npm run test:p0。
- 适用范围：任务实时反馈。
- 来源：代码排查与离线回归。

## 独立提取复跑不能重复 PATCH

- 现象：同一批已批阅历史再次提取时，题目明明已经存在，进度却长时间停滞，云端请求数量持续增加。
- 根因：去重分支只比较答案，未比较合并后的课程名和验证状态；相同结果仍重复 PATCH，多个历史页并发时放大延迟。
- 正确做法：content_hash 命中后同时比较答案、去重后的 course_names 和 verified；三者都未变化时直接返回 merged，只有课程名或验证状态确实变化才 PATCH。独立提取结束还要用作业明细重新求和校验学生和运行总计。
- 验证方式：第二轮真实提取复跑新增保持 0，学生去重为 185/120，失败为 0；tests/e2e-product.mjs 的 extract-summary-verified 收口断言通过。
- 禁止事项：不要把重复请求速度当成数据变化；不要只看总计，必须核对每份作业明细之和；不要把去重的内部状态与新增混淆。
- 相关文件：electron/core/hash.ts、electron/bank.ts、tests/e2e-product.mjs。
- 适用范围：独立提取、自动答题校对、JSON 导入的题库去重写入。

## 批阅页富文本题干必须按可见文本读取

- 现象：待回写历史能读取 45 题，但同一候选始终匹配 0；题型、选项和已选答案实际一致。
- 根因：`.e-q-q` 内含多个块级富文本节点，`textContent` 会把相邻段落直接拼接，`innerText` 会保留可见分隔；两者规范化后的题干不同，导致 `content_hash` 不一致。
- 正确做法：history.aspx 的题干、选项、已选答案和标准答案优先使用 `innerText`，再折叠空白；只有没有可见文本时才回退 `textContent`。
- 验证方式：真实只读探针确认候选题题型、四个选项、已选答案一致，`textContent` 匹配 0、`innerText` 匹配 1；修复后产品补偿日志从“匹配 0”变为“匹配 1，对错可判定 1”，并继续扫课答题。
- 禁止事项：不要通过清空待回写队列绕过；不要把只差富文本空白的同题当新题；不要全局删除题干内部正常空格。
- 相关文件：`electron/review.ts`、`tests/e2e-product.mjs`。
- 适用范围：自动答题校对、待回写补偿、独立提取。
- 来源：真实产品 Playwright E2E / 只读历史探针。

## 提取模式的合法跳过状态也是作业终态

- 现象：所有可读取历史均已提取、学生已进入 `round_ended`，产品 E2E 仍报“有提取作业未完成”。
- 根因：业务状态机把 `extracting_done` 和 `skip_*` 都视为合法终态，测试收口却只接受 `extracting_done`，把主观题、权重为 0 等明确跳过项误判为未完成。
- 正确做法：提取收口统一使用同一个终态判断：`extracting_done` 或任意合法 `skip_*`；`extracting`、`todo` 等中间态仍必须阻止完成。
- 验证方式：P0 覆盖 `extracting_done`、`skip_non_objective`、`skip_weight0`、`extracting` 和 `todo`；真实 7 个唯一账号产品 E2E 输出 `extract-summary-verified`，104 份作业逐项收口。
- 禁止事项：不要在测试脚本里另写一套比业务状态机更窄的终态列表；不要把合法跳过计为写入失败。
- 相关文件或命令：`tests/helpers/extract-status.mjs`、`tests/e2e-product.mjs`、`tests/p0.test.mts`、`electron/runner.ts`、`npm run test:p0`。
- 适用范围：独立提取题库的课程完成、学生完成和整轮 E2E 收口。
- 来源：2026-09-21 多账号真实产品 E2E 与红绿回归。

## Electron 产品 E2E 会加载构建产物而不是刚修改的 TypeScript 源码

- 现象：TypeScript 类型检查通过且源码已加入停止检查，但产品 E2E 连续表现为完全相同的旧行为。
- 根因：`electron.launch({ args: ['.'] })` 按 `package.json` 入口加载 `dist-electron/main.js`；只改 `electron/*.ts` 而未重新构建时，真机进程仍运行旧产物。
- 正确做法：修改 Electron 主进程或 preload 后，先执行 `npm run build`，确认 `dist-electron` 重新生成，再运行产品 E2E。
- 验证方式：同一运行锁用例在旧构建中停止 45 秒仍未释放；重新构建后立即通过，输出 `stoppedAndUnlocked: true`。
- 禁止事项：禁止只运行 `tsc --noEmit` 后就声称产品 E2E 已加载修复；禁止把旧构建行为误判为新源码修复失败。
- 相关文件或命令：`package.json`、`dist-electron/main.js`、`npm run build`、`npm run test:e2e:run-lock`。
- 适用范围：所有通过项目入口启动 Electron 的产品 E2E。
- 来源：2026-09-21 运行锁真机复测与构建前后对照。

## 新一轮开始必须清空上一轮提取统计

- 现象：重新扫描后未选课程的学生已正确显示“本轮未选择课程”，但主界面仍显示上一轮的课程数、作业数或历史提取统计。
- 根因：提取统计只在进入提取分支后重置；未选学生在生成空队列时提前结束，沿用了上一轮快照。
- 正确做法：每轮进入 runOne() 时统一清空所有提取总计、课程/作业进度、历史页进度和当前历史记录，再执行登录、扫课和选课。
- 验证方式：node tests/e2e-course-selection.mjs 连续执行两轮；第二轮重新扫描清空选择，只给一个学生选课，未选学生进入“本轮未选择课程”且 extractTotalCourses=0；随后停止任务并确认恢复编辑。
- 禁止事项：不要只在 work_mode === extract 分支内重置；不要在渲染层用零值覆盖主进程残留。
- 相关文件或命令：electron/runner.ts、tests/e2e-course-selection.mjs、npm run build、npm run test:p0。
- 适用范围：重复扫描、重复运行、可选课程、部分学生未选、提取题库实时状态。
- 来源：2026-09-21 两轮真实产品 E2E 与根因修复复测。

## 历史方案：浏览器显隐切换必须回传并核对真实窗口状态

> 旧同一 PID show/hide 验收已作废。本节只用于解释旧失败证据，当前运行中禁止切换，停止后按新模式重新启动。

- 现象：工作台选择“无头浏览器”后按钮已经高亮并提示成功，但 Chrome 窗口仍可能留在前台。
- 根因：显隐 IPC 没有返回值，渲染层先改本地按钮并盲目提示成功；浏览器刚启动时若根进程 PID 尚未从 CDP 取得，macOS 原生隐藏会被跳过，失败结果也不会传回界面。
- 当前结论：不再用显隐 IPC 实现模式切换；工作台只保存下一次启动模式，主进程以真实 headless:true/headless:false 启动并在运行中锁定。
- 当前验证：tests/e2e-display-toggle.mjs 检查启动参数、运行中拒绝切换、停止后重启和 profile 复用。
- 禁止事项：禁止只改变按钮样式、禁止通过显隐切换冒充模式、禁止无头扫码时切成可视化。
- 相关文件或命令：`electron/pool.ts`、`electron/runner.ts`、`electron/main.ts`、`src/views/HomeView.vue`、`tests/e2e-display-toggle.mjs`。
- 适用范围：macOS 持久化浏览器的工作台显隐切换、无头提取和无头答题。
- 来源：2026-09-21 用户现场复现、失败测试和真实 Electron 工作台按钮复测。

## 真实 headless 与 headed 必须分别启动

- 现象：工作台选择“无头浏览器”后仍出现完整 Chrome 窗口。
- 根因：浏览器池固定使用 `headless:false`，再用 CDP 负坐标和 macOS 进程隐藏模拟无头；按钮和旧测试把窗口隐藏误当成 Playwright 无头。
- 正确做法：无头使用 `launchPersistentContext(..., { headless:true, channel:'chromium' })`；可视化使用 `headless:false`。模式在上下文生命周期内固定，运行中 UI 与主进程都拒绝切换；停止并释放后按新模式重启，继续复用该生 profile。
- 验证方式：检查浏览器根进程启动参数、工作台真实窗口状态和运行锁；无头命令含 headless 参数且无窗口，可视化命令不含 headless 参数且有窗口；运行中 IPC 切换失败，停止后 PID 改变但 userDataDir 不变。
- 禁止事项：禁止 CDP 移窗、最小化、macOS 隐藏或同一进程 show/hide 冒充模式；禁止无头扫码时临时转为可视化；禁止同时打开同一 profile 的两个上下文。
- 相关文件或命令：`electron/pool.ts`、`electron/runner.ts`、`src/views/HomeView.vue`、`tests/e2e-display-toggle.mjs`。
- 适用范围：答题、提取、扫码和所有学生持久化浏览器。
- 来源：2026-09-21 用户现场截图、标准纠正和失败测试。

## 真实答题二维码必须由可作业条件自然触发

- 现象：使用产品真实答题模式和已保存持久化 profile 等待 180 秒，学生未进入 occupying_verify，没有可供程序内二维码查看器读取的快照。
- 根因：信息不全，当前探针没有确认门户是否为该账号分配了需要作答的作业；提取模式能正常读取课程和历史，答题模式不应把“没有自然触发二维码”直接判成二维码实现失败。
- 正确做法：先用真实课程/作业探针确认存在未满分且可点击“做作业”的作业，再从产品答题入口触发二维码；只验证真实弹窗截图、内存 IPC、PNG 剪贴板、版本失效和验证前闸门，未出现真实二维码时保持待测。
- 验证方式：产品答题探针只输出脱敏状态、动作、名额和课程数；超时后调用停止并确认浏览器释放。不得生成测试二维码或直接写入二维码 data URL。
- 禁止事项：不要用固定图片、假 data URL、伪造主进程快照或手动改 needsVerify 冒充扫码前验收；不要因为提取通过就推断答题二维码已通过。
- 相关文件或命令：\`electron/core/qr.ts\`、\`electron/runner.ts\`、\`src/views/HomeView.vue\`、产品答题模式探针、\`tests/e2e-scenter.mts\`。
- 适用范围：TASK-G02、T15-G13 至 T15-G19，以及所有依赖真实作业二维码的答题 E2E。
- 来源：2026-09-21 两次真实产品答题模式探针，均 180 秒超时后安全停止；信息不全，待人工补充可作业账号或二维码条件。

## 真实二维码探针必须点击真实作业入口

- 现象：只运行课程扫描或提取模式时没有二维码，容易误以为程序内二维码不可用。
- 根因：二维码只在真实答题模式点击站点“做作业”后由站点验证弹窗触发；课程扫描完成或提取历史不会进入该状态。
- 正确做法：使用真实持久化账号启动答题模式，等待课程检测完成并点击真实作业入口；进入 `occupying_verify / needs_verify` 后再验证程序内快照、复制、刷新、旧版本失效、未确认阻塞和关闭弹窗。
- 验证方式：`KAIDA_PRODUCT_RUN=1 KAIDA_WORK_MODE=answer KAIDA_QR_PROBE=1 node tests/e2e-product.mjs` 分别以 `KAIDA_DISPLAY_MODE=headless` 和 `visual` 执行；两种模式均真实点击“做作业”并输出 `qr-probe-verified`。
- 禁止事项：不要用固定二维码图片、手写 data URL、伪造 `needsVerify` 快照或仅调用二维码 IPC 代替真实作业触发；不要因没有扫码协助而关闭任务并标记扫码后链路通过。
- 相关文件或命令：`tests/e2e-product.mjs`、`electron/runner.ts`、`electron/core/qr.ts`、`src/views/HomeView.vue`。
- 适用范围：T15-G13 至 T15-G19，以及所有依赖真实作业验证弹窗的扫码前测试。
- 来源：2026-09-22 无头和有头真实答题二维码探针。

## 浏览器上下文异常关闭必须清理池状态

- 现象：真实浏览器进程被终止后，进程已经消失，但浏览器名额仍可能停留在 occupied，后续排队任务无法及时启动。
- 根因：浏览器池只在业务正常收尾时调用 release，没有监听 BrowserContext 的 close 事件；崩溃路径不会同步清理持有表、内存样本和槽位。
- 正确做法：上下文创建后监听 close；仅当事件对应当前持有上下文时清理持有表、样本和槽位，再提升排队项；正常 release 先移除持有表，避免重复处理。
- 验证方式：`node tests/e2e-display-toggle.mjs` 真实启动无头浏览器，终止根进程，确认进程消失、机器快照浏览器数归零，再停止并以有头模式重启成功。
- 禁止事项：不要只检查 ps 进程消失就判定槽位释放；不要依赖业务 finally 才处理浏览器崩溃；不要清理其它学生当前持有的上下文。
- 相关文件或命令：`electron/pool.ts`、`tests/e2e-display-toggle.mjs`。
- 适用范围：无头/有头答题、题库提取、扫码占位和所有持久化浏览器上下文。
- 来源：2026-09-21 真实 Electron 浏览器终止回归先红后绿。

## 异步进程探针必须等待 Promise

- 现象：浏览器已经被终止，测试仍等待“进程释放”直到超时。
- 根因：测试把返回 Promise 的 browserProcess() 直接放进同步否定表达式，Promise 对象始终为真，导致`!browserProcess(profile)`永远为假。
- 正确做法：在轮询条件中使用 async callback 并 await browserProcess(profile)，再断言进程为空。
- 验证方式：修正后同一崩溃回归通过，并继续执行浏览器计数归零和有头重启断言。
- 禁止事项：不要把异步探针当同步布尔值；不要因测试超时直接修改产品释放逻辑。
- 相关文件或命令：`tests/e2e-display-toggle.mjs`。
- 适用范围：所有 Electron E2E 的进程、窗口和快照轮询。
- 来源：2026-09-21 浏览器崩溃回归测试基础设施排查。
## 学生主状态与当前动作必须分字段展示

- 现象：学生卡主状态显示“等待选择课程 · 课程检测完成，请选择本轮课程”，下方当前动作又显示同一动作，造成状态重复。
- 根因：StudentView.headline 把账号状态和 action 拼成一条字符串，渲染层同时展示 headline 与 action。
- 正确做法：headline 只使用 ACCOUNT_ZH 的主状态，action 单独用于当前动作，进度单独读取课程/作业统计。
- 验证方式：`node tests/e2e-workbench.mjs` 在真实课程扫描等待选课状态断言 `headline === "等待选择课程"`，并确认不等于主状态与 action 的拼接值。
- 相关文件：`electron/runner.ts`、`tests/e2e-workbench.mjs`。
- 适用范围：工作台状态胶囊、学生账号卡和所有实时快照消费方。
- 来源：2026-09-21 工作台真实 E2E 先红后绿。

## 共享账号工作台 E2E 必须按真实运行态收口

- 现象：工作台测试把两个学生同时送入等待选课后，只停止一个学生，最终全局 `running` 一直保持，测试在收口阶段超时。
- 根因：运行锁和浏览器池是全局状态；单学生测试扩展为多学生后，清理逻辑仍只覆盖原目标账号。
- 正确做法：多学生工作台用例必须等待所有目标学生进入预期状态，停止时逐个释放，并在 `snapshot().running === false` 后再断言设置恢复；共享账号 E2E 必须串行执行。
- 验证方式：修正后的 `node --experimental-strip-types tests/e2e-workbench.mjs`、`node tests/e2e-course-selection.mjs` 和 `node tests/e2e-browser-pool.mjs` 均退出码 0。
- 禁止事项：不要把全局运行态超时直接归因于浏览器或业务失败；不要并行启动复用同一持久化 profile 的产品 E2E。
- 相关文件：`tests/e2e-workbench.mjs`、`tests/e2e-course-selection.mjs`、`tests/e2e-browser-pool.mjs`。
- 适用范围：工作台学生切换、课程选择、浏览器池和所有共享本机账号的产品 E2E。
- 来源：2026-09-22 工作台真机 E2E 先红后绿与串行复测。

## 检测到课程不等于当前已选课程

- 现象：学生已完成课程检测但尚未选择本轮课程时，课程日志按钮仍可点击，日志门禁把检测到的第一门课程当成当前课程。
- 根因：渲染层 currentCourseName 为无显式选择状态回退到 courses[0]，日志按钮只检查该回退值是否存在。
- 正确做法：可选课程等待阶段必须单独判断 selectedCourseName；没有明确当前选择时禁用课程日志并提示先选择课程；已点选课程后再开放日志。
- 验证方式：工作台 E2E 先红后绿；第二学生进入 waiting_course_selection 且未选课时 `#tool-log` disabled，选择课程后课程日志可打开并按课程过滤。
- 禁止事项：不要把已检测、已选中、当前活动课程混为一个字段；不要只用课程数组非空判断日志是否可用。
- 相关文件或命令：src/views/HomeView.vue、tests/e2e-workbench.mjs。
- 适用范围：可选课程工作台、课程日志、历史成绩和所有依赖当前课程的按钮门禁。
- 来源：2026-09-22 工作台真实 E2E 先红后绿。

## 课程选择 IPC 必须回传主进程最终集合

- 现象：渲染层点击取消一门课程后，主进程快照已只剩另一门，但工作台标题和课程日志仍显示已取消的课程。
- 根因：课程选择 IPC 只返回选中数量；渲染层在异步快照到达前无法用主进程最终集合校正本地当前课程，且检测阶段的活动课程可能仍是上一门课程。
- 正确做法：主进程返回最终 selectedNames；渲染层优先显示仍在最终集合中的被点击课程，取消当前课程时回退到剩余集合首项或清空。
- 验证方式：重新构建后运行 node --experimental-strip-types tests/e2e-workbench.mjs，真实覆盖两门课程选择、取消回退、学生切换、课程日志和历史成绩；最终输出 courseLogScoped:true 且退出码 0。
- 禁止事项：不要只返回选中数量；不要用渲染层旧快照推测主进程最终课程；不要把检测到的活动课程当成用户本轮已选课程。
- 相关文件或命令：electron/runner.ts、src/types/bridge.d.ts、src/views/HomeView.vue、tests/e2e-workbench.mjs、npm run build。
- 适用范围：可选课程选择、工作台当前课程、课程日志、历史成绩和依赖当前课程的按钮。
- 来源：2026-09-22 工作台真实 E2E 先红后绿、构建类型检查和 Patchright 复测。

## Electron 产品 E2E 必须先构建当前源码

- 现象：源码修复后重复运行 Electron E2E，失败结果仍与旧逻辑一致。
- 根因：测试启动产品入口加载 dist/index.html 和 dist-electron/main.js，源码修改不会自动进入已生成产物。
- 正确做法：源码或测试涉及构建产物时先运行 npm run build，再运行 Patchright Electron E2E；构建失败先修复类型或产物问题。
- 验证方式：本轮先因旧产物重复失败，重新构建后工作台 E2E 通过，随后课程选择、运行锁和显示模式回归继续通过。
- 禁止事项：不要把未重建产物的 E2E 失败当成当前源码行为；不要用手工修改 dist 冒充构建。
- 相关文件或命令：package.json、dist/、dist-electron/、npm run build、node --experimental-strip-types tests/e2e-workbench.mjs。
- 适用范围：所有加载 Electron 构建产物的产品真机 E2E。
- 来源：2026-09-22 工作台真实 E2E 复测与构建输出。

## 快速变化的实时动作必须与同一帧快照比较

- 现象：工作台 E2E 已等待界面与主进程动作一致，但随后分别读取快照和 DOM 时，动作已推进到下一条，断言出现“实际作业一、期望作业二”的竞态失败。
- 根因：主进程持续广播实时动作；测试把快照读取、DOM 读取和断言拆成多个时间点，比较的不是同一时刻状态。
- 正确做法：在一次轮询中同时读取主进程快照和界面字段，只有两者一致时把这一对值保存下来，再用保存的同一对值继续断言。
- 验证方式：工作台测试在新增阶段性测验历史读取后先稳定复现竞态；改为同一轮捕获后重新运行，输出 \`ok:true\` 且阶段性测验历史 \`stageHistoryItems=1\`、\`stageHistoryStates=["no_view"]\`。
- 禁止事项：不要通过延长固定等待或放宽字符串断言掩盖实时状态竞态；不要把跨时刻读取结果拼成一帧证据。
- 相关文件或命令：\`tests/e2e-workbench.mjs\`、\`node --experimental-strip-types tests/e2e-workbench.mjs\`。
- 适用范围：Electron 实时工作台、日志、进度、状态和所有持续广播的产品 E2E。
- 来源：2026-09-22 工作台真实 E2E 失败复现、最小测试修复与复测。

## 共享持久化设置必须由 E2E 显式准备并恢复

- 现象：显示模式测试结束后，账号页新增学生继承了上一个测试留下的可视化默认值，账号 E2E 的默认无头断言失败。
- 根因：Electron 测试复用同一 userData，browser_visible_default 是产品级持久化设置；前一个测试修改设置后没有为后续测试恢复前置条件。
- 正确做法：测试开始时读取并设置所需默认值，测试结束在 finally 中恢复原值；产品逻辑继续保留“新增账号继承当前设置默认模式”的行为。
- 验证方式：node tests/e2e-accounts.mjs 在显示模式测试留下 visual 后仍通过，并输出新增、编辑取消、编辑保存、切换和删除均为 true。
- 禁止事项：不要把共享 userData 的历史状态当成测试默认值；不要为通过断言修改产品默认逻辑；不要在失败路径遗漏临时账号或设置恢复。
- 相关文件或命令：tests/e2e-accounts.mjs、electron/store.ts、node tests/e2e-accounts.mjs。
- 适用范围：所有复用 Electron userData、safeStorage 或持久化浏览器 profile 的产品 E2E。
- 来源：2026-09-22 当前工作区账号 E2E 失败、数据流追踪与修复后复测。

## 验证态必须晚于二维码快照准备

- 现象：答题页面已经进入 needs_verify，但立即读取程序内二维码偶发返回“二维码尚未生成或已失效”。
- 根因：主进程先发布 needs_verify 和占用验证名额，再异步截取真实二维码并写入内存快照；渲染层和 E2E 可能在快照写入前读取。
- 正确做法：先创建验证会话并占用验证名额，完成真实二维码截图和内存快照写入后，再发布 needs_verify；截图失败仍发布明确的刷新错误，绝不伪造快照。
- 验证方式：使用目标文件、单个真实账号、答题+全部课程分别以无头和有头运行 tests/e2e-product.mjs，两种模式均输出 qr-probe-verified。
- 禁止事项：不要通过固定 sleep 或放宽断言掩盖竞态；不要在没有真实二维码截图时构造 data URL 冒充二维码。
- 相关文件：electron/runner.ts、electron/core/qr.ts、tests/e2e-product.mjs。
- 适用范围：真实作业二维码、验证闸门、程序内二维码查看/复制/刷新和所有依赖 needs_verify 的 UI。
- 来源：2026-09-22 无头答题二维码探针先红后绿。

## 顺序账号 E2E 不要等待持续运行的 loginRefresh

- 现象：第一个顺序账号结束后，测试驱动等待第二个账号的 `loginRefresh()` Promise，Electron 界面仍有浏览器进程但测试不再轮询状态。
- 根因：`loginRefresh` 会启动持续的主进程运行流程，不能作为顺序切换的短完成 Promise 等待。
- 正确做法：用 `void window.kaida.loginRefresh(...)` 触发，再回到快照轮询；页面断言等待真实 DOM 文本，避免抢在 Vue 广播前读取。
- 相关文件：`tests/e2e-product.mjs`。
- 来源：2026-09-22 可选课程、无头、并发1顺序复测。

## 2026-09-22：测试入口不能绕过生产安全存储回退

- 现象：用户删除账号后，旧 `kaida-store.bin` 可能仍存在但无法由新的 Electron 测试进程解密；生产 `load()` 会安全回退为空，而测试探针直接调用 `safeStorage.decryptString` 会提前失败，导致账号无法通过产品 IPC 重导入。
- 处理：测试入口读取既有存储时使用与生产一致的“解密失败回退为空”语义，再调用正式 `saveSettings`/账号 IPC 重建安全存储；不读取、打印或写入明文凭据。
- 边界：重建账号会生成新的 local_id，旧 profile 不能凭目录名自动冒认复用；必须保留真实扫码条件，不能把网络中断或旧 profile 孤立误报为登录态通过。

## 2026-09-23：Supabase 只读可用不代表题库写权限可用

- 现象：题库导入 E2E 的测试批次清理请求在写入前收到 HTTP 401；同一公共配置的零行只读请求返回 HTTP 200。
- 根因：当前验证只证明公共配置可完成受控读取，不能证明题库表的删除或写入策略允许当前会话；本轮没有进一步猜测策略或修改题库规则。
- 正确做法：把只读探针和写入/删除门禁分开记录；写入门禁失败时停止测试批次，不创建测试题，也不把题库导入记为通过。
- 验证方式：`npm run test:e2e:bank-import` 在清理阶段复现 HTTP 401；零行只读请求返回 HTTP 200。
- 禁止事项：不要绕过 RLS、改用 Secret、把 HTTP 401 当成导入成功，或在失败清理后继续写入真实题库。
- 相关文件或命令：`tests/e2e-bank-import.mjs`、`electron/core/public-config.ts`、`npm run test:e2e:bank-import`。
- 适用范围：Supabase 题库导入、批量删除、测试数据清理和所有依赖公共客户端权限的 E2E。
- 来源：2026-09-23 真实门禁执行。

## 2026-09-23：同名更新按钮的 E2E 选择器必须限定区域

- 现象：顶部“检查更新”和设置页底部固定“检查更新”同时存在时，按可访问名称直接点击会触发严格模式冲突。
- 正确做法：顶部入口限定在 `header`；需要验证页面反馈时单独点击设置页固定按钮，避免把两个入口混成一个用例。
- 相关文件：`tests/e2e-chg026-ui.mjs`。
- 适用范围：Electron 自定义顶栏和页面内固定操作栏的同名按钮。
- 来源：2026-09-23 CHG-026 OTA 开发版检查 E2E 先红后绿。

## 2026-09-23：停止后须推送最终运行快照

- 现象：真实全部停止后主进程 `running=false`，但底部“全部停止”按钮短时间仍可点击。
- 根因：停止 IPC 在 `stopStudent` 完成时未主动推送快照，渲染层只能等周期采样；运行收尾与 UI 状态不同步。
- 正确做法：停止 IPC 完成后立即 `pushSnap()`；E2E 同时断言运行态释放、按钮禁用和窗口保留。
- 相关文件：`electron/main.ts`、`src/views/HomeView.vue`。
- 来源：2026-09-23 U01-04 三账号真实补位与全部停止复测。

## 2026-09-24：多选隐藏答案先变化不代表逐题保存完成

- 现象：多选点选后隐藏答案已出现目标集合，随后仍可能出现“多选答案与目标不一致，停止当前作业”。
- 根因：旧流程只等待 `[name=answer]` 更新就点击下一项；本地延迟保存复现了同一题的 POST 重叠。真实站点本次报错的唯一根因尚未由请求轨迹确认。
- 正确做法：保留原有点选作为首选，每项等待保存响应并检查答案；失败后按页面实际 `li.checked` 用 DOM 点击补齐，再核对隐藏答案完整集合和右侧 `active`。失败时仍禁止提交。
- 验证方式：`node tests/multiple-answer.mjs` 覆盖顺序保存、首次保存失败回退、原有错选纠正；`npm run test:p0`、`node --experimental-strip-types tests/answer-writeback.mts`、`npm run build` 通过。未进行学校站点真机复测。
- 禁止事项：不要把前端即时写入当作服务端保存成功；不要因一次回填失败直接放弃备用补齐；不要只凭 `li.checked` 认定已提交。
- 相关文件或命令：`electron/answer.ts`、`electron/page-tools.ts`、`tests/multiple-answer.mjs`。
- 适用范围：作答页多选题逐项回填、纠错和提交前复核。
- 来源：2026-09-24 用户截图、页面结构记录、本地红绿回归。

## 2026-09-24：多选最终复核还需核对勾选集合

- 现象：隐藏答案已是目标集合，右侧题号也已提亮，但部分选项的 `li.checked` 与目标不一致，旧回填函数仍返回成功。
- 根因：最终仅调用隐藏答案与题号复核；没有执行作答页结构文档第 10 节要求的多选勾选集合检查。
- 正确做法：多选点选结束后同时核对隐藏答案、右侧 `active` 和目标选项的完整 `checked` 集合；不一致时进入备用点选，仍不一致则停止。
- 验证方式：`node tests/multiple-answer.mjs` 在隐藏答案与题号已通过、勾选少一项的场景先失败再通过；未进行学校站点实测。
- 禁止事项：不要单凭 `checked` 当作已保存，也不要只凭隐藏答案与右侧提亮忽略可见勾选不一致。
- 相关文件或命令：`开大自动答题页面结构.md` 第 10、12 节，`electron/answer.ts`，`tests/multiple-answer.mjs`。
- 适用范围：作答页多选题回填与提交前确认。
- 来源：2026-09-24 页面结构对照及本地红绿回归。

## 批量同步课程模式不能无条件清空本轮选课

## 主按钮状态以活跃任务而非独立布尔标志判断
## 右侧题号提亮看 active 不是 notdo

- 现象：选中选项后右边题号变青底白字（截图里 1、2 同时亮），用 `.notdo` 统计已做永远是 0。
- 根因：60 个格子作答后仍带 `notdo`。保存成功后 `isDoWork()` 只加 `active`，背景 `#099` / `rgb(0,153,153)`。顶部 Tab 的 `active` 是当前题型，题号 `active` 才是已做。批改态 `.right` 本作答页没有。
- 正确做法：用户可见已做 = `a.e-item.active`。真正保存成功仍以该题 `[name=answer].value` 非空为准。
- 验证方式：已答 1、2 题后，`document.querySelectorAll('.e-selects-g a.e-item.active').length === 2`，且 `.notdo` 仍是 60。
- 禁止事项：不要用 `notdo` 计数；不要把题号 `active` 当成当前题；不要找 `.right` 当已做。
- 相关文件或命令：`开大自动答题页面结构.md` 第 5.3.1 节；`previewnew.js` 的 `isDoWork`
- 适用范围：作业作答页右侧答题卡
- 来源：验证

## 只读 Playwright evaluate 会读丢 answer.value

- 现象：页面上 1、2 已勾选且右侧已提亮，但 Playwright evaluate 读 `input[name=answer].value` 是空。
- 根因：只读 evaluate 看不到 jQuery `.val()` 写进去的真实 value。CDP `Runtime.evaluate` 读到的是 `"0"`。
- 正确做法：读答案用页面真实 DOM / CDP，不要只信只读 Playwright evaluate。
- 验证方式：同一页 Playwright 读空、CDP 读 `"0"`。
- 禁止事项：不要据此认定「有勾但没保存」。
- 相关文件或命令：`开大自动答题页面结构.md` 第 12.1 节
- 适用范围：本作业页自动化采集
- 来源：验证

## 判断题 A/B 与 data-index 反转

- 现象：按 A=0、B=1 去点，提交的对错与界面相反。
- 根因：判断题 `A) 正确` 的 `data-index="1"`，`B) 错误` 的 `data-index="0"`。
- 正确做法：点选和读答案都用 `li[data-index]`，不要用字母序号推 index。
- 验证方式：读 `.e-q-body[data-questiontype="3"] li.e-a` 的文本与 `data-index`。
- 禁止事项：不要把单选的 0=A 套到判断题。
- 相关文件或命令：`开大自动答题页面结构.md`
- 适用范围：判断题 `data-questiontype=3`
- 来源：验证

## li.checked 不能当已做

- 现象：第 1 题 A 带着 `checked` 勾，但题仍算未做。
- 根因：`checked` 只是 UI；权威答案在 `input[name=answer]`。样本页第 1 题 A 存在假阳性。
- 正确做法：已做 = 该题 `[name=answer]` 非空。`checked` 只作对照。
- 验证方式：对比第 1 题 `li.e-a.checked` 与空的 `[name=answer]`。
- 禁止事项：不要用 `aria-checked` 或题号 `active` 单独判断已做。
- 相关文件或命令：`开大自动答题页面结构.md`
- 适用范围：本作业作答页选项与答题卡
- 来源：验证
- 备注：本轮 CDP 复核时第 1、2 题 `answer` 已是 `"0"`。首屏「有勾但 answer 为空」无法回看，**信息不全，待人工补充**。多选题仍会在 POST 前就加 `checked`。

## 提交确认绿按钮是取消

- 现象：点提交作业后弹出「作业提交后将不可修改，您确定要提交作业吗？」；绿按钮看起来像确定。
- 根因：自定义 `xcConfirm`。`a.sgBtn.ok` 确定是深蓝 `#36367a`；`a.sgBtn.cancel` 取消是绿 `#5d9417`。不是浏览器原生 confirm。
- 正确做法：点 `.xcConfirm a.sgBtn.ok`。点绿按钮或 × 会中止。
- 验证方式：看弹窗里两个按钮的 class 与颜色。
- 禁止事项：不要按颜色猜；不要用 Playwright native dialog 去接这个框。
- 相关文件或命令：`开大自动答题页面结构.md` 第 13.2.1 节
- 适用范围：作业作答页提交
- 来源：验证

## 多选题必须多选

- 现象：多选题只点一个选项，或点完一个其它勾被清掉。
- 根因：type=2 用 `toggleClass`，不清兄弟；answer 是逗号串。role 仍是 radio，不能当单选。
- 正确做法：对每个目标 `data-index` 点一次，检查 `answer` 含全部 index。
- 验证方式：连续点两个选项后该题应有两个 `checked`，answer 形如 `"0,2"`。
- 禁止事项：不要套单选清兄弟；不要只点一项就算做完。
- 相关文件或命令：`开大自动答题页面结构.md` 第 10 节
- 适用范围：多项选择题 type=2
- 来源：验证

## 门户 URL 里的学号和 xhtoken 禁止入库

- 现象：学习中心地址带 xh、xhtoken，作业预览内联脚本还有 JWT/姓名。
- 根因：站点把登录态放在查询串和页面脚本里。
- 正确做法：文档和日志只写路径与参数名。题库、进度、截图文件名都不带这些值。
- 验证方式：仓库内搜索 xhtoken 不应出现真实令牌值。
- 禁止事项：不要把用户粘贴的完整门户 URL 原样写进仓库。
- 相关文件或命令：docs/page-structures/学习平台-我的课程.md
- 适用范围：全项目
- 来源：验证

## 预览页和作答页路径差一个斜杠

- 现象：点列表「查看」进了预览，以为已经在答题页。
- 根因：/study/assignment-preview.aspx 是详情+历史+做作业；/study/assignment/preview.aspx 才是作答。
- 正确做法：列表「查看」只进预览；预览「做作业」才进作答。
- 验证方式：对照两页 path。
- 禁止事项：不要用同一个 page object 当两页。
- 相关文件或命令：docs/page-structures/README.md
- 适用范围：形考列表到作答
- 来源：验证

## 做作业先走 doHomework，普通学生会出微信扫码

- 现象：点「做作业」不跳转，或无头卡住。
- 根因：onclick 调用 doHomework。非行业分校走 showQRCodeDialog，标题「微信扫码验证」。已验证过才打开作答页。
- 正确做法：跟点击走。出现扫码就暂停当前学生并保留占位；无头继续保持 headless:true 且不显示浏览器，只通过程序内二维码；可视化继续保持 headless:false 且窗口可见。用户点击「验证完毕」后由主进程复核页面状态再继续，不能临时改启动模式。
- 验证方式：样本 isIndustryCollege=False 会进扫码分支。
- 禁止事项：不要采集页面里的 token 自己调 faceapi；不要擅自 goto 作答页 href 绕过扫码，除非用户明确改口。
- 相关文件或命令：docs/page-structures/作业预览-作答历史.md
- 适用范围：assignment-preview.aspx 的「做作业」
- 来源：验证

## 形考列表的查看必须限定两个容器

- 现象：点到课程实践或其它面板的「查看」。
- 根因：HomeWorkNew.aspx 同一页还有论文、书面、实践、小组活动等。
- 正确做法：只扫 #onlineHomework 和 #phasedTest。无数据看标题是否含「：暂无数据」。
- 验证方式：实践「查看」指向 laboratoryInfo/preview.aspx，作业「查看」指向 assignment-preview.aspx。
- 禁止事项：不要全局按「查看」文本乱点。
- 相关文件或命令：docs/page-structures/形考作业列表.md
- 适用范围：HomeWorkNew.aspx
- 来源：用户 HTML + 验证

## npm 装完 Electron 仍缺二进制

- 现象：`npm run dev` 报 `Electron failed to install correctly, please delete node_modules/electron and try installing again`。
- 根因：electron 的 npm 包装上了，但 Chromium 二进制没下下来，`path.txt` 和 `dist/` 是空的。国内直连 GitHub 发布包经常失败。
- 正确做法：用镜像补装：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。验证 `node -e "console.log(require('electron'))"` 打出 `Electron.app/Contents/MacOS/Electron`。
- 验证方式：补装后 `npm run dev` 能开窗，不再抛 install 错。
- 禁止事项：不要把 `Electron.app` 或 `node_modules/electron/dist` 提交进 git。
 - 相关文件或命令：`node_modules/electron/install.js`；环境变量 `ELECTRON_MIRROR`
 - 适用范围：本机安装 Electron 桌面壳
 - 来源：验证

## Stitch 设置页 save-hint 默认可见

- 现象：Vue 给「已保存最新配置」绑 `opacity-0`，对照 HTML 打开设置页时这条提示是看得见的。
- 根因：把点击保存后的成功态当成了默认态。Stitch HTML 的 `#save-hint` 没有 `opacity-0`；脚本只在点击时加强可见。
- 正确做法：默认 class 与 HTML 一致，保持可见。课程并行 HTML `value=1` 时仍按 PRD 默认 2，不要改回 1。
- 验证方式：对比 `liran_docs/ui-shells/stitch-download/PC-P02-settings.html` 的 `#save-hint` 与 `src/views/SettingsView.vue` 默认渲染。
- 禁止事项：不要把 Stitch 默认可见控件改成 hidden；不要为了 1:1 把课程并行改回 1。
- 相关文件或命令：`src/views/SettingsView.vue`；`PC-P02-settings.html`
- 适用范围：UI 壳 Stitch 一比一
- 来源：验证

## 主界面日志按钮不要自造面板

- 现象：点学生卡「日志」后卡片被一块自定义面板撑高，底栏上移。
- 根因：Vue 加了 Stitch HTML 没有的 logOpen 日志列表。PC-P01-home.html 的 #tool-log 只 toast「实时引擎日志：0 报错 · 正常回填中」。
- 正确做法：日志按钮保留，点击只 toast，不另造面板。
- 验证方式：对比 liran_docs/ui-shells/stitch-download/PC-P01-home.html 的 #tool-log 后直接闭合 aside；src/views/HomeView.vue 无 logOpen 面板。
- 禁止事项：不要为了看进度在学生卡里加 HTML 没有的块。
- 相关文件或命令：src/views/HomeView.vue；PC-P01-home.html
- 适用范围：UI 壳 Stitch 一比一
- 来源：验证

## 历史方案：隐藏式无头不要用 headless:true

> 本节只保留旧方案和失败背景，禁止作为当前实现或验收规则。当前规则见“真实 headless 与 headed 必须分别启动”。

- 旧现象：曾用 headless:false 配合最小化或窗口显隐模拟无头，导致窗口状态与 Playwright 启动模式不一致。
- 旧根因：把“窗口不可见”误当成 headless:true，并尝试在同一上下文里动态切换 headed/headless。
- 当前结论：无头必须真实 headless:true；可视化必须真实 headless:false。两种模式停止后释放上下文，再按新模式重启并复用学生 profile。
- 当前验证：tests/e2e-display-toggle.mjs 检查真实启动参数、运行锁、停止后重启和 profile 复用。
- 禁止事项：禁止用最小化、CDP、负坐标、macOS 隐藏或同一进程 show/hide 冒充另一模式。
- 相关文件或命令：electron/pool.ts；tests/e2e-display-toggle.mjs
- 适用范围：学生浏览器池
- 来源：2026-09-21 标准纠正与复测

## Node strip-types 不支持参数属性

- 现象：`node --experimental-strip-types --test` 报 `TypeScript parameter property is not supported`。
- 根因：`constructor(public limit: number)` 会生成赋值，strip-only 不支持。
- 正确做法：写成字段 + 构造函数赋值。
- 验证方式：`npm run test:p0` 8 条通过。
- 禁止事项：不要在给 Node 直接跑的 TS 里用参数属性、enum、namespace。
- 相关文件或命令：electron/core/slot-pool.ts；tests/p0.test.mts
- 适用范围：离线 P0 自检
- 来源：验证

## 设置页回显不要把掩码写回仓库

- 现象：getSettings 把 Key 显示成 `********`，再点保存会把掩码当真实 Key。
- 根因：渲染进程拿不到明文，保存时原样提交。
- 正确做法：空串或 `********` 表示不改旧值。
- 验证方式：读 electron/store.ts 的 saveSettings。
- 禁止事项：不要把真实 Key 回填到输入框默认值。
- 相关文件或命令：electron/store.ts
- 适用范围：设置保存
- 来源：验证

## 不要直开无 lck 的 IAM 首页

- 现象：打开 `iam.shou.org.cn/ac/#/index?entityId=...`（没有 `lck`）再点登录，`authExecute` 返回 `code:500 操作失败!`。
- 根因：`getAuthMethodsInit()` 没跑，登录链没有 context。
- 正确做法：从 `https://learning.shou.org.cn/scenter` 进，让门户 302 到 IAM。此时 `lck` 前缀 `context_oaut`，长度 47。
- 验证方式：对比有无 `lck` 的 `authExecute` 响应码。
- 禁止事项：不要把上号器里硬编码的 CAS `lck=context_CAS_...` 当产品入口，未登录会被踢回 `l.shou.org.cn`。
- 相关文件或命令：electron/login.ts
- 适用范围：TASK-E01 登录
- 来源：验证

## IAM 必须调 submitLogin，只点按钮不够

- 现象：填好账密只点 `.content_submit`，请求发不出去或认证不成功。
- 根因：Vue 登录组件要走 `login-content.submitLogin()`，并先写 `login-model.content_input/content_password`。
- 正确做法：原生 input/change 填框，同步 Vue 字段，再 `submitLogin()`。
- 验证方式：`authExecute` HTTP 200，message 为「认证成功」。`authPara` 长度 15 是正常的。
- 禁止事项：不要因为 para 短就以为缺了公钥。
- 相关文件或命令：electron/login.ts
- 适用范围：IAM 账密登录
- 来源：验证

## 门户 /login?code 不要真实 GET

- 现象：IAM 成功后浏览器进 `learning.shou.org.cn/login?code&state`，文档响应 400，body 只有 `\r\n\r\n\r\n`（6 字节），没有 Set-Cookie。
- 根因：该路径被瑞数/网关拦住。剥掉 `z3XQF0XWodOoO` / `z3XQF0XWodOoP` / `enable_z3XQF0XWodOo` 后再 GET 仍 400。Playwright Chromium 与 Chrome channel 一样。
- 正确做法：拦截带 `code` 的 document，禁止 `route.fetch()` 真 GET；剥 WAF cookie 后 302 到 `/scenter`。
- 验证方式：e2e 日志出现 `GET 400 learning.shou.org.cn/login`；拦截后不再打这条。
- 禁止事项：不要用 `**/*` 全局 route，会打坏 IAM 静态资源。不要 `route.abort()` 文档导航，页面会变成 `chromewebdata`。
- 相关文件或命令：electron/login.ts
- 适用范围：OAuth 回调
- 来源：验证

## oauth-login 只收 {code} 仍会被网关 400

- 现象：页面 `XMLHttpRequest` POST `/api/auth/oauth-login` body `{"code"}`（code 长度 32），HTTP 400，body 空包，不是业务 JSON。SPA 约定成功后 `localStorage.token` + `META_USER__`，并跳 `https://l.shou.org.cn/`。
- 根因：网关空包。即使三种 WAF cookie 都在，XHR/fetch 仍是 native，POST 仍 400。在暂停的 IAM 导航里发 XHR 会和 route handler 死锁。
- 正确做法：等文档在 `learning.shou.org.cn` 上再 POST；成功才写 token。当前 Playwright 会话里该接口仍 400，进不了 `#tab-courseList`。
- 禁止事项：不要把 code 打进日志；不要盲目重放 POST（code 只能用一次，网关 400 时可能未消费，但业务 200 后禁止重放）。
- 相关文件或命令：electron/login.ts；门户 `assets/index-e3a69e8f.js` 路由 `state=authLogin`
- 适用范围：学习门户换票
- 来源：验证

## 登录后直跳学习站首页会 412/400

- 现象：OAuth 回调后 302 到 `https://l.shou.org.cn/`，先 412 再 400，标题空，没有课程 Tab。
- 根因：学习站首页同样有挑战；没有门户 token 时不能当 scenter 替代入口。
- 正确做法：仍以 `/scenter` 为目标。SPA 自己成功换票后才会去 `l.shou.org.cn/` 再带回 `xh` 查询串。
- 验证方式：e2e 日志 `GET 412 l.shou.org.cn/`。
- 禁止事项：不要把完整 `xh` / `xhtoken` 写进仓库或日志。
- 相关文件或命令：electron/login.ts
- 适用范围：登录收尾跳转
- 来源：验证

## Playwright 原版过不了瑞数，要用 patchright

- 现象：捆绑 Chromium + stealth 仍只有 `z3XQF0XWodOoO/P`，没有 `enable_`；随后 `/login`、`/scenter`、`/assets`、`/api/study/learning-course-list` 都是 HTTP 400、body 约 6 字节。
- 根因：原版 Playwright 会 `Runtime.enable`，瑞数首屏判定为机器人。patchright 1.63 与当前 Playwright 同版本，首屏能拿到 `learning.shou.org.cn` 的 `enable_z3XQF0XWodOo`。
- 正确做法：`electron/pool.ts` 与 E2E 用 `import { chromium } from 'patchright'`；`headless: false`；locale `zh-CN`、timezone `Asia/Shanghai`。禁止 `channel: 'chrome'` 顶替产品浏览器。首屏有 `enable_` 后不要再拦 Fetch。
- 验证方式：`tests/_waf_probe.mts patchright` 的 cookies 含 `enable_`；`tests/e2e-scenter.mts` 登录后 `#tab-courseList` 在、课表 API JSON 200、`#pane-courseList .course-item` 至少一门。
- 禁止事项：不要用假 `{code:200,result:[]}` 糊弄课表；不要把 IAM `loginToken` / `xh` 写入日志或仓库。
- 相关文件或命令：electron/pool.ts；electron/login.ts；tests/e2e-scenter.mts
- 适用范围：TASK-E01 / TASK-T01
- 来源：验证

## fulfill /scenter 后不要 unrouteAll

- 现象：缓存 HTML fulfill 完立刻 `ctx.unrouteAll`，`/assets/index-*.js|css` 变 400，标题还在但 `#tab-courseList` 没了，登录超时。
- 根因：登录后带 O/P 的真 GET 资源也会被瑞数 400；资源要靠登录前缓存。拆掉拦截等于拆掉资源。
- 正确做法：有 `enable_` 就别拦；没有才兜底 fulfill 文档和 `/assets/`。不要在 handler 里 `unrouteAll`，也不要随后 `page.reload()`（真 GET `/scenter` 400 会丢 Tab）。
- 验证方式：unrouteAll 当次 e2e 出现 `GET 400 .../assets/index-` 且 `hasTab: false`。
- 禁止事项：不要把瑞数 `/4Hh5DXW6X5Uf/*.js` 当普通 JS 用无 cookie 的 `fetchBare` 喂回去。
- 相关文件或命令：electron/login.ts
- 适用范围：门户文档拦截
- 来源：验证

## 满分已批阅不要点做作业去测扫码

- 现象：测试号预览历史全是 100 分已批阅，仍点「做作业」会新开卷。
- 根因：扫码闸门只在第一次点做作业时出现；满分卷按 PRD 必须跳过，拿它刷扫码会浪费次数且不是 4.x 合法前置。
- 正确做法：skip_full_score；4.1 必须等 needDo（客观题权重>0 且不是 100 分已批阅）。本机号都满分时在 09 写明缺待做作业，不得伪造勾。
- 验证方式：预览历史已批阅且 score===100 → 不出现 doHomework 点击、不点续做。
- 禁止事项：不要为了扫码去点已满分作业。
- 相关文件或命令：electron/detect.ts；tests/e2e-scenter.mts；09 第 3.3/4.1 步
- 适用范围：TASK-F01 / TASK-G01 / TASK-T01
- 来源：验证

## 排队号不能 acquire 失败就 return

- 现象：账号并行 2、第三号 request 得到 queued 后，runOne 直接结束，名额释放后第三人永远不启动。
- 根因：acquire 满员返回 ok:false；loginAndRefresh 虽 Promise.all 全号，但 queued 那路没有等待 promoteQueued。
- 正确做法：queued 时卡片写排队中，循环再 acquire，直到 launching 或用户停止。occupying_verify 仍占名额，promoteQueued 不得把第三人插进去。
- 验证方式：npm run test:p0 的 T-D2 / T-D2b。
- 禁止事项：不要把 queued 当成本轮结束；不要在扫码暂停时给排队号补位。
- 相关文件或命令：electron/runner.ts；electron/core/slot-pool.ts；electron/pool.ts
- 适用范围：TASK-D01 / TASK-C02
- 来源：代码审查后已修，待 8.1 真机复测

## 硅基流动 fetch 必须带超时

- 现象：已进入 `assignment/preview.aspx`，学生卡长时间停在「自动开答」且题库答题 0 / AI 答题 0。
- 根因：`askAi` 的 `fetch` 没有 AbortController。Clash 或上游卡住时 Promise 永不返回，整份作业不会点选也不会提交。
- 正确做法：每个模型 12 秒 abort，失败换下一个；选项正文先 `normalizeOption` 再和当前页选项比对。
- 验证方式：本机直连硅基流动约 3 秒内 200；卡住时应在 12 秒内换模型而不是无限等。
- 禁止事项：不要把对话里的 Key 写进源码或 git。
- 相关文件或命令：electron/ai.ts
- 适用范围：TASK-J01 / TASK-H01
- 来源：验证

## 改 electron/*.ts 会杀产品浏览器

- 现象：改主进程后出现多个 Electron 窗，Chrome for Testing 的 History 锁库，新 `launchPersistentContext` 打不开同一 userDataDir。
- 根因：vite-plugin-electron 重启主进程，不一定关掉旧的 persistent Chromium；profile 目录被占。
- 正确做法：改主进程前先结束本项目 Electron 和 `kaida-auto-quiz/pw-profiles` 里的 Chrome for Testing，再 `npm run dev`。扫码会话在 profile 里，2 小时内通常不用再扫。
- 验证方式：只留一个 Vite、一个 Electron、每账号一个 Chrome for Testing。
- 禁止事项：不要用 @电脑 或本机 Chrome 顶替这些窗口。
- 相关文件或命令：electron/pool.ts；vite-plugin-electron
- 适用范围：TASK-A01 / TASK-T01
- 来源：验证

## 作答点选必须等 no-click，并用元素 click

- 现象：已经打开 `/study/assignment/preview.aspx`，但 8 秒内 `[name=answer]` 仍空，题库/AI 计数一直是 0。
- 根因：`previewnew.js` 点一次会给整组 `li` 加 `no-click` 并 POST；Playwright `locator.click()` 不一定进 jQuery 处理函数。多选连点会被 `no-click` 丢掉。
- 正确做法：对目标 `li.e-a[data-index]` 用 DOM `element.click()`；每次点击前后等到没有 `li.e-a.no-click`；再用 CDP 读 `[name=answer]`。
- 验证方式：点完后 CDP 读到非空 answer，右侧 `a.e-item.active` 增加。
- 禁止事项：不要自己改 class 冒充已选；不要连点不等待。
- 相关文件或命令：electron/answer.ts；开大自动答题页面结构.md 第 9–10 节
- 适用范围：TASK-H01
- 来源：验证（页面结构）+ 本轮作答页停留过久

## 读已选答案不要每次 newCDPSession

- 现象：已点 `li.e-a`，进度却一直「AI 失败空过」，题库/AI 计数停在 0，每题空等约 8 秒。
- 根因：`waitAnswer` 每 200ms `context().newCDPSession(page)`，会话建失败就当没选上。
- 正确做法：先 `page.evaluate` 读该题 `[name=answer]`；空了再 CDP 兜底。
- 验证方式：`/tmp/kaida-answer-cdp.jsonl` 连续 `ok:true`；进度出现「AI 回填」且 AI 答题 > 0。
- 禁止事项：不要只靠新建 CDP 会话轮询。
- 相关文件或命令：electron/page-tools.ts
- 适用范围：TASK-H01 / TASK-T01
- 来源：验证

## 全答完时提交只有一次确认

- 现象：60 题都写进 `[name=answer]` 后点提交，进度出现 1 次「确认提交」再报「提交弹窗未出现」。
- 根因：第二次 xcConfirm 只在还有空题时出现。全答完点第一次深蓝确定就会 `saveOnlineWork`，没有第二次弹窗。原先必须点两次 ok，第二次 8 秒超时被当成失败。
- 正确做法：第一次确定必须点到；第二次确定最多等几秒，没有就算成功路径；最终以作答历史出现新提交时间为准。
- 验证方式：对照作答页结构 13.2；看 `/tmp/kaida-submit.jsonl` 的 `no-second-ok` 与随后是否 `navigated-preview`。
- 禁止事项：不要把第二次弹窗超时当成提交失败再点一次提交；不要点绿取消。
- 相关文件或命令：electron/submit.ts；开大自动答题页面结构.md 第 13.2 节
- 适用范围：TASK-K01 / TASK-T01
- 来源：验证

## 工作台学生切换只显示当前一人

- 现象：右侧切换条挤两颗胶囊，姓名被裁成「可扫...」，10 并发时点不到其他人。
- 根因：两颗 `flex-1 min-w-0 overflow-hidden` 胶囊平分宽度。
- 正确做法：只渲染当前学生一颗胶囊，其余进 `⋯ N` 列表。
- 验证方式：三个号时可见 1 颗胶囊 + `⋯ 2`；点三点能看到另外两人全名。
- 禁止事项：不要为了多显示几个号把名字裁到看不清。
- 相关文件或命令：src/views/HomeView.vue；src/student-switcher.ts
- 适用范围：TASK-C01
- 来源：验证

## 空壳 #dl_qrCodeCheck 不算扫码

- 现象：预览页没有「微信扫码验证」，进度却停在需验证；Chromium「要恢复页面吗」气泡被当成码。
- 根因：只判断 `#dl_qrCodeCheck` 有宽高。页面常驻空壳对话框，标题和 `#qrCode` 都没有。
- 正确做法：可见对话框里要有「微信扫码验证」或可见 `#qrCode`。弹窗消失或进入作答页再继续。不要用 `body.innerText` 搜标题。
- 验证方式：空壳 vis+无标题 → false；有标题或 qrVisible → true。真码出现时暂停等人扫。
- 禁止事项：不要在可见真码时自动点验证完毕。
- 相关文件或命令：electron/page-tools.ts；electron/runner.ts
- 适用范围：TASK-G01
- 来源：验证

## 真码标题是微信扫码验证，正文还有未扫码

- 现象：只按文档标题搜「微信扫码验证」时曾经漏检；后来用 body 全文又把登录页「验证码」误判成扫码。
- 根因：真弹窗标题就是「微信扫码验证」。正文是「请使用微信扫码进行验证，感谢您的配合。」加红字「未扫码」，中间有 `#qrCode`。
- 正确做法：对可见 `#dl_qrCodeCheck` 认标题「微信扫码验证」或正文「请使用微信扫码」，或「未扫码」且 `#qrCode` 可见。不要用整页 `body.innerText`。
- 验证方式：真弹窗截图标题为「微信扫码验证」，红字「未扫码」。
- 禁止事项：不要在红字仍是「未扫码」时自动点验证完毕。
- 相关文件或命令：electron/core/qr.ts
- 适用范围：TASK-G01 / TASK-T01
- 来源：验证

## 扫码弹窗会停在后台标签

- 现象：工作台显示需验证，前台 Chrome 标签只是预览页，看不见码。
- 根因：一生一 persistent context 里同号多门课各开标签。点「做作业」出码的那页没 `bringToFront`，用户对着另一张预览页扫不到。
- 正确做法：检测到真码后把该页提到前台。未验证时同一账号只允许一份点「做作业」。
- 验证方式：把后台标签切到带「微信扫码验证」的那页，码就在。
- 禁止事项：不要因为前台页没有码就当成已扫过。
- 相关文件或命令：electron/runner.ts
- 适用范围：TASK-G01 / REQ-010
- 来源：验证

## 未验证时课程并行会点出多张码

- 现象：同一学生多个标签同时弹出「微信扫码验证」，作答次数被点上去，历史里一串「未提交记录」。
- 根因：课程并行先开多门课，每门课的 needDo 都会点「做作业」，没有「未验证只点一份」闸门。
- 正确做法：该号 verified=false 时只允许一份点「做作业」；扫完并刷新其余预览后再点下一份。
- 验证方式：未扫码时数该号带码的标签应为一。
- 禁止事项：不要用多标签出码来加快未验证账号。
- 相关文件或命令：electron/runner.ts
- 适用范围：TASK-G01 / 09 的 4.1
- 来源：验证

## 扫码成功后二维码容器可能仍保持可见

- 现象：真实二维码完成扫码后，#dl_qrCodeCheck 仍是可见容器，正文变为「微信扫码验证成功！进入作答」；如果只按容器可见或标题判断，账号会一直停在「需验证」。
- 根因：站点先更新弹窗正文，再异步关闭弹窗或跳转，成功态与未扫码态共用同一个 DOM 容器。
- 正确做法：在二维码弹窗文本判断中优先识别「微信扫码验证成功」或同时包含「验证成功」和「进入作答」，成功态立即结束扫码等待并执行账号状态收口；仍为「未扫码」时继续占用名额等待人工处理。
- 验证方式：真实 /tmp/kaida-qr.jsonl 出现成功正文；产品实时快照随后从「需验证」进入「自动开答」，并继续产生三类题型的 [name=answer] 写入与提交日志。
- 禁止事项：不要因为 #qrCode 仍有宽高就重复扫码、重复点击做作业或把成功账号判为阻塞。
- 相关文件或命令：electron/core/qr.ts、electron/page-tools.ts、electron/runner.ts、npm run test:p0
- 适用范围：TASK-G01 / TASK-H01 / TASK-K01 / TASK-T01
- 来源：验证

## Node 直接运行 E2E 时本地 TypeScript import 需要扩展名

- 现象：`node --experimental-strip-types tests/e2e-scenter.mts` 在进入登录前报 `ERR_MODULE_NOT_FOUND`，找不到 `electron/core/selectors`。
- 根因：Node 原生 ESM 不像 Vite 一样自动补 .ts 扩展名，E2E 入口的间接依赖仍使用无扩展名相对导入。
- 正确做法：被 Node 原生 ESM 直接加载的本地模块使用显式 .ts 扩展名；本轮先修复 `electron/page-tools.ts` 的直接依赖。
- 验证方式：同一条 E2E 命令能够进入 IAM 登录并输出课程检测结果。
- 禁止事项：不要通过猜测或全局改写模块解析参数掩盖导入问题。
- 相关文件或命令：`electron/page-tools.ts`；`KAIDA_E2E_INDEX=3 KAIDA_E2E_DO=0 node --experimental-strip-types tests/e2e-scenter.mts`
- 适用范围：产品 Playwright E2E 的 Node 原生入口
- 来源：验证

## 历史页参考答案节点因题型而异

- 现象：历史页明示单选／多选参考答案，但当前读取结果可能为空；判断题虽然可读，仍没有“参考答案优先”分支。
- 根因：当前 `electron/review.ts` 只查 `.e-ans-ref .e-a-g p.checked`；Chrome 实页单选／多选答案为 `.e-ans-ref > span.e-ans-r`，判断为 `.e-ans-ref > div.e-ans-r > .e-a-g p.checked`。
- 正确做法：按题型读取本题参考答案；单／多选字母逐项映射本题选项正文，判断映射正确／错误；不要把可读到判断题文字误当成新分支已实现。
- 验证方式：2026-09-27 用户已打开的 Chrome 历史页只读 DOM 核对三种结构；功能回归待开发后执行。
- 禁止事项：不要把学生选项的 `li.checked`、题目解析文字或答案字母直接当成可入库的选项正文。
- 相关文件或命令：`docs/page-structures/作答历史查看页.md`、`electron/review.ts`。
- 适用范围：答题后校对回写与历史题库提取。
- 来源：2026-09-27 Chrome 真实页面只读 DOM 与代码选择器核对。

## 大学英语复合题不能按顶层题目数和普通单题选项处理

- 现象：同一作答页的听力／完型／阅读各把多个小题装在一个顶层 `.e-q-body`；词汇匹配在一个表单中放多个下拉。只数顶层题或抓取其全部 `li.e-a` 会把小题漏掉或混在一起。
- 根因：Chrome 实页题型码 11/9/8 的子题各有 `subanswer` 表单，题型码 7 用一个 `match` 表单；现有 `qtypeFromPage` 只认 1/2/3。
- 正确做法：先区分栏目码与题型码，按父级共享材料和子题／匹配槽位建立映射；保存与批阅证据按实际子表单核对。匹配下拉默认 A 且没有空选项，不能把默认显示当成已作答。
- 验证方式：2026-09-27 用户已打开大学英语作答页只读 DOM 核对；实际保存和历史回写功能未测试，待开发阶段验证。
- 禁止事项：不要用 15 个顶层容器代替本样本 45 个作答位；不要猜测参考答案或把默认下拉值入库。
- 相关文件或命令：`docs/page-structures/大学英语新题型和专属题型页面结构.md`、`electron/answer.ts`、`electron/core/hash.ts`。
- 适用范围：大学英语复合题作答、提取与校对回写。
- 来源：2026-09-27 Chrome 真实作答页只读 DOM 与代码检查。

## Chrome 自动化不能打开本地 file 页面进行快照对照

- 现象：脱敏 HTML 案例生成后，Chrome 浏览器控制拒绝访问 `file://`，提示仅允许 `http:` 与 `https:`。
- 根因：浏览器控制的 URL 安全策略禁止本地文件协议；这不是页面 HTML 自身的加载错误。
- 正确做法：做离线结构、脚本语法和敏感字段静态检查；由用户手动打开本地 HTML 做视觉对照。不得借别的浏览器入口或协议包装绕过同一阻止。
- 验证方式：`node tests/fixture-english-page.mjs` 通过；浏览器视觉对照仍需人工验证。
- 禁止事项：未真正打开并比对时，不声称已像素级复刻或浏览器交互验收通过。
- 相关文件或命令：`tests/fixtures/大学英语当前试卷/README.md`、`tests/fixture-english-page.mjs`。
- 适用范围：从登录态 Chrome 页面制作脱敏离线测试案例。
- 来源：2026-09-27 Chrome 浏览器控制安全策略响应与静态验证。

## 正式 PRD 转换校验要求独立字段

- 现象：T003 正式 PRD 已有七项验收和五维评分，但转换校验仍报告 AC 映射、关联索引和评分字段缺失。
- 根因：校验器按独立行的固定字段名读取 AC 和评分；叙述句及 Markdown 表格中的同义内容不满足该格式。
- 正确做法：每项 AC 分别写“对应需求、验收步骤、预期结果、失败条件”；关联索引使用“文件类型、文件路径、文件作用、当前状态、关联需求”表头；评分使用独立的五维分数、总分和流程字段。
- 验证方式：运行 `python3 /Users/liran/.codex/skills/liran-plan/scripts/check_adaptive_flow_docs.py --prd-file liran_docs/requirements/T003-工作台切换分页与扫码授权标识-PRD.md --prd-status formal --prd-source-file liran_docs/requirements/T003-工作台切换分页与扫码授权标识-需求整理.md --score-file liran_docs/requirements/T003-评分记录.md`，输出 `Adaptive workflow docs check passed.`
- 禁止事项：不要只凭文档内容看似完整就宣布正式 PRD 转换审计通过。
- 相关文件或命令：`liran_docs/requirements/T003-工作台切换分页与扫码授权标识-PRD.md`、`liran_docs/requirements/T003-评分记录.md`、上述校验命令。
- 适用范围：`liran-plan` 正式 PRD 转换与评分。
- 来源：2026-09-28 T003 转换校验失败与修正后复验。

## PRD 新增 CHG 编号后需完整变更字段与影响映射

- 现象：T003 只写 CHG-001 文字说明后，正式 PRD 转换校验报变更编号、用户原话、原需求、新需求、等级、状态和完整影响矩阵缺失。
- 根因：校验器发现 CHG 编号后，会核对第 19 节独立字段和第 21 节的 REQ、AC、页面/UI、模块/微观任务、04、08、09、Goal 映射；叙述段落不足。
- 正确做法：需求变更记录逐字段写明差异、影响和状态，并在变更影响矩阵建立同编号的全路径映射；0 级验收澄清也按此记录。
- 验证方式：对 T003 PRD、需求整理和评分运行 `check_adaptive_flow_docs.py --prd-status formal`，返回 `Adaptive workflow docs check passed.`。
- 禁止事项：不要只增加 CHG 编号就声称转换审计通过，也不要借澄清重排已有 REQ/AC。
- 相关文件或命令：`liran_docs/requirements/T003-工作台切换分页与扫码授权标识-PRD.md`、`liran_docs/requirements/T003-评分记录.md`、`/Users/liran/Documents/codex 相关项目/plan-docs/scripts/check_adaptive_flow_docs.py`。
- 适用范围：`liran-plan` 正式 PRD 的用户确认后变更与验收口径澄清。
- 来源：2026-09-28 T003 CHG-001 首次校验失败、补齐字段后复验通过。

## 无 hash 的历史待证题仍须保持提取待处理

- 现象：英语历史里无可靠听力转写或词汇配对依据的题被计入 `referenceStats.retry`，但作业被标成 `extracting_done`。
- 根因：runner 只按 `pendingReferenceHashes.length` 判断待处理；身份未确认的题没有 hash，待重试计数因此被忽略。
- 正确做法：以本次历史的待重试计数保持作业 `pending_writeback`，不把无 hash 项伪装成入库成功。
- 验证方式：`node tests/t003-runner-extract.mjs` 先断言失败为 `extracting_done`，修复后通过；`node tests/t003-review-flow.mjs` 验证听力和匹配题留在待证。
- 禁止事项：不要因为没有 hash 就宣称全部提取完成，也不要借父题得分猜出待证项的答案。
- 相关文件或命令：`electron/runner.ts`、`electron/review.ts`、`tests/t003-runner-extract.mjs`。
- 适用范围：英语复合题历史提取与题库待回写状态。
- 来源：2026-09-28 T003 失败断言、最小修复和复测。

## 本地英语整卷回写需区分可匹配子题与无配对匹配题

- 现象：本地脱敏英语卷的 45 位答案都保存并提交后，产品持续停在 `pending_writeback`，不会自然进入 `round_ended`。
- 根因：本地批阅页经生产解析为 36 行，35 行有可匹配身份；词汇匹配只剩父题，缺 10 个槽位的标准配对，不能与作答结果逐槽匹配。
- 正确做法：内部产品 E2E 分别断言 45 位保存读回、提交、本次批阅和 35 行可靠回写；匹配题保留待证与待回写，受控停止测试进程。再次命中用新的隔离产品用户目录和同一隔离题库验证。
- 验证方式：`node tests/t003-local-product.mjs` 与 `KAIDA_DISPLAY_MODE=visual node tests/t003-local-product.mjs` 各完成两轮；均观察到 45 位保存、2 次提交及更正答案再次命中，匹配题仍待证。
- 禁止事项：不要把父题得分推断为 10 个匹配答案，也不要把 `pending_writeback` 写成整卷回写完成或学校真实提交成功。
- 相关文件或命令：`tests/t003-local-product.mjs`、`electron/review.ts`、`electron/runner.ts`。
- 适用范围：大学英语匹配题历史校对、内部端到端验收。
- 来源：2026-09-28 T003 本地产品 E2E 首次超时、批阅解析预检查及双模式复测。

## T003 产品 E2E 必须先构建并区分本地与真实批阅证据

- 现象：源码新增词汇逐槽参考分支后，产品 E2E 仍得到旧版 36 行、35 行回写结果；重建后本地两轮进入 `round_ended`。真实站点点击“做作业”仍停在预览页。
- 根因：Electron 产品加载 `dist-electron`，旧构建不会自动包含源码修改。真实入口无动作的根因未确定；只读探针发现页面有 `doHomework` 定义文本，但运行时函数未定义。
- 正确做法：源码变更后先运行 `npm run build` 再跑产品 E2E；本地批阅仅在显式提供十槽参考标记时逐槽回写，真实历史缺该标记则保持待证。真实入口继续从页面按钮调查与复测。
- 验证方式：英语及置顶课程各在无头、可视化运行本地产品两轮，每组 45 位、65 次保存、2 次提交、2 次批阅、225 次隔离题库 GET、45 次 PATCH，终态 `round_ended`；真实产品两模式点击后为 `submit_failed`，无二维码或作答页，授权 false、题库写入 0。
- 禁止事项：不要用旧构建结果判断新源码；不要把合成词汇配对或听力转写当成真实学校证据；不要直接导航作答页绕过真实入口。
- 相关文件或命令：`electron/review.ts`、`tests/t003-local-product.mjs`、`tests/t003-real-product.mjs`、`tests/t003-preview-probe.mts`、`npm run build`。
- 适用范围：T003 英语批阅、扫码前真实入口与 Electron 产品验收。
- 来源：2026-09-28 T003 新构建、本地四组产品 E2E 与真实入口只读诊断。前条“本地英语整卷回写”记录的是修复前阶段，不能作为当前本地产品结论。

## Patchright evaluate 的隔离世界不能证明页面函数不存在

- 现象：T003 预览页中 `page.evaluate` 返回 `doHomework` 未定义，DOM 内联脚本有顶层声明，但点击“做作业”仍无请求或弹窗。
- 根因：CDP 主世界读取确认 `doHomework` 是函数；先前“页面脚本未执行”的判断来自 Patchright `page.evaluate` 的隔离世界，已被主世界证据推翻。按钮无动作的真正原因仍未确定。
- 正确做法：页面全局变量或 jQuery 值出现矛盾时，用只读 CDP 主世界复核；继续观察真实按钮调用链，不猜测学校站点根因。
- 验证方式：`tests/t003-preview-probe.mts` 可视化有效账号探针输出隔离世界 `undefined`、CDP 主世界 `function`，按钮点击后仍无请求、弹窗或新页面；脚本语法和顶层声明检查通过。
- 禁止事项：不要仅凭 `page.evaluate` 的未定义结果宣称页面函数缺失或直接导航作答页；不要把本条诊断写成真实入口已通过。
- 相关文件或命令：`tests/t003-preview-probe.mts`、`electron/page-tools.ts`、`electron/runner.ts`。
- 适用范围：Patchright 与真实站点页面主世界的读取、T003 扫码前入口排障。
- 来源：2026-09-28 T003 可视化探针与只读 CDP 复核；更正上一条对真实入口的函数未定义判断。

## T003 真实扫码前入口须区分站点前置提示与正常作业

- 现象：首选置顶测验列为 todo，但点击后停在预览页；同账号普通作业可正常弹码。
- 根因：置顶测验的 `doHomework` 有非空前置提示，站点 alert 后返回；普通作业没有此前置提示。此前用隔离世界判断函数未定义和概括为所有作业入口失败均不成立。
- 正确做法：从产品页面选合法可作答的普通作业，实际点击“做作业”；置顶测验保持受当前样本限制，不绕过站点提示。
- 验证方式：`tests/t003-preview-probe.mts` 在主世界确认函数和前置提示；`tests/t003-real-product.mjs` 无头／可视化均进入 `needs_verify`，程序内二维码图片加载，提前确认被拒绝，授权 false、隔离题库写入 0。
- 禁止事项：不要把当前置顶测验的站点限制推广为所有作业失败；不要把弹码写成已扫码或已真实提交。
- 相关文件或命令：`tests/t003-preview-probe.mts`、`tests/t003-real-product.mjs`、`liran_docs/09-真机实测.md`。
- 适用范围：T003 真实站点扫码前产品 E2E。
- 来源：2026-09-28 有效账号主世界诊断及普通作业双模式产品复测；更正前两条真实入口结论。

## 置顶课提取用例须先确认账号有可查看批阅历史

- 现象：产品提取测试选到置顶课并到达终态，但断言“没有读取已批阅历史”失败。
- 根因：该测试账号的置顶课没有可查看批阅历史，不满足提取用例前置；另一已确认有历史的账号可正常提取。
- 正确做法：真实只读提取选有可查看批阅历史的合法账号；无历史账号仅用于扫描或无历史边界，不把无数据写成产品提取失败。
- 验证方式：`KAIDA_E2E_INDEX=0 KAIDA_WORK_MODE=extract KAIDA_REAL_COURSE=pinned node tests/t003-real-product.mjs` 读取 1 条历史、隔离题库 25 行；无历史账号原断言失败。
- 禁止事项：不要为凑提取结果伪造学校历史或放宽必须读到批阅历史的断言。
- 相关文件或命令：`tests/t003-real-product.mjs`、`liran_docs/09-真机实测.md`。
- 适用范围：T003 置顶课真实只读提取 E2E 的账号样本选择。
- 来源：2026-09-28 两账号置顶课只读提取对照复测。

## 工作台课程分页 E2E 先确认当前页

- 现象：改为 7 门／页后，真实 8 门账号的第一页容量断言得到 1 门而不是 7 门。
- 根因：工作台会按当前执行课程自动定位页码，产品测试进入时可能已经在第 2 页。
- 正确做法：逐页核对前先用页面“上一页课程”按钮回到第一页，再验证 7+1 顺序、无漏重及后台继续运行。
- 验证方式：`tests/t003-real-workbench.mjs` 旧起点假设失败 1≠7；调整后无头／可视化真实产品 E2E 均退出码 0，账号课程数为 8／7。
- 禁止事项：不要假定切换学生后必定停在第一页；不要以主进程课程数替代页面翻页。
- 相关文件或命令：`src/views/HomeView.vue`、`tests/t003-real-workbench.mjs`。
- 适用范围：工作台课程分页的真实产品 E2E。
- 来源：2026-09-28 T003 7 门分页失败断言与双模式复测。

## 听力媒体后缀不能证明可用音频

- 现象：四条英语批阅历史均有同站点 `.mp3` 形式的媒体入口，但没有转写节点；首条直接请求未得到音频。
- 根因：目前只确认直接 HEAD／GET 返回 `text/html`、点击后两秒内未观察到音频响应；站点为何返回 HTML 尚未确定。
- 正确做法：只在取得可验证的音频内容或可靠转写时处理听力子题；媒体后缀、父题得分和学生选项均不算听力依据。
- 验证方式：`tests/t003-real-history.mts` 只读输出四条媒体入口结构、首条请求类型与点击响应数量；36 行中 30 行可识别、6 行待证。
- 禁止事项：不要把 `.mp3` 路径直接当成音频已读取，也不要把无转写听力题猜答或入库。
- 相关文件或命令：`tests/t003-real-history.mts`、`electron/answer.ts`、`electron/review.ts`。
- 适用范围：T003 大学英语真实历史与听力输入验收。
- 来源：2026-09-28 登录会话只读复核；未记录媒体地址或音频内容。

## 提取并发会覆盖实时题号反馈

- 现象：多个历史页并行提取时，工作台动作文本在不同历史之间跳转，用户看不到连续的“第 x/y 题”；单个历史读取失败还会把整份作业标成待回写。
- 根因：历史任务并发争抢同一个学生动作字段，且失败分支按整份作业扩大待处理范围。
- 正确做法：同一学生的提取作业和历史页按顺序处理；历史页单独失败只记录该历史失败并继续其它历史，只有实际候选写入失败才保留待回写。
- 验证方式：`node tests/t003-runner-extract.mjs`；真实 `KAIDA_WORK_MODE=extract KAIDA_COURSE_SCOPE=selected|all node tests/t003-real-product.mjs`，检查课程行不持续停在 `pending_writeback`。
- 禁止事项：不要用固定数字伪造实时进度；不要把待证参考答案或单页读取失败扩大成整份作业待回写。
- 相关文件或命令：`electron/runner.ts`、`tests/t003-runner-extract.mjs`、`tests/t003-real-product.mjs`。
- 适用范围：所有学生的题库提取工作流。
- 来源：2026-09-28 真实全部课程提取复测与本地回归。

## 题库查看不能让课程分类请求阻塞题目首屏

- 现象：进入查看题库后先显示 0 题，等待远端课程分类结束才开始读取题目；连续搜索时旧响应还可能覆盖新结果。
- 根因：解锁后串行执行课程分类和题目查询，前端没有丢弃过期查询结果。
- 正确做法：课程分类和题目查询并行；查询请求设置递增序号，只应用最新响应，失败时保留已有题目并显示错误。
- 验证方式：`npm run build`；`npm run test:e2e:bank`（提供测试所需门禁输入）检查进入后出现“正在读取云端题库…”并最终显示数据或明确错误。
- 禁止事项：不要把加载中的 0 题当成空题库；不要让旧搜索响应覆盖当前筛选。
- 相关文件或命令：`src/views/BankView.vue`、`electron/bank.ts`。
- 适用范围：题库查看、筛选、搜索和分页。
- 来源：2026-09-28 用户截图与本地产品链路复核。

## 题库 E2E 不要等待原生 option 可见

- 现象：课程选项已经出现在原生 `<select>` 的 DOM 中，但 `option.waitFor()` 默认等待可见会超时；原生下拉未展开时 option 本来不可见。
- 正确做法：对选项等待 `state: 'attached'`，再使用 `selectOption`；长文本截断断言必须先于点击整行展开，因为当前展开状态作用于整行。
- 验证方式：`npm run test:e2e:bank`；真实题库查看 E2E 已通过三组门禁输入，测试批次清理回读为零。
- 相关文件：`tests/e2e-bank.mjs`。
- 来源：2026-09-28 题库真实查看 E2E 复测。
