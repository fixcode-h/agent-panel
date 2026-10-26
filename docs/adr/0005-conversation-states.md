# ADR 0005：对话只有 8 个状态，子对话只剩合回时请父对话收尾

状态：已接受 · 2026-10-23

## 背景

用户 2026-10-23 提了一组连在一起的问题，首要目的是「分清楚对话到底应该有几个状态」：

- 子对话和父对话的状态同步、子对话自己的状态、计划的实时刷新都不准；子对话上报给父对话的状态经常和实际对不上。
- 子对话结束时显示「这一轮被中断：做完后收尾…」，应该正常显示对话结束。
- 开了独立分支（worktree）的子对话收尾要交给父对话：子对话没有后台命令在跑、没有在等父对话回答、编译测试通过、计划只剩合回时，请父对话收尾（改计划状态、合回父对话分支、删子对话分支）。
- 父子对话之间的通讯、改状态和改计划的操作都用工具调用的样子显示。
- 子对话能做的测试在子对话里、合并前做完：合并就是验收通过。UE 这种独占资源的编译交给父对话，结果回到子对话（延续 [0004](./0004-ue-build-by-parent.md)）；简单编译子对话自己做。
- 要求参考 Claude Code 父子 Agent 的状态同步和计划刷新方式。

## 事实核对

| 位置（改动前）                                                        | 现状                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `shared/task.ts` `taskStage` / `childIcon` / `childHolds`             | 列表分组、行首图标、「彻底完成」各自判断，说法不一                                                                         |
| `shared/plan.ts` `childTurnSettle`                                    | 子对话一轮结束时收口父计划的另一套判据，只看 requests / working / status / 后台命令 / 计划，漏了提问、工作流、派出的子任务 |
| `server/tasks.ts` `reportToParent` / `settleParentTurn` / `childLeft` | 三条给父对话报状态的路，各自拼文案，会重复报、报早                                                                         |
| `server/tasks.ts` `completeChild`                                     | 彻底完成时 `stopTask(id, 'finish')` 结束等下一句的进程                                                                     |
| `shared/engine.ts` `runConversationTurn`                              | 被停下且没答完就写「这一轮被中断」：上面那次 `finish` 停止也被当成中断                                                     |
| `server/tasks.ts` `submitMerge`（0002）                               | 子对话调用后面板直接合并，父对话事后才知道                                                                                 |

## 决策

### 一、对话只有 8 个状态，判定只在 `convState` 一处

顶层对话和子对话共用一套。`shared/task.ts` 的 `convState(facts)` 是唯一判定，按优先级从上到下：

| 状态         | 说法     | 什么时候                                                                                   |
| ------------ | -------- | ------------------------------------------------------------------------------------------ |
| `needs`      | 等你处理 | 有待回答的提问、待确认的请求（放最前，不然被「执行中」盖住，用户不知道在等他）             |
| `failed`     | 失败     | 这一轮执行出错                                                                             |
| `running`    | 执行中   | CLI 正在处理这一轮                                                                         |
| `waiting`    | 等结果   | 这一轮说完了，在等会自己推回来的结果：后台命令、工作流运行、派出的子任务                   |
| `stopped`    | 已中断   | 用户暂停，或被别的动作打断（重启、换 CLI、父对话结束）；`stopReason === 'finish'` **不算** |
| `wrapup`     | 待收尾   | 子对话只剩合回，已请父对话收尾，在等父对话                                                 |
| `unfinished` | 未完成   | 这一轮正常说完，但计划没做完，或独立分支里还有没合回的改动、也没请收尾                     |
| `done`       | 已完成   | 顶层对话：这一轮答完、没挂着的事；子对话：彻底完成（合回、回收）                           |

派生关系：列表分组 `TaskStage = stageOf(convState)`（needs/failed → 要你看，running/waiting → 在动，wrapup/unfinished → 差一步）；行首图标、子对话栏文字（`convStateText`）、`list_conversations` 的状态、给父对话的上报都从同一个结论来。别处不许再拼「是不是做完了」。

没选的方案：

- **沿用 5 个 `TaskStage`**：「等结果」和「执行中」、「待收尾」和「未完成」混在一起，正好是用户抱怨「上报不准」的来源。
- **更多状态（排队、合并中、编译中……）**：这些是某个状态里的细节，写在上报的 why 里，不升格为状态，免得每加一种后台事就加一个状态。

### 二、彻底完成后结束进程是「对话结束」，不是中断

`shared/engine.ts` 的 `finishedStop(host)`：停止原因是 `finish` 时按答完处理，不写「这一轮被中断」。`convState` 也不把它算 `stopped`。

### 三、子对话上报只有一条路：`childReport` + `reportChild`

- `shared/task.ts` 的 `childReport(task, {background, more, unmerged})` 返回 `state`、父计划那一步怎么收口（`done` → ok，`failed`/`stopped` → fail，其余 hold）、一句话 `why`、要不要发消息 `notify`。
- `server/tasks.ts` 的 `reportChild` 是唯一出口：按 `reportKey`（状态 + why）去重，同一状态不重复报；`running`/`waiting`/`needs` 只更新父计划那一步的说明，不刷消息。
- 上报消息带 `child: {id, title, state}`，界面显示成「子对话状态 · 标题 · 状态」的工具行，点开跳到子对话。
- 独立分支的子对话一轮结束先走 `settleChildWorktree`：能推进就推进（`advanceChildTo`），该催合并就催（`nudgeMerge`），最后上报。

`childTurnSettle` 删掉，`settleParentTurn` / `childLeft` 合并进这条路。

### 四、收尾流程：子对话请求，父对话执行

