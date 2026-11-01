---
paths: server/asks.ts, server/exec/panel-requests.ts, shared/push-auth.ts, web/src/components/chat/QuestionPanel.tsx, web/src/components/tasks/ChildAskCard.tsx, web/src/components/tasks/RequestCard.tsx, scripts/ui/02c-element-pick.mjs
---

# 提问窗口

## 提问窗口的关闭：这个问题不回答，终止当前对话

- 规则：凡是弹 `QuestionPanel` 的地方，右上角的关闭都是「不回答 + 终止对话」，不是收起、也不是只暂停：任务页走停止并当场作废 `task.requests`（`dropRequests`），子对话请你决定的走 `/tasks/:id/parent-asks/close`（父对话卡片记 `declined`、子对话连进程终止），其他会话走 `/asks/:id/close`（`askSession` 的 stop）。接口返回的状态里不能再带着提问，不能等进程收尾再清。
- 起因：c649562 之前停止接口返回的任务还带着提问，窗口关不掉；子对话的选择窗口关闭只是收起，用户纠正为「关闭表示不回答，终止当前对话」。
- 防线：`scripts/e2e/05-workflow-edge.mjs`、`scripts/e2e/04-subagents.mjs`、`server/asks.test.ts`、`scripts/ui/02c-element-pick.mjs` 的提问窗口和子对话提问截图。

## 授权不是提问：要用户点头的事走「允许 / 拒绝」卡，不借提问工具

- 规则：要用户授权才能做的事（推送并合并主干这类）由面板工具发 `kind: 'tool'` 的授权卡、`purpose` 标明用途（见 `server/exec/panel-requests.ts`），回答由面板记下；不让模型用 ask_user / AskUserQuestion 问：提问的回答面板认不出用途、记不下，「提问」关着时还会被自动答成「按你的判断继续」，等于模型自己决定。自动作答只管 `kind: 'question'`。
- 起因：c5e5c5d8 起项目推送策略「第一次需要推送时问一次」靠提问工具问，「提问」默认关着，推不推实际由模型自己定。
- 防线：`server/exec/panel-requests.test.ts`、`scripts/e2e/07-local.mjs`「推送授权」。
