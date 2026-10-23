# ADR 0003：合并不等于完成，彻底完成才回收独立分支

状态：已接受 · 2026-10-23

## 背景

用户 2026-10 报了两个连在一起的现象：

- 子对话 `37619a90` 在 03:56 就被标成「已完成」（面板不再转圈），可它这一轮其实还在跑：后台命令没结束、计划没走完；随后它的独立分支（worktree）被删掉。截图里分支状态行写的是「已在「dev」里」。
- 另一个子对话计划还写着「计划 5/7」，也已经被发起合并。

还有一件同源的事：`start_plan` 启动的工作流，工具调用一返回就被当成这一轮结束（行上显示 `0.00s`），工作流运行其实还在后面跑，对话没被算成「执行中」。

根因是 ADR 0002 定的「合进去就把子对话标记完成」：`server/tasks.ts` 的 `childMerged` 合并成功后直接 `tk.resolved = true`，而 `shared/task.ts` 的 `taskStage` 里 `resolved` 排在 `working` 之前、见到就返回 `done`。于是合并那一刻「已完成」和「还在跑」同时成立，回收独立分支的路径也照着 `resolved` 直接删目录。

要定的是：完成判定、独立分支回收、面板阶段显示共用哪一套口径，以及哪些触发点允许回收。

## 事实核对

| 位置                                                        | 现状                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `shared/task.ts` `childHolds` / `childComplete`             | 一次列全 8 个条件码：working / background / workflow / helpers / plan / asking / requests / unmerged，空数组才算彻底完成  |
| `shared/task.ts` `childHoldsOf`                             | 把任务状态换成 `childHolds` 的入参；后台命令数、合并状态这两样服务端才知道，由调用方补                                    |
| `shared/task.ts` `runRunning`                               | 工作流运行还没跑完：以 `task.runs` 最后一条为准（`status === 'running' && !endedAt`），老任务没有运行记录时退回看 `steps` |
| `shared/task.ts` `taskStage` / `childStage`                 | 阶段口径：`requests`/`asking` → 需要你处理，`working`/`background`/`workflow`/`helpers` → 执行中，`resolved` 排在这些之后 |
| `shared/task.ts` `childRunning` / `taskBusy`                | 转圈和「运行中」汇总的口径，都已按上一条带上后台命令、工作流运行和派出的子任务                                            |
| `server/tasks.ts` `releaseChild`                            | 唯一的回收点：`worktreeStatus` 说没合就拒绝；`childHoldsOf` 非空就原样保留并返回原因                                      |
| `server/tasks.ts` `childMerged`                             | 合并成功只写一条面板消息（分支状态），不再置 `resolved`、不再删目录                                                       |
| `server/tasks.ts` `settleChildTurn` / `settleChildWorktree` | 一轮结束收口；后台命令结束的回调、PATCH 手动标记完成也都收敛到 `releaseChild`                                             |
| `server/exec/worktree.ts` `releaseWorktree`                 | 删之前再核一次 `worktreeStatus().merged`：删了找不回来，不能只靠调用方记得传对                                            |
| `POST /:id/worktree/discard`、`DELETE /:id`                 | 用户显式「删除独立分支 / 丢弃」和删任务仍直接 `removeWorktree(..., true)`，这些是用户主动要求删，不设门禁                 |

## 决策

**合并只更新分支状态（「已在「dev」里」）；「彻底完成」由一个函数判定，它说满足才置完成、才回收独立分支。**

一套判定：`shared/task.ts` 的 `childHolds`（入参组装见 `childHoldsOf`，给人看的原因见 `childHoldText`）。服务端置状态、删独立分支、面板阶段和转圈都读它，不在别处另写一份。

回收的门禁（全部满足才删）：

1. 这一轮没在跑（`working` 为 false；CLI 进程活着等下一句也算结束）；
2. 后台命令都结束了（`queued` / `running` 一个都没有）；
3. 工作流运行跑完了（`runRunning` 为 false）；
4. 派出去的子任务都交回结果了；
5. 计划做完（`shared/plan.ts` 的 `openPlan` 为空）；
6. 没有待用户回答的提问、没有待确认的请求；
7. 已经合回父对话分支——按 git 现查（`worktreeStatus`），不信任务上记的 `worktree.state`。

