# server · 状态回收与强制更新后的恢复

[server 模块](README.md)的子页面：面板重启和页面宽限到期后的状态回收、强制更新后的恢复名单。模块的状态块、`server/tasks.ts` 拆分表、入口、依赖和回归验证见 [README.md](README.md)，Bug 记录见 [bugs.md](bugs.md)。

2026-10-31 从 `README.md` 原样挪出（文字没改），各条的日期和结论以当时为准。

## 状态回收：面板重启后与页面宽限到期后

「落成已停止」只有一种写法：`shared/task-settle.ts` 的 `settleStopped`（启动迁移、页面回收、定时核对共用，见 [ADR 0033](../../adr/0033-state-settle-and-tasks-split.md)）。

服务启动时 `server/tasks/startup.ts` 的 `migrateOnStart`（`tasksApi` 里暴露成 `ready`）会把「重启后已经没人接着做、界面却还会画成在跑」的任务落成 `status: 'stopped'` + `stopReason: 'restart'`：

- 这一轮还在跑的（`status === 'running'`）：正在跑的节点标成被打断（`interrupted: true`），并写一条 transient 系统消息说明继续执行会续接那个节点的会话；
- 这一轮已经说完、但计划没做完（`openPlan`）或独立分支还没合回（`worktree.state === 'active'`）的：CLI 进程已经在重启时回收，不落静止的话行首会一直转圈、还算进分组和侧栏的「N 个执行中」，同时又显示「Agent 进程已回收，继续会重新拉起」（用户报的现象）。这两种落成已停止，消息里说清「还没收尾、接着做就发消息」；
- 判据是 `shared/task.ts` 的 `restartInterrupted`，走 `childSpinning` / `childState`，和图标、分组、计数是同一处，不另写一套「算不算在跑」；
- 「待收尾」（`wrapRequest.state` 不是 `failed`，即 `requested` / `merging`）不落静止：它等的是父对话合并，不靠 CLI 进程，重启后照样能收。

落成已停止后 `convState` 返回 `stopped`（`convStateText` 是「已中断」），`stopReason` 是 `restart` 不是 `user`，图标是 `idle`，行上写 `stopReasonText`（「面板重启时中断」）而不是「已暂停」；发消息才会回到 running。回归：`server/task-restart.test.ts`（计划没做完、独立分支没合回两条要在旧实现上先确认失败）。起因和完整排查见 [bugs/restart-child-still-running.md](bugs/restart-child-still-running.md)。

**页面宽限回收也走同一套收口（运行期的同一条路径）**：`server/presence.ts` 的 `evict` 到点回收时调 `setPresenceIdleHandler`，旧实现只有 `cancelWait(id)`——只结束还在等下一句的 CLI，一个字段都不写回任务记录，于是任务永远停在 `status: 'running'`、`working: false`：界面继续转圈并计入「N 个执行中」，而「继续」按钮只对 `shared/task.ts` 的 `resumable(status)`（`stopped` / `failed`）显示，在 `running` 下根本不渲染，用户看到一个在跑的任务却没有能拉起的入口（用户报的「很多子对话没有拉起」）。现在回调里先 `cancelWait(id)`，再分两种：

- 内存里有 live 记录且没在跑（`!entry.task.working`）→ `stopTask(id, 'presence')`，走引擎的正常停止流程收尾；
- 没有 live 记录（进程已经回收）→ `settleReclaimed(store, id, 'presence')`（`server/exec/reclaim.ts`）直接改落盘：`status: 'stopped'` + `stopReason: 'presence'`，清 `working` / `awaitingUser` / `prewarming`。

`settleReclaimed` 只改「`running` 且 `working === false`」的任务：**正在产出的（`working === true`）不碰**（不能把真在产出的任务写成已停止），**已经停下的不碰**（用户暂停、父对话结束这类原因不能被覆盖，和 `stopTask` 的原因语义一致）。界面侧 `web/src/components/tasks/child-line.ts` 的 `convGone` 对 `idle` 的行也返回 `'hint'`，所以停下来的行上依然写「Agent 进程已回收，继续会重新拉起」（计划没做完的行还会由 `childLabels` 追加一条同样的标签，不只在悬停里）；用户按的暂停（`stopReason: 'user'`）不显示这句。回归：`server/reclaim.test.ts` 5 条、`child-line.test.ts` 的「页面宽限回收后的静止行」。这条路径的完整排查也在同一份 Bug 记录里。

