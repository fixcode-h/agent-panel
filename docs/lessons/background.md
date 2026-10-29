---
paths: server/background.ts, server/exec/parsers.ts, web/src/lib/tasks.ts, server/orch-mcp.ts
---

# 后台命令

## 后台命令交出去不等于做完：没结果就一直转圈

- 规则：后台命令那一行按输出里「还没拿到结果的编号」（`bgPendingIds`，不锚定开头）判断转圈，结果段带编号接在后面（`settleJobRow`）；跑得久、没输出要提醒对话；推送失败重试并留在对话里。命令一律静默跑，不新开窗口。见 ADR 0006。
- 起因：带前缀的工具名被当成「运行命令」0.09 秒完成；Command Code 在结果前插 `<repair_note>`，锚定开头的匹配认不出编号，又显示完成；模型 `start cmd` 弹窗跑测试。
- 防线：`server/background.test.ts`「那一行收口」「监管」；`web/src/lib/tasks.test.ts`。

## 后台命令的名字要能显示出来

- 规则：带 `command` 的输入被解析层存成命令原文（`parsers.ts` 的 `inputText`），标题要用名字或命令第一行兜底（`true` 这类 JSON 字面量也算命令）；名字不能带换行，否则推回结果行显示时会截掉「成功 / 失败」。
- 起因：后台命令折叠行只剩动作名和耗时，用户要求显示命令。
- 防线：`web/src/lib/tasks.test.ts`、`server/orch-mcp.test.ts`、ui-check。
