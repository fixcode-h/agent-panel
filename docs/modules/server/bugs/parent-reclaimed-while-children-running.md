# 父对话在等子对话时被回收成「已中断」：子对话还在跑，父对话先没了

- 状态：已修复（改动、回归用例随同一批落地；`shared/task-stage.test.ts`、`server/presence.test.ts` 的新用例先在旧实现上确认失败，`server/task-restart.test.ts` 与 `scripts/e2e/04-subagents.mjs` 补上父子两侧的护栏）
- 症状：一个父对话派出子对话后停在等它的结果，用户切走页面（或关掉标签页），宽限到期后父对话被落成「已中断」（`status: 'stopped'`、`stopReason: 'presence'`），而子对话还在跑；子对话的结果回来时父对话已经不在「等结果」的状态里，用户看到的是一条被回收的父对话
- 入口：`server/presence.ts` 的 `evict`（`busy` 判定）、`server/tasks.ts` 的 `keepAliveBusy` / `childrenRunning` / `enforceKeepAlive`、`server/exec/reclaim.ts` 的 `settleReclaimed`、`shared/task.ts` 的 `keepAliveHolding` / `keepAliveBusy` / `childFacts` / `restartInterrupted`
- 根因类型：状态收口缺口（回收判定只看「自己有没有执行位」，不看名下还在跑的对话）
- 模块：`server`（回收触发 `server/presence.ts`、判定与上限 `server/tasks.ts`、收口 `server/exec/reclaim.ts`）、`shared`（判定 `shared/task.ts`）
- 关键词：父对话被回收、等子对话、子对话还在跑、presence、宽限到期、keepAliveBusy、keepAliveLimit、保活上限、没有执行位、不保活的 CLI、canWait、stopReason presence、已中断、父对话落成已停止、childrenRunning、keepAliveHolding、settleReclaimed

## 现象

父对话派出子对话后这一轮已经说完，停在等子对话的结果。用户切走页面，过了宽限（或保活会话超过上限），父对话被结束并落成「已中断」，但子对话还在跑：

- 父对话那一行不转圈了，显示「页面切走后结束」；
- 子对话仍在执行，结果最后交回时父对话已经被收口过一次；
- 用户的原话：「子对话还在运行，父对话的 Agent 绝对不能回收」。

## 复现条件

1. 父对话派出一个跑得比较久的子对话（父对话这一轮结束后不再有输出，名下的子对话仍在跑）；
2. 父对话用的 CLI 不支持保活，或者这一轮结束时进程已经退出——`server/exec/runner.ts` 的 `canWait = chat && !op && def.keepAlive && !def.rpc?.nativeAsk`，`features.keepAlive` 没开的 CLI（`shared/clis/*.json` 里的 claude / codex / gemini）就走这条路：一轮结束后 `live` 里没有它的条目；
3. 用户切走页面，`server/presence.ts` 的宽限到期；
4. `evict` 先问 `busy(taskId)`（接的是 `server/tasks.ts` 的 `keepAliveBusy`）。旧实现第一行是 `if (!entry) return false`：**没有执行位就当空闲**，于是走进 `onIdle`；
5. `onIdle` 里没有 live 记录的分支走 `settleReclaimed(store, id, 'presence')`。父对话的计划里通常还挂着「等子对话」那一步（`openPlan` 有值，`restartInterrupted` 为真），或者这一轮还写着 `status: 'running'`，两者都命中收口条件 → 落成 `stopped` + `stopReason: 'presence'`。

保活上限（`enforceKeepAlive`）走的是同一个判定，所以超额时也会把这类父对话放进候选池；父对话只是在 `live` 里没有条目时不受上限影响，一旦有保活条目、名下的子对话又刚好不在 `live` 里（旧实现只从 `live` 枚举子对话）就会被算成空闲。

## 根因

判定只有一处（回收时长、保活上限都问 `keepAliveBusy`），但这一处在「没有执行位」时直接返回 `false`，把「进程不在了」当成「事情做完了」。

- 有执行位时判定是对的：`keepAliveBusyOf` → `convState` 会把 `children` / `background` / `workflow` / 提问都算成还在运行；
- 没有执行位时（这一轮结束、进程退出，最常见的就是不保活的 CLI）这条信息全丢了，而这时恰恰是「父对话在等子对话」的常态：父对话没有进程，子对话有进程；
- 名下的子对话数也只从 `live` 枚举（旧实现写在 `keepAliveBusy` 里），和 `childActive` 用的「在跑 / 等结果 / 等回答 / 正在启动 / 还有交过来的消息」不是同一个来源。

## 修法

### 一处判定：`shared/task.ts` 的 `keepAliveHolding`

新增 `keepAliveHolding({ live, task, more, background, children })`，把「有没有执行位」这层分叉收进来：

- **有执行位**：`more`（正在启动 / 还有排队的消息）→ 忙；否则走原来的 `keepAliveBusy(task, { background, children })`；
- **没有执行位**：名下有还在跑的子对话、后台命令没回来，或者正在启动 / 有排队的消息 → 忙；都没有 → 空闲，照旧回收。

