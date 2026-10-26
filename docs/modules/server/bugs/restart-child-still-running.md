# 子对话进程已回收却仍显示在跑：行首转圈、计进「N 个执行中」，又提示「继续会重新拉起」却没有「继续」入口

同一条 Bug 有两条路径，判据同一处、收口时机不同：

1. **重启路径**：面板重启后，重启前还在跑的子对话仍显示「进行中」（行首转圈、计进侧栏分组的「N 个执行中」）。启动迁移只覆盖 `status === 'running'`，「这一轮说完了但计划没做完 / 独立分支没合回」的不在范围内。
2. **运行期路径**：不重启也会出现——页面切走后宽限到期，`server/presence.ts` 的 `evict` 只结束还在等下一句的 CLI，**不落任务状态**，任务一直写着 `status: 'running'`。用户看到一批子对话卡片停在「未完成」，每张下面都写「CLI 进程已回收，继续会重新拉起」，实际都没有在跑（计划停在 5/8、6/8、7/11），而且**在 `running` 状态下没有「继续」按钮**（它只对 `stopped` / `failed` 显示），于是「很多子对话没有拉起」。

- 状态：已修复（两条路径的代码、回归用例随同一批改动落地；`server/task-restart.test.ts` 5/5、`server/reclaim.test.ts` 3/3、`web/src/components/tasks/child-line.test.ts` 10/10 通过，`npm run typecheck`、`npm run lint` 通过，实测见「回归验证」）
- 症状：面板重启后，重启前还在跑的子对话在界面上仍显示「进行中」（行首转圈、计进侧栏分组的「N 个执行中」）；页面切走宽限到期后回收了进程，一批子对话卡片仍停在「未完成 + 继续会重新拉起」，实际没有进程、也没有能点的「继续」
- 入口：`server/tasks.ts` 的 `ready` 启动迁移和 `setPresenceIdleHandler`、`server/exec/reclaim.ts` 的 `settleReclaimed`、`shared/task.ts` 的 `childIcon` / `childState`（`convState` 的 `unfinished` / `unmerged`）/ `resumable`、`web/src/components/tasks/child-line.ts` 的 `convGone`
- 根因类型：状态收口缺口（重启迁移范围不足、页面回收只结束进程不落状态）+ 状态判定不看进程存活（两处信号不同源）
- 模块：`server`（启动迁移与回收回调 `server/tasks.ts`、进程清理 `server/exec/orphans.ts`、回收收口 `server/exec/reclaim.ts`、宽限计时 `server/presence.ts`）、`shared`（状态判定 `shared/task.ts`）、`web`（子对话行的提示 `web/src/components/tasks/child-line.ts`）
- 关键词：重启、页切走回收、presence、页面切走后结束、转圈、执行中、N 个执行中、很多子对话没有拉起、CLI 进程已回收、继续会重新拉起、没有「继续」入口、stopReason restart、stopReason presence、unfinished、unmerged、childIcon、ready、cleanStaleCliProcesses、settleReclaimed、cancelWait、childClosedHint、resumable

## 现象

### 路径一：面板重启后

用户在面板重启后看到（截图）：

- 左侧任务列表：「SilverPalace」分组右边挂着红色标签「1 个执行中」，分组里那条子对话仍是转圈状态。
- 右侧对话流里对应的一条卡片写着：

  > 子对话 对话列表小圆点与转圈同时出现 ｜ 计划 6/8 未完成 ｜ CLI 进程已回收，继续会重新拉起

也就是说面板自己知道「CLI 进程已回收」，但这条子对话在列表和任务树里仍然算「执行中」。用户的要求：重启会让这一轮断掉，看不到任何正在产出的过程，转圈就是在骗人，重启后应该显示成静止态（已停止 / 已中断）。

### 路径二：页面切走宽限到期后（不重启）

用户补充的现象（同一片逻辑，用户原话「很多子对话没有拉起」）：左侧/中间列出的一批子对话卡片全都停在「未完成」，每张下面都写着同一句：

> CLI 进程已回收，继续会重新拉起

