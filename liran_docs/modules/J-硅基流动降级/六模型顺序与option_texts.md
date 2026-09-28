# 多模型顺序与 option_texts

上级：[[_J]]
下级：无
依赖：[[凭据safeStorage]]

---

## 场景
当前题未命中题库。

## 触发
AI 答题。

## 逻辑
顺序：1 deepseek-ai/DeepSeek-V4-Flash 2 zai-org/GLM-5.3 3 Pro/moonshotai/Kimi-K2.6 4 Qwen/Qwen3.8-27B 5 tencent/Hy4-preview 6 stepfun-ai/Step-3.5-Flash。只认 {"option_texts":[...]}。非法 JSON、缺字段、正文不在选项集合则换下一个。界面记下实际模型 id。

## 状态 / 边界
当前按 PRD REQ-013 的 14 个唯一模型顺序降级。所有模型共用统一高校课程客观题提示词，只接受 `option_texts`。单轮全部失败时主界面显示题号、已尝试模型数和最后原因；提交前最多补答 30 轮。第 30 轮仍失败时显示剩余题号并安全停止，明确标记未提交。
