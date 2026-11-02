# 没列计划的对话说完打算就停住，要用户说「继续」才接着做

- 状态：已修复（e2e `03-chat`「动了手却没列计划就收尾」、`09-subagent-runtime`「子任务没交最后的总结就结束」通过）
- 症状：对话（Claude Code + `deepseek-v4.1-flash`）查了一半，回复「情况基本清楚了……我再确认这些连接的状态和目标 IP……」或「现在删除远端这 12 个已合并分支。」后这一轮就结束了，没有调用任何工具，停在「等下一句」，用户说「继续啊」才接着做；子任务说完「继续读操作原语与快照/选择器。」就交回，结果只有这一句
- 入口：`server/tasks/run.ts` 的 `onTurnEnd` → `server/tasks/children.ts` 的 `nudgePlan` / `nudgeNoPlan`；子任务是 `shared/engine.ts` 的 `runHelper` → `shared/helper-summary.ts` 的 `runWithSummary`
- 根因类型：模型提前结束回合（CLI 正常报这一轮结束，stop_reason 是 end_turn），面板的兜底只认「计划没做完」，没列计划的对话和子任务没人推
- 模块：`server`（`server/tasks/children.ts`、`shared/helper-summary.ts`）
- 关键词：Chat 模式、只说不做、提前结束回合、继续、没有计划、催办、deepseek、Codex、接着读、删除远端分支、子任务、总结

## 根因

和 [child-ends-turn-with-plan-open](./child-ends-turn-with-plan-open.md) 是同一个模型行为：回复里说了下一步要做什么，这次回应却没有工具调用，CLI 照常报这一轮结束（Claude Code 只在模型返回 end_turn 时这样安静地收尾；截断的流、空的工具调用它自己会重试）。那次的兜底（`nudgePlan`）只在「计划没做完、也没在等结果」时推，前提是对话列了计划；没列计划的对话 `planStalled` 直接返回 false，子任务（`runHelper`）完全没有兜底。

## 修复

- 第一版（f3b5320）按最后一句的字眼猜（`announcedOnly`：「我先 / 接下来 / 接着读…」，带「了 / 已 / 完」的算结论）。2026-11-02 复发：「现在删除远端这 12 个已合并分支。」里的「已」被当成结论，没推。用户纠正：不按字眼猜，按计划判定。`announcedOnly` 删掉。
- 对话：一轮结束时有计划就按计划推；没计划但这一轮跑命令、改文件 3 处以上（`PLAN_ACTS`），推一次让它把做过的和还要做的列成计划、按计划做完（`nudgeNoPlan`），同一条用户消息只推一次。推满了还停着写 `unfinished` 警告。
- 子任务：不列计划、没有总结卡，做完交以「## 总结」开头的总结；最后一条回复没有这一行，就在同一个会话里推一次，还没有就交回并留警告。评审子任务按验收结论判定。
- 计划提示词照 Claude Code 待办的口径：三步以上的事才列计划，过程中冒出的新步骤加进计划。
- 一轮结束的 stop_reason 透传进 rpc 会话的 result 事件，以后能直接看出是模型收的尾。

## 防线

- e2e `03-chat`「动了手却没列计划就收尾：面板推一次让它列计划，不来回推」。
- e2e `09-subagent-runtime`「子任务没交最后的总结就结束：面板在同一个会话里推一次，补上总结再交回」。
- `shared/helper-summary.test.ts`：只认总结标题行，「已完成」这类字眼不算。
