# 终止子任务后计划那一步一直「等待中」，子对话停下、交给父对话的汇报被吞

- 状态：已修复（`server/engine-steps.test.ts`「有中断没做完的子任务」、`shared/tasks/idle-ask.test.ts`「子对话计划没做完时先不报父对话」通过）
- 症状：子对话改完一处、用 message_parent 请父对话编译后结束这一轮，计划才做到一半就停住；父对话一直没收到这封汇报、也不编译，两边互等到用户第二天去父对话里问「编译还是报错」（同一个子对话连着出现两次）
- 入口：`shared/engine.ts` 的 `stopHelpers`、`helperBatch`；`server/tasks/children.ts` 的 `reportChild`；`shared/task.ts` 的 `planStalled`、`childSelfDrives`
- 根因类型：终止被打断的子任务时没收口计划里等它的等待项；「计划没做完不报父对话」只看计划没做完，没看面板是不是真的会推它
- 模块：`server`（`server/tasks/children.ts`）、`shared`（`shared/engine.ts`、`shared/task.ts`）
- 关键词：子对话停止、计划没做完、等待中、stop_subtask、被打断的子任务、message_parent、阶段汇报、pendingReport、父子互等、nudgePlan

## 现象

用户导出的子对话「修 Lua.Build.cs 的 UE5.8 编译报错」（2026-11-11 / 11-12，Claude Code + `deepseek-v4.1-flash`）：

1. 15:42 子对话用 stop_subtask 终止了一个被打断、没重新开始的评审子任务 `@chat/sub/h2`，子任务记成已终止，但计划第 7 步「补评 Target.cs 构建设置改动」仍挂着等它（`waits[].state = waiting`）。
2. 15:43 子对话 message_parent（不带 question）写「第五处改完，请你做最终整包编译」，第 13 步标进行中，这一轮结束。
3. 父对话一直没收到这封汇报；第二天 00:39 用户去父对话说「编译还是报错」，父对话才编译、把第六层报错交给子对话。
4. 00:40 子对话改完第六层，同样 message_parent 后结束这一轮，又停住；导出时 `pendingReport` 里两封汇报都还在。

## 根因（证据链）

1. 父对话收不到汇报 ← `reportChild` 对「未完成、还有没做完的步骤、面板没推满」一律 return（ADR 0041：交给子对话自驱），阶段汇报（`pendingReport`）只在上报时并进去，跟着一起没发。
2. 面板也没推子对话 ← `nudgePlan` 的 `planStalled` 看到第 7 步还挂着等待项，当成「在等别人」不推（日志原因 `step-waiting`）。
3. 等待项一直不收口 ← `stopHelpers` 终止被打断的子任务走 `dropInterrupted`，只把子任务记成跳过，没调 `settleHelperWaits`；这个子任务不在本进程跑，`helperBatch` 也不会再交回它的结果，没有别的地方收口。

## 修复

- `stopHelpers`：终止了子任务就 `settleHelperWaits`，等它的那一步退回进行中（写明等的结果没成功），由对话决定重做还是标跳过。
- `helperBatch`：没有结果要交回时也顺手 `settleHelperWaits`，收掉等着已结束子任务的等待项（一轮结束都会走这里）。
- `reportChild`：计划没做完时只有 `childSelfDrives`（面板会推它，或在等父对话安排修复）才不报；挂着等待却没东西在跑时照常报父对话，汇报随之交出去。
