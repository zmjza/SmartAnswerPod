# 学生账号 UI 壳接入清单

上级：[[10-UI壳接入清单]]
对应模块：[[_B]]
任务 ID：T001
PRD 需求文档：`liran_docs/requirements/T001-开大自动答题桌面端-PRD.md`
视觉依据：已确认文本视觉方案。用户把账号从设置单拎成独立页。
UI 路线：stitch
流程档位：完整流程
页面样式检查：不检查页面样式是否符合方案
验收责任：Codex Playwright E2E 真机（禁止 @电脑）；本清单只记录壳，不重做 UI
---

## 目标

账号列表桌面端一行三张卡片，窄屏单列；手工添加、Excel 三列导入（姓名账号密码，跳过表头）。不要 Key。不要并行开关。

## Codex 已创建文件

| 文件 | 用途 | 是否允许外部 AI 编辑 | 备注 |
|---|---|---|---|
| src/views/AccountsView.vue | 学生账号壳 | 否 | Stitch 回传后一比一 |
| src/App.vue | 四字导航 | 否 | |

## 查看入口

- 入口路径：顶栏「学生账号」
- 入口性质：正式入口
- 临时入口处理：不需要

## Stitch 信息（仅第 4 路线填写）

 - Stitch Project Title：OpenEdu Auto Desktop（MCP 实际 Title：上海开大自动答题）
 - Stitch Project ID：4741787672985224870
 - Stitch Screen Name：PC-P04-students 学生账号 (微动效交互版)
 - Stitch Screen ID：5fd62582fdaf45e1a246bdce3e24c446
 - Stitch 下载文件保存路径：liran_docs/ui-shells/stitch-download/
 - HTML 样式来源文件：liran_docs/ui-shells/stitch-download/PC-P04-students.html
 - 静态数据来源：Stitch HTML 假数据（张同学 / 李同学）

## 事实来源优先级（仅第 4 路线填写）

1. 第一事实来源：Stitch 下载下来的 HTML
2. 第二事实来源：Stitch 下载下来的代码 / 样式 / MD 规范
3. 第三事实来源：Stitch 下载下来的截图

## Stitch Screen 映射（仅第 4 路线填写）

| Stitch Screen | Screen ID | Screen 类型 | 对应真实前端页面/组件/状态 | 目标文件 |
|---|---|---|---|---|
| PC-P04-students | 5fd62582fdaf45e1a246bdce3e24c446 | 页面 | 学生账号 | src/views/AccountsView.vue |

## 控件规格盘点（仅第 4 路线填写）

已按 PC-P04-students.html 盘点。按钮：导入 Excel 批量名单、新增学员、编辑配置、删除、切换当前、保存并添加。输入：姓名、学号/账号、登录密码。提示：占用中删除需先停止并释放名额。Screen 名以 Stitch 实际 PC-P04-students 为准。

## 允许编辑文件清单

Codex 只改 src/views/AccountsView.vue。外部输入不得新增文件。

## 禁止编辑范围

- 禁止改后端、数据库、权限、密钥
- 禁止把 Key、学号、token 写进界面默认数据
- 禁止把无头/可视化切换放进顶栏
- 禁止新增全局样式污染
- 禁止接真实 API（development 再接）

## 预留 API 清单

| 预留 | 说明 | 标记 |
|---|---|---|
| 手工添加 | 姓名账号密码 | 接线锚点 codex-connect |
| Excel 导入 | 三列姓名账号密码，跳过表头 | 接线锚点 codex-connect |
| 删除账号 | 占用中先停再释放名额 | 接线锚点 codex-connect |

## 注释锚点清单

已打 TODO(codex-connect) 于添加、Excel、删除。

## 预留状态清单

loading / empty / error / success。

## 预留事件清单

添加账号、导入 Excel、删除账号。

## mock/type 规划

壳内静态两行假账号。

## 样式作用域

仅本壳。禁止改全局 theme/reset。

## 外部 AI 输入包

未选外部 AI。

## Stitch 落地要求（仅第 4 路线填写）

根据 Stitch HTML 一比一还原。禁止只模仿大概风格。

## Stitch 初次接收与强制复修（仅第 4 路线填写）

初次接收检查：可以进入实例级细节复修。第二次复修：顶栏 person 按钮不再误绑 Excel 导入，与 HTML title「当前操作员」一致。隐藏 file input 不占布局。

## Codex 开发目标接线任务

见 `04-开发追踪.md` 对应 TASK。本壳只负责外观。

## UI 壳接收检查

可以进入实例级细节复修。查看入口顶栏「学生账号」。

## 真机测试影响项

Playwright E2E 清单见 `09-真机实测.md`。壳阶段不跑站点。

## 回退 / 重构记录

无。