但实际它们都没有在跑：计划停在 5/8、6/8、7/11 之类不动，最后活动时间是几分钟到十几分钟前。

和后一条提示合起来看就矛盾了：行上写着「继续会重新拉起」（说明进程已经没了），图标却还是转圈、还算进「N 个执行中」（说明状态仍是 `running`）；而承载「继续」的按钮在 `running` 状态下根本不出现（见下面「路径二的根因」），用户按不了、也没别的入口，所以「拉起」永远不会发生。

## 复现条件

1. 子对话这一轮已经说过话了（落盘里 `status` 是 `done`），但**计划没做完**（`openPlan` 有值，例如 6/8）或者**独立分支还没合回**（`worktree.state === 'active'`）。
2. 这时重启面板（关掉服务再开，或者崩溃后被重新拉起）。
3. 重启后 `server/exec/orphans.ts` 的 `cleanStaleCliProcesses` 按 `run/cli-pids.json` 把遗留 CLI 杀掉、清掉登记，但**不碰任务记录**；`server/tasks.ts` 的 `ready` 只迁移 `status === 'running'` 的任务，这一类 `status` 是 `done`，原样留在落盘里。
4. 界面按 `childIcon` 判定：`convState` 因为 `unfinished` / `unmerged` 返回 `unfinished`，`childIcon` 对它返回 `running` → 行首转圈、子对话栏算在跑；同一行 `cliAlive` 是 `false`，`convGone` 返回 `hint`，又挂一句「CLI 进程已回收，继续会重新拉起」。

本机真实数据里就是这样一条：子对话 `c8f2721d-f0e7-4057-b1ee-734aa377da0a`（父对话 `93b08721-4bab-4f55-93e6-0e2fe180eeab`），落盘里 `status: 'done'`、`working: false`、计划 6/8（`doneAt: ''`）、`worktree.state: 'active'`、没有 `wrapRequest`。

路径二（不重启，页面切走宽限到期）：

1. 一个子对话这一轮说完了，CLI 留着等下一句（MCP 工具等回复间隙）：落盘里 `status: 'running'`、`working: false`，计划停在 6/8。
2. 用户切走页面（或关掉页面、切到别的对话），`server/presence.ts` 的 `scheduleIdle` 开始计宽限（「设置 · 自动回收闲置 Agent」开启时；宽限时长默认 60 分钟，未读的更短），到点 `evict(taskId)`；这一轮还在跑（`busy`）就不回收，只记 `pending`。
3. `evict` 调 `onIdle`（即 `server/tasks.ts` 的 `setPresenceIdleHandler`），旧实现只有 `cancelWait(id)`：它让在等下一句的 CLI 结束这一轮，**一个字段都不写回任务记录**。
4. 于是任务永远停在 `status: 'running'`、`working: false`：`convState` 走 `unfinished`（计划没做完）→ `childIcon` 是 `running`（转圈、计入「N 个执行中」），而进程真的没了、`cliAlive` 为假 → `convGone` 给 `hint`「CLI 进程已回收，继续会重新拉起」；「继续」按钮的显示条件是 `shared/task.ts` 的 `resumable(status)`（只看 `stopped` / `failed`），在 `running` 状态下根本不渲染——这一轮既不会自动拉起，用户也没有可点的入口。

## 根因

先按三种候选分别查，结论是第三种为主、第二种是伴生现象：

