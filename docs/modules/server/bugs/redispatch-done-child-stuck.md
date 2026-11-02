# 已完成的子对话被父对话再交代任务，一直停在「等待模型」

- 状态：已修复（`server/tasks/keepalive-endlive.test.ts` 通过；没能用真实 CLI 复现，见下面「复现」）
- 症状：子对话收尾成功、已完成，父对话觉得不合适又把修改交给它；子对话里能看到父对话发来的任务，但一直显示「等待模型」不开始。用户停止后点继续，子对话开始输出，却完全不知道父对话刚交代的任务
- 入口：`server/tasks/children.ts` 的 `completeChild`、`server/tasks/keepalive.ts` 的 `endLive`、`server/tasks/child-messages.ts` 的 `sendToChild`、`server/tasks/asks.ts` 的 `wakeConv`、`server/tasks/run.ts` 的 `followUp` / `deliver`
- 根因类型：收尾停不下来的那份执行一直占着执行位，后来的消息被交进一份已经没有进程在跑的执行
- 模块：`server`（`server/tasks/keepalive.ts`、`server/tasks/run.ts`、`server/tasks.ts`）
- 关键词：子对话完成后再交代、send_to_conversation、等待模型、不启动、继续后不知道新任务、endLive、执行位、不再等它、abandonLive、orphaned

## 根因

`completeChild` 先 `endLive(..., 'finish')` 结束子对话的 CLI。`endLive` 取消等下一句、限时后强制停，再等一段还没收完时只写一条「不再等它」就返回：执行位（`live` 里那一份）原样留着，`status` 还是 `running`。

之后父对话 `send_to_conversation` → `sendToChild` 用 `runningConv` 找到的正是这份留下来的执行：

- `status === 'running'` → `deliver`：没有等下一句的 CLI 可交，消息记进这份执行、排到「这一轮结束后」——可这一轮永远不会结束，界面就一直是执行中、「等待模型」；
- 不是 `running` 时走 `wakeConv`：消息排进去后 `await entry.done`，同样永远等不到。

用户停止时这份执行的消息只在内存里（落盘的还是收尾时那一份），「继续执行」按盘上的最后一条要求续接，所以新的一轮不知道父对话刚交代的任务。

## 修复

- 执行位可以被面板「放弃」（`keepalive.ts` 的 `abandonLive`）：杀掉它名下的 CLI 进程，收尾停的按正常结束落盘、别的按 `settleStopped` 落成已停止，让出执行位，`done` 跟着结束（`reserve` 时备好的 `abandoned`，`run.ts` 把它和执行合成 `done`），等它的 `wakeConv` / `closeChildren` 不再挂着。之后引擎就算收完也不写盘（`Live.orphaned`），不会盖掉新的一轮。
- `endLive` 强制停止后还收不完时调用 `abandonLive`，不再只是「不再等它」。收尾时排着的消息由新的一轮接着处理。
- 用户停止（以及随父对话停、归档、删除）后盯着进程（`watchStop`）：名下 CLI 进程没了就算停下了，连着几秒看不到就直接收口；进程迟迟不退就直接杀。

## 复现

用户要求用真实 Claude Code 跑；这次的云端环境网络策略拦了 `amr-link.open-design.ai`，没能跑通，改由单测覆盖「强制停止后仍收不完 → 让出执行位、done 结束、按完成落盘」。