触发点都走 `releaseChild`：合并成功、一轮结束（`settleChildTurn` → `settleChildWorktree`）、后台命令结束回调、手动 PATCH `resolved`。条件不满足就保留目录和分支，并把原因显示在分支状态行（「已在「dev」里，独立分支先留着：后台命令还没跑完」），不静默保留也不静默删除。全部满足时先结束等下一句的 CLI、停掉后台命令，再删目录和分支，最后才 `resolved = true`。

用户显式操作（删除独立分支、丢弃改动、删除任务、删除项目）保持原样：用户点了就删。

候选方案与没选的理由：

- **合并即完成（0002 的现状）**：合并只说明代码进去了，工作区里还在跑的命令、还没做完的计划都不在合并里，删早了会毁掉正在写的工作区，也被用户当场报了出来。
- **界面单独算一遍「是否完成」**：`taskStage` 里 `resolved` 排队顺序的问题就是这么来的——两处口径早晚要漂移。
- **只在回收时判定，界面照旧看 `resolved`**：面板会继续出现「已完成」和「还在跑」同时成立，用户看到的现象不变。

## 操作清单 / 契约

| 入口                          | 行为                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| 合并成功（`childMerged`）     | 写分支状态和面板消息；还在一轮里就等这一轮结束，已经停下的马上试一次 `releaseChild` |
| 一轮结束（`settleChildTurn`） | 走 `releaseChild`；只差「没合回去」时催一次 `submit_merge`                          |
| 后台命令结束                  | 结果推回子对话；推不回去（已停下、已合并好）时再试一次回收                          |
| 手动 PATCH `resolved: true`   | 走 `closeChild` → `releaseChild`，还差条件时 409 并带上原因                         |
| 分支状态行                    | 带上 `childHoldsOf` 的结果，界面用 `childHoldText` 拼成一句话                       |

## 与现有实现的关系

- 取代 ADR 0002「决策」中的这一条：_合进去就把子对话标记完成，这一轮结束后回收独立分支和 CLI 进程_。合并由面板做、编译测试留在子对话分支、冲突撤回并推回、`tests` 必填、一轮做完没合就催一次，这些结论仍然有效。
- 改动落在 `shared/task.ts`（判定）、`server/tasks.ts`（`releaseChild` 与各触发点）、`server/exec/worktree.ts`（`releaseWorktree`）、`web/src/components/tasks/Worktrees.tsx`（分支状态行的原因），文案同一个提交写进 `shared/locales/en/tasks.ts`。
- ADR 0002 的状态行改为被本条取代，正文保留。

## 运行时

- 数据来源：任务状态（`working`、`requests`、`parentAsks`、`plans`、`steps`、`runs`）从 `Task` 上取；后台命令数来自 `background.list(id)` 里 `queued` / `running` 的条数；合并状态来自 `worktreeStatus(project.path, tk.worktree)`；工作流运行状态来自 `task.runs` 最后一条，由 `shared/engine.ts` 在运行开始和结束时写入。
- 失败怎么表现：git 读不出状态时按「没合回去」处理（不删、报原因）；`releaseWorktree` 抛错只记一条 warn 并保留，不会因为删失败把任务标成完成。

## 分期

一次做完。

## 风险与代价

- 条件长期不满足时 worktree 会一直留着，要用户手动删。这是认下的代价：用户明确要求宁可晚删也不能删早。
- 判定靠 `runs` / `steps` / 计划状态如实收口。漏收口只会让分支多留一会儿，不会误删。
- 新增的 `childHoldText` 文案要走 `t()` 并补英文，漏翻 `npm run typecheck` 会失败。
- 回收点收敛成一个函数后，`releaseChild` 变成关键路径：以后加自动回收路径必须走它，别再直接调 `removeWorktree` 或写 `resolved`。

## 开放问题

无。