1. **「启动时只清了进程、没把任务状态改成已停止」**：一半成立。`cleanStaleCliProcesses`（`server/exec/orphans.ts`）只按 pid 登记杀进程并清登记文件，确实不动任务记录；但 `server/tasks.ts` 的 `ready` 本来就有迁移，问题在它的**范围**——过滤条件是 `x.status === 'running'`。
2. **「状态改了、界面的 running 判定另算一处」**：成立，是伴生现象。行首图标和子对话栏读 `childIcon`（`unfinished` 也返回 `running`），而「进程还在不在」这句提示读 `cliAlive`（`convGone` / `childClosedHint`）。两处信号不同源，就出现「转圈 + CLI 进程已回收」同屏；侧栏分组的「N 个执行中」又走 `taskBusyCount` / `taskBusy` → `convState(taskFacts)`，和行首图标不是同一个函数。
3. **「重启后没有重新校验进程在不在就沿用旧状态」**：主因。`childIcon` 的输入 `ChildEntry.cliAlive` 只影响「已关闭」标签，**不参与图标判定**；`childIcon` 对 `unfinished` / `unmerged` / `wrapup` 一律返回 `running`。这个「还有事没做完 = 还在跑」的判定在进程活着时是对的，重启后 CLI 已经没了、后台命令和工作流的内存记录也一起没了，它就不再成立，而启动迁移没有把这一类任务收口。

所以缺的不是「再算一次进程在不在」，而是「重启后要把『界面还会画成在跑』的任务统一落成已停止」：判据要和图标同源，不能另写一套「算不算在跑」（项目教训 `lmvkmb75vog8n`）。

### 路径二的根因：页面宽限回收只结束进程，不落状态

同一个缺口的运行期版本。`evict` 的语义本身没错（进程不再等下一句、下次进来冷启动续接），错在**收口只做了一半**：`cancelWait(id)`（`server/exec/runner.ts`）停掉还在等下一句的 CLI，调用方却不写任务记录。

- **不写状态的后果是双重卡死**：界面继续按 `running` 画（转圈、计入「N 个执行中」），而「继续」按钮只对 `resumable(status)` 为真的 `stopped` / `failed` 显示——用户看到一个「在跑」的任务，却没有能让它重新跑起来的按钮，于是「很多子对话没有拉起」。
- **不是「拉起失败」，是根本没触发拉起**：路径二里没有任何自动拉起的设计（回收的约定是用户回来或发消息时冷启动），所以不需要、也不应该去重试拉进程；要做的是把任务落成静止态，让界面给出的下一步（继续 / 发消息）真实可用。
- **也不能直接把 `status` 改了就算**：正在产出的任务（`working === true`）不能动（`evict` 已经用 `keepAliveBusy` 挡住，但回调里还要自己再挡一次）；已经停下的任务不能覆盖原因（用户按的暂停、父对话结束…）。这两条是收口函数必须自己守的边界。

选定的显示语义（放弃「自动拉起」）：进程已回收且这一轮实际中断时，任务落成 `stopped` + `stopReason: 'presence'`（界面写「页面切走后结束」、图标 `idle`），行上仍然保留「CLI 进程已回收，继续会重新拉起」这句——它此时是真的：行已静止，「继续」按钮出现了，按下去或发消息就会重拉 CLI。理由是回收本来就是为了「别让没人看的 CLI 一直挂着」，回来才续；自动拉起等于回收完立刻把进程重开一遍，和回收目的相反。

## 修法

### 判据放进 `shared/task.ts`，和图标同一处

新增 `restartInterrupted(task)`：按界面同一套方式构造 `ChildEntry`（`plan` 取 `openPlan(task)`、`unmerged` 取 `task.worktree?.state === 'active'`、`wrapup` 取 `task.wrapRequest`、`cliAlive` 固定 `false`），然后返回 `childSpinning(entry) && childState(entry) !== 'wrapup'`——即「重启后界面还会画成正在跑」。

- **走 `childSpinning` / `childState`，不另写判定**：行首图标、列表分组、计数、徽标都从 `childIcon` / `convState` 派生，判据跟着它们走，以后加状态不会漏掉这个迁移。
- **「待收尾」排除**：`wrapRequest.state` 不是 `failed` 时（`requested` / `merging`）说明已经在等父对话合并，不靠 CLI 进程，重启后照样能收，落成已停止反而把收尾请求的状态搅乱。
- `cliAlive: false` 只是为了让 `ChildEntry` 完整；图标判定不看它（见根因第 3 点）。

### `ready` 的迁移范围扩到「界面还会画成在跑」

