# 子对话请求收尾后父对话不合回，父子一直互相等

- 状态：已修复（`shared/task-idle-ask.test.ts` 的 `wrapUpPending`、`shared/lifecycle.test.ts` 的 `wrapup-unhandled`、e2e `04-subagents`「父对话收到收尾请求却没合回」通过；改前在旧代码上确认 e2e 超时失败）
- 症状：子对话 `submit_merge` 后显示「待收尾」，父对话收到【收尾请求】、回了一句「改动核对通过……现在合回」就结束这一轮，没调 `finish_child`；之后父对话一直停着，状态诊断报 `child-idle-parent-waiting`
- 入口：`server/tasks/run.ts` 的顶层 `onTurnEnd` → `server/tasks/drive.ts` 的 `nudgePlan`；`shared/task.ts` 的 `planStalled`；`server/tasks/children.ts` 的 `reportChild`
- 根因类型：模型提前结束回合（只说不做），面板把「等子对话收尾」当成在等别人，父对话这一侧没有兜底
- 模块：`server`（`server/tasks/drive.ts`、`server/tasks/merge.ts`、`server/tasks/run.ts`）、`shared`（`shared/task.ts`、`shared/lifecycle.ts`）
- 关键词：请求收尾、待收尾、finish_child、父对话不动、互相等、现在合回、只说不做、child-idle-parent-waiting、wrapup-unhandled、nudgeWrapUp

## 现象

用户 2026-11-03 报：子对话「面板提醒次数做成设置项（默认 6）」请求收尾，父对话那一轮跑了 4 条命令、回复「改动核对通过……现在合回。」就结束了。子对话行一直是「计划 10/11 · 待收尾 · Agent 进程已回收」，父对话不再动；状态诊断：「计划还在等子对话……它们已经不在跑了，父对话却没被叫醒」。

## 根因

1. 收尾请求送到了（父对话回了话），问题出在这一轮之后：模型说了「现在合回」却没调用 `finish_child`，CLI 照常报这一轮结束。
2. 子对话「待收尾」时 `reportChild` 只把父计划里等它的那一步继续挂成「等待中」。父对话一轮结束时 `nudgePlan` → `planStalled` 看到有等待中的步骤，判成「在等别人」（日志 `reason: step-waiting`），不推。
3. 子对话这边 `planStalled` 看到请过收尾也不推。两边都在等，等的其实是父对话自己要做的事；`nudgeMerge` 只管子对话那一侧（`child-stuck-before-merge`），父对话这一侧没有对应的兜底。
4. 状态诊断已经认出了这个情况，但只负责显示，不接恢复动作。

## 修复

- `shared/task.ts` 新增 `wrapUpPending`：请过收尾（`wrapRequest.state === 'requested'`）、还没完成的子对话，算父对话自己的事。
- `server/tasks/drive.ts` 新增 `nudgeWrapUp`：项目顶层对话一轮结束、停稳后，名下有这样的子对话（不在合并中、没有排着交回它的消息）就推一条，写明对每个子对话调用 `finish_child`（带 id）或 `send_to_conversation` 交回。次数和计划推进共用设置的 `nudgeMax`；推满了写一行警告，告诉用户发消息或进子对话点「合并」。`run.ts` 顶层 `onTurnEnd` 先跑它，再跑 `nudgePlan`。
- `server/tasks/merge.ts`：收尾请求没能马上交给父对话（退回收件箱）时，过 60 秒复查一次，父对话还空着就按上面推。
- `shared/lifecycle.ts`：在等的子对话已请求收尾时不再报 `child-idle-parent-waiting`，改报 `wrapup-unhandled`（等了几分钟、面板提醒了几次）。

## 防线

- `shared/task-idle-ask.test.ts`：`wrapUpPending` 只认 requested 且没完成的。
- `shared/lifecycle.test.ts`：待收尾时报 `wrapup-unhandled`、父对话在跑时不报。
- e2e `04-subagents`「父对话收到收尾请求却没合回：面板推它一次，它再合回」：假 CLI 第一次收到收尾请求时不调 `finish_child`（`<FAKE_CLI_LOG>.skip-wrap`），断言面板只推了一次、父对话随后合回、子对话完成。
