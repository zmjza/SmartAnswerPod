# AI对的入库

上级：[[_L]]
下级：无
依赖：[[题干选项集合hash]]

---

## 场景
本轮有 AI 答题且已批阅。

## 触发
点历史查看进入 history.aspx。

## 逻辑
对的写入 questions，source=ai_verified，verified=true。同一 hash 去重。

## 状态 / 边界
AI 错题不入库。查看失败走待回写。