`server/tasks.ts` 的 `ready` 过滤条件从 `x.status === 'running'` 改成 `x.status === 'running' || restartInterrupted(x)`，原来的字段改写保持不变（`status: 'stopped'`、`stopReason: 'restart'`、清 `requests` / `working` / `awaitingUser` / `prewarming`、结算 `runMs` / `waitMs` / `idleWaitMs`、把 `status === 'running'` 的节点 `pauseStep` 后标 `interrupted: true`、`turns` 收口）。

- **`stopReason` 必须是 `restart`**：这是面板重启打断的，不是用户按的暂停（项目教训 `lmvkmbatncz75`）。界面因此显示 `stopReasonText('restart')`（「面板重启时中断」），图标是 `idle`，不会写成「已暂停」。
- **系统消息按情况分两种**：这一轮还在跑的仍写原来那句「点『继续执行』从中断的节点接着做」；「这一轮已经说完、只是没收尾」的改成 `面板重启时这件事还没收尾，已经不在执行。接着做就发消息，会重新拉起 CLI 接着做。`（英文在 `shared/locales/en/server.ts`）。它没有可续接的中断节点，说「继续执行」会误导。
- **不动 `worktree.state`**：独立分支还活着，继续时还要用它（回归用例里断言迁移后仍是 `active`）。

### 页面宽限回收也走同一套收口（路径二）

运行期的同一个缺口用同一个目标修：回收之后，落盘里不能还写着 `running`。

**新增 `server/exec/reclaim.ts` 的 `settleReclaimed(store, id, reason)`**：读一条任务，只有「`status === 'running'` 且 `working === false`」才写回 `status: 'stopped'` + 传入的 `stopReason`，并清 `working` / `awaitingUser` / `prewarming`；返回是否真的改了。

- **两条不碰**：`working === true`（真在执行，不能把产出中的任务写成已停止）和已经停下的（`stopped` / `failed` / `done`）——原因（用户按的暂停、父对话结束…）不能被覆盖（和 `stopTask` 的原因语义一致，项目教训 `lmvkmbatncz75`）。
- **放在 `server/exec/`**：它和 `stopTask` 一样属于执行链路的收尾，只依赖一个很小的 `{ get, update }` 形状，测试里用真的 `createTaskStore` + 临时数据目录验（不 mock 落盘）。

**`server/tasks.ts` 的 `setPresenceIdleHandler`**（旧实现是 `setPresenceIdleHandler((id) => cancelWait(id))`）：

1. 先 `cancelWait(id)`：还在等下一句的 CLI 结束这一轮（没有就跳过）。
2. 内存里有 live 记录且没在跑（`!entry.task.working`）→ `stopTask(id, 'presence')`，走引擎的正常停止流程收尾；
3. 没有 live 记录（进程已经回收了）→ `void settleReclaimed(store, id, 'presence')` 直接改落盘。

`stopReason` 用 `presence`（`shared/schema.ts` 的 `StopReason`），界面因此显示 `stopReasonText('presence')`（「页面切走后结束」），不是「已暂停」（项目教训 `lmvkmbatncz75`）。

**`web/src/components/tasks/child-line.ts` 的 `convGone`**：对 `childIcon` 是 `idle` 的行也返回 `'hint'`。收口后行首不转圈了，但如果这一句提示也跟着消失，一排静止的卡片就只剩「页面切走后结束」，用户看不出继续能不能恢复（用户报的「很多子对话没有拉起」就是这么来的）。现在的口径：

- `idle`（页面切走 / 隐置回收 / 重启顺带停下，即 `stopped` 但 `stopReason` 不是 `user`）→ 静止 + 「CLI 进程已回收，继续会重新拉起」；
- 用户按的暂停（`childIcon` 是 `stopped`，`stopReason: 'user'`）→ 不显示这句（行上已写「已暂停」，再说「继续会重新拉起」会让人以为不是自己停的）；
- `running` / `waiting` 照旧显示；`done` 说「已关闭」；失败不提进程。

## 防复发护栏

`server/task-restart.test.ts`（`npm run test:unit` 会跑）五条：

