---
paths: server/asks.ts, web/src/components/chat/QuestionPanel.tsx, web/src/components/tasks/ChildAskCard.tsx, web/src/components/tasks/RequestCard.tsx, scripts/ui/02-task.mjs
---

# 提问窗口

## 提问窗口的关闭：这个问题不回答，终止当前对话

- 规则：凡是弹 `QuestionPanel` 的地方，右上角的关闭都是「不回答 + 终止对话」，不是收起、也不是只暂停：任务页走停止并当场作废 `task.requests`（`dropRequests`），子对话请你决定的走 `/tasks/:id/parent-asks/close`（父对话卡片记 `declined`、子对话连进程终止），其他会话走 `/asks/:id/close`（`askSession` 的 stop）。接口返回的状态里不能再带着提问，不能等进程收尾再清。
- 起因：c649562 之前停止接口返回的任务还带着提问，窗口关不掉；子对话的选择窗口关闭只是收起，用户纠正为「关闭表示不回答，终止当前对话」。
- 防线：`scripts/e2e/05-workflow-edge.mjs`、`scripts/e2e/04-subagents.mjs`、`server/asks.test.ts`、`scripts/ui/02-task.mjs` 的「提问窗口」「子对话提问」。