`server/tasks.ts` 的 `keepAliveBusy` 只剩取数：`live` 里有没有这条、`pendingJobs(id)`、`childrenRunning(id)`、`startQueue` / `hasHeld`。回收时长（`server/presence.ts` 的 `setPresenceBusy`）和保活上限（`enforceKeepAlive`）读的还是同一个 `keepAliveBusy`，没有在触发点各加一个 `if`。

`childrenRunning(parentId)` 从 `server/tasks.ts` 里抽出来：`live` 中 `parentTaskId` 是它、且 `childActive(task)` 为真的条目数。「数几个」和「某个子对话在不在跑」是同一个判定（`childActive`）。

**不是永不回收**：子对话全部结束、父对话也空下来之后 `children` 归零，`keepAliveHolding` 返回 `false`，两段时间和上限照旧收（`shared/task-stage.test.ts` 的用例里显式断言了这一条）。

### 宽限到点还在跑的对话留一个复查（评审 R1）

修完上面两处后有一个反方向的缺口：`server/presence.ts` 的 `evict` 在忙时只 `pending.add(taskId)` 就返回，而唯一能把「待回收」变回计时器的是 `resetIdleCountdown`，全仓只有 `server/tasks.ts` 的 `onKeepAlive`（这一轮结束开始保活）调它。没有执行位的父对话永远不会走 `onKeepAlive`：子对话被用户强制停掉、后台命令被停、子对话启动失败，都不会再交回结果，于是父对话就永远挂在 `pending` 里，两段时间和保活上限都不再作用于它——从「被误回收」变成了「永不回收」，违反边界④。

修法：`evict` 忙的时候记完标记再排一个复查计时器（`scheduleRecheck`），到点重新判一次——还忙就继续等，空下来就照常回收。复查间隔是独立常量 `BUSY_RECHECK_MS`（默认 60 分钟，测试用 `AGENT_PANEL_PRESENCE_RECHECK_MS` 缩短），**不取宽限期**：宽限期可以设成 0，按 0ms 重排会把事件循环打成自旋（项目教训里的老坑）。复查用独立的 `rechecks` Map，不和宽限的 `timers` 共用：共用的话 `scheduleIdle` 的「已经在计时」会把复查当成宽限，宽限是 1 分钟的用户要等到复查点（默认 60 分钟）才能回收。`resetIdleCountdown` / `setViewer(active)` / `forgetPresence` 会把两种计时器一起清掉或重排。

`evict` 开头读一次回收开关（`if (!reclaimEnabled) return`）：用户关掉「按时间回收」后，已经排出去的宽限计时器和它排出的复查都不能再收（以前只有 `scheduleIdle` 读开关，已排的计时器到点照样收）。开关只在 `evict` 这一处读，不再在 `scheduleRecheck` 里另写一份。

### 重启迁移的条目构造改为从 `childFacts` 派生

`shared/task.ts` 的 `restartInterrupted` 以前自己手拼一份 `ChildEntry`（`status` / `working` / `requests` / `unmerged` / `wrapup`…逐项抄一遍），和 `childFacts` 是两套字段清单：以后 `childFacts` 加一项判定字段，这里就会漏掉，重启迁移的落静止范围和界面图标就不一致。现在抽出 `childEntryOf(task)`：`...childFacts(task, { unmerged })` 打底，只有 `id` / `title` / `cliAlive: false` / `startedAt` / `plan` 这五项现取。`restartInterrupted` 只调它。

### 空回合与 `reportChild` 两条路径核对结论

- **空回合兜底**：`server/exec/runner.ts` 的 `emptyTurn()`（零工具、零改动、只说了一句准备语或一个字都没回）在保活之前判定，命中就不保活、交给收尾处的兜底。父对话派出子对话时一定调用过面板工具，`turnTools()` 大于 0，不会被判成空回合；即使真丢了保活，父对话也不再被回收——由上面的 `keepAliveHolding` 护住，这轮不需要改 runner。
- **`reportChild` 时序**：子对话结束的收口只有一个出口 `endTurn` / `reportChild`（`scripts/rules-check.mjs` 第 8 条守着），`reportedState` 用 `state|turnDoneAt|status` 去重，`noteParent` 写入前重读 `live` 里那份。本轮核对的结论是不需要改行为，只补了父子两个都进恢复名单的用例。

## 防复发护栏

