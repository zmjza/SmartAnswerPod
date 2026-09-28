> 历史提示词，禁止直接执行。当前可执行版本为 `liran_docs/T001-development-3-4-目标提示词-v1.17.md`；本文件仅保留历史记录。

你自行判断本任务是否需要多智能体协作；如需开启，只允许一个主智能体统筹，任一时刻最多同时运行五个子代理，子代理完成后必须及时回收，回收后可按需启用新的子代理，禁止子代理继续派生代理。

> 本文件的后续正文为历史内容，禁止执行；CHG-026 UI 增量以 `liran_docs/T001-development-3-4-目标提示词-v1.17.md` 和 PRD 1.16 为准。

请直接开始执行下面步骤，先读取必须读取的文件与避坑，再按开发顺序把已有 UI 壳接到真实业务，跑通离线 P0，并用产品 patchright 对真实开大站点跑完整 E2E 直到全部通过；不要先解释，不要问是否开始，不要重做已完成的 Stitch UI 壳，禁止使用 @电脑。

目标提示词类型：普通
合同格式：文件指针型短合同
任务 ID：T001
任务名称：开大自动答题桌面端
流程档位：完整流程
修改前评分：94/100
五维评分：项目现状 16、修改规模 20、依赖与修改后影响 18、风险与回滚 20、验证复杂度 20
评分证据：liran_docs/requirements/T001-评分记录.md
基础目标数量：3
目标提示词数量：4
当前目标：第 3 / 4 次
目标阶段：development
当前阶段：development
UI 目标：启用（UI 2/4 已完成，本阶段不重做壳）
UI 路线：stitch
等待外部输入：否
验收责任：Codex Playwright E2E 真机（产品浏览器=patchright；禁止 @电脑 / Computer Use / 用本机 Chrome 或原版 Playwright 代替）
页面样式检查：不检查页面样式是否符合方案
归档阶段：non-final
当前状态：进行中
进入证据：文档 1/4 产物审计通过；UI 2/4 用户确认没问题；PRD 1.7 已纳入 CHG-006/CHG-007；云端 public.questions 已存在且含 course_names；用户确认 E2E 必须全绿且不要 @电脑。仓库已有 electron/core、四页接线、离线 P0 9/9、patchright 登录进课。tests/e2e-scenter.mts 已含 answerAndSubmit，须新进程才跑。账号 20****09 已对 needDo 点「做作业」并出码。
阻塞原因：4.3 等人扫码（qrGone=false，未进作答页）；旧 E2E 进程扫完不会作答/提交；TASK-L01 缺 history.aspx，禁止猜批改选择器；禁止拿满分卷点做作业。
编码解锁条件：文档与 UI 已完成，本阶段允许修改实现源码。
续做规则：按 liran_docs/04-开发追踪.md 与 liran_docs/09-真机实测.md 当前状态续做，禁止推倒 Stitch UI 与已绿离线 P0。产品浏览器必须是 patchright（import { chromium } from 'patchright'），无头任务使用真实 headless:true，可视化任务使用真实 headless:false；两种模式均使用 channel:'chromium'、locale zh-CN、timezone Asia/Shanghai 和该生持久化 profile。禁止原版 Playwright、禁止 channel:'chrome'、禁止 fulfill 后 unrouteAll、禁止用最小化/CDP/macOS 隐藏模拟模式或在同一上下文动态切换。运行中模式锁定，停止释放后按新模式重新启动并复用 profile。IAM 必须从 learning.shou.org.cn/scenter 启动，让门户跳转到带有效上下文的 IAM，再回到学习中心并确认 #tab-courseList；禁止直拼无 lck 的 IAM 首页。二维码统一走程序内“查看作业二维码”，扫码后仍待条件。其余未勾按 04/09 续做，禁止拿满分卷点做作业。
本阶段职责：TDD 实现、真实业务接线、离线 P0、产品 patchright E2E 真机全部通过、文档回写。用户已确认覆盖：本阶段必须跑通 09 清单。
禁止进入的后续阶段：acceptance 收口话术、@电脑 真机、用户验收收口、归档、整体完成。允许且必须做产品 patchright E2E。

