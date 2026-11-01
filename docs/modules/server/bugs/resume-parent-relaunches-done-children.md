# 停父对话再继续：已交付的子对话返工，用户停掉的子对话被拉起

- 状态：已修复（`shared/resume-kids.test.ts`、`server/tasks/keepalive-endlive.test.ts`、`shared/plan.test.ts`「用户亲手停的不是失败」、e2e `09-subagent-runtime`「父对话被停下后继续……」通过）
- 症状：先单独停掉一个子对话再停父对话，停止原因都变成「父对话」；继续父对话后已交付的子对话把做完的事又做一遍，用户停掉的子对话也被拉起；父对话把「用户停掉了它」当成失败去交回重试
- 入口：`server/tasks/keepalive.ts` 的 `stopTask`；`server/tasks/children.ts` 的 `closeChildren`、`reportChild`；`server/tasks/conversation-routes.ts` 的 `resumeKids`、`resumePrompt`；`shared/resume-kids.ts`；`shared/task.ts` 的 `childReport`
- 根因类型：连带停止覆盖了已有的停止原因；继续时只按停止原因筛，不看父对话是否已收下结果；用户停止按失败上报
- 模块：`server`（`server/tasks/keepalive.ts`、`server/tasks/children.ts`、`server/tasks/conversation-routes.ts`、`shared/resume-kids.ts`、`shared/task.ts`）
- 关键词：停止父对话、继续执行、停止原因、父对话结束时一起结束、用户暂停、返工、重派、待收尾、已交付

## 现象

真实 API 实测报告问题 3：A 子对话已交付（父对话已验收），先单独停掉 B（停止原因「用户」），再停父对话，A、B、C 的停止原因都被改成「父对话」；继续父对话后三个都被拉起，A 从头再做，B 被拉起，用户单独停它的意思没了。父对话还把 B 当成失败处理（「B 已中断、需要交回重试」）。

## 根因

1. `stopTask` 每次都改写 `entry.stopReason`：B 的停止还没收完时父对话停下，`closeChildren` 再补一次 `parent`，用户的停止原因被覆盖，`resumeKids` 就把它当成被连带打断的拉起来。
2. `resumeKids` 只按停止原因筛：已交付后又被连带打断（例如正在回父对话一句话）的子对话，父对话计划里早就收下了结果，仍被拉起来按原来的要求再做一遍；请过收尾、在等父对话合并的也会被拉。
3. `childReport` 把用户停止和失败一样处理：父计划那一步退回「需要修复」，上报里写「要重试就交回」，父对话自然去重派。

## 修复

- `stopTask`：连带停（`parent`、`budget`）不改已经在停的对话的停止原因。
- `shared/resume-kids.ts` 的 `sortStoppedKids`：继续时停着的子对话分三类——被连带打断、活没交的拉起；用户单独停掉的不拉，写进续接说明，让父对话问用户要不要一起继续；待收尾（`requested` / `merging` / `testing`）和父计划里等它的都已收成成功的不拉，续接说明里写明不要让它们重做。
- `childReport`：用户停的子对话说法写「用户停掉了它，等用户决定要不要继续」，父计划那一步继续等（`hold`），不退回「需要修复」；`reportChild` 的下一步写明不要自动交回、重派或另建子对话。

## 防线

- `shared/resume-kids.test.ts`：分类和续接说明。
- `server/tasks/keepalive-endlive.test.ts`：「用户已经停下的子对话再被父对话连带停……」。
- `shared/plan.test.ts`：用户亲手停的子对话 `settle` 是 `hold`。
- `scripts/e2e/09-subagent-runtime.mjs`：「父对话被停下后继续……」里加了已交付的子对话和用户单独停掉的子对话：停父对话后原因不变，继续时不被拉起，父对话的续接说明列出用户停掉的那个。
