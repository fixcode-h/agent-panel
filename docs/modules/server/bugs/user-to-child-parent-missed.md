# 用户直接在子对话里发消息，子对话做完父对话收不到状态

- 状态：已修复（`scripts/e2e/15-user-to-child.mjs` 通过）
- 症状：用户绕过父对话直接在子对话里输入新要求，子对话照常做完，父对话却一直以为它停在「已完成」，不会被叫起来处理结果
- 入口：`server/tasks.ts` 的 `POST /tasks/:id/messages`、`trackUserToChild`、`reportChild` / `noteParent`、`deliver`
- 根因类型：上报只在父对话计划有步骤等这个子对话时才叫起父对话，用户直接交代的要求没有在父对话计划里挂等待
- 模块：`server`（`server/tasks.ts`）、`shared`（`shared/plan.ts` 的 `ensureChildStep` / `bindWait`，未改动）
- 关键词：子对话直接输入、用户直接发给子对话、父对话收不到状态、停在已完成、收件箱、计划等待、trackUserToChild、reportChild、noteParent、resolved

## 根因

子对话每轮结束由 `reportChild` 报给父对话，`noteParent` 只有在父对话计划里有一步在等这个子对话（`settleWait` 命中）时才叫起父对话；否则上报只记进父对话的消息和收件箱，等父对话下次有人说话才看到。父对话用 `send_to_conversation` 派活时会 `ensureChildStep` + `bindWait` 挂上等待，用户直接在子对话里发消息时没有这一步，所以父对话一直停着。

另外，已标完成（`resolved`）的子对话 CLI 还停在等下一句时，消息走 `deliver` 直接交给 CLI，完成标记不清，界面和父对话看到的还是「已完成」，做完也被 `reportedDone` 挡住不再上报。

## 修复

- 用户直接给子对话发消息时（`trackUserToChild`）：和 `send_to_conversation` 同一套，在父对话计划里挂一步等这个子对话（计划已结束就重开、没有能挂的就补一步），父对话里记一行「用户直接交代子对话」，告诉它不用转交。子对话做完时 `settleWait` 命中，父对话被叫起来处理状态。
- `deliver` 把消息交给已完成子对话时清掉 `resolved` 和上报去重记录。

## 顺带：父对话里两条一样的「子对话状态」

- 原因：一轮结束会上报两次——CLI 报完这一轮（`result`，`onTurnEnd`）一次，进程退出、整次执行收尾（`reportToParent`）一次。去重键 `reportKey` 带着 `task.status`，第一次时还是 `running`、第二次变成 `done`，同一轮同一状态被当成两次上报。保活等下一句的 CLI 进程不退出，只报一次，所以是「偶尔」出现。
- 另外第一次上报用的是 `task.summary`，它要等整次执行收尾才更新，所以那条带的是上一轮的结果。
- 修复：去重键去掉 `status`（同一轮 `turnDoneAt` + 同一状态只报一次）；上报的结果优先取最新回复。