必须读取：
- AGENTS.md、docs/pitfalls/README.md、docs/pitfalls/general.md
- liran_docs/requirements/T001-开大自动答题桌面端-PRD.md（版本 1.7；第 8–14 节 REQ-001 至 REQ-023、AC-001 至 AC-024、第 9 节状态码与题库表含 course_names、第 10 节四页）
- liran_docs/06-数据字典.md、liran_docs/07-API文档.md
- liran_docs/00-项目说明书.md、01-需求文档.md、02-架构文档.md、03-索引.md、04-开发追踪.md、08-测试用例.md、09-真机实测.md、10-UI壳接入清单.md
- liran_docs/modules/ 下 A–M 全部叶子（_A.md 至 _M.md 及子页）
- docs/page-structures/README.md 与已有结构文件；仓库根 开大自动答题页面结构.md
- src/views/HomeView.vue、SettingsView.vue、BankImportView.vue、AccountsView.vue、src/App.vue、electron/main.ts、electron/preload.ts、src/mock/demo.ts
- 上号器只读：/Users/liran/Documents/自动上号器（扩展工具版本）（只搬登录填账密，不把扩展嵌进 App）
- liran_docs/ui-shells/ 四份清单与 stitch-download HTML（接线保持视觉，主色 indigo #4F46E5，禁止改回湖绿）

允许修改：
- Electron 主进程/预加载/渲染进程、新增主进程模块（浏览器池、登录、检测、作答、提交、题库、AI、状态机、加密、OTA 配置）
- package.json 最小必要依赖（Playwright 捆绑 Chromium、electron-updater 等）与打包 ignore
- 将壳上 TODO(ui-shell)/TODO(codex-connect)/TODO(codex-state)/TODO(codex-permission) 接到真实逻辑
- liran_docs/04、08、03、10 与相关模块叶子的完成状态
- docs/pitfalls/ 追加已验证技术坑（不写密钥）
- docs/page-structures/ 仅在用户补了 DOM 之后写入
- 内部测试所需的最小单测或自检脚本，以及产品 Playwright E2E 所需最小测试入口
- 课程并行产品默认保持 2（Stitch HTML value=1 不得改回 1）
- 允许对接已有 public.questions；缺列才 ALTER，禁止 DROP 整表

禁止修改：
- 禁止覆盖 AGENTS.md 旧正文，禁止把具体坑写进 AGENTS.md
- 禁止把密钥、token、账密、学号明文、xhtoken、硅基流动 Key、Supabase Secret/service role 写入源码、界面默认值、git、安装包、日志全文
- 假数据只用张同学/李同学、0000****0001（李同学可用 0000****0002 掩码）
- 禁止编造登录页全量 DOM、扫码弹窗 HTML、门户顶栏学生信息、history.aspx；缺则停在对应模块请用户补
- 禁止在同一上下文把 headless:true 切成 headed；禁止无头/可视化按钮进顶栏；禁止内嵌完整浏览器；模式切换必须停止释放后按新模式重新启动
- 禁止改掉主按钮「登录并刷新课程」；禁止去掉题库答题 x / AI 答题 y
- 禁止把提取题库做成第五页；禁止把学生账号塞回设置页
- 禁止续做；禁止第一期做资源学习、主观题、课程实践
- 禁止按课拆表；禁止重建或 DROP 已有 questions 表
- 禁止静默改分、绕过扫码、采集 data-userid 或门户 URL token
- 禁止 @电脑 / Computer Use / 用本机 Chrome 或原版 Playwright 代替产品 patchright；禁止预先给 09 打勾；禁止拿满分已批阅作业点「做作业」去刷扫码；禁止进行用户验收收口、禁止归档、禁止宣布整体完成、禁止改 N/M、禁止新建 /goal、禁止擅自 commit/push
- 禁止重做 Stitch 一比一视觉；设置页「已保存最新配置」保持默认可见
- 写文件只用 apply_patch；补丁起止行必须是三星号加 Begin Patch / End Patch，中间不要再加星号；同一文件不得在一个 patch 里既 Delete 又 Add

目标需求（必须全部做到，不得漏项；细节以正式 PRD 与 04 微观任务当前内容为准，不复制全文）：

