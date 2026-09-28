# 开大页面结构索引

后续自动化必须先读本目录，再读对应页面文件。页面 DOM 变了就改对应文件，不要把选择器散写进业务代码里当唯一真相。

- 证据优先：用户提供的 HTML 片段 > 已打开 Chrome 页的只读核对 > 站点脚本。对不上时以用户 HTML 为准，并在该页标注现场复核差异。
- 禁止写入：学号、xh、xhtoken、token、账号、姓名、手机号、JWT、完整敏感日志。URL 只记路径和参数名。
- 题量、分数、百分比以页面实计为准，样本数字只作示例。

## 文件

| 文件 | 页面 | 路径 | 状态 |
| --- | --- | --- | --- |
| [学习平台-我的课程.md](学习平台-我的课程.md) | 统一学习门户 / 我的课程 | `learning.shou.org.cn/scenter` | 已根据用户 HTML 整理，Chrome 只读核对过骨架 |
| [课程学习-形考作业入口.md](课程学习-形考作业入口.md) | 课程壳左侧「形考作业」 | `#courseHomeWorkNew` | 用户只给了入口节点；侧栏完整项来自 HomeWorkNew 现场 |
| [形考作业列表.md](形考作业列表.md) | 网上记分作业 + 阶段性测验 | `/study/HomeWorkNew.aspx` | 两种样本都已落盘 |
| [作业预览-作答历史.md](作业预览-作答历史.md) | 作业详情 / 历史 / 做作业 / 扫码 | `/study/assignment-preview.aspx` | 用户 HTML + 现场 doHomework |
| [作答历史查看页.md](作答历史查看页.md) | 已批阅试卷题目、对错、标准答案 | `/study/assignment/history.aspx` | 真实 Playwright 脱敏 DOM 已补 |
| [作业作答页.md](作业作答页.md) | 在线作答（单选/多选/判断/提交） | `/study/assignment/preview.aspx` | 指向仓库根目录已有文档 |
| [大学英语新题型和专属题型页面结构.md](大学英语新题型和专属题型页面结构.md) | 大学英语五类作答及已批阅历史结构 | `/study/assignment/preview.aspx`、`/study/assignment/history.aspx` | 作答页与历史页均已只读核对；真实保存行为待证 |

## 还没有单独成文的页

| 页面 | 路径 | 原因 |
| --- | --- | --- |
| 登录页 | 待确认 | 用户说会复刻已有谷歌插件自动上号，本轮无 HTML |
| 课程学习目录全文 | `/study/learnCatalogNew.aspx` | 本轮只需「形考作业」入口 |
| 扫码弹窗 DOM 全量 | `dl_qrCodeCheck` | 已有脚本契约；弹窗打开后的完整 HTML 待补一张现场 |
| 扫码弹窗 DOM 全量 | `dl_qrCodeCheck` | 已有脚本契约；弹窗打开后的完整 HTML 待补一张现场 |
| 续做页 | `/study/assignment/continuation.aspx` | 用户 HTML 有链接，页内结构待补 |
| 视障作答页 | `/study/assignment/readpreview.aspx` | 明确不走这条 |

## 路径不要混

| 路径 | 是什么 |
| --- | --- |
| `/scenter` | 学习门户，点课程 |
| `/study/learnCatalogNew.aspx` | 课程学习目录（课程链接默认打开这里） |
| `/study/HomeWorkNew.aspx` | 形考作业列表 |
| `/study/assignment-preview.aspx` | 作业预览 + 作答历史 +「做作业」（中间没有 / ） |
| `/study/assignment/preview.aspx` | 真正作答页（中间有 / ） |
| `/study/assignment/history.aspx` | 已提交试卷查看 |
| `/study/assignment/continuation.aspx` | 未完成提交的续做 |

列表里的「查看」进预览页；预览页的「做作业」进作答页。提交成功后脚本会跳回 assignment-preview.aspx。
