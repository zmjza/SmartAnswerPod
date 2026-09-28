# 设置 UI 壳接入清单

上级：[[10-UI壳接入清单]]
对应模块：[[_B]]
任务 ID：T001
PRD 需求文档：`liran_docs/requirements/T001-开大自动答题桌面端-PRD.md`
视觉依据：已确认文本视觉方案。PRD 第 10 节。参考图样本姓名学号不入库。
UI 路线：stitch
流程档位：完整流程
页面样式检查：不检查页面样式是否符合方案
验收责任：Codex Playwright E2E 真机（禁止 @电脑）；本清单只记录壳，不重做 UI
---

## 目标

硅基流动 Key、Supabase URL、anon key、账号并行默认 2、课程并行默认 2、浏览器显示默认关、日志默认开。账号列表已单拎到学生账号页。

## Codex 已创建文件

| 文件 | 用途 | 是否允许外部 AI 编辑 | 备注 |
|---|---|---|---|
| src/views/SettingsView.vue | 设置壳 | 否 | Stitch 回传后一比一 |
| src/App.vue | 切页 | 否 | |

## 查看入口

- 入口路径：顶栏「设置」
- 入口性质：正式入口
- 临时入口处理：不需要

## Stitch 信息（仅第 4 路线填写）

 - Stitch Project Title：OpenEdu Auto Desktop（MCP 实际 Title：上海开大自动答题）
 - Stitch Project ID：4741787672985224870
 - Stitch Screen Name：PC-P02-settings 设置 (动态微交互版)
 - Stitch Screen ID：109626339c614b1eb65c9656b766504b
 - Stitch 下载文件保存路径：liran_docs/ui-shells/stitch-download/
 - HTML 样式来源文件：liran_docs/ui-shells/stitch-download/PC-P02-settings.html
 - 静态数据来源：Stitch HTML；密钥输入默认空，不用 HTML 里的假 Key

## 事实来源优先级（仅第 4 路线填写）

1. 第一事实来源：Stitch 下载下来的 HTML
2. 第二事实来源：Stitch 下载下来的代码 / 样式 / MD 规范
3. 第三事实来源：Stitch 下载下来的截图

## Stitch Screen 映射（仅第 4 路线填写）

| Stitch Screen | Screen ID | Screen 类型 | 对应真实前端页面/组件/状态 | 目标文件 |
|---|---|---|---|---|
| PC-P02-settings | 109626339c614b1eb65c9656b766504b | 页面 | 设置 | src/views/SettingsView.vue |

## 控件规格盘点（仅第 4 路线填写）

已按 PC-P02-settings.html 盘点。输入：硅基流动 Key / Supabase URL / anon key，高度 h-10。步进器：账号并发默认 2、课程并发产品默认 2（HTML value=1，保持 2）。开关：显示浏览器窗口默认关、详细运行日志默认开。按钮：连通性测试、恢复默认、保存并应用配置、复制、显隐。#save-hint 默认可见。

### 按钮 / 图标 / 输入控件

回传后再填实例 px。

### 表格 / 操作区 / 易塌陷区域

字段变多时仍可滚动。

## 允许编辑文件清单

Codex 只改 src/views/SettingsView.vue。外部输入不得新增文件。

## 禁止编辑范围

- 禁止改后端、数据库、权限、密钥
- 禁止把 Key、学号、token 写进界面默认数据
- 禁止把无头/可视化切换放进顶栏
- 禁止新增全局样式污染
- 禁止接真实 API（development 再接）

## 预留 API 清单

| 预留 | 说明 | 标记 |
|---|---|---|
| 设置保存 | 账密、三 Key、并行度、浏览器显示默认、日志 | 接线锚点 codex-connect |

## 注释锚点清单

已打 TODO(codex-connect) 于保存。

## 预留状态清单

loading / empty / error / success / disabled。加密失败不得写明文。

## 预留事件清单

保存设置。

## mock/type 规划

密钥输入默认空。

## 样式作用域

仅本壳。禁止改全局 theme/reset。

## 外部 AI 输入包

未选外部 AI。选定后再写可复制包。

## Stitch 落地要求（仅第 4 路线填写）

根据 Stitch HTML 一比一还原。禁止只模仿大概风格。

## Stitch 初次接收与强制复修（仅第 4 路线填写）

初次接收检查：可以进入实例级细节复修。第一次复修：save-hint 默认可见；课程并行保持 2。第二次复修：本页无结构差，日志开关 v-model 默认开，浏览器开关默认关。

## Codex 开发目标接线任务

见 `04-开发追踪.md` 对应 TASK。本壳只负责外观。

## UI 壳接收检查

可以进入实例级细节复修。查看入口顶栏「设置」。密钥默认空。

## 真机测试影响项

Playwright E2E 清单见 `09-真机实测.md`。壳阶段不跑站点。

## 回退 / 重构记录

无。
