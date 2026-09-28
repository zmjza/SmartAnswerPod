# 主界面 UI 壳接入清单

上级：[[10-UI壳接入清单]]
对应模块：[[_C]]
任务 ID：T001
PRD 需求文档：`liran_docs/requirements/T001-开大自动答题桌面端-PRD.md`
视觉依据：已确认文本视觉方案（聊天确认原文：就这样吧，布局我自己在 stitch 在微调。视觉方案确认了）。PRD 第 10 节。参考图样本姓名学号不入库。
UI 路线：stitch
流程档位：完整流程
页面样式检查：不检查页面样式是否符合方案
验收责任：Codex Playwright E2E 真机（禁止 @电脑）；本清单只记录壳，不重做 UI
---

## 目标

呈现顶栏本机状态、左列科目、右列客观题检测/作答状态、右侧学生卡片、底栏进度、主按钮「登录并刷新课程」。扫码按钮在卡片上。不内嵌完整浏览器。

## Codex 已创建文件

| 文件 | 用途 | 是否允许外部 AI 编辑 | 备注 |
|---|---|---|---|
| src/views/HomeView.vue | 主界面壳 | 否 | Stitch 回传后由 Codex 一比一改 |
| src/mock/demo.ts | 静态假进度 | 否 | 无真实姓名学号 |
| src/App.vue | 切页 | 否 | |
| electron/main.ts | 开窗 | 否 | 不接 Playwright |

## 查看入口

- 入口路径：`npm run dev` 开发态 Electron 窗，启动即工作台；顶栏四字导航
- 入口性质：正式入口
- 临时入口处理：不需要

## Stitch 信息（仅第 4 路线填写）

 - Stitch Project Title：OpenEdu Auto Desktop（MCP 实际 Title：上海开大自动答题）
 - Stitch Project ID：4741787672985224870
 - Stitch Screen Name：PC-P01-home 主界面 (动态微交互版)
 - Stitch Screen ID：092c05d88efd490d9d0edea686463143
 - Stitch 下载文件保存路径：liran_docs/ui-shells/stitch-download/
 - HTML 样式来源文件：liran_docs/ui-shells/stitch-download/PC-P01-home.html
 - 静态数据来源：Stitch HTML 假数据（张同学 / 李同学 / 0000****0001）
- 生成提示词：`liran_docs/ui-shells/T001-Stitch多页面设计提示词.md`

## 事实来源优先级（仅第 4 路线填写）

1. 第一事实来源：Stitch 下载下来的 HTML
2. 第二事实来源：Stitch 下载下来的代码 / 样式 / MD 规范
3. 第三事实来源：Stitch 下载下来的截图

- 能从 HTML 直接确认的尺寸、结构、class、层级，不允许靠截图猜。
- HTML 没写清但代码 / MD 有写清时，才可以用第二层证据。
- 截图只能做补充校对，不是第一依据。

## Stitch Screen 映射（仅第 4 路线填写）

| Stitch Screen | Screen ID | Screen 类型 | 对应真实前端页面/组件/状态 | 目标文件 |
|---|---|---|---|---|
| PC-P01-home | 092c05d88efd490d9d0edea686463143 | 页面 | 主界面 | src/views/HomeView.vue |
| 扫码按钮/悬停明细 | 归属 PC-P01 | 状态/组件 | 学生卡与作业悬停 | src/views/HomeView.vue |

## 控件规格盘点（仅第 4 路线填写）

已按 PC-P01-home.html 盘点。按钮：全选执行、全选未完成、查看来源、无头浏览器、可视化浏览器、答题、提取题库、查看作业二维码、验证完毕、停止、日志、删除、登录并刷新课程。顶栏：CPU%、内存%、本软件占用、浏览器数、压力。Badge：题库答题、AI 答题。进度：底栏课程/待做。Toast 默认隐藏；来源 popover 默认 hidden-popover。

### 按钮 / 图标 / 输入控件

- 无头/可视化：px-2.5 py-1 rounded-full text-[11px]；选中 bg-[#4F46E5] text-white font-semibold shadow-sm；未选 text-slate-600 hover:text-[#4F46E5] font-medium
- 答题/提取题库：px-3 py-1，选中/未选同上
- 查看作业二维码：flex-1 py-1 rounded-lg；验证完毕：py-1 px-3 rounded-lg bg-[#10B981]
- 停止/日志/删除：py-1.5 纵向，icon text-[16px]，字 11px
- 主按钮：h-11 px-7 rounded-full text-[14px]，icon 18px，旁 ⌘R text-[11px]
- 本页无原生 table / 分页 / 独立弹窗 Screen

### 表格 / 操作区 / 易塌陷区域

课程列与作业态内容变多仍要可扫；规格等 HTML。

## 允许编辑文件清单

当前不允许外部 AI 改文件。Codex 只改白名单：src/views/HomeView.vue、src/mock/demo.ts、src/App.vue、electron/main.ts。

## 禁止编辑范围

- 禁止改后端、数据库、权限、密钥
- 禁止把 Key、学号、token 写进界面默认数据
- 禁止把无头/可视化切换放进顶栏
- 禁止新增全局样式污染
- 禁止接真实 API（development 再接）

## 预留 API 清单

| 预留 | 说明 | 标记 |
|---|---|---|
| 进度订阅 | 五层状态 | 接线锚点 codex-state |
| 启动检测 | 主按钮登录并刷新课程 | 接线锚点 codex-connect |
| 扫码闸门按钮 | 查看作业二维码、验证完毕 | 接线锚点 codex-connect |
| 无头可视化切换 | 卡片右上角 | 接线锚点 codex-connect |

## 注释锚点清单
已打 TODO(ui-shell)、TODO(codex-connect)、TODO(codex-state)、TODO(codex-permission)。

## 预留状态清单

loading / empty / error / success / disabled / selected。主界面另有 queued、occupying_verify、待回写等业务态，development 接线。

## 预留事件清单

点击登录并刷新、查看作业二维码、验证完毕、无头/可视化切换、答题/提取题库、停止、学生切换、日志、更新稍后。

## mock/type 规划
src/mock/demo.ts、src/types/shell.ts。development 替换订阅。

## 样式作用域

仅本壳。禁止改全局 theme/reset。

## 外部 AI 输入包

未选外部 AI。选定后再写可复制包。

## Stitch 落地要求（仅第 4 路线填写）
根据 Stitch MCP 下载下来的文件里的 HTML 样式一比一还原。禁止只模仿大概风格，禁止重新设计。

## Stitch 初次接收与强制复修（仅第 4 路线填写）
初次接收检查：可以进入实例级细节复修。第一次复修：toast/popover 默认隐藏。第二次复修：去掉自造日志面板，#tool-log 只 toast；无头/可视化/答题/提取题库用 HTML 整段 class（segOn/segOff、workOn/workOff）；学生 pill 与 meta 随选中切换；刷新图标 animate-spin。

## Codex 开发目标接线任务

见 `04-开发追踪.md` 对应 TASK。本壳只负责外观。

## UI 壳接收检查
可以进入实例级细节复修。查看入口 npm run dev。主按钮「登录并刷新课程」。无头/可视化不在顶栏。题库答题/AI 答题可见。

## 真机测试影响项

Playwright E2E 清单见 `09-真机实测.md`。壳阶段不跑站点。

## 回退 / 重构记录

无。