**回收宽限只收真空闲的会话**：`server/presence.ts` 的 `evict` 先问同一个判定（`server/tasks/keepalive.ts` 的 `keepAliveBusy` → `shared/task.ts` 的 `keepAliveHolding`）：

- 有执行位时按任务事实判（`convActive`：在跑、等子对话 / 子任务 / 后台命令 / 工作流、有没回复的提问和请求），再加上正在启动和还有排队的消息；
- **没有执行位时**（这一轮已经结束、进程也退了，例如工作流节点、压缩 / 审查这类操作，或者对话页已经关了）看名下还在跑的子对话（`childrenRunning`，和 `childActive` 同一套判定）和还没回来的后台命令：它们的结果还要交回这条对话，按「没人看就回收」收掉会把它落成「已中断」（用户报的「父对话被回收」）。

子对话全部结束、自己也空下来之后照旧回收，不是永不回收。宽限到点还在跑的会话在 `server/presence.ts` 里进 `pending` 之后会排一个复查（`scheduleRecheck`，间隔 `BUSY_RECHECK_MS`，用独立的 `rechecks` Map，不占宽限计时）：子对话被用户停掉、后台命令被停时不会再交回结果，也不会走 `onKeepAlive` 的 `resetIdleCountdown`，只记标记就成了永不回收，所以到点要再判一次（间隔不取宽限期，宽限期可以设成 0，按 0ms 重排会自旋）。`evict` 开头读回收开关：用户关掉「按时间回收」后，已排出去的计时器和它排出的复查也不再收。重启迁移的条目构造也走 `shared/task.ts` 的 `childEntryOf`（从 `childFacts` 派生），以后 `childFacts` 加判定字段不会在迁移这一侧漏掉。回归：`shared/task-stage.test.ts` 的 `keepAliveHolding` 用例、`server/presence.test.ts` 的「父对话在等子对话」「宽限到点还在跑的对话留一个复查」「关掉自动回收」「复查不占宽限计时」、`server/task-restart.test.ts` 的「重启时名下有子对话在跑的父对话」、`scripts/e2e/09-subagent-runtime.mjs` 的同名段；排查和旧实现对照见 [bugs/parent-reclaimed-while-children-running.md](bugs/parent-reclaimed-while-children-running.md)。

**定时核对兜底（ADR 0033）**：`server/tasks/state-sweep.ts` 每 60 秒按 `shared/task-settle.ts` 的 `stateBreaks` 找两种矛盾——记录说在做、面板里却没有执行位 / 启动队列 / 后台命令（`orphan`），收尾停在「合并中」却没在合并（`merging`）。连着两次看到、中间任务没被写过才收：`orphan` 落成已中断（`stopReason: 'lost'`）并在对话里写一句，是子对话的再交给父对话上报（`reportChild`，必填依赖），`merging` 退回「已请求收尾」并告诉父对话。日志里出现「定时核对：记录和实际对不上」就说明某条收尾路径漏了落状态，按日志里的任务去补那条路径。另外，子对话计划里挂着「等父对话安排修复」（kind `parent`）、父对话连着两次都不在执行位上时，提醒父对话一次（`remindParent`，接到 `peer.ts` 的 `remindParentFix`，叫不叫过 `holdWake`；同一条等待只提醒一次）：修复请求交出时的叫醒在面板重启时会丢、父对话被叫醒那一轮也可能没回它。回归：`server/tasks/state-sweep.test.ts`。

## 强制更新后：把被打断的任务列进恢复名单

「强制更新」会停掉所有 CLI（`server/update.ts` 的 `stopForUpdate`）。停之前先把这一批任务记下来，新版本启动后问用户要不要接着跑：