| 用例 | 守着什么 |
| ---- | -------- |
| `shared/task-stage.test.ts`「keepAliveHolding：名下有子对话在跑时，这一轮结束、进程也退了也不回收」 | 没有执行位 + `children: 1` / `background: 1` / `more: true` 都算忙；子对话归零、任务做完时照旧回收到 |
| `server/presence.test.ts`「父对话在等子对话：宽限到了也不回收，子对话结束、自己空下来之后照旧回收」 | 接到 presence 的 `evict`：宽限到点不回收、`isWatched` 仍为真；子对话结束后 `resetIdleCountdown` 重排，空满一整段照旧回收 |
| `server/presence.test.ts`「宽限到点还在跑的对话留一个复查：子对话被停掉、自己空下来后照旧回收」 | 评审 R1：忙时进 `pending` 之后必须有复查把它拉回回收，不能永远挂着（子对话被强制停掉时不会再有 `onKeepAlive`） |
| `server/presence.test.ts`「关掉自动回收：宽限或复查到点都不收」 | 先打开开关走到「宽限到点 → 忙 → 排上复查」，再关开关：复查到点也不能收（不是只测宽限计时器） |
| `server/presence.test.ts`「复查不占宽限计时：空下来以后按宽限收，不等到复查点」 | 复查用独立的 `rechecks` Map，`scheduleIdle` 的「已经在计时」不能把它当成宽限 |
| `server/task-restart.test.ts`「重启时名下有子对话在跑的父对话：落成已停止，父子都进恢复名单」 | 重启迁移把父子都落静止（进程都回收了），`stopReason` 是 `restart`；`interruptedTaskIds` 里父对话不能漏（子对话的结果要它接） |
| `scripts/e2e/04-subagents.mjs`「父对话在等子对话：宽限到期不回收父对话（子对话的结果还要交给它）」 | 真实链路：不保活的 CLI 建父对话（留下没做完的计划）+ 接口建一个 `SLOW` 子对话 → 切走父对话页 → 等两倍宽限 → 父对话的 `stopReason` 不能是 `presence`、`status` 不能是 `stopped` |

## 回归验证

按项目教训 `lmvmabgjdi271`（「没被回收」这类否定断言要在旧实现上跑一遍确认会失败），把 `keepAliveHolding` 的「没有执行位」分支临时改回旧行为（`if (!x.live) return false`）：

| 实现 | 结果 |
| ---- | ---- |
| 旧行为（没有执行位就当空闲） | `shared/task-stage.test.ts`「keepAliveHolding…」失败、`server/presence.test.ts`「父对话在等子对话…」失败（后者失败在「宽限到了也不回收」那条断言） |
| 新实现 | 恢复后两个文件 47 条全过 |

复查的同一种验证（评审 R1）：把 `evict` 忙分支的 `scheduleRecheck(taskId)` 临时去掉（回到「只记标记」的旧写法），`server/presence.test.ts`「宽限到点还在跑的对话留一个复查」失败；恢复后全文件通过。

第二次复看又补了两条同种验证：

- 去掉 `evict` 开头的 `if (!reclaimEnabled) return`：`server/presence.test.ts`「关掉自动回收：宽限或复查到点都不收」失败；
- 把 `scheduleRecheck` 改回共用 `timers`（`rechecks` → `timers`）：`server/presence.test.ts`「复查不占宽限计时」失败。

两条恢复后该文件 15 条全过。

第三次复看后，用例「关掉自动回收」的构造改成先在开关打开时真的排上复查、再关开关（原本是在宽限到点前就关，复查根本没排上，名字和实际的覆盖对不上）；同种反向验证（去掉 `evict` 开头的开关检查）后该用例照样失败。

`restartInterrupted` 改成从 `childFacts` 派生是结构收敛（当前字段集下两种写法结论相同），`server/task-restart.test.ts` 的用例守的是行为契约，不声称能拦住这次重构本身。

## 落地改动

| 位置 | 改了什么 |
| ---- | -------- |
| `shared/task.ts` | 新增 `keepAliveHolding`（有 / 没有执行位两种口径的保活结论）、抽出 `childEntryOf` 让 `restartInterrupted` 从 `childFacts` 派生条目 |
| `server/tasks.ts` | 抽出 `childrenRunning(parentId)`（从 `live` 枚举 `childActive` 的子对话）；`keepAliveBusy` 改为取数后交给 `keepAliveHolding`，不再在没有执行位时直接返回 `false` |
| `server/presence.ts` | `evict` 开头读回收开关（关掉后已排的计时器也不再收）；忙时记完 `pending` 再排复查（`scheduleRecheck`，独立 `rechecks` Map，间隔 `BUSY_RECHECK_MS`，不取宽限期以避开 0ms 自旋）；空下来后照常回收 |
| `shared/task-stage.test.ts` | 新增 `keepAliveHolding` 用例（含「子对话结束照旧回收」） |
| `server/presence.test.ts` | 新增「父对话在等子对话」、「宽限到点还在跑的对话留一个复查」、「关掉自动回收：宽限或复查到点都不收」、「复查不占宽限计时」四条例用 |
| `server/task-restart.test.ts` | 新增「重启时名下有子对话在跑的父对话」用例（父子落静止 + 都进恢复名单） |
| `scripts/e2e/04-subagents.mjs` | 新增「父对话在等子对话」的端到端段（宽限两倍后父对话不被落静止），并在切走前、断言前各确认一次 `working === false`：这段时间父对话要是被叫醒在跑，断言会先把构造打红，不会静默假绿（评审 R2） |
