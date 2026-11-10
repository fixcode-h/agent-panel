# ADR 0037：Chat 页的对话一问一答，项目里的对话（Agent 模式）由面板推着做完

状态：已接受 · 2026-10-31 · 部分被 [ADR 0038](./0038-chat-roles.md) 取代（编排工具一行、`Orchestra.plain`、风险最后一条）

> 2026-11-02：推进次数被 [ADR 0041](./0041-conversation-self-drive.md) 修改：子对话和顶层对话一样最多推 3 次；没计划时不再推它列计划，改为收尾自检；默认提示的「可见进度」改成 `shared/turn-rules.ts` 的回合规则（允许直接调用工具）。

> 2026-11-03：推进次数改成设置项 `nudgeMax`（默认 6，范围 0–20，0 表示不自动推），不再写死 3 次；Chat 页一问一答仍只推 1 次。

## 背景

用户 2026-10-31 反馈：「Agent 的对话模式有问题……不会一直处理问题了，走了一步就停止了，再催一下又继续走一步」，截图是对话停在「等待你的下一条消息」；要求「对话模式和 Agent 模式要分开」。用户用 Claude Code 和 Command Code 两种 CLI。

方案经用户确认：Chat 模式回到直接和 Agent 对话（保留后台命令），Agent 模式由面板推着做完，连续推 3 次没有进展才停下并说明卡在哪；Command Code 去掉「每轮回复完就等用户」的提示。

## 事实核对