开发顺序不得打乱：TASK-M01 页面结构契约 → TASK-A01 桌面壳（已有四页 Vue 则只补主进程 patchright/捆绑 Chromium，不重做壳）→ TASK-B01/B02 凭据与设置/学生账号接线 → TASK-D01 浏览器池 → TASK-C01/C02 主界面订阅五层状态机 → TASK-E01 登录 → TASK-F01 检测形考 → TASK-G01 扫码闸门 → TASK-I01 题库 → TASK-H01 点选 → TASK-J01 AI → TASK-K01 提交连刷 → TASK-L01 校对待回写 → TASK-A02 OTA 配置（本阶段不发布 GitHub Release）→ TASK-T01 产品 patchright E2E（09 全绿）。微观任务见 liran_docs/04-开发追踪.md。

硬规则：
1. REQ-001/AC-001：Electron+Vite+TS+Vue3；主进程产品浏览器为 patchright 捆绑 Chromium（不是原版 Playwright、不是本机 Chrome）；mac+win；登录从本机上号器 content.js 只读搬改；仓库无扩展拷贝。
2. REQ-002/AC-002：账密、硅基流动 Key、Supabase URL/anon 在设置页填，safeStorage 加密；加密失败拒绝写明文；禁止 service role。
3. REQ-003/AC-003/AC-023：顶栏 CPU%、内存%、本软件占用、浏览器数=launching+occupied+occupying_verify（不含排队）、压力正常/偏高/过高；左列科目、中列作业态、右侧学生卡、底栏进度；主按钮必须是「登录并刷新课程」；始终看见题库答题 x / AI 答题 y；卡片主句=账号中文状态+当前动作，不能只写进行中；无头/可视化只在学生卡右上角。顶栏四字：工作台、题库、学生账号、设置。
4. REQ-004/AC-004：学生账号页列表、手工添加、Excel 三列（姓名账号密码）跳过表头；设置页 Key、URL、anon、账号并行默认 2、课程并行默认 2、浏览器显示默认关、日志默认开；删除账号释放名额；占用中刷新先停再检测。
5. REQ-005/021/AC-005/AC-021：多学生账号一起跑，每账号同时多门课；一生一 launchPersistentContext + 独立 userDataDir；同号多份作业共用该浏览器里的标签，禁止每份一浏览器、禁止全员共用一个浏览器；扫码暂停继续占名额，禁止给排队学生补位；headless 使用真实 headless:true 且无窗口，visual 使用真实 headless:false 且窗口可见；运行中锁定，停止释放后按新模式重启并复用 profile。
6. REQ-006/AC-006：自动登录 IAM 进学习中心；错密或连续失败停该号，已占名额的其它号继续，排队号不补位；IAM 验证码/人脸与作业扫码同一套暂停 UI；登录页 DOM 未补则停在 E，禁止先猜。
7. REQ-007/AC-007：确认 #tab-courseList，只取 #pane-courseList .course-item，忽略收藏课程；点 #courseHomeWorkNew；只读 #onlineHomework 与 #phasedTest；标题含「：暂无数据」=无作业；客观题且权重>0% 进预览；权重 0% 与非客观题跳过；不点实践/论文/其它面板。
8. REQ-008/AC-008：100 分已批阅跳过且不点续做，一律新开；窗口外、剩余次数<=0 跳过；无限制看 replyCount=-1 或「无限制」。
9. REQ-009/AC-009：主按钮只跑检测，检测阶段不点「做作业」；答题模式检测完自动开答；提取题库模式只抽已批阅，不开答、不提交。提取入口在工作台学生卡「答题 | 提取题库」，不是第五页。
10. REQ-010/AC-010：未验证时同一账号同时只允许一份点「做作业」；无头弹码不显示浏览器，只提供程序内二维码；可视化模式保持真实窗口可见并同时提供程序内二维码；点击「验证完毕」先由主进程复核成功态，再刷新其余预览并继续，不能改变浏览器模式；约 2 小时以页面是否再弹码为准；旧弹窗取消后刷新；扫码弹窗 HTML 未补则停在 G。
11. REQ-011/AC-011：第一期仅单选/多选/判断。点选项正文所在 li.e-a[data-index]，不要 input radio/checkbox，不要 .notdo 计数，不要用字母/index 当答案。权威已选=该题 form [name=answer] 非空，用户可见已做= a.e-item.active。多选必须点齐全部正确正文，answer 为逗号 index。判断按「正确/错误」正文点选（页面 data-index 1=正确、0=错误仅对照，禁止 A=0 套用）。未知题型或答案无法写入时停止当前作业，不得提交空题。
12. REQ-012/018/AC-012/AC-018（PRD 1.6 CHG-006）：云端已有一张 public.questions，全账号共用，禁止按课拆表、禁止重建整表。作答只 `where content_hash = $1 limit 1`，超过 2 秒当未命中走 AI。content_hash=题型+规范化题干+排序后选项正文集合，unique 已存在；选项顺序打乱仍命中。course_names text[] 不进身份：提取/作答入库写入当前门户课程标题并追加去重；JSON 导入无课程名则空数组。回填按 answer_texts 正文匹配当前选项，不用 ABCD。其余字段 qtype/stem/options/answer_texts/source/verified/conflict/updated_at 以 PRD 第 9 节与数据字典为准。独立提取只抽已批阅「查看」；自动提取随答题校对。读失败当未命中走 AI；写失败进待回写。不提供导出。
13. REQ-013/AC-013：硅基流动 14 模型按去重顺序降级：1) deepseek-ai/DeepSeek-V4-Flash 2) deepseek-ai/DeepSeek-V4-Pro 3) zai-org/GLM-5.3 4) moonshotai/Kimi-K2.7-Code 5) Qwen/Qwen3.8-27B 6) stepfun-ai/Step-3.5-Flash 7) tencent/Hy4-preview 8) Qwen/Qwen3.6-35B-A3B 9) Qwen/Qwen3.6-27B 10) Pro/deepseek-ai/DeepSeek-V3.2 11) deepseek-ai/DeepSeek-V3.2 12) zai-org/GLM-5.2 13) Pro/zai-org/GLM-5.1 14) Pro/moonshotai/Kimi-K2.6。所有模型共用统一高校课程客观题提示词，只认 {"option_texts":[...]}；非法 JSON 换下一个；所有学生共享最小 0.75 秒请求启动间隔，HTTP 429 按 Retry-After 或至少 5 秒冷却；题库成功回填后随机等待 1–3 秒再进入下一题，补答命中题库相同，AI 回填不叠加该等待；全失败时主界面显示题号、尝试数和最终原因；设置页可换 Key；禁止把对话里的 Key 写入代码。
14. REQ-014/AC-014：程序自己提交，用户不管。提交前双检每题隐藏答案完整集合与右侧 a.e-item.active，漏题最多补答 30 轮；第 1–29 轮继续并实时显示轮次，每轮重建最新复核计划；第 30 轮仍失败则列出剩余题号和最终原因，安全停止并明确显示未提交。复核通过后点 #submitHomeWork；正常“作业提交后将不可修改”确认点深蓝 a.sgBtn.ok。若出现“部分题目没有作答／未作答视为错误”，必须点绿色 a.sgBtn.cancel 取消并禁止交卷。成功=作答历史出现提交时间更新的有效新记录，不以弹窗关闭为准。约 8 秒无正常确认再点一次提交；仍无则失败，不扣次数，当次这份停。禁止 Playwright native dialog。
15. REQ-015/AC-015：无限制当次最多 10 次；有限且上限或剩余<=3 则当次最多 1 次；其余 min(10, 剩余)；到 100 立刻停。必须已批阅并校对完才允许新开。空转（分不涨且库无变化且剩余题都已 AI 失败）提前停。
16. REQ-016/017/AC-016/AC-017：已批阅后打开查看：AI 答对的入库（source=ai_verified），答错不入库；题库命中但答错则删除该 hash，下一轮走 AI。批阅超时或查看失败记待回写，该份当次不得新开；下次该号检测或答题先补抽补删，补完再决定要不要新开。history.aspx 未补则停在 L，禁止先猜 DOM。
17. REQ-019/AC-019：electron-updater 指向当前 GitHub 仓库 Releases；打包排除密钥、Playwright profile、Login Data、Cookies。本阶段只完成配置与 ignore，不执行正式双平台发布、不创建 GitHub Release。
18. REQ-020/AC-020：选择器只读页面结构文档。assignment-preview.aspx 是预览+历史+做作业；assignment/preview.aspx 才是作答页，禁止混用 page object。
19. REQ-022/AC-022：主进程五层英文枚举以 PRD 第 9 节为唯一真源（slot/account/course/homework/question），渲染只订阅，不得另造同义码。每次点击、跳转、弹窗推一条进度；字段不含密码/Key/token/cookie 全文/xhtoken。崩溃只 released 该号，已占名额其它号继续。
20. 站点仅 iam.shou.org.cn、learning.shou.org.cn、l.shou.org.cn。第一期只做网上记分作业 + 阶段性测验里的客观题且权重>0%。
E2E（REQ-023/AC-024）：用产品 patchright 按 liran_docs/09-真机实测.md 对真实站点逐步跑，必须全部通过。禁止 @电脑。人工只处理扫码或验证码，做完必须继续。用户提供的 Key 只进 safeStorage，禁止写入源码、git、文档。缺 DOM 停在对应模块回写 04/09，禁止猜。满分作业不得点做作业。

