---
paths: shared/task.ts, server/tasks/**, server/exec/delivery.ts, web/src/components/tasks/child-line.ts
---

# 子对话没有输出时自动询问

## 子对话长时间没有输出：面板以父对话的名义自动问，不新开一轮、不挡用户消息

- 规则：判定写成纯函数（`shared/task.ts` 的 `childIdleAsk`），定时器只拿结论执行：0 关闭、只问还在执行的子对话、等用户 / 等后台命令 / 等工作流这类能解释的等待不问、每隔阈值最多问一次、同一段静默最多 3 次，收到输出重新计时。发送走 `server/tasks.ts` 的 `deliver`（先插话、再 notes、最后排到这一轮结束后）；`r.how === 'held'` 时从队列和对话里撤掉这条询问（`removeHeld`），按阈值隔开再试，不能让它排在用户消息前面、也不能在收尾时开新一轮把 `resolved` / `wrapRequest` 清掉。询问以父对话的名义（`peer.rel = 'parent'`）记进子对话，记在 `task.autoAsk`，子对话行上显示「已自动询问，等回复」。
- 起因：用户要求「子对话 3 分钟没有输出就自动询问下当前状态，看看是否卡死，由父对话来问」，并强调 AI 的所有操作都不能阻挡 CLI 接收新消息。
- 防线：`shared/task-idle-ask.test.ts` 覆盖阈值、0 关闭、等待、防抖、次数上限和输出重置；`server/exec/delivery.test.ts` 覆盖 held 队列里撤掉询问后用户消息仍排在前面；`scripts/e2e/04-subagents.mjs` 用 `HANG` 假 CLI（`STALL_ONCE` 只在 RPC 分支生效，codex 不认）断言询问送达并被回复、用户消息不被挡。