| 位置 → 现状（改动前）                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/schema.ts` 的 `TaskMode` → 只有 `workflow` / `chat`；Chat 页和项目对话都是 `chat`，唯一的区别是 `projectId` 为空                                                                                                                                                     |
| `server/exec/runner.ts` 的 `chat` 判定 → `!step && sessionKey === task.agentId && task.mode === 'chat'`，Chat 页和项目对话一视同仁                                                                                                                                           |
| `shared/engine.ts` 的 `runConversationTurn` → 两种对话都 `makeOrchestra(host, { chat: true, … })`，Chat 页也挂上 `spawn_agents`、`send_message` 等编排工具和「派完结束这一轮」的说明（`server/orch-mcp.ts` 的 `orchHint`）                                                   |
| `server/tasks/run.ts` 的 `onTurnEnd` → 顶层对话只在这一轮调过工具（`turn.tools > 0`）时调 `nudgePlan`                                                                                                                                                                        |
| `server/tasks/children.ts` 的 `nudgePlan` / `nudgeAnnounced` → 同一进度（`计划 id:已完成几步`）或同一条用户消息只推一次（`planNudged`）；Chat 页没有计划，只剩 `nudgeAnnounced`（最后一句命中「我先 / 接下来…」才推）                                                        |
| `shared/agent-role.ts` 的 `DEFAULT_CHAT_PROGRESS` → 不用角色的对话只追加「完成一组工具后先报告阶段结果再继续」，没有内置通用约束里「说了要做就同一回合做完」的配套规则（`shared/builtin/agents.ts`「回合怎么推进」）                                                         |
| `shared/builtin/agents.ts` 通用约束 → 「用户说『继续』『自主执行』后，常规步骤不再逐个确认」，反过来读成「没说之前要逐个确认」                                                                                                                                               |
| `server/exec/invoke.ts` 的 `WAIT_HINT` → 有 `notes` 且不是 `nativeAsk` 的 CLI（Command Code）每轮都被提示「每轮回复完成后调用 wait_user_message」；保活本来已经由面板在这一轮结束时做（`server/exec/rpc-keepalive.test.ts`「模型没调 wait_user_message，回复完进程也留着」） |

## 决策

**按有没有项目分两种对话：Chat 页（`isPlainChat`：`mode === 'chat'`、没有项目、不是子对话）一问一答；项目里的顶层对话是 Agent 模式，面板推着它把事做完。**

|              | Chat 页的对话                                                                                                                                                                     | Agent 模式（项目里的顶层对话）                                                                                   | 子对话                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 编排工具     | 只留 `run_background` / `check_background` / `stop_background`，说明只讲这三个（已被 ADR 0038 改成按能力给）                                                                      | 不变                                                                                                             | 不变                                 |
| 一轮结束推进 | 只在这一轮调过工具、最后一句是「我先…」才推，每条用户消息一次（和原来一样，防 [chat-ends-turn-after-announcing](../modules/server/bugs/chat-ends-turn-after-announcing.md) 复发） | 调过工具，或没调工具但最后一句是要动手的话，都看；同一进度（或同一条用户消息）最多推 3 次，第 3 次要求说明卡在哪 | 不变：同一进度一次，推不动上报父对话 |

所有对话都适用的两处提示词：

- 不用角色的对话追加的 `DEFAULT_CHAT_PROGRESS` 补「回合怎么推进」：说了要做就这一回合做完，报告阶段结果后接着做，只在做完、需要用户拿主意、确实卡住时结束回合。
- 内置通用约束改成「常规步骤不用逐个确认，直接做下去；只在不可逆操作……时停下」。

Command Code 不再提示「每轮回复完成后调用 wait_user_message」；工具照样挂着（打开对话页的预热要用），说明改成「只在做完或需要用户拿主意时调用，还有没做完的步骤就直接接着做」。

候选方案：

- **新加一个 `TaskMode`（`plain`）**：没选。要迁移已有数据、改前后端所有按 `mode` 判断的地方，而「有没有项目」已经能准确区分，`isPlainChat` 一处判定即可。
- **Agent 模式不设上限、一直推到计划做完**：没选。模型原地打转时会无限推、烧 token；3 次没进展说明推不动了，交给用户。
- **Chat 页完全不推**：没选。会让 2026-10 修过的「说完打算就停」复发。

## 操作清单 / 契约

| 改动                                                                                                                                                                                                    | 位置                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `isPlainChat(task)`                                                                                                                                                                                     | `shared/conv-mode.ts`                                             |
| `Orchestra.plain`（ADR 0038 删掉，改成 `canSpawn` / `team`）；`orchTools` 只留后台命令三件，`orchHint` 只讲后台命令（没有时返回空，runner 不拼空行）                                                    | `shared/engine.ts`、`server/orch-mcp.ts`、`server/exec/runner.ts` |
| `AGENT_NUDGE_MAX = 3` / `nudgeMax` / `nextNudge`（推进计数的纯逻辑）；`takeNudge` / `lastNudge` 取代 `planNudged` 的「同一 key 只推一次」判断（`planNudged` 仍记最后一个 key，给 `stuckAfterNudge` 用） | `shared/conv-mode.ts`、`server/tasks/children.ts`                 |
| `onTurnEnd`：Agent 模式没调工具但 `announcedOnly` 命中也推                                                                                                                                              | `server/tasks/run.ts`                                             |
| `DEFAULT_CHAT_PROGRESS` 补「回合怎么推进」                                                                                                                                                              | `shared/agent-role.ts`                                            |
| 通用约束的「逐个确认」措辞                                                                                                                                                                              | `shared/builtin/agents.ts`                                        |
| 去掉 `WAIT_HINT`，改 `wait_user_message` 的说明                                                                                                                                                         | `server/exec/invoke.ts`、`server/ask-mcp.ts`                      |

## 与现有实现的关系

修改 [ADR 0032](./0032-conversations-keep-going.md) 第一节的两条：「同一进度只推一次」（Agent 模式改为最多 3 次）和「顶层对话只在这一轮调用过工具时推」（Agent 模式没调工具但说了要动手也推）。0032 的其余决策（父子只发必要消息、继续时连带恢复）不变。判定仍只看计划状态和 `announcedOnly`，不新增按回复文字猜「没做完」的规则。

## 运行时

推进计数存在内存（`createChildren` 里的 `nudgeCount`，规则在 `shared/conv-mode.ts` 的 `nextNudge`），面板重启后从 1 重新数（2026-11-10 更新：计数现在由 `shared/drive.ts` 的 `DriveBudget` 记，存进 `Task.driveCount`，重启后接着数；每轮改动的起点也存进 `Task.turnTrack`，见 `server/turn-changes.ts`）；计数按对话 id 记最后一个 key，进度变了（计划多完成一步、用户发了新消息）就重新计。推进前照旧等 `PLAN_NUDGE_MS` 让 CLI 停稳，再核对一次还停着才发；推送失败只写日志。

## 分期

一次做完。

## 风险与代价

- Agent 模式最多多推 2 次，每次是一轮模型调用的 token；用量上限（`checkBudget`）照旧先判，到了上限不推。
- 模型真做完了却以「接下来……」这类话收尾时，Agent 模式会被多推一次；它回一句「已经做完」就不再命中 `announcedOnly`。
- Chat 页的对话拿不到 `spawn_agents`：要并行拆活的需求请到项目里开对话。（ADR 0038：Chat 模式按设计不派子任务）

## 开放问题

- Agent 模式连续推满 3 次后要不要在界面上给一条明显的提示（目前靠模型在第 3 次提醒后自己说明卡在哪）。倾向：先看用户反馈，需要再加；定下来之前不加界面元素。

## 补充（2026-11-02）：去掉按字眼判断，改为按计划 / 总结判断

- `announcedOnly`（按「我先 / 接下来 / 接着读…」猜还要做）删掉：它把「已合并」里的「已」当成结论，漏推了说完「现在删除远端分支」就停的对话。上面表格里 `nudgeAnnounced`、`announcedOnly` 的几行作废。
- 顶层对话（Agent 模式）一轮结束：有计划照旧按计划推（`nudgePlan`）；没计划但这一轮跑命令、改文件 `PLAN_ACTS`（3）处以上，推一次让它把这件事列成计划（`server/tasks/children.ts` 的 `nudgeNoPlan`），之后按计划推进接管。同一条用户消息只推一次。Chat 页没有面板计划，不推。
- 推满了还没做完：写一行 `unfinished` 警告（「没做完就停下了」），不让它看起来像做完了。
- 子任务不列计划、没有总结卡：按最后一条回复里的「## 总结」标题行判定做完（`shared/helper-summary.ts`），没有就在同一个会话里推一次，还没有就交回并留一行警告。评审子任务按验收结论判定，不看总结。
- 计划提示词照 Claude Code 待办的口径简化：三步以上的事才列计划，过程中冒出的新步骤加进计划。
