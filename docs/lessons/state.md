---
paths: shared/task.ts, shared/plan.ts, shared/engine.ts, server/tasks.ts, server/orch-mcp.ts, server/exec/process.ts, server/exec/proc-stats.ts, web/src/lib/useStickToBottom.ts, web/src/components/tasks/Messages.tsx, web/src/components/tasks/TaskView.tsx
---

# 对话状态、父子同步和停止

## 父子对话之间的交付：消息走 deliver，收口按面板的完成条件判断

- 规则：让父对话处理一件事（子对话的提问交给它决定之类）时不能按 `working` 判断它空闲：停在等下一句、收尾中、预热时 `working` 都是 false，但执行位还占着，直接 `followUp` 会抛 `TaskBusyError`。用 `deliver`（能续就续、能插话就插话、收不下记到这一轮结束后处理），只有 `live` 里没有进程时才 `followUp`；问题全文和选项一起交过去。叫不起来时把原因返回接口，界面显示原因并给重试；卡片状态字段（如 `delegated`）必须进 `messageStamp`，否则服务端改了也不推送。
- 规则：子对话回合结束时收口父对话计划只用 `shared/task.ts` 的 `childReport`（状态来自 `convState`，见 ADR 0005），出口只有 `server/tasks.ts` 的 `reportChild`。要看的事实：没做完的计划步骤、正在跑或排队的后台命令（`background.list` 的 `queued`/`running`）、这一轮之后要不要接着做（`hasHeld`、`startQueue`）、提问、工作流、派出的子任务。没收口时那一步继续等、note 写清在等什么。计划做完会收起（`activePlan` 是 undefined），判据里不要写计时。
- 起因：点「交给父对话决定」好几次父对话都没动，`followUp` 撞上执行位后只留一条 `log.warn`；子对话跑完一轮停在等下一句时，父计划里等它的步骤被标成完成（截图「计划 6/8」与实际不符）。
- 防线：`shared/task-stamp.test.ts`、`shared/plan.test.ts` 的「子对话这一轮结束」「三个子对话都在跑」用例；`scripts/e2e.mjs` 的「父对话停在等下一句时点交给父对话决定」。

## 对话状态只在 convState 判，上报只有一个出口，彻底完成不是中断

- 规则：对话（顶层、子对话）只有 `shared/task.ts` 的 8 个 `ConvState`，列表分组、图标、子对话栏文字、`list_conversations`、给父对话的上报都从 `convState` 派生，不在别处再拼「做没做完」。子对话给父对话报状态只走 `reportChild`（按 `reportKey` 去重）。面板因为「彻底完成」而结束进程用 `stopReason: 'finish'`，引擎（`finishedStop`）和 `convState` 都按正常结束处理，不写「这一轮被中断」。
- 规则：独立分支的子对话收尾是请求：`submit_merge` 只登记 `wrapRequest` 并叫醒父对话，合并、标完成、删分支由父对话 `finish_child` 触发。合并就是验收，测试必须在合并前、在子对话分支里跑通。
- 起因：用户 2026-10-23 指出子对话结束显示「这一轮被中断」、上报给父对话的状态不准；根因是 `childTurnSettle`、`childHolds`、`taskStage` 三套判据和三条上报路径各说各的，`completeChild` 的 `finish` 停止又被引擎当成中断。
- 防线：`shared/task-stage.test.ts` 的 `convState` 用例；`shared/plan.test.ts` 的 `childReport` 用例；`server/engine-steps.test.ts` 的 finish 用例；`scripts/e2e/04-subagents.mjs` 的收尾请求断言。

## 驱动转圈、计时的字段必须进 messageStamp；停止要杀到孙进程

- 规则：界面靠 `messageStamp` 判断消息变没变，工具行的 `running`、`ms` 这类决定转圈和耗时的字段必须进 stamp，否则服务端收掉了界面也不刷新。停止后台命令用 `killTreeDeep`：先拍进程表快照，按 ppid 把子孙都杀掉，Windows 上父进程先退、孙进程被改挂（或 setsid）也能找到。
- 起因：用户 2026-10-23 反馈「强制停止对话，不会终止后台运行命令」，截图里 `git config…` 一直转圈：stamp 没包含 `running`，停止的更新推不到界面；`taskkill /T` 找不到已经脱离父进程的孙进程。
- 防线：`shared/task-stage.test.ts` 的 `messageStamp` 用例；`server/exec/proc-stats.test.ts` 的 `descendants` 用例。

## 跟随到底部按滚动方向判断，不按离底部多远

- 规则：`useStickToBottom` 贴底时只有 `scrollTop` 变小（用户往上滚）才松开（`stillPinned`）。内容变高后浏览器补发的 scroll 事件里 `scrollTop` 没变、离底部却变远了，按距离判断会误以为用户滚走。
- 起因：用户 2026-10-23 反馈对话进行中偶发不回到底部。
- 防线：`web/src/lib/useStickToBottom.test.ts` 的 `stillPinned` 用例。

## 等子对话的步骤只由面板标完成；子对话收尾只走 submit_merge

- 规则：计划里挂着等待（子对话、后台命令）的步骤，Agent 自己标完成不算，面板在结果推回时标；父对话开子对话、交消息没写 step 时挂在正在做（或在等）的那一步。独立分支里的子对话不派「版本控制」收尾（`spawn` 直接拒），自己或子任务 `git merge` 过去后计划停在「合回」时也要提醒它 submit_merge。
- 起因：2026-10-24 父对话把子对话的计划抄进自己的计划一口气标完成，界面显示「计划已完成」；子对话的工具搜索没找到 submit_merge，派「版本控制」直接合进 dev，分支已合进去所以面板不提醒，子对话卡在收尾 13 分钟，直到用户追问才调用 submit_merge。
- 防线：`shared/plan.test.ts` 的「还在等子对话的步骤」；`scripts/real-cli/pi-handoff.mjs`（真实 Pi + 模拟模型，不进 CI）。

## 「在运行」只看 convActive，在运行的不失活

- 规则：在不在运行只用 `convActive`（`taskActive` / `childActive` / `keepAliveBusy`）；回收前先问它，子对话只随用户停止、归档、删除结束。见 ADR 0010。
- 防线：`shared/task-stage.test.ts`「对外状态统一」；e2e `04-subagents`「父对话切走」。