```
子对话：计划只剩 merge 收尾步骤
  └─ submit_merge(note, tests)
       门槛：tests 必填；没有在跑/排队的后台命令；没有待答的提问和 parentAsks；openWork 为空
       面板：提交 worktree → wrapRequest = requested → 计划收尾步骤标 waiting
             → 叫醒父对话，消息【收尾请求】（panel: 'wrapup'）
父对话：
  ├─ 验收不过 → send_to_conversation 把要补的交回（子对话新一轮会清掉 requested）
  └─ finish_child(id)
       面板在 mergeLock 下合并：
       ├─ 成功 → childMerged：收尾步骤标完成、删 wrapRequest、advanceChildTo(quiet)
       │         （标完成、stop 'finish'、删 worktree 和分支）
       ├─ 失败 → wrapRequest = failed、收尾步骤退回 running，把失败原因交回子对话
       └─ 不论哪条路：syncParentPlan 按 childReport 刷新父计划里等它的那一步（done 才标完成，
                 其余继续等并写清在等什么），落盘推界面，刷新后的计划附在工具结果里
```

- 每次 `finish_child` 结束都强制刷新父对话的计划（用户 2026-10-24 定的硬要求），共用目录的子对话也一样。合进去不等于做完：子对话还没收口时父计划那一步继续等，不能先标完成。

- 合并就是验收：门槛里的测试必须在合并前、在子对话自己的分支里跑通。
- 界面上子对话行的「合并」按钮遇到 `requested` 的请求时同样走 `finishChild`。
- 共用目录（没有独立分支）的子对话没有分支可合，`finish_child` 只做收口。

没选的方案：子对话 `submit_merge` 后面板直接合并（[0002](./0002-child-merge-on-done.md) 的做法）。父对话事后才知道，没机会验收，也没法在合并前退回；用户明确要求收尾交给父对话。

### 五、编译测试分工

| 场景                       | 谁编译                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 普通项目、独立分支的子对话 | 子对话在自己的分支里编译测试，跑通再 `submit_merge`                                                               |
| 普通项目、共用目录的子对话 | 子对话自己跑简单编译                                                                                              |
| UE 项目、共用目录的子对话  | `request_build` 交给父对话；父对话 `request_build(children)` 占位编译，结果以【父对话编译结果】直接推回这些子对话 |
| UE 项目、独立分支的子对话  | 不在 worktree 里编 UE；`submit_merge(build)` 合回后由父对话申请编译                                               |

UE 编译占位和排队仍按 [0004](./0004-ue-build-by-parent.md)。

### 六、父子之间的操作都显示成工具调用

`submit_merge`（请父对话收尾）、`finish_child`（收尾子对话）、`request_build`（申请编译）、`list_peers`、`message_peer` 进 `shared/panel-tools.ts` 和 `web/src/lib/tasks.ts` 的工具视图；面板替对话插的消息（`panel: 'child' | 'wrapup'`）在 `Messages.tsx` 显示成工具行，不再隐藏。

## 参考 Claude Code 学到的

| Claude Code 的做法                                                 | 这里怎么用                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 后台任务只有很少几个终态，结束时发**一条**结构化通知给发起方       | 子对话状态收成 8 个；上报一个出口、按状态去重，只在状态变化时发               |
| TodoWrite 每次整表替换，同一时间只有一个 in_progress，过时了会提醒 | 计划仍走 `set_plan` 整表；`openWork` 排除收尾步骤，收尾步骤由面板改，不靠模型 |
| 队友（teammate）一轮结束进入 idle 是正常的，不是中断               | `finish` 停止不算中断；`waiting` 和 `unfinished` 分开                         |
| Agent 之间靠工具调用通讯（SendMessage 等），界面上看得见           | 收尾请求、收尾、申请编译都是工具，消息带 `child` 元数据显示成工具行           |

## 与现有实现的关系

- 替代 [0002](./0002-child-merge-on-done.md) 里「`submit_merge` 后面板直接合并」：现在是请求，由父对话 `finish_child` 执行。
- [0003](./0003-child-complete-before-recycle.md) 的 `childHolds` 仍是「能不能回收」的判据，`advanceChildTo` 继续用它；状态展示和上报改由 `convState` 判。
- [0004](./0004-ue-build-by-parent.md) 不变，`request_build` 多了 `children` 参数，结果直接回到申请的子对话。

## 运行时

- 状态事实：任务字段（`status`、`working`、`requests`、`parentAsks`、计划、`runs`、`wrapRequest`、`stopReason`）+ 服务端补的后台命令数、是否未合回。
- `Task.wrapRequest`：`requested | merging | failed`，子对话开新一轮时清掉 requested/failed，收尾步骤退回 running。
- 推送：消息和工具行的状态字段都进 `messageStamp`，服务端改了才会推到界面。

## 分期

一次做完。出口：类型检查、lint、单元测试、e2e（`04-subagents` 断言父对话收到 `wrapup` 消息并调用了 `finish_child`）。

## 风险与代价

- 收尾多一跳：子对话要等父对话处理。父对话空闲时 `wakeTask` 会开新一轮，在跑时实时送达，不会卡住。
- 父对话不调用 `finish_child`：子对话停在「待收尾」，列表归到「差一步」，用户看得见；也可以点合并按钮手动收尾。
- 状态判定集中后，改 `convState` 会同时影响列表、图标、上报：靠 `shared/task-stage.test.ts`、`shared/plan.test.ts` 兜住。

## 开放问题

- 父对话长时间不处理收尾请求要不要自动催：倾向不催，状态已经显示「待收尾」；先不实现。
