---
paths: server/tasks.ts, server/orch-mcp.ts, server/exec/worktree.ts, server/no-push.test.ts, web/src/components/tasks/Worktrees.tsx, shared/plan.ts
---

# 子对话收尾和独立分支

## 对话的独立分支不推远端，标记完成就删

- 规则：子对话的 worktree 里给 CLI 和后台命令都带 `noPushEnv`（`pushInsteadOf` 指向不存在的协议），用户明确要求才由父对话推当前分支；子对话标记完成时删掉它的 worktree 和分支，还有没合回的改动就拒绝，其余条件见下一条。
- 起因：用户要求「对话的 worktree 不能推送到远端」「子对话标记完成就删除对应的 worktree」。
- 防线：`server/no-push.test.ts`、`scripts/e2e.mjs`。

## 合并成功不等于做完了：置完成和删 worktree 必须过同一套「彻底完成」判定

- 规则：`shared/task.ts` 的 `childFlowOf` / `childHolds` 是唯一判定，置 `resolved`、回收独立分支、面板阶段和转圈都读它；任何路径（合并成功、一轮结束、后台命令结束、面板或父对话手动标记完成）都只走 `server/tasks.ts` 的 `advanceChildTo`（第 4 步置完成 → 第 5 步上报父对话 → 第 6 步列表刷新），顺序和幂等由 `shared/task.ts` 的 `advanceChild` 管，不许直接调 `removeWorktree` 或写 `resolved`；条件不满足就保留目录和分支并把 `childHoldText` 的原因显示给用户。用户显式「删除独立分支 / 丢弃」照旧直接删。
- 起因：合并本改动的那次提交（2026-10，子对话 worktree-ed7cb8cc）——用户报「还有后台命令、计划没完成就被标成已完成」，worktree 也跟着被删了；后来用户要求完成状态只能单向流转，父对话不许跳步直接改子对话的最终状态。
- 防线：`shared/child-flow.test.ts`、`shared/task-stage.test.ts`、`server/exec/worktree.test.ts`。

## 等子对话的步骤只由面板标完成；子对话收尾只走 submit_merge

- 规则：计划里挂着等待（子对话、后台命令）的步骤，Agent 自己标完成不算，面板在结果推回时标；父对话开子对话、交消息没写 step 时挂在正在做（或在等）的那一步。独立分支里的子对话不派「版本控制」收尾（`spawn` 直接拒），自己或子任务 `git merge` 过去后计划停在「合回」时也要提醒它 submit_merge。finish_child 每条出口都由 syncParentPlan 刷新父计划。
- 起因：2026-10-24 父对话把子对话的计划抄进自己的计划一口气标完成，界面显示「计划已完成」；子对话的工具搜索没找到 submit_merge，派「版本控制」直接合进 dev，分支已合进去所以面板不提醒，子对话在收尾卡了 13 分钟。
- 防线：`shared/plan.test.ts` 的「还在等子对话的步骤」「刷新计划」；`scripts/real-cli/pi-handoff.mjs`（真实 Pi + 模拟模型，不进 CI）。

## 状态字段是记录不是事实，判据按实际情况算

- 规则：`task.worktree.state` 只记面板自己走过的动作（合并、丢弃），分支被手动删掉或 `submit_build` 合完清掉后它可能还停在 `active`。判「合没合回原分支」在 `worktreeStatus()` 里按 `ahead`/`dirty` 算（分支已经不存在时按 `state` 兜底），`merged`、合并按钮和界面上的数字都从这一个判据出来，不要一处看 `state`、一处看数字。
- 起因：分支已经通过 `submit_build` 合进原分支、分支也删了，`state` 还是 `active`，`ahead`/`dirty` 都是 0 却算出 `merged: false`，界面显示「未合并到「…」：」后面空着，还挂着没用的合并按钮。
- 防线：`server/exec/worktree.test.ts` 的「分支已经删掉时」用例。
