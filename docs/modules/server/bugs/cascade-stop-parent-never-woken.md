# 停下父对话再继续，子对话接着做完了父对话却一直等

- 状态：已修复（`shared/resume-kids.test.ts`、`shared/plan.test.ts`、`scripts/e2e/09-subagent-runtime.mjs` 通过）
- 症状：停下父对话再点继续，子对话被拉起来做完了，父对话不被叫醒、计划那一步挂着「需要修复」；面板推父对话查原因，它就另建子对话重做
- 入口：`shared/task.ts` 的 `childReport`；`server/tasks/child-messages.ts` 的 `noteParent`；`server/tasks/conversation-routes.ts` 的 `resumeKids`；`shared/resume-kids.ts` 的 `rearmKidWait`
- 根因类型：暂停被当成失败结算，结果回来时等待已经不在「等待中」
- 模块：`server`（`server/tasks/`）、`shared`
- 关键词：停止、继续执行、连带拉起、resumeKids、需要修复、父对话不醒、重复子对话、ADR 0042

## 现象

用户报：停下父对话再继续，子对话、子任务没接上，父对话一直等，或者面板又新开一批子对话重做。

## 根因

1. 父对话停止时子对话记 `stopReason: 'parent'`，`childReport` 除了 `user` 以外的停止一律结算成 `fail`。
2. `noteParent` 先 `settleWait` 把父计划里等它的那条等待收成失败、那一步退回进行中并写「需要修复」，再判断是连带停下、不发消息。
3. 父对话继续时 `resumeKids` 把子对话拉起来，但没有把那条等待改回等待中；子对话做完时 `settleWait` 只认等待中的，对不上，父对话不会被叫醒。同时「需要修复」让面板推父对话去查原因、重做。
4. `resumeKids` 只对顶层对话调用，孙对话不会被连带拉起；用户直接继续一个子对话时也不恢复父计划的等待。

## 修复

- 停下是暂停（ADR 0042）：只有归档、删除、被接手、核对时已经没人在跑（`lost`）的停止才结算成失败，其余保持等待中。
- `resumeKids` 递归拉起孙对话；拉起成功后 `rearmKidWait` 把父计划里已经收成失败的等待改回等待中、清掉「需要修复」；用户直接继续子对话时同样恢复。
- 用量上限停下的整棵树继续时也连带拉起。

## 防线

- `shared/plan.test.ts`：各停止原因的结算（暂停的继续等、不会回来的收成失败）。
- `shared/resume-kids.test.ts`：恢复等待、清掉「需要修复」、主步骤回到等待中；用量上限也连带拉起。
- `scripts/e2e/09-subagent-runtime.mjs`：「停下就是暂停」——停父对话后那一步还在等，继续后原来的子对话做完、计划收到结果、没有另建子对话。