| 用例                                                         | 守着什么                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 重启前这一轮还在跑的任务：落成已停止，节点标成被打断         | `status` / `working` 落静止、节点 `pending` + `interrupted`、`stopReason` 是 `restart` 而不是 `user` |
| 这一轮说完了但计划没做完的子对话：重启后落成已停止，不再显示在跑 | 计划 6/8 这类 `unfinished` 被收口；迁移前它本来画成在跑，迁移后 `childSpinning` 为假、图标 `idle` |
| 独立分支还没合回的子对话：重启后也落成已停止                 | `worktree.state === 'active'` 的 `unmerged` 被收口，且分支记录不被清掉        |
| 彻底做完的任务保持已完成                                     | 迁移不误伤 `done` 且没有挂起事项的任务                                        |
| 已经请父对话收尾的任务保留待收尾：它等的是父对话合并，不靠 CLI 进程 | `wrapup` 不被落成已停止，`wrapRequest` 原样保留                               |

用例里的 `spins()` 和界面用同一份判定（`childSpinning` + `cliAlive: false`），不另写期望；`shared/task-stage.test.ts` 继续守着 `convState` / `childIcon` 的优先级，改图标判定时会先在那里面暴露。

`server/reclaim.test.ts`（运行期路径，`npm run test:unit` 会跑）三条：

| 用例                                                     | 守着什么                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| 进程已回收、状态还写着 running 的等下一句任务：收口成已停止，不再显示在跑 | `status: 'stopped'`、`stopReason: 'presence'`、`childSpinning` 从真变假、`childIcon` 为 `idle` |
| 这一轮真的在执行（working）的任务不碰                    | 还在产出的任务不能被写成已停止                                                |
| 已经停下的任务不覆盖原来的停止原因                        | `stopReason: 'user'` 不被改成 `presence`                                      |

`web/src/components/tasks/child-line.test.ts` 新增一条「页面宽限回收后的静止行：说清继续会重新拉起，不写成「已关闭」」：`status: 'stopped'` + `stopReason: 'presence'` 的行上出现「页面切走后结束」和「CLI 进程已回收，继续会重新拉起」，不出现「已关闭」。

## 回归验证

### 用例（按项目教训 `lmvmabgjdi271`，先在旧实现上确认会失败）

重启路径（`server/task-restart.test.ts`）：

| 实现                                     | 结果                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| 旧实现（`ready` 只过滤 `status === 'running'`） | 「计划没做完」「独立分支没合回」两条失败，其余 3 条通过          |
| 新实现                                   | 5/5 通过                                                               |

运行期路径（`server/reclaim.test.ts`）：

| 实现                                                                                     | 结果                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧实现（`git show d93265eb:server/tasks.ts` 的 `setPresenceIdleHandler((id) => cancelWait(id))`，且该提交下没有 `server/exec/reclaim.ts`） | 三条都无从通过：旧实现没有写回状态的分支，用例也不能加载收口函数（代码比对结论，本轮未在旧实现上重跑，见「待确认」）；用例第一条断言 `spins(waiting) === true` 就是「回收前界面把它画成在跑」的复现 |
| 新实现                                                                                   | 3/3 通过（本轮跑过）                                                                                                                                           |

界面侧（`web/src/components/tasks/child-line.test.ts`）：新增的「页面宽限回收后的静止行」一条本轮 10/10 全文件通过。

### 真实数据（本机数据目录的副本，真实目录只读）

复制数据目录，用临时目录起服务：`AGENT_PANEL_DATA=<临时目录> PORT=8899 AGENT_PANEL_TRAY= npx tsx server/index.ts`。

同一条子对话 `c8f2721d`：

| 指标                                        | 重启前（迁移前落盘）                        | 重启后（迁移后）                                |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| `status` / `stopReason`                     | `done` / 无                                 | `stopped` / `restart`                           |
| `/api/tasks/<父对话>/children` 返回的那行喂给界面判定 | `spinning: true`、同时 `hint` 有值  | `state` 已中断、`icon: idle`、`spinning: false` |
| 行上的说明                                  | 「CLI 进程已回收，继续会重新拉起」          | 不再显示这句，改为「面板重启时中断」            |
| 父对话 `childrenWorking`                    | —                                           | `0`（同一分组再没有子对话算作运行中）           |

