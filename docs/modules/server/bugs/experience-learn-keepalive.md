# 对话做完了不学经验：保活的 CLI 一直等不到排学习的那一步

- 状态：已修复（e2e `03-chat` 通过）
- 症状：项目里的对话一轮做完、停在「已完成」，经验学习一直不触发，对话里也没有「学到经验」或失败的提示
- 入口：`server/tasks/run.ts` 的 `onTurnEnd`（顶层对话）、`server/experience-learn.ts` 的 `schedule`
- 根因类型：每轮结束要做的事挂在 run 的收尾处，保活时 run 不返回
- 模块：`server`（`server/tasks/run.ts`）
- 关键词：经验学习、自动学、对话完成、保活、keepAlive、等下一句、onTurnEnd、experience-state

## 现象

用户 2026-11-05 报：对话结束后不会进行学习，这个功能已经有了。

## 根因（证据链）

1. 排学习只有一处：`server/tasks/run.ts` 收尾处的 `sc.learnExperience(task.id)`，要等这一次执行（run）返回才到。
2. Claude Code、Codex、Command Code、Pi 的 CLI 定义都是 `keepAlive: true`：对话页开着时（`hasViewer`），回复完 CLI 停在等下一句（`server/exec/runner.ts` 的 `keepAlive` / `waitNext`），run 一直不返回。用户正看着对话等它做完，恰好就是这种情况；页面没开着时进程会退出，所以以前的测试（没有页面在看）测不出来。
3. 所以一轮做完时学习根本没排上；要等闲置回收把进程收掉 run 才返回，这时对话常常已经被用户追问、停掉或换了状态，`isDone` 不成立就不学。
4. `schedule` 到点的结果（没完成、没过闸门、已覆盖）也没进日志，查不到为什么没学。

## 修复

- 顶层项目对话的 `onTurnEnd` 里排学习（CLI 的 result 和停在等下一句都会走到，只发一次）；收尾处那一份留着接住不保活的 CLI 和工作流，`schedule` 去抖，重复排只重置计时。
- `schedule` 到点把 `learn` 的结果写进运行日志（`经验学习`，带 result）。
- 防线：e2e `03-chat`「保活的对话一轮结束就学经验，不等进程退出」（报告页面在看、等它停在等下一句后断言学过；去掉修复时这一步超时失败）。
