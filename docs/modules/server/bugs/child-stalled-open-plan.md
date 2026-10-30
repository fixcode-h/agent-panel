# 子对话说完一句就停住，计划没做完也没人推

- 状态：已修复（`shared/task-idle-ask.test.ts`、e2e `04-subagents` 通过）
- 症状：子对话只回了一句「先跑类型检查和 fold 单测。」就结束这一轮，计划停在 1/8；父对话的计划一直「还在等它」，子对话一直停在等下一句，没有任何提醒
- 入口：`server/tasks.ts` 的 `askIdleChildren`；`shared/task.ts` 的 `childIdleAsk`、`planStalled`
- 根因类型：自动询问只管还在执行（`working`）的子对话，这一轮已经说完、计划没做完的被当成「没在执行」跳过
- 模块：`server`（`server/tasks.ts`、`shared/task.ts`）
- 关键词：子对话、停住、卡住、计划没做完、等下一句、自动询问、状态询问、父对话等它

## 现象

父对话派出「对话间消息不折进过程折叠」后，子对话（Claude Code + 第三方网关模型）改完三处代码，回了一句「先跑类型检查和 fold 单测。」就结束了这一轮，没有调用工具。面板把「未完成：计划还没做完」报给父对话，父对话当时在处理用户的新问题，没有去推它。之后子对话一直停着。

## 根因

1. 这一轮结束、进程停在保活等下一句：`working` 是 false。
2. 「子对话没有输出时自动询问」（`childIdleAsk`）第一条就是 `!working → not-running`，所以从来不问这种子对话。
3. 父对话那边只收到一条状态回报，是否去推由父对话的模型自己决定，漏掉就没有兜底。

## 修复

- 新增 `planStalled`：没在执行、没收口、计划没做完、计划里没有在等结果的步骤、也没请父对话收尾时，算「停住了」。
- `childIdleAsk` 对这种子对话同样按设置的分钟数自动询问，询问内容写明计划进度，要它直接调用工具接着做；这种情况下次数不因它回了一句而清零，问满上限（3 次）就停，不会无限循环。

## 防线

- `shared/task-idle-ask.test.ts`：「这一轮说完了、计划没做完也没在等别的……」。

## 后续（2026-10-30）

「停在等下一句」的那种改由一轮结束时的推进（`nudgePlan`）马上处理，自动询问不再管它，免得重复推；见 [child-ends-turn-with-plan-open](./child-ends-turn-with-plan-open.md) 和 [ADR 0032](../../../adr/0032-conversations-keep-going.md)。