执行步骤：
1. 读避坑、页面结构、PRD 第 9/10 节、04 微观任务与 08 用例。
2. 严格按开发顺序实现；每模块先写最小失败测试或自检再接线。
3. 缺 DOM 在该模块停止，回写 04 受阻原因与待补文件，不得猜选择器。
4. 把壳上已有控件接到真实逻辑：登录并刷新课程、无头/可视化、查看作业二维码、验证完毕、答题/提取题库、设置保存、Excel 导入、JSON 导入。点击必须打到真实模块。
5. 先跑 08 可离线 P0 + npx vue-tsc --noEmit + npx vite build + git diff --check -- . + 仓库搜索真实 Key/学号明文/xhtoken/sb_secret。再按 09 用产品 patchright 打真实站点，逐步打勾直到全部通过。扫码等人手后继续。禁止 @电脑。
6. 回写 04/08/03/10；已验证坑写入 docs/pitfalls/。
7. 新文件必须是实现所必需；不重画 UI；不 commit、不 push。

验证要求：
- git diff --check -- .
- npx vue-tsc --noEmit && npx vite build
- 有 markdownlint 或文档检查则运行，没有则说明未发现
- 对照 liran_docs/08-测试用例.md 跑通可离线 P0：至少选项打乱仍命中、同一题两门课只一行且 course_names 含两课名、名额暂停不补位、提交点 ok 不点 cancel、次数闸门、状态码未另造、不把 notdo 当已做
- 仓库搜不到真实 Key、学号明文、xhtoken、sb_secret
- npm run dev 仍能打开四页；主按钮文案正确；切换不在顶栏；始终能看见题库答题/AI 答题占位或真实计数
- 09 Playwright E2E 每步均有真实操作证据并可打勾；未使用 @电脑；未擅自 commit/push
- 最终输出：新增/修改文件列表、各 TASK 状态、缺 DOM 阻塞项、验证命令与结果、是否还有未提交改动