- **记录**：`stopForUpdate` 调 `tasksApi` 的 `interruptedTasks()`（`server/tasks.ts`，`server/index.ts` 里接到 `updateApi` 的 `interrupted`），把 `{ id, doing }` 列表写进数据目录的 `cache/interrupted-by-update.json`（`server/interrupted.ts` 的 `recordInterrupted`：每次都覆盖上一次，空名单也写——清掉上次没处理完的旧记录，弹窗只显示当前这次打断要恢复的对话）。`doing` 由 `restartDoing` 生成，按「正在执行的节点标题 → 没做完的计划进度（`计划 6/8`）→ 最后一条要求的第一行」取第一个有的：重启后节点状态会变回 pending，这些只能在停之前存下来。
- **弹窗**：新版本启动后 `interruptedApi`（`server/interrupted.ts`）提供 `GET /app/interrupted` 和 `POST /app/interrupted/ack`，`web/src/components/layout/UpdateResumeDialog.tsx` 读它、默认全勾选，勾选的逐个调 `POST /tasks/:id/resume`（`server/tasks/conversation-routes.ts` 的 `routes.post('/:id/resume')`，界面侧是 `api.resumeTask`）。读取时再过滤一遍：任务已删除、归档、导入，或者在弹窗出现前就已经跑完的不列。点「稍后再说」或关掉弹窗写 `acknowledged: true`，记录留着但不再自动弹。
- **名单口径**（`shared/task.ts` 的 `interruptedTaskIds(tasks, working)`）：只记这次真正被打断的——现在真在跑的（`working`）+ 它们名下还有在跑子对话的父对话（`working` 条目带的 `parentTaskId`，子对话的结果要交回它，它不在名单里就没人接）+ 这一轮真的还在执行、CLI 被停掉结果回不来的（`status === 'running' && !awaitingUser`，包括在等子任务的那种）。
- **不再算闲置任务**：以前这条名单直接用 `restartUnfinished`，它还包括「这一轮已经说完、停在等下一句、计划没做完」的任务，于是每次强制更新都把历史上所有没做完计划的任务累计进名单（用户报的「有 24 个任务被强制更新打断」，见 [bugs/update-resume-accumulates-history.md](bugs/update-resume-accumulates-history.md)）。父对话仍通过「在跑子对话的 `parentTaskId`」进名单，之前修的父子不一致（[bugs/update-resume-missed-parent.md](bugs/update-resume-missed-parent.md)）不回归。

**`restartUnfinished` 与 `restartInterrupted` 的分工**：`restartInterrupted` 回答「界面还会不会画成在跑」（含独立分支还没合回、由 `ready` 落成 stopped 的那种）；`restartUnfinished` 回答「重启后还有没有活要自己接着干」——`migrateOnStart` 的崩溃名单用它，`interruptedTaskIds` 再按「这一轮还在执行」收窄成本次强制更新的名单。后者四种不算：

- 用户手动暂停（`stopReason: 'user'`）：弹窗默认全勾选，列出来等于推翻用户上一步的决定；
- 待收尾（`wrapRequest.state` 不是 `failed`）：剩下的事是等父对话合并，不靠 CLI 进程，重启后照样能收；
- 独立分支还没合回：同上，重启不影响合并；
- 后台命令：`jobs` 不存盘（见 `shared/schema.ts` 的 `Task.jobs`），重启后无从判断，`restartUnfinished` 也就列不进名单。

**判定和名单都在纯函数里**（`shared/task.ts`），服务端只负责取任务列表：`store.list()` 不带完整对话（只保留用户消息），但 `plans` / `steps` / `stopReason` / `wrapRequest` 都在，判「计划没做完」够用；在跑的任务用 `live` 里那份（比落盘的新）。**不要在这里改用 `store.get` 逐个读完整任务**：那是完整对话文件（长的几 MB），强制更新停 CLI 前同步读上百 MB 会卡在磁盘上（评审 R1）。`workingTasks()` 仍然保留，给清扫独立目录（`sweepStaleWorktrees`）用。

回归：`server/task-restart.test.ts`（覆盖 `restartUnfinished` 的判定、`interruptedTaskIds` 只收在跑任务的名单、父子都进名单、闲置任务不进名单、`doing` 的取值）。反向验证：把 `interruptedTaskIds` 临时退回旧口径（对全部任务用 `restartUnfinished`），「强制更新的恢复名单只记本次真正被打断的」「强制更新名单里不再累计闲置的历史任务」「重启恢复名单：已收口的不再拉起」三条失败；恢复后全文件通过。

## 面板退出 / 重启后：首页「全部继续」

以前只有强制更新会记名单；普通的关面板（SIGTERM）、崩溃之后，所有对话都停在「面板重启时中断」，只能逐个点「继续」（实测报告问题 18）。现在：

