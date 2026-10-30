# 没列计划的对话说完打算就停住，要用户说「继续」才接着做

- 状态：已修复（`shared/task-stage.test.ts`「说完打算就收尾」通过）
- 症状：Chat 模式的对话（Claude Code + `deepseek-v4.1-flash`）查了一半，回复「情况基本清楚了……我再确认这些连接的状态和目标 IP……」后这一轮就结束了，没有调用任何工具，停在「等下一句」，用户说「继续啊」才接着做
- 入口：`server/tasks/run.ts` 的 `onTurnEnd` → `server/tasks/children.ts` 的 `nudgePlan` → `nudgeAnnounced`；`shared/task.ts` 的 `announcedOnly`
- 根因类型：模型提前结束回合（CLI 正常报这一轮结束、没有工具调用），面板的兜底只认「计划没做完」，没列计划的对话没人推
- 模块：`server`（`server/tasks/children.ts`、`shared/task.ts`）
- 关键词：Chat 模式、只说不做、提前结束回合、继续、没有计划、催办、deepseek

## 根因

和 [child-ends-turn-with-plan-open](./child-ends-turn-with-plan-open.md) 是同一个模型行为：回复里说了下一步要做什么，这次回应却没有工具调用，CLI 照常报这一轮结束。那次的兜底（`nudgePlan`）只在「计划没做完、也没在等结果」时推，前提是对话列了计划；Chat 模式的对话、只聊几句就动手的项目对话都没有计划，`planStalled` 直接返回 false，面板什么都不做。

## 修复

- 没有计划时改看这一轮的最后一句（`announcedOnly`）：最后一条回复以第一人称要动手的话收尾（「我再…」「我先…」「接下来…」「现在去…」「let me…」），之后没有工具调用，也不是在问用户（带问号）。
- 命中时和计划推进一样等 CLI 停稳（2 秒后进程结束或停在等下一句、没有新消息进来）再核对一次，还是这样就以面板的名义推「你说了「…」，但这一轮没有调用工具就结束了，直接接着做」。
- 每条用户（或父对话）消息只推一次：推过它又只说打算就停，就留给用户，不来回推。只回答了一句、没动手的那一轮照旧不推（`onTurnEnd` 的 `turn.tools > 0`）。

## 防线

- `shared/task-stage.test.ts`：「说完打算就收尾：最后一句是要动手的话、之后没调工具才算，问用户、给结论的不算」。
