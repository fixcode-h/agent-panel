---
paths: server/exec/redirect.ts, server/exec/runner.ts, server/exec/rpc/spec.ts, scripts/e2e.mjs, shared/alerts.ts, server/tasks.ts, shared/task.ts, web/src/components/tasks/child-line.ts, server/asks.ts, web/src/components/chat/QuestionPanel.tsx, web/src/components/tasks/ChildAskCard.tsx, web/src/components/tasks/RequestCard.tsx, server/designs.ts, web/src/components/design/DesignChat.tsx
---

# 插话、正在执行的命令和没有响应的 CLI

## 为插话停下命令前，先分清命令是不是只读

- 规则：判定写成纯函数放 `server/exec/redirect.ts`，runner 只拿结果决定还要等多久。只读命令（`ls`、`rg`、`git log`、`git worktree list` 这类）等它自然跑完——这批工具结束时 CLI 自己会取走补充；会写文件、装依赖、跑测试、等外部状态的才按短阈值打断，只读的只在更长的兜底阈值才停。停下时给模型的说明要写明这条命令已取消、输出不完整、不要当结果，并让它需要时重跑。
- 起因：面板自己的执行记录 92dfd0da 里，`git worktree list` 跑 9.2 秒就被新消息打断重跑（随后出现「为了马上处理新消息，停下了正在执行的命令」）；用户每发一条消息，正在读的代码就白读一遍。
- 防线：`server/exec/redirect.test.ts` 覆盖只读判定和各阈值下的等待时间；`scripts/e2e/03-chat.mjs` 的 Pi 长命令（`sleep 120; gh pr checks 14`）用例证明非只读命令仍然会被打断。

## 错误写进对话并带分类；交给 CLI 后没有输出要提醒，下一句要能救回来

- 规则：执行和面板自己出的错都写进对话，系统消息带 `alert`（分类和说明在 `shared/alerts.ts`），界面画成可点开的警告行；只写 `log.warn` 不算处理过。交给 CLI 一句话、工具结果或开始一次模型请求后 `NO_RESPONSE_MS` 内没有真正的输出，写 `no_response` 警告并登记卡住；之后来的消息不再插话进那一轮，`HARD_STOP` 直接结束进程、接回会话重开，带上没被处理的那条。新加一类报错时 `AlertKind`、`alerts.ts`、`shared/locales/en/alerts.ts` 各加一项。
- 起因：2026-10-24 后台命令「等待 PR 42 检查」的结果交给保活的 Command Code 后它一个字都没输出，用户的新消息又插话进卡住的那一轮，界面上没有任何错误。
- 防线：`scripts/e2e/03-chat.mjs` 的「CLI 收下消息后没有输出」；`shared/alerts.test.ts`。

## 运行中发的消息走服务端补充接口，页面不要自己维护队列

- 规则：会话运行中发消息走服务端的补充接口（设计对话是 `POST /designs/:id/steer`，输入复用 `DesignChatInput`，带附件、标注、引用、风格）：能插话就交给正在跑的这一轮，收不下就记进对话并在这一轮结束后自动开下一轮（`pendingTurns` + `drainTurns`），`delivery` 记清 `steer` / `held` / `next` / 停止后 `lost`，界面用共享的 `deliveryText` 显示，不要一直停在「结束后自动处理」；前端不要造本地 queue 冒充已送达。停止要连「准备新一轮」（`starting`）的窗口一起取消，取消后还得把停止期间登记进 `pendingTurns` 的消息接上，否则它们会一直停在「结束后自动处理」。
- 起因：2026-10-24 设计对话原来只把纯文字交给 `/steer`，带附件、引用、风格的消息塞进页面本地 queue（「排队中，这一轮结束后发送」），用户要求改成和 Chat 模式一致。
- 防线：`scripts/e2e/06-assist.mjs` 的「设计补充 / 接续 / 停止测试」；`npm run typecheck` 的漏翻检查。

## 子对话长时间没有输出：面板以父对话的名义自动问，不新开一轮、不挡用户消息

- 规则：判定写成纯函数（`shared/task.ts` 的 `childIdleAsk`），定时器只拿结论执行：0 关闭、只问还在执行的子对话、等用户 / 等后台命令 / 等工作流这类能解释的等待不问、每隔阈值最多问一次、同一段静默最多 3 次，收到输出重新计时。发送走 `server/tasks.ts` 的 `deliver`（先插话、再 notes、最后排到这一轮结束后）；`r.how === 'held'` 时从队列和对话里撤掉这条询问（`removeHeld`），按阈值隔开再试，不能让它排在用户消息前面、也不能在收尾时开新一轮把 `resolved` / `wrapRequest` 清掉。询问以父对话的名义（`peer.rel = 'parent'`）记进子对话，记在 `task.autoAsk`，子对话行上显示「已自动询问，等回复」。
- 起因：用户要求「子对话 3 分钟没有输出就自动询问下当前状态，看看是否卡死，由父对话来问」，并强调 AI 的所有操作都不能阻挡 CLI 接收新消息。
- 防线：`shared/task-idle-ask.test.ts` 覆盖阈值、0 关闭、等待、防抖、次数上限和输出重置；`server/exec/delivery.test.ts` 覆盖 held 队列里撤掉询问后用户消息仍排在前面；`scripts/e2e/04-subagents.mjs` 用 `HANG` 假 CLI（`STALL_ONCE` 只在 RPC 分支生效，codex 不认）断言询问送达并被回复、用户消息不被挡。

## 提问窗口的关闭：这个问题不回答，终止当前对话

- 规则：凡是弹 `QuestionPanel` 的地方，右上角的关闭都是「不回答 + 终止对话」，不是收起、也不是只暂停：任务页走停止并当场作废 `task.requests`（`dropRequests`），子对话请你决定的走 `/tasks/:id/parent-asks/close`（父对话卡片记 `declined`、子对话连进程终止），其他会话走 `/asks/:id/close`（`askSession` 的 stop）。接口返回的状态里不能再带着提问，不能等进程收尾再清。
- 起因：c649562 之前停止接口返回的任务还带着提问，窗口关不掉；子对话的选择窗口关闭只是收起，用户纠正为「关闭表示不回答，终止当前对话」。
- 防线：`scripts/e2e/05-workflow-edge.mjs`、`scripts/e2e/04-subagents.mjs`、`server/asks.test.ts`、`scripts/ui/02-task.mjs` 的「提问窗口」「子对话提问」。
