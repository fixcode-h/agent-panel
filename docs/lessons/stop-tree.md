---
paths: server/tasks/keepalive.ts, server/tasks/actions-routes.ts, server/tasks/conversation-routes.ts, server/exec/parsers.ts, shared/task.ts, shared/engine.ts, shared/run-stops.ts, web/src/components/tasks/**
---

# 对话停止、续接和「在跑」的显示

## 等不到执行收尾就收口并让出执行位，不能只写「不再等它」

- 规则：限时等一份执行收完（`endLive`、停止后）等不到时，走 `server/tasks/keepalive.ts` 的 `abandonLive`：杀进程、按停止（收尾的按完成）落盘、`release` 执行位、`abandon()` 让 `done` 结束；之后引擎收完也不写盘（`Live.orphaned`）。执行位留着不放，`runningConv` 就一直把消息交给这份没有进程的执行，排着的消息永远等不到「这一轮结束」。「停下没有」按进程判断：用户停止后名下 CLI 进程没了就是停下了（`watchStop`），不等引擎走完收尾。
- 起因：用户 2026-11-02 报「子对话完成后父对话再交代任务，子对话一直等待模型；停止再继续也不知道那条任务」——4fd28a6 给 `endLive` 加了限时，但超时后只是「不再等它」，执行位没让出来。
- 防线：`server/tasks/keepalive-endlive.test.ts` 的「强制停止后执行仍收不完」「用户停止后进程已经没了」。

## 连带停的一律记成 parent；没有进程在做的不转圈；CLI 自己的重试要显示出来

- 规则：停一棵对话树自上而下：先停发起的对话，再一层层往下，每层停对话本身，它的子任务和工作流跟着中断信号停、记成「被打断」（不用它们各自的终止开关，那会记成「已终止」、继续时接不上）；上面先停，它就不会处理下面停下的消息、也不会重派。随父对话停的子对话不再往父对话发「子对话停止」。子树里在执行或在等子任务的对话都走 `stopTask(kid, 'parent')`，不能只 `cancelWait`：只取消等待既不中断子任务，也不记停止原因，收口时会被当成用户停的，父对话继续时 `resumeKids` 不会拉起它。只有停在等下一句（`awaitingUser`）的只取消等待。收口的兜底原因写 `parent`，不写 `user`。等子对话停稳统一用 `settleBefore`，不各写一个更短的超时。
- 规则：`childIcon` 的转圈只给会自己往前走的状态；`unfinished`（计划没做完、分支没合回）只在 `cliAlive` 时转圈。需要「按状态」判断的地方（重启迁移 `restartInterrupted`）直接读 `childState`，不借图标。
- 规则：CLI 自己重试模型请求时一定要映射成 `notice`（kind `retry`）+ `retry_ok`，Claude Code 是 stream-json 的 `{"type":"system","subtype":"api_retry"}`；没映射的话界面只显示「等待模型」，插话也要等重试完。
- 起因：用户 2026-11-02 报「父对话总在等待模型、子对话的消息不处理」「子对话进程回收了还在父对话里转圈」「停了父对话子对话不停 / 再启动子对话起不来」；后两条里有 PR #152 的 `stopTree` 只取消等待、兜底原因写成 `user` 的问题。
- 规则：界面上「在跑」只给真的有人在推进的：对话停下后计划按暂停画（`PlanPanel` 的 `planPaused`），排着的子任务只在对话执行时进运行区（`helperShown`），图标不转圈；用户亲手停的对话不因为「名下还有东西在跑」藏「继续执行」。
- 规则：只写在提示词里的「不要重派」靠不住：被打断的子任务由 `spawn_agents` 强制，要么 `resume` 它，要么 `stop_subtask` 终止后再派。
- 防线：`server/tasks/keepalive-endlive.test.ts` 的「停父对话：在等子任务的子对话按随父对话停收口」；`shared/task-stage.test.ts` 的「运行区的子任务」；`server/engine-steps.test.ts` 的「有中断没做完的子任务时不能另派新的」；`web/src/components/tasks/child-line.test.ts` 的「独立分支还没合回」；`server/exec/parsers.test.ts` 的「Claude Code：网关出错时自己重试」。流程总表见 `docs/modules/server/README.md` 的「对话进程的生命周期」。

## 停下就是暂停：子任务只用 pauseUnit / cancelUnit 收，暂停的子对话不结算父计划的等待

- 规则：子任务、工作流节点停下只走 `shared/run-stops.ts` 的 `pauseUnit`（会接着做）或 `cancelUnit`（明确不做了），不在别处手写 `status` / `interrupted` / `apiWait`。子对话停下时父计划等它的那一步只有 `stopEnds`（归档、删除、被接手、`lost`）才收成失败；拉起子对话后用 `rearmKidWait` 恢复等待。继续执行时被打断的子任务由引擎 `resumePausedHelpers` 在原记录续跑。
- 起因：用户 2026-11-03 要求「停了再启动不新开，子对话、父对话复用」，梳理出随父对话停下的子对话被收成失败、拉起后做完叫不醒父对话（ADR 0042）。
- 防线：`shared/pause-unit.test.ts`、`shared/resume-kids.test.ts`；`scripts/e2e/09-subagent-runtime.mjs` 的「停下就是暂停」「被打断的子任务由面板接着跑」。
