# 桌面壳与发布（_A.md）

上级：无
下级：[[Electron启动]]、[[GitHub-OTA]]
依赖：无

---

## 职责
提供可安装的 Electron 桌面壳，mac/Win 双端，Playwright 在主进程捆绑 Chromium，OTA 走 GitHub Releases。

## 包含的子模块 / 交互点
- [[Electron启动]]
- [[GitHub-OTA]]

## 对外提供
可启动的 App、更新通道、主进程运行时。

## 关键说明
禁止把自动上号器扩展拷进仓库。禁止依赖用户本机 Chrome。

## 对应需求
REQ-001、REQ-019；AC-001、AC-019

## 微观任务
见 `liran_docs/04-开发追踪.md` 中 TASK-A01/A02。