再次发消息时才恢复成 running（发消息会重新拉起 CLI）。

静态检查、单测和端到端（动了启动迁移和页面宽限回收，按大改动跑）：

```bash
npm run typecheck && npm run lint
npx tsx --test server/task-restart.test.ts   # 5/5 通过
npx tsx --test server/reclaim.test.ts        # 3/3 通过
npm run test:e2e:wsl                         # WSL Ubuntu-24.04，退出码 0，全部分片通过
```

## 落地改动

| 位置                          | 改了什么                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/task.ts`              | 新增 `restartInterrupted(task)`：按 `ChildEntry` 走 `childSpinning` / `childState`，返回「重启后界面还会画成在跑」；`wrapup` 排除                                       |
| `server/tasks.ts`             | `ready` 过滤条件扩成 `status === 'running' \|\| restartInterrupted(x)`，系统消息按「这一轮还在跑」和「已经说完但没收尾」分两种文案；`setPresenceIdleHandler` 从只有 `cancelWait(id)` 改成先 `cancelWait`，有 live 记录且没在跑走 `stopTask(id, 'presence')`，没有 live 记录走 `settleReclaimed(store, id, 'presence')` |
| `shared/locales/en/server.ts` | 补新文案的英文 `This work was not finished before the panel restarted and is no longer running. Send a message to continue; the CLI will be started again.`                                      |
| `server/task-restart.test.ts` | 新增 5 条用例（见「防复发护栏」）                                                                                                                                                                |
| `server/exec/reclaim.ts`      | 新增 `settleReclaimed(store, id, reason)`：把「`running` 且 `working === false`」的任务落成 `stopped` + 传入的 `stopReason`；`working` 的、已停下的不碰                                                                       |
| `web/src/components/tasks/child-line.ts` | `convGone` 对 `childIcon` 是 `idle` 的行也返回 `'hint'`（页面切走 / 隐置 / 重启收口），静态行上依然显示「CLI 进程已回收，继续会重新拉起」；`stopReason: 'user'` 的不显示 |
| `server/reclaim.test.ts`      | 新增 3 条用例（见「防复发护栏」）                                                                                                                                                                |
| `web/src/components/tasks/child-line.test.ts` | 新增 1 条「页面宽限回收后的静止行：说清继续会重新拉起，不写成「已关闭」」                                                                                                                                |

## 待确认

- **运行期路径没有像重启路径那样的真实数据实测记录**：本轮只有 `server/reclaim.test.ts` 和 `child-line.test.ts` 的用例证据，界面效果（静止行 + 这句提示 + 「继续」按钮出现）是按代码推导的；要补齐就跟重启路径一样，复制数据目录起临时服务，找一条 `status: 'running'`、`working: false` 的子对话手动过一遍回收宽限。
- **运行期路径的旧实现对照没有在旧代码上实跑**：`server/exec/reclaim.ts` 在那个提交下不存在，`reclaim.test.ts` 在旧实现上会直接加载失败，所以「旧实现三条都不过」是按旧 `setPresenceIdleHandler` 代码比对得出的，不是实测记录。以后重新捡这块时，可以把 `reclaim.test.ts` 改成「用旧 handler 的写法（只 `cancelWait`）跑一遍、断言任务仍是 `running`」的绕行用例来补齐实测。
- 另一个改动正在动 `shared/task.ts` 的 `childIcon` / `childSpinning` 附近和 `web/src/components/tasks/` 的圆点、转圈判定：`restartInterrupted` 依赖 `childSpinning` / `childState` 的语义（`unfinished` / `unmerged` / `wrapup` 返回 `running`），`convGone` 也读 `childIcon`。合并时若那边改了这几个状态的图标映射，两条路径的覆盖范围和本记录的结论要一起重核。