状态回写：
- liran_docs/04-开发追踪.md：当前目标第 3 / 4 次、阶段 development、各 TASK/微观任务状态、内部测试证据
- liran_docs/08-测试用例.md：已跑用例结果
- liran_docs/03-索引.md：当前状态
- liran_docs/10-UI壳接入清单.md：接线结果，不宣称重做 UI
- docs/pitfalls/：已验证坑
- liran_docs/09-真机实测.md：按真实 E2E 结果打勾或记录失败与受阻；不得预填

完成条件：全部满足才能宣布本开发阶段已完成并解锁下一目标：
- TASK-A01 至 TASK-L01、TASK-A02 配置与 TASK-T01 已按 PRD 实现，或因缺 DOM 在对应模块明确受阻并列出待补文件
- 无密钥入库，无自动上号器整份拷贝
- 离线 P0 + typecheck/build/diff-check/密钥扫描通过；09 Playwright E2E 全部真实通过（受阻项已写明原因）
- 未使用 @电脑；未进行用户验收收口；未归档；未宣布整体完成
- 四页仍可打开，主按钮与题库/AI 计数仍在

下一阶段解锁条件：上述完成条件全部成立后，才允许生成 acceptance 4/4。4/4 只处理未通过项复测、问题回写与用户检查交接，禁止改用 @电脑。本阶段结束后只能写「本阶段已完成，已解锁下一目标」，禁止整体完成或已归档话术。
