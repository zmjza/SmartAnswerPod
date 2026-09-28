# 题库导入 UI 壳接入清单

上级：[[10-UI壳接入清单]]
对应模块：[[_I]]
任务 ID：T001
PRD 需求文档：`liran_docs/requirements/T001-开大自动答题桌面端-PRD.md`
视觉依据：已确认文本视觉方案。PRD 第 10 节。不提供导出。
UI 路线：stitch
流程档位：完整流程
页面样式检查：不检查页面样式是否符合方案
验收责任：Codex Playwright E2E 真机（禁止 @电脑）；本清单只记录壳，不重做 UI
---

## 目标

JSON 导入题库。不提供导出。导入后按 content_hash 去重。

## Codex 已创建文件

| 文件 | 用途 | 是否允许外部 AI 编辑 | 备注 |
|---|---|---|---|
| src/views/BankImportView.vue | 题库导入壳 | 否 | Stitch 回传后一比一 |

## 查看入口

- 入口路径：顶栏「题库」
- 入口性质：正式入口
- 临时入口处理：不需要

## Stitch 信息（仅第 4 路线填写）

 - Stitch Project Title：OpenEdu Auto Desktop（MCP 实际 Title：上海开大自动答题）
 - Stitch Project ID：4741787672985224870
 - Stitch Screen Name：PC-P03-bank-import 题库导入 (动态微交互版)
 - Stitch Screen ID：4ffb416003994f77bc888dddf58d717a
 - Stitch 下载文件保存路径：liran_docs/ui-shells/stitch-download/
 - HTML 样式来源文件：liran_docs/ui-shells/stitch-download/PC-P03-bank-import.html
 - 静态数据来源：Stitch HTML

## 事实来源优先级（仅第 4 路线填写）

1. 第一事实来源：Stitch 下载下来的 HTML
2. 第二事实来源：Stitch 下载下来的代码 / 样式 / MD 规范
3. 第三事实来源：Stitch 下载下来的截图

## Stitch Screen 映射（仅第 4 路线填写）

| Stitch Screen | Screen ID | Screen 类型 | 对应真实前端页面/组件/状态 | 目标文件 |
|---|---|---|---|---|
| PC-P03-bank-import | 4ffb416003994f77bc888dddf58d717a | 页面 | 题库导入 | src/views/BankImportView.vue |

## 控件规格盘点（仅第 4 路线填写）

已按 PC-P03-bank-import.html 盘点。按钮：重新选择、开始导入。无导出。去重说明：题干加排序后选项集合。独立提取不在本页，文案指向工作台学生卡「提取题库」。

### 按钮 / 图标 / 输入控件

回传后再填实例 px。

### 表格 / 操作区 / 易塌陷区域

导入结果新增/合并/冲突/跳过要看得见。

## 允许编辑文件清单

Codex 只改 src/views/BankImportView.vue。

## 禁止编辑范围

- 禁止改后端、数据库、权限、密钥
- 禁止把 Key、学号、token 写进界面默认数据
- 禁止把无头/可视化切换放进顶栏
- 禁止新增全局样式污染
- 禁止接真实 API（development 再接）

## 预留 API 清单

| 预留 | 说明 | 标记 |
|---|---|---|
| JSON 导入 | content_hash 去重 | 接线锚点 codex-connect |
| 导入结果 | 新增/合并/冲突计数 | 接线锚点 codex-state |

## 注释锚点清单

已打 TODO(codex-connect)、TODO(codex-state)。

## 预留状态清单

loading / empty / error / success。不提供导出。

## 预留事件清单

选择 JSON 文件导入。

## mock/type 规划

点击导入仅显示静态计数，不写云端。

## 样式作用域

仅本壳。禁止改全局 theme/reset。

## 外部 AI 输入包

未选外部 AI。选定后再写可复制包。

## Stitch 落地要求（仅第 4 路线填写）

根据 Stitch HTML 一比一还原。禁止只模仿大概风格。

## Stitch 初次接收与强制复修（仅第 4 路线填写）

初次接收检查：可以进入实例级细节复修。第二次复修：文件名展示绑定 fileName；隐藏 file input 不占布局。无导出。

## Codex 开发目标接线任务

见 `04-开发追踪.md` 对应 TASK。本壳只负责外观。

## UI 壳接收检查

可以进入实例级细节复修。查看入口顶栏「题库」。无导出按钮。

## 真机测试影响项

Playwright E2E 清单见 `09-真机实测.md`。壳阶段不跑站点。

## 回退 / 重构记录

无。