- **记录**：`tasksApi().stopAll()` 停 CLI 之前调同一个 `interruptedTasks()`（名单口径同上，只记这次真正被打断的），写进 `cache/interrupted-by-restart.json`（`server/restart-interrupted.ts` 的 `recordRestart`：空名单也写，把上次没处理的冲掉）。强制更新走 `stopAll({ forUpdate: true })` 写空名单，被打断的任务交给上面的弹窗，不在首页再问一遍。没正常退出（崩溃、被杀）来不及记名单：`migrateOnStart` 返回迁移时 `restartUnfinished` 成立的任务 id（`tasksApi` 的 `ready` 就是它），读名单时并进来——崩溃路径没有「本次打断了谁」的记录，只能按 `restartUnfinished` 判「重启前还有没有活」，所以它仍包含闲置但计划没做完的任务。
- **接口**：`GET /app/restart-interrupted`、`POST /app/restart-interrupted/ack`（`restartRoutes`，挂在 `interruptedApi` 里，同一组依赖）。强制更新的记录还没处理时，它列过的 id 不在这里出现。读取时只留 `shared/resume-kids.ts` 的 `restartResumable` 成立的：顶层（子对话由父对话继续时 `resumeKids` 连带拉起，用户停掉的、已交付的子对话那边按 `sortStoppedKids` 跳过）、还停着、停止原因还是 `restart`（重启后用户继续过又自己停了、已经做完的都不列）、没归档 / 导入 / 删除。
- **界面**：`web/src/components/tasks/RestartResumeBar.tsx`，首页输入框下面一条「上次面板关闭时有 N 个对话在运行，已经中断：逐个看 / 全部继续 / ×」。全部继续逐个调 `POST /tasks/:id/resume`，没能继续的留在列表里写明原因；全部成功或点 × 才确认。
- **不做「重启后自动继续」**：继续会花钱、会接着改项目，用户可能正是因为它跑偏了才关的面板。

回归：`server/restart-interrupted.test.ts`、`server/tasks/startup.test.ts` 的「返回上次没正常退出时还在执行的对话」、界面检查 `scripts/ui/08-misc.mjs` 的「首页-重启后全部继续」。

## 额度用完、被限流后自动接上（2026-11-11，Agent 模式扩展 1）

设置 →「常规」→「额度用完或限流」两项，都默认关，结构在 `settings.quotaResume`（`shared/quota-resume.ts`）：

- **换备用模型**：按用户排的顺序换成第一个还没用过的 CLI / 模型马上接着做，可以跨 CLI（runner 发现会话所在的 CLI 变了，按「换了 CLI」把之前的对话带过去）。不用角色的对话改 `cli`、`model`（跨 CLI 时清掉思考强度）；用角色的对话记成 `modelOverride`，角色固定了 CLI 的只换这个 CLI 的模型。停用的 CLI 跳过。
- **到点自动继续**：备用的都用过了（或没开）再看恢复时间：先认报错原文（`|<秒>`、`try again in …`、`resets 3pm`），再看 CLI 推来的额度窗口（`server/cli-extras.ts` 的 `getLimits`，用满的取最晚的）。被限流读不到时间时 5 分钟后再试；额度用完读不到时间（多半要充值）不等，超过 8 天的也不等。

判定只看失败那一行红色告警的分类（`quota` / `rate_limit`），不看模型回复。执行在 `server/tasks/quota-resume.ts`：`run.ts` 收尾时对话状态是 `failed` 就调 `quotaAfterFail`；接着做走「继续执行」同一个接口（`POST /tasks/:id/resume`），连带拉起子对话、父计划恢复等它都不另写。每一步（换成了什么、等到几点、为什么没接、没能拉起的原因）都在对话里写一行。

记录在对话的 `quotaResume`（`input` 是用户最近一条消息的 id，换了就从头算；同一条输入之后最多自动接 6 次）。等的时刻存在 `quotaResume.until`，新的一轮开始时清掉（用户自己重试、发消息都会让这次等待作废），面板重启后 `armQuota` 重新排上计时器。状态窗口最上面那句在等时写「等额度恢复 · 几点自动继续」，按钮是「现在继续」。

回归：`shared/quota-resume.test.ts`（判定）、`scripts/e2e/03-chat.mjs`「额度用完：按备用顺序换模型」、`scripts/ui/05-settings.mjs`「设置-额度用完或限流」。
