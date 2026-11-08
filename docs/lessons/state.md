---
paths: shared/task.ts, shared/plan.ts, shared/engine.ts, server/tasks/**, shared/peer-message.ts, shared/bug-diagnosis.ts, web/src/components/tasks/ToolRow.tsx
---

# 对话状态和父子对话之间的交付

## 父子对话之间的交付：消息走 deliver，收口按面板的完成条件判断

- 规则：给对话交消息（子对话提问、计划在等的结果、后台命令结果、编译申请）不能按 `working` 判空闲：等下一句、收尾、预热时它是 false 但执行位还占着，`followUp` 会抛 `TaskBusyError`。「是否正在运行」只用 `server/tasks/asks.ts` 的 `runningConv`，交消息只走 `wakeConv`，不手写 `deliver`/`followUp` 分支；`working` 只用于插话、归档 / 合并 / 更新拦截、列表 busy。问题全文和选项一起交过去。
- 规则：子对话回合结束时收口父对话计划只用 `shared/task.ts` 的 `childReport`（状态来自 `convState`，见 ADR 0005），出口只有 `server/tasks/children.ts` 的 `reportChild`。要看的事实：没做完的计划步骤、正在跑或排队的后台命令（`background.list` 的 `queued`/`running`）、这一轮之后要不要接着做（`hasHeld`、`startQueue`）、提问、工作流、派出的子任务。没收口时那一步继续等、note 写清在等什么。计划做完会收起（`activePlan` 是 undefined），判据里不要写计时。
- 起因：点「交给父对话决定」好几次父对话都没动，`followUp` 撞上执行位后只留一条 `log.warn`；2026-10-25 父对话等下一句时自动交出的提问报「任务正在执行」；子对话跑完一轮停在等下一句时，父计划里等它的步骤被标成完成（截图「计划 6/8」与实际不符）。
- 防线：`shared/task-stamp.test.ts`、`shared/plan.test.ts` 的「子对话这一轮结束」「三个子对话都在跑」用例；`scripts/e2e/04-subagents.mjs` 的「父对话停在等下一句时子对话提问」用例。

## 对话状态只在 convState 判，上报只有一个出口，彻底完成不是中断

- 规则：对话（顶层、子对话）只有 `shared/task.ts` 的 8 个 `ConvState`，列表分组、图标、子对话栏文字、`list_conversations`、给父对话的上报都从 `convState` 派生，不在别处再拼「做没做完」。子对话给父对话报状态只走 `reportChild`（按 `reportKey` 去重）。面板因为「彻底完成」而结束进程用 `stopReason: 'finish'`，引擎（`finishedStop`）和 `convState` 都按正常结束处理，不写「这一轮被中断」。
- 规则：独立分支的子对话收尾是请求：`submit_merge` 只登记 `wrapRequest` 并叫醒父对话，合并、标完成、删分支由父对话 `finish_child` 触发。合并就是验收，测试必须在合并前、在子对话分支里跑通。
- 起因：用户 2026-10-23 指出子对话结束显示「这一轮被中断」、上报给父对话的状态不准；根因是 `childTurnSettle`、`childHolds`、`taskStage` 三套判据和三条上报路径各说各的，`completeChild` 的 `finish` 停止又被引擎当成中断。
- 防线：`shared/task-stage.test.ts` 的 `convState` 用例；`shared/plan.test.ts` 的 `childReport` 用例；`server/engine-steps.test.ts` 的 finish 用例；`scripts/e2e/04-subagents.mjs` 的收尾请求断言。

## 「在运行」只看 convActive，在运行的不失活

- 规则：在不在运行只用 `convActive`（`taskActive` / `childActive` / `keepAliveBusy`）；回收前先问它，子对话只随用户停止、归档、删除结束。见 ADR 0012。
- 防线：`shared/task-stage.test.ts`「对外状态统一」；e2e `04-subagents`「父对话切走」。

## 「一条消息只交给一个子对话」按用户消息算范围

- 规则：`sentToOther` 和 `handedOff` 只在当前这条用户消息（`currentAskIndex`：用户亲自发的、已交给 CLI 的最后一条）里去重；子对话交回、面板推进拉起的几轮仍算同一条，用户发了新消息就重新算。例外（`handOffFrom`）：转发的正文就是某条更早的用户消息原文时从那条算起，内存记录也不随插话清空——插话、read_user_notes 进来的消息也会成为当前消息。
- 起因：审计发现按整个对话历史去重，父对话对 A 说过「继续」，以后对 B 说「继续」永远被拒；收窄后（2bb92363）「规则 1 交给 c1、规则 2 插话进来、再把规则 1 交给 c2」被放过。
- 防线：`shared/peer-message.test.ts`、`server/orchestrator.test.ts` 的去重用例。

## Agent 停下等用户看方案、看报告：算执行中；入口放在已有的行上，用户在哪一页都点得到

- 规则：Agent 交了东西等用户审（诊断报告这类），这件事还没做完：对话状态算执行中（`ConvFacts.diagnosis` → `running`），父对话那边照样转圈、不推它接着做；不要挂成「等你处理」的请求（`task.requests`），也不在父对话页另起一行。审阅入口放在已经有的行上：子对话里交东西的那一行工具调用，加上父对话页上这个子对话自己的那一行（「正在运行」、子对话列表），交上来时自动弹一次（每一版一次，`web/src/components/tasks/ChildReport.tsx`）。
- 起因：ADR 0045 第一版（1efc3a9）挂成请求、父对话页多一条，用户纠正；bd191249 改成只放在子对话的工具行上，用户在父对话页找不到入口，又报过一次。
- 防线：`shared/bug-diagnosis.test.ts`、`server/orchestrator.test.ts`、`scripts/ui/02b-subagent.mjs`（父对话页没有单独一行、子对话行和工具行上都有「查看报告」、自动弹一次）。
