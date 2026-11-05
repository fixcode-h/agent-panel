# 子对话一收口，父对话还没推送合主干，计划就显示完成；合回后的子对话又被要求重交收尾

- 状态：已修复（`shared/plan.test.ts`、`server/tasks/before-end.test.ts` 通过）
- 症状：父对话计划最后一步「收尾：推送到远端并合并主干」在等子对话，子对话一收口这一步就打勾、计划显示已完成，PR 其实还没合；子对话被父对话合回后又收到「你还没请父对话收尾」，重新列计划、再交一次 submit_merge，父对话只好再收一次
- 入口：`shared/plan.ts` 的 `settleWait`；`shared/end-turn.ts` 的 `mergeOwedOf`
- 根因类型：通用的「等的结果都回来就标完成」套到了收尾步骤上；收尾记号（wrapRequest）清掉后没看计划里已完成的收尾
- 模块：`shared`（`shared/plan.ts`、`shared/end-turn.ts`）
- 关键词：收尾、推送到远端并合并主干、计划提前完成、settleWait、等子对话、submit_merge、你还没请父对话收尾、重复收尾、finish_child

## 现象

用户导出的对话「丢弃本地所有改动前先确认工作区状态」（2026-11-05）：

1. 父对话 15:05 用 finish_child 合回子对话「拆分 shared/task.ts 超出行数上限」，子对话的计划收尾步骤标完成、计划收起，但子对话这一轮还没结束。
2. 15:11 子对话结束前钩子提示「你还没请父对话收尾」，子对话新开一份计划、15:18 再交一次 submit_merge；父对话 15:19 再 finish_child 一次（「分支上没有新的改动」）。
3. 子对话收口的同时，父对话计划的「收尾：推送到远端并合并主干」被标完成，父对话自己说「推送已完成，但 PR #217 的检查和合并还没做」，PR 到 16:01 才合并。

## 根因（证据链）

1. 父对话把推送收尾挂上了等子对话和后台命令的等待 ← `settleWait` 在一项的等待全部成功时一律 `setStatus(item, 'done')`，不分是不是收尾步骤。收尾步骤等的只是收尾前要先回来的结果，收尾本身（推送并合主干 / 合回）还没做。
2. 子对话被合回时 `childMerged`（`server/tasks/merge.ts`）清掉 `wrapRequest`、标完成收尾步骤、计划随之收起 ← `mergeOwedOf` 看到没有进行中的计划、`changes` 还有改动，按「没列计划但改过文件」判成欠收尾。

## 修复

- `settleWait`：带 `wrapUp` 的步骤等的结果都成功时退回进行中（清掉面板写的等待说明），推送收尾由 Agent 推送并合并主干后标完成，合回 / 验收仍由面板标。
- `mergeOwedOf`：没有进行中的计划、最后一份计划里面板收尾已完成时不算欠收尾。
- 防线：`shared/plan.test.ts`「推送收尾在等子对话、后台命令」；`server/tasks/before-end.test.ts`「已经合回过」断言。
