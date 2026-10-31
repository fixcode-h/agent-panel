# server：本机 API、JSON 存储、项目和任务管理

- status: analyzed
- source_paths: `server/`
- entry: `server/index.ts`
- analyzed_at: 2026-10-27（本轮把「自动压缩上下文」的默认值从「按 Agent 自己的规则」（0）改成 70%，并给设置加了 `defaultsVersion` 迁移版本；同日新增「子对话把禁止子对话执行的角色转交父对话」一条，并合入同日「运行区展示正在跑的工作流」；测试步骤那条追加了「以项目当前设置为准」；同日第三轮把「打开一个对话页时服务端重复付的代价」里剩下的 P1 全部改成现在的行为，并补上 4200 条对话的实测与四个回归测试；同日补「版本更新」一节：GitHub 403 限流时回退缓存、ETag/304、冷却与 `GITHUB_TOKEN`）；2026-10-28 图片附件改为直接放对话目录根（不再有 attachments/ 子目录），git 的更改列表和评审差异按任务上记的 placedAttachments 排除面板图片

## 职责

- 本机 HTTP API：Hono + `@hono/node-server`，只监听 `127.0.0.1`（因为会启动本机 CLI、读写项目目录），同时提供前端静态文件（生产模式由 `server/static.ts` 托管构建产物：gzip + 缓存头 + ETag，见下面的加载链路一节）。
- 数据存储：用户数据是数据目录（默认 `~/.agent-panel`）下的 JSON 文件，读写集中在 `server/store.ts`，任务单独存在 `server/task-store.ts`。
- 项目与任务：项目扫描和分类（配合 `shared/project-scan.ts`）、任务创建、排队、停止、续跑、任务快照（`server/tasks.ts`、`server/task-store.ts`）。
- 定时计划（左侧导航「计划」）：排期存在数据目录的 `config/schedules.json`（`server/schedules.ts` 用 `createCollection`，登记在 `server/store.ts` 的 `DATA_FILES` 里），随「数据」页的「配置」类一起统计占用、导出和导入（这一类按 `shared/data.ts` 不可清理）。面板进程在跑时按 `SCHEDULE_TICK_MS`（30 秒）轮询，到点用 `server/tasks.ts` 导出的 `startChat` 新建对话，和页面上 `POST /tasks` 走同一个 `createTask`（校验项目 / 角色、建独立分支、拷附件、启动执行），不另造执行链路。进程不在时到点的计划不补跑：超过 `SCHEDULE_MISS_MS`（60 秒）才算错过，只把时间往后推并记下 `missedAt`。写回运行状态前会重读一次，用户在这期间改过的排期不会被快照覆盖。每次到点启动成功 / 启动失败 / 错过 / 上游没成功，以及用户点「立即执行」（成功或失败），都在 `runs` 里追加一条 `ScheduleRun`（计划时间、实际发生时间、结果、是否手动、对话 id、原因）：新的在前，最多 `SCHEDULE_RUN_HISTORY` 条（`appendRun` 截断）；手动执行记 `manual: true` 且没有计划时间。运行记录是已经发生的事实，写回时**不随排期过滤**——用户改了排期，这次运行照样记上；分组和「最近一次结果」仍只按 `outcomeOf` 判，不读 `runs`。已知限制：`writeBack` / `runNow` 是「读最新 → 追加 → 整数组写回」，两个写入者恰好在彼此的 `store.get` 与 `store.update` 之间并发时，后写的会用旧数组覆盖对方刚追加的一条；窗口只在两次 await 之间，最多丢一条展示历史，不影响排期和 `outcomeOf`。彻底的修法是把追加合进 `createCollection.update` 的队列内合并，留作后续。 运行耗时：`schedulesApi` 的 `peekTask`（`server/index.ts` 传 `tasks.peek`，只读任务元数据）在每次轮询开头查一遍最近两天（`SETTLE_WINDOW_MS`）里启动、还没补耗时的运行，按 `settleRun` 在那条记录上补 `endedAt` / `durationMs` / `failed`，写回前重读计划、只替换补上的几条。POST / PUT 用 `scheduleTimingError` 拦「结束日期早于首次执行」；PUT 把已结束的计划的结束日期往后改时，过期的 `at` 先用 `nextRunAt` 推到现在之后（不先记一次错过）。
- 定时计划的接口：`GET/POST /schedules`、`PUT/DELETE /schedules/:id`、`POST /schedules/:id/run`（立即执行，不改排期，只记 `lastRunAt` / `lastTaskId` 和一条手动运行记录）；`server/index.ts` 启动时 `schedules.start()` 开始轮询，退出时 `stopSchedules()` 停掉定时器。
- 子对话分派（`server/tasks/children.ts` 的 `startChild`）：父对话通过 `create_conversation` 派出的子对话立即开始执行，没有子对话并发上限和排队；`startQueue` 只留作短暂的「启动中」标记。工作流节点、合并编译、后台命令等其他占位/排队不变。
- 子对话的完成流转只有一个入口（`server/tasks/children.ts` 的 `advanceChildTo` → `shared/task.ts` 的 `advanceChild`，按 `wrapup → plan → pending → complete → report → list` 走），但两个发起方的行为不同：**用户手动点「解决」**（`PATCH /tasks/:id` 的 `resolved: true`，也就是子对话面板标题栏那个按钮）传 `fromUser: true`，先进 `settleChildForUser`——**先**判停不掉的（这一轮在跑 `working`、工作流运行、待回答的提问 / 待确认的请求），不能先把在跑的子任务杀了再告诉用户解决不了；过了才用现成的 `stopHelper` 停掉 `slot === 'sub'` 还在跑的子任务并轮询等它们真的结束（上限 `HELPER_STOP_TIMEOUT_MS` 15 秒，停不下来返回 `helpers` 和是哪几项，不静默抹成完成），`background.stop` 停掉后台命令，写盘前再核对一次 `live` 里还是不是这一份任务（等待期间用户又发消息继续时 resume 会换成新对象，旧快照写回去会盖掉新一轮的消息和状态，和 `completeChild` 同一套检查），最后用 `shared/plan.ts` 的 `settlePlan` 把计划里没做完的步骤（含 `children` 子步骤、工作流那次运行的节点）收成完成，之后照常走 complete → report → list，不再因为「计划没做完」返回 409；**父对话收尾（`finish_child`）、一轮结束的自动收口、后台命令结束**都不传 `fromUser`，仍要求计划真做完，没做完就停在 `plan` 那一步交回 `plan`——父对话侧的动作不能把真没做完的工作盖成完成。即使用户点「解决」也仍如实拒绝的：这一轮还在跑（`working`）、子任务 15 秒内没停下来（`helpers`）、工作流还在运行（`workflow`）、还有待回答的提问 / 待确认的请求（`asking` / `requests`）；流转本身还要求后台命令都停了（`background`）、独立分支已经合回（`unmerged`）。演示版后端（`web/src/lib/demo-backend.ts` 的 PATCH 分支）同步调 `settlePlan`，否则演示里会停在「已解决但计划还有 n 步没做完」。回归：`shared/plan.test.ts`（未完成步骤连同子步骤递归收口、清掉等待说明、`closed` 计划收成 `done`、没有计划或已做完不动）、`shared/child-flow.test.ts`（同一份没收口的计划 `advanceChild` 仍被 `plan` 拦住，`settlePlan` 之后才走完 complete → report → list）、界面检查 `scripts/ui/02-task.mjs` 的「子对话-点解决后计划全部完成」。
- 子对话摘要把「已收起」一起交给前端（`GET /tasks/:id/children`，`server/tasks/children-routes.ts`）：每个条目在 `status` / `working` / 等待项之外多一个 `gone: taskGone(liveTask)`，判定就是 `shared/task.ts` 的 `taskGone`（归档，或独立分支被用户删掉），和运行区、执行中计数读同一处，不另写一套。演示后端 `web/src/lib/demo-backend.ts` 的 `/children` 返回同一个字段，前端 `web/src/lib/api.ts` 的 `taskChildren` 类型也有它。
- `/children` 的未读事实：每条再多两个时间戳 `turnDoneAt` / `turnSeenAt`（直接取内存任务或 `store.list()` 的摘要字段），前端靠 `shared/task.ts` 的 `taskTurnUnread` 判「做完还没看」（子对话行读 `childDoneDot`，和侧栏橙点 `taskDoneDot` 同一份口径）。只多两个时间戳，不为它读整份 `.messages.json`：`/children` 是热点，每 4 秒刷一次。演示后端 `web/src/lib/demo-backend.ts` 的 `/children` 回同样两个字段，演示数据里「汇总测试耗时」是一条完成未读的子对话。前端展示和回归见 `docs/modules/web/README.md` 的子对话切换下拉那一条。
- 删除独立分支（`POST /tasks/:id/worktree/discard`）成功后除了写 store，必须把新的 `worktree` 也同步回内存里那份任务（`entry.task.worktree = next` + `entry.rev++`）：`current()`、`/tasks` 列表摘要（`idle`）和 `/children` 都优先读内存副本，只写 store 的话接口会继续按旧的 `active` 算（`gone` 恒为 false，运行区和计数继续挂着），而且下一次 PATCH 还会拿旧 worktree 把 `discarded` 写回 `active`。回归：`scripts/e2e/05-workflow-edge.mjs` 的「删除独立分支后列表接口读到的也是已删除」。
- 任务「提问」开关与子对话的联动（`server/tasks/actions-routes.ts` 的 `PATCH /tasks/:id`，规则在 `shared/child-ask.ts`）：`askUser` 是这条对话允不允许提问（引擎按它决定让不让问），只影响这条对话自己，父对话开关不带动已有子对话（用户 2026-10-31 定的）；`childAskUser` 是「之后新建的子对话默认开不开提问」，右键菜单在 PATCH 里带上一次性的 `applyChildAsk` 决定已创建的子对话要不要一起打开（`applyChildAskUser` 逐条改 `askUser` 并落盘）；顶层对话的 `childAskUser` 固定默认 true，设置里没有全局默认。新建子对话的初始 `askUser` 只在一处算：`createTask`（带 `parentTaskId` 时）和引擎内建的 `createConversation` 都取父对话的 `childAskUser`。界面一侧的设置项、右键菜单和三层优先级见 [web 模块 README](../web/README.md)。子对话的提问交给谁（用户 2026-10-31 定的）：子对话自己的 `askUser` 关着时，提问工具由 invoke 回 `AUTO_ANSWER`、`message_parent`（question）和 `suggest_next_step` 由 `server/tasks/peer.ts` 的 `messageParent` 直接让它自己决定（记进 `pendingReport`，随一轮结束那封信交给父对话），什么都不往上交；开着时提问工具在 `server/exec/runner.ts` 的 `ask` 分支改走 `messageParent`（不在子对话里弹给用户），父对话 `askUser` 开着就挂 ask 卡片和子对话的 `parentAsks` 等用户选，关着就交给父对话的 AI 作答，答案都按回话交回子对话。回归：`server/child-ask.test.ts`、`server/engine-steps.test.ts`（子对话提示词按开关二选一）。
- 子对话合回后的父对话测试（`server/tasks/merge.ts` 的 `finishChildStep` → `server/tasks/test-runs.ts` 的 `startParentTests`，队列在 `server/parent-tests.ts`）：`scope === 'parent'` 的步骤（全量单测、全量界面检查、e2e，原 `runInParent`）不在子对话自己的分支里跑（只对子对话生效；父对话自己验证时走 `verifyBlock` 的全量启用步骤，见 [ADR 0018](../../adr/0018-test-steps-run-in-parent.md)），合并成功（`integrate`）后先写 `wrapRequest.state = 'testing'`、把计划里的收尾步骤标等待，再用子对话的 `changes` 跑 `pickSteps` 筛出这轮命中的步骤（一条都没命中就不跑；改动清单取不到时才全跑），把这一批排进队列——由面板在父对话目录里一次只跑一步，后台命令按 `exclusive` 和 UE 编译共用独占队，名字是「父对话测试：<子对话标题> · <步骤名>」，所以父对话运行区看得到谁在跑。全部通过才 `childMerged`（标完成、清 `wrapRequest`、按 `childFlowOf` 收口删分支）；失败把「来自子对话「标题」（id）」+ 失败步骤 + 用时 + 输出推回该子对话，状态记 `test-failed`（与「没合进去」的 `failed` 分开），子对话重新合并时全部重跑（不跳过）。耗时记进任务的 `Task.testRuns`；重启后 `recoverParentTests` 把 `testing` 的重新排队（从第一步重跑），`advanceChildTo` 的 `parentTest` hold 保证没跑完不标完成、不删分支。UE 的 `request_build` 不受影响，仍按 ADR 0004 走。
  **判断用的步骤以项目当前设置为准**：`parentRunRole`（提示词里谁跑）、`testStepsOf`（`parentStepsOf` 决定合回后要不要转父对话，`recordSelfTestRun` 按它匹配耗时）、engine host 的 `verify.steps`（这一轮提示词里的步骤清单）
  都过 `shared/test-steps.ts` 的 `currentTestSteps(task.testSteps, project)`：项目存在就用 `project.testSteps`，项目被删 / 读不到才用任务快照。
  所以改了项目设置，已开始的对话下一次判断（下一轮提示词、下一次子对话合并）就按新设置跑，不需要新建对话；
  命令在 `background.start` 派发时由当时的步骤算定，一条命令不会中途换成新命令。取项目的点各自只取一次（`deps.projects.get`），不在同一次判断里重读。
- 计划的推进与滞后检测（[ADR 0021](../../adr/0021-plan-model-lifecycle.md)）：后台命令结束仍走 `settleWait`（成功 `done`、失败 `failed`），子对话 / 子任务 / 合回 / 工作流结束照旧自动推进；`notePlanInput`（`server/tasks/child-messages.ts`）在用户消息、父对话交代任务进入对话时写 `activePlan.lastInputAt`（面板推送的后台命令结果、子对话状态上报不算——对应步骤已经自动推进过），`deliver` 和 `followUp` 两个入口都打点。`server/exec/runner.ts` 的 `runRealTurn` 在调引擎前用 `planNotice` 算一次提醒并 `log.warn('plan', …)`（确认「到底提醒过没有」），这一轮结束后把 `inputNotedAt` 记成 `lastInputAt`——同一句提醒只出现一次，对话选择「不改计划、说明一句」时不会被每轮追问。未带 `step` 的后台命令由引擎挂到当前进行中的步骤（`runningStepId`），以前这种长命令在计划里完全看不见。回归：`server/orchestrator.test.ts`（未带 step 自动挂进行中的那一步并变等待中；每轮提示含「现在：第 N 步」「⚠ 计划还停在」「新输入先判计划」「增量还是重开」）。

- 子对话把「禁止子对话执行」的角色转交父对话（`server/tasks/peer.ts` 的 `forwardSpawn` / `attachOrchestra`，[ADR 0019](../../adr/0019-agent-run-in-parent.md)）：引擎的 `spawn` 判定是子对话、角色 `runIn` 是 `parent` 时调 host 的 `forwardSpawn`，它同步判定父对话能不能接（先看 `live`，否则用 `task-store.ts` 新增的 `known()` 同步读内存里已加载的任务，不读盘）。能接：父对话的 AI 正在处理这一轮（`live` 里的 `orch` 只在 `runAgent` 期间挂着）就直接 `orch.spawn(..., { local: true })` 并在父对话里写一条「子对话 X 请求创建子任务 Y」的正式记录（子任务卡片挂在它上面）；其它阶段就排进内存里的 `forwards` 队列，`wakeConv` 只发一句短提示（正文只写一处，避免两条一样的请求），父对话下一轮开始调 AI 时由 `onOrchestra` 派出去。接不了（这个任务没有父对话、找不到父对话、父对话已归档、父对话自己也是被派出来的子对话）返回明确原因，子对话的步骤不标完成。排队只在内存里，重启后父对话只剩那条来源说明（转交本来就不阻塞子对话）。

- 设置的读取与默认值迁移（`server/settings.ts` 的 `getSettings`）：迁移逻辑在 `shared/settings.ts` 的 `migrateSettingsDefaults`，正式后端和演示后端（`web/src/lib/demo-backend.ts` 的 `/settings`）共用同一份，避免两边默认值不一致。读到 `backgroundLimit` 正好是旧默认值 16 时改成 64 并写回 `settings.json`，用户显式设过其他值的不动；旧设置里的 `childConcurrency` 读到时忽略。后台命令的全局兜底上限在 `server/background.ts` 的 `MAX_RUNNING`（64）。各 CLI 的 `autoCompact` 默认值从 0（按 Agent 自己的规则）改成 70%（常量 `AUTO_COMPACT_DEFAULT`），迁移时把存量 0 改成 70；因为 0 本身也是界面上的选项，这次迁移按 `Settings.defaultsVersion`（`SETTINGS_DEFAULTS_VERSION`）只做一次，`saveSettings` 保存时也写下当前版本，用户之后选回 0 不会被改回 70。
- 读一条后台命令的当前样子（`GET /tasks/:id/jobs/:jobId` → `server/background.ts` 的 `view(taskId, id)`，响应体是 `shared/schema.ts` 的 `TaskJobView`）：界面上点后台命令行标题打开的终端窗口按它轮询，命令的输出只在服务端内存的 `BgJob.lines`（`KEEP_LINES` 保留结尾 300 行），不进对话记录，所以必须单独有个读接口。返回 `state` / `code` / `output` / `createdAt` / `startedAt` / `endedAt` / `lastOutputAt`；`output` 是 `lines.join('\n')` 原文，不掺「跑完了」「退出码」这些面板的话（那是推回对话的 `jobOutput` / `resultText` 的事）。排队中、结束后都读得到（用户可能过一阵才点开，结束后要给最终输出和退出码）；归属按 `BgJob.taskId` 校验，跨对话读别人的编号一律当不存在返回 404，和 `/tasks/:id/processes` 只作用于自己子树是同一个口径。回归：`server/background.test.ts`（跑着能读到已输出内容、跑完读得到最终输出和退出码、跨 `taskId` 和不存在的编号读不到）、`server/task-job-view.test.ts`（路由层 404）。
- 进程与内存路由只作用于当前对话的子树：`/tasks/:id/processes`（列表和合计）、`/tasks/:id/processes/:pid/kill`、`/tasks/:id/processes/clean`、`/tasks/:id/processes/suggest`（AI 清理建议）、`/tasks/:id/memory`（内存曲线）都按 `subtreeIdsOf` 算出的「这个对话 + 它的全部后代」过滤（`shared/run-usage.ts` 的 `subtreeTaskIds`）。关闭进程和 AI 建议用同一集合校验 pid，清理只清子树里的登记残留，不会碰到列表外、属于祖先或兄弟对话的进程。合计只算子树的 CLI 进程：`totalMemory` / `MemoryPoint.total` = `cliMemory` / `cli`，面板自身内存走 `serverMemory` / `server`，不计入对话合计。
- CLI 相关：检测本机 CLI、读取模型列表、一键安装 / 更新 / 卸载（`server/detect.ts`、`server/models.ts`、`server/cli-packages.ts`、`server/install.ts`）。
- 面板能力给 Agent 用：进程内 MCP 工具，编排（`server/orch-mcp.ts`）、向用户提问（`server/ask-mcp.ts`）、UI 设计（`server/design-mcp.ts`）。`spawn_agents` 顶层的 `agent` / `tier` / `resume` 是整批默认值，顶层写错字段直接报错（以前只读 `tasks[i]`、顶层 `resume` 被静默丢掉，复看会退回默认「子任务」角色，见 [bugs/helper-resume-lost-role.md](bugs/helper-resume-lost-role.md)）；resume 命中时角色怎么定、`tier` 跟谁，规则在 [shared 模块 README 里「对话的执行计划」那一条](../shared/README.md)。
- 其他：附件和上传、文件系统接口、AI 创建 / 优化的提示词组装（`server/assist.ts`）、项目教训、导出、版本更新。
- 对话回收站（`server/tasks/trash.ts` 的 `DELETE /:id` → `enterTrash`、`GET /trash`、`POST /:id/restore`、`DELETE /:id/permanent`）：删除只做标记（`Task.deletedAt`，见 `shared/schema.ts`），任务记录、`*.messages.json`、独立分支、附件、聊天目录都先留着；保留期是 `shared/task.ts` 的 `TRASH_RETENTION_DAYS`（7 天），过期由 `cleanupTrash(now)` 物理删除（`purgeTasks`：store 记录、worktree、附件、聊天 / 交接目录），挂在 `server/index.ts` 的 `runCleanup` 上——和 `sweepStaleWorktrees` 同一节奏（启动后 10 秒一次、之后每小时一次），不另起定时器；`now` 可注入，测试用它造「7 天前删的」。进回收站前先 `stopTask` + `endBackground`，这一轮和后台上命令都停下来；删父对话时子对话一起标记（`parent` 原因），恢复时一起回来，`GET /trash` 只列顶层对话并带 `children` 计数。恢复时如果独立分支目录已经被清掉（`sweepStaleWorktrees` 或手工删了），把 `worktree` 置空（按共用目录继续）并回 `{ worktreeCleared: true }`，界面据此提示「恢复后需要重新执行」，不留一个指向不存在目录的 `active` 分支；不标成 `discarded`，那会被 `taskGone` 认成已收起、恢复后的对话直接显示「已完成」。已删除的对话从 `GET /tasks`、`GET /tasks/:id/children`、`GET /tasks/search`、启动迁移（`ready` 的 `restartInterrupted` 那段）和 `interruptedTasks` 里全部排掉，判定只用 `shared/task.ts` 的 `taskGone` / `taskDeleted`（`taskGone` 已把 `deletedAt` 算作「已收起」）；`sweepStaleWorktrees` 把有 `deletedAt` 的对话也算「在用」，保留期内不动它的分支目录。回归：`server/task-trash.test.ts`（删除/恢复/级联/过期清理/永久删除/分支目录已清理）、`shared/task-trash.test.ts`（`taskGone` 纳入删除、保留期剩余天数）、界面检查 `scripts/ui/05-settings.mjs` 的「回收站-列出已删除的对话」「回收站-恢复后」。
- 对话内容搜索（`GET /tasks/search?q=&limit=`，`server/tasks/list-routes.ts`）：按 `updatedAt` 倒序扫任务的 `*.messages.json`，只回命中片段 + `taskId` + `messageId` + 命中条数，不回整条消息；三个预算任一用完就停（扫多少个对话、回多少条、读进多少字符，常量在 `shared/task-search.ts`），同一个对话最多 3 条命中，进了回收站的不参与。片段截取（正文压成一行、命中词两侧各留 36 字、高亮位置）也在 `shared/task-search.ts`，前后端共用同一份口径。对话文件按 `updatedAt` 缓存（`cachedMessages`，最多 40 个对话 / 800 万字符），边输边搜时不会每次把几十个几 MB 的对话重新读一遍；读消息走 `task-store.ts` 的 `readMessages()`，不经过 `get()` 的 full 缓存（搜索会扫几十个对话，不能把用户正在看的那份挤出去）。实测（4.8 万条消息、60 个对话的数据目录）：冷启动首屏 49ms，同一实例缓存热 3ms，无命中扫满 60 个对话 109–145ms。回归：`server/task-search-route.test.ts`、`shared/task-search.test.ts`。
- 工作总结（`server/summary.ts`）：两步走。`POST /summary/extract` 起一个提炼 job（页面轮询 `/summary/jobs/:id`，可 `stop`）：来源是「对话」时取面板里加过的项目在窗口内有活动的任务（`activeInRange` 先筛、再按 id 读完整对话），来源是「报告」时取窗口内的已有报告（`reportsInWindow`）；没有材料时不跑 CLI，直接给空分项。用「每日工作总结」角色（`summaryRole`：本机那份，删了用内置定义）的 CLI / 模型在项目目录里只读跑，提示词是角色设定（`summaryRoleText`，参数 `material=面板提供`，不带引入的「通用约束」）+ `extractPrompt`；回答用 `parseExtract` 解析成分项，解析不了带原因重试一次，仍不行就报错。`POST /summary` 只用页面传来的采纳分项按 `renderReport` 拼报告并保存（不再跑 CLI），`PUT` / `DELETE /summary/:id` 编辑、删除；报告存在 `tasks/summaries.json`，上限 `SUMMARY_KEEP`（只是防止无限长大）。`GET/PUT /summary/config` 存面板里加过的项目（`config/summary.json`）。
- Skills / 命令库（`server/library.ts`）：各 CLI 用户目录下的 Skill 和自定义命令的列表、读写、复制、删除；一个 Skill 目录里的多个文件（`SKILL.md` 以外的脚本、参考文档）走 `/library/entry` 的读 / 写 / 删 / 改名，见下面的「技能库的多文件管理」。
- 联网搜索代理（`server/web-search.ts`，挂在 `/api/web-search`）：CLI 的 `web_search` / `web_fetch` 打到面板，由面板按「设置 · 联网搜索」里的搜索源、密钥和地址代发请求，密钥不下发给扩展。请求用的基址由 `resolveSearchEndpoint(cfg)` 解析（`doSearch`），不再直接取 `cfg.endpoint.trim() || provider.endpoint`：`endpoint` 的归属（`Settings.webSearch.endpointProvider`）对不上当前源时按当前源的默认地址走，切源时上一源留下的旧地址不会被采信——采信了就会把请求打到旧主机，回来只有 404 或不是 JSON 的响应，看不出是地址残留；归属为空（旧设置）或就是当前源时照旧用用户填的地址；`searxng` 没有默认地址，回落为空串、由这里报「搜索源 … 需要填写地址，请在「设置 · 联网搜索」里补上」。默认源 deepseek（DeepSeek 官方 Search API）没填密钥时回 400「搜索源 … 需要密钥」，不发请求、也不回退到别的源；query 拼上 `site:` 超过 128 字时 `provider.build` 抛的错同样回 400。地址里带这一轮 CLI 的随机地址（和提问桥接共用，路由用 `server/ask-mcp.ts` 的 `hasAskSession` 核对），访问令牌打开时也能用；`server/auth.ts` 对这个前缀放行、由路由自己核对。参数 / 地址守卫生效顺序是「同步能查的（协议、凭据、主机名形态、IP 字面量）→ 域名解析结果 → 每一跳重定向」，跳转手动跟着走（最多 `FETCH_MAX_REDIRECTS = 5`），抓取结果按 100000 字符窗口返回、同一地址 15 分钟内用缓存（`CACHE_BUDGET_CHARS` 限总量）。参数错误回 400、上游和网络错误回 502，`{ error }` 里是带原文的那句话，交给模型和用户看。单测 `server/web-search.test.ts`（网络和 DNS 都是桩）。
- 出网请求（`server/net.ts`）：面板访问 GitHub 的统一入口 `netFetch`，按「设置里的代理 → 环境变量 → 直连」出网，直连或配置的代理失败后自动改用本机正在运行的代理重试；版本更新和安装包下载都用它，见下面的「GitHub 出网与代理回退」。
- 候选教训草稿区（`server/lesson-drafts.ts`，接口 `/lesson-drafts`）：`GET /` 列表、`POST /` 从一份报告提炼（`{ reportId }`，只补草稿区还没有的条目：`missingDrafts` 按提炼依据判重，不整份重新生成——在的草稿用户可能已经改过，覆盖掉就是静默丢他的东西；丢掉一条后再点提炼能找回来，返回 `{ drafts, created, info }`）、`PUT /:id` 编辑、`DELETE /:id` 丢弃。提炼规则在 `shared/lesson-draft.ts`（纯函数，单测在 `shared/lesson-draft.test.ts`），草稿存在 `lesson-drafts.json`，**不会写进 docs/lessons/**：落到哪个分片由用户看过后手动写。
- 项目更新时的字段保留与校验（`server/index.ts` 的 `parseProject`、`PUT /projects/:id`）：请求没带 `initResult` 时保留旧值（和 `lessons`、`initializedAt` 同一套做法），带上的用 `ProjectProposalSchema` 严格校验，不合法直接拒绝；初始化推荐因此随项目持久化，重开设置还能应用。初始化对话跑完交回结果走单独的 `PUT /projects/:id/init-result`（同文件）：服务端自己读最新项目，再用 `shared/project-init.ts` 的 `withInitResult` 只合并 `initResult` / `initializedAt`（时间取本次完成），不碰别的字段；结果要等对话跑几分钟才回来，整份 PUT 会把客户端手里过期的快照（用户这期间应用的推荐、改过的设置）写回旧值，见 [web 的 Bug 记录](../web/bugs/init-apply-overwritten-by-snapshot.md)。

## server/tasks.ts 拆分后的位置（ADR 0033）

文档、教训和 Bug 记录里写「`server/tasks.ts` 的 `xxx`」的，函数名没变，按下表找所在文件。`tasksApi` 本身只留共用状态、小工具、路由组装和对外接口；模块经 `TasksScope`（`server/tasks/scope.ts`）取闭包里的名字。

| 文件                                              | 内容                                                                                                                                                                                                                                                                | 主要函数                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `server/tasks.ts`                                 | 共用状态和小工具、路由组装、对外接口                                                                                                                                                                                                                                | `tasksApi`、`current`、`peerOf`、`placeInTask`、`autoArchive`                              |
| `server/tasks/run.ts`                             | 开始一轮、接着说、消息交付、卡住重开                                                                                                                                                                                                                                | `start`、`followUp`、`deliver`、`restartStalled`                                           |
| `server/tasks/children.ts`                        | 子对话生命周期：计数、彻底完成的推进、合回、上报、一轮结束推进计划、启动子对话                                                                                                                                                                                      | `advanceChildTo`、`reportChild`、`nudgePlan`、`closeChildren`、`startChild`、`ruleCommand` |
| `server/tasks/merge.ts`                           | 子对话收尾：`submit_merge`、编译请求、就地微改动、`finish_child`、父计划等待步                                                                                                                                                                                      | `submitMerge`、`finishChild`、`finishChildStep`、`syncParentPlan`                          |
| `server/tasks/child-messages.ts`                  | 父子之间的通知（ADR 0034：随父对话停下的中断、用户直接交代只改父计划不发信；同一子对话没读的汇报新的替换旧的；AI 的阶段汇报由 `reportChild` 并进一轮那一封）                                                                                                        | `noteParent`、`sendToChild`、`trackUserToChild`、`notePlanInput`                           |
| `server/tasks/peer.ts`                            | 子对话传话给父对话、转交子任务                                                                                                                                                                                                                                      | `messageParent`、`forwardSpawn`、`attachOrchestra`                                         |
| `server/tasks/asks.ts`                            | 提问和确认、叫醒对话                                                                                                                                                                                                                                                | `wakeConv`、`answerChildAsk`、`delegateAsk`、`settleAsks`                                  |
| `server/tasks/edit-worktree.ts`                   | 独立分支：合并排队、恢复和开出 worktree、`begin_edit`                                                                                                                                                                                                               | `mergeLock`、`ensureChildWorktree`、`beginEdit`                                            |
| `server/tasks/jobs.ts`                            | 后台命令的结果推回、列表、结束                                                                                                                                                                                                                                      | `background`、`endBackground`、`withJobs`                                                  |
| `server/tasks/test-runs.ts`                       | 父对话代跑测试、记录结果、重启后接着等                                                                                                                                                                                                                              | `startParentTests`、`recordSelfTestRun`、`recoverParentTests`                              |
| `server/tasks/idle-ask.ts`                        | 子对话没输出时自动询问                                                                                                                                                                                                                                              | `askIdleChildren`、`armIdleAsk`                                                            |
| `server/tasks/budget.ts`                          | 父对话用量上限：每轮结束按整棵对话树核一次，80% 提醒、用满停下（StopReason `budget`），算法在 `shared/budget.ts`                                                                                                                                                    | `checkBudget`                                                                              |
| `server/tasks/keepalive.ts`                       | 停止、保活上限与回收、进程面板                                                                                                                                                                                                                                      | `stopTask`、`keepAliveBusy`、`enforceKeepAlive`、`processPanel`                            |
| `server/tasks/startup.ts`                         | 启动迁移、合并中退回                                                                                                                                                                                                                                                | `migrateOnStart`、`reopenMerge`                                                            |
| `server/tasks/state-sweep.ts`                     | 定时核对                                                                                                                                                                                                                                                            | `createStateSweep`                                                                         |
| `server/tasks/trash.ts`                           | 回收站                                                                                                                                                                                                                                                              | `enterTrash`、`purgeTasks`                                                                 |
| `server/tasks/*-routes.ts`                        | 接口：`list`（列表、搜索、回收站、保活）、`children`、`process`（子任务 / 后台命令 / 进程 / 内存）、`read`（SSE、整份对话、导出导入）、`conversation`（新建、发消息、预热、继续执行）、`worktree`、`files`、`actions`（改设置、倒回、分叉、压缩、评审、停止、回答） | `createTask`、`prewarmChat`、`resumeKids`、`taskDir`、`childUnmerged`                      |
| `server/tasks/helpers.ts`、`types.ts`、`scope.ts` | 不依赖闭包的常量和小工具、`Live` 等类型、`TasksScope` 和 `lazyScope`                                                                                                                                                                                                |                                                                                            |

新功能放进对应模块，别加回 `server/tasks.ts`：它在 `scripts/file-caps.json` 里有行数上限（规则检查第 15 条）。

## 入口

- `server/index.ts`：路由登记和启动；第一行先加载 `server/lang.ts` 定界面语言。
- `server/net.ts`：需要访问 GitHub 的请求的统一入口 `netFetch(url, init)`（`init` 是 `RequestInit` 加可选的 `timeoutMs` 和 `onAttempt`）；`timeoutMs` 只限制等到响应头的时间，之后读 body 不受影响，不传就一直等；`onAttempt` 在每次尝试（含回退到另一条路）前调用，供调用方重置自己的空闲计时。
- `server/exec/`：真实调用 CLI 的部分单独成模块，见 [server-exec](../server-exec/README.md)。

## 依赖

`shared/` 的数据结构和 CLI 定义、`hono`、`zod`、`cross-spawn`（Windows 上调用 npm 安装的 `.cmd`）、`undici`（`ProxyAgent` 和走代理的 `fetch`，只在 `server/net.ts` 用）。定时计划的规则全在 `shared/schedule.ts`：服务端只按它判断到没到点、执行后怎么往后推，不自己再算一套。

## 打开一个对话页时服务端重复付的代价（2026-10-26 实测，2026-10-27 两轮更新）

单次打开对话页会打到下面几组接口，它们合起来就是「打开慢」的服务端那一半（热数据、本机 loopback，均已复测）。**2026-10-26 的数字是优化前的基线，保留作背景；下面这些到 2026-10-27 都已改掉——第一轮是 `/seen`、`/presence`、静态资源 gzip + 长缓存，第二轮是打开对话分页、SSE 增量首包、`/children` 两档轮询、`GET /tasks` 的 ETag、子对话计数的共享缓存。每条后面写的是现在的行为和实测，这一节已经没有遗留的 P1 待办。**

- **`/seen` 不再读整份对话、也不再回完整任务（2026-10-27 已完成）**：`current()`（`server/tasks.ts:493`）→ `store.getFull`（`server/task-store.ts:448`）每次都 `readJson` + `TaskMessage.array().safeParse` 整份 `.messages.json`，2.0MB / 611 条的那份实测 91–133ms；`POST /seen`（`server/tasks.ts:4323`）以前走的就是这条路径，还把完整任务 2467KB 原样回给前端（前端只拿它做 apply）。现在它取 `live` 里那份、没有才 `getMeta`，只回 `{ turnSeenAt }`（`shared/schema.ts` 的 `TaskSeenResult`）；要落盘时走 `server/task-store.ts` 的 `updateMeta()`——只改任务记录文件，**不读也不写 `.messages.json`**，并且带 `keepUpdatedAt: true`，所以「只是看过了」不算任务更新，列表顺序和更新时间都不动。
- **`/presence` 只做存在性检查（2026-10-27 已完成）**：`POST /presence`（`server/tasks.ts:4312`）以前同样走 `current()`，为一次心跳把整份对话读一遍再校验。现在只用 `getMeta(id)`（`server/tasks.ts:504`，底层 `store.getMeta` 只查有没有这条任务），之后照旧只动内存里的 viewer。
- **`GET /:id/events` 首包能只发增量（2026-10-27 第二轮已完成）**：以前建连后先发一次 `full`（实测 2726KB，和那次 `GET /:id` 是同一份数据）。现在建连时读浏览器重连自动带的 `Last-Event-ID`、或首次建连由页面带的 `?rev=`，交给 `shared/task.ts` 的 `taskRevOffset(messages, rev)` 判「页面上那份是不是当前对话的前缀」：版本由 `taskMessageRev` 拼成 `<条数>:<最后一条消息 id>`，对得上就返回补发起点（**含最后一条**，正在流式增长的那条不会漏），对不上返回 -1。对得上发 `patch`（`{ meta, messages: messages.slice(offset), total }`），对不上才发 `full`；两种事件都带 `id: <版本>`，浏览器自己记住它，重连时当 `Last-Event-ID` 带回来。消息被删（返工时重跑节点）或换了对话一律回 `full`，不猜着拼。实测同一份 4200 条 / 6.11MB 的对话：首包 `full` 6,401,764 字节 / 130.2ms → 带 `rev` 的 `patch` 78,851 字节 / 5.9ms。
- **`GET /:id/children` 的 git 结果留更久、前端按状态分档（2026-10-27 第二轮已完成）**：每个子对话一次 `childWorktree` → `worktreeStatus`（4 条 git），首跑实测 1131ms，之后靠 `worktreeSeen` 的 TTL 降到 2–10ms。`UNMERGED_TTL` 从 10s 提到 **15s**（和前端静止档对齐，没合并的分支状态 15 秒内不重复跑 git），`STOPPED_TTL` 仍 60s。前端不再固定每 4 秒刷一次：`web/src/components/tasks/TaskView.tsx` 的 `CHILD_POLL_ACTIVE_MS`（4000）/ `CHILD_POLL_IDLE_MS`（15000）按「有没有在跑」分档，判定读 `shared/task.ts` 的 `childSpinning`（和子对话行的图标、执行中计数同一处，不另写一套），**列表为空时一次都不轮询**——子对话产生由 SSE 推来的 `childrenWorking` / `childrenCli` 和上报信号 `childSignal` 触发重拉（`childrenReload` ref）。实测：有子对话但都静止时请求间隔 15.2 / 15.0 / 15.0 / 15.0 秒；没有子对话时 12 秒内只有首拉 1 次、之后 0 次。
- **`GET /:id` 可以只回最近一段（2026-10-27 第二轮已完成）**：`?limit=N` 只回最近 N 条、`?before=<messageId>` 取这条之前的 N 条（往前翻页的锚点），纯函数是 `shared/task.ts` 的 `messagePage`；响应体在任务之外多带 `messageTotal`（完整条数）和 `messageHasMore`（还有更早的），**整份都在这一份里时**再带 `messageRev`（`taskMessageRev` 的版本，前端建 SSE 时带上它，首包就只补发增量；截断的那段不是整份的前缀，不能当版本用）。**不传参数行为完全不变**（导出、AI 处理、老版本页面照旧拿整份）。锚点找不到时（那条消息被返工删掉了）取最早的一段而不是尾部那页，否则前端一条都接不上、卡在同一页。实测同一份对话：全量 6,401,729 字节 / 63.3ms → `?limit=50` 77,310 字节 / 3.9ms，`?before=` 同样 77,310 字节 / 2.1–14.6ms。演示后端 `web/src/lib/demo-backend.ts` 的 GET 单任务同步支持这两个参数。
- **`GET /tasks` 带 ETag（2026-10-27 第二轮已完成）**：列表被前端每 2.5 秒拉一次（有任务在跑时），以前每次都要 `store.list()` + 序列化 79KB。现在对最终响应体算 sha1（`createHash`）当 `ETag`，`If-None-Match` 命中就回 304、不带响应体。前端 `web/src/lib/api.ts` 的 `allTasks` 带上次的 `If-None-Match`，304 时返回 `null`，`web/src/lib/data.tsx` 的 `reloadTasks` 收到 `null` 不动 state（侧栏不重渲染）。实测：第一次 200 带 ETag，带 `If-None-Match` 再请求 304、0 字节。
- **SSE 每秒的全量扫描改成共享缓存（2026-10-27 第二轮已完成）**：以前每秒对每个打开的对话各调一次 `activeChildren` / `cliChildren`，每次内部都 `store.list()` 全量遍历。现在统一走 `server/tasks/children.ts` 的 `childCountsOf(parentId)`（`CHILD_COUNT_TTL = 1000`）：一次 `store.list()` 把所有父对话的 `childrenWorking` / `childrenCli` 都算出来，`activeChildren` / `cliChildren` / `withLive` 都读它，多个打开的对话共享同一份。实测：两个对话各开一条 SSE 连接跑 10 秒，`store.list` 调用 40 次 → 11 次。
- **静态资源改成 gzip + 长缓存（2026-10-27 已完成）**：托管从 `serveStatic`（原 `server/index.ts:1053`）换成 `server/static.ts` 的 `serveDist` / `serveIndex`（挂在 `server/index.ts:1056`）。文本类型（js / css / html / json / svg / map / webmanifest 等）用 Node 内置 `zlib` 的 gzip（level 6），压缩结果按文件缓存、同一文件的并发请求只压一次、构建产物换了（mtime / 大小变）就重压；字体和图片本身已是压缩格式，不压。`/assets/*` 的文件名带内容哈希，回 `public, max-age=31536000, immutable`；`index.html` 和其余不带哈希的文件回 `no-cache`（每次校验，命中就是 304），发版后一定拿得到新入口。两者都带 `W/"…"` 的 ETag 并处理 `If-None-Match`，gzip 与未压缩两份的 ETag 分开（否则会拿压缩版去回不要 gzip 的请求），可压缩类型一律带 `vary: accept-encoding`。**只作用于打包产物**：`npm run dev` 下前端仍由 Vite 自己服务，完全不经过这套缓存头。SPA 兜底照旧——`serveDist` 找不到文件就交给 `serveIndex`，所以任何找不到的路径（含 `/assets/*`）都回 `index.html`（200 + HTML），排查「资源 404」时用 content-type 判。

本次实测（同一份 2.12MB / 1000 条消息的对话，本机 loopback、预热 OS 缓存，`curl -s -o /dev/null -w '%{size_download} %{time_total}'`）：

| 请求                                      | 改前                                                                                                  | 改后                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `POST /api/tasks/:id/seen`                | 以前走 `current()`、回整份任务：本份是下一行的 2,125,105 字节，2.0MB / 611 条那份实测 2,467KB / 133ms | 41 字节 / 1.0–1.1ms                                             |
| `GET /api/tasks/:id`（旧 `/seen` 也走它） | 2,125,105 字节 / 11–21ms                                                                              | 带 `?limit=50` 只回最近 50 条（数字见下面第二轮那张表）         |
| `POST /api/tasks/:id/presence`            | 与上面同一条路径（`current()`）                                                                       | 204 / 1.3–2.3ms                                                 |
| `index-tnFgKEWT.js`                       | 705,555 字节（未压缩）                                                                                | 200,850 字节（gzip）                                            |
| `fonts-DFrIiuit.css`                      | 459,218 字节（未压缩）                                                                                | 200,798 字节（gzip）                                            |
| woff2 字体                                | 不压缩                                                                                                | 不压缩（已是压缩格式）                                          |
| `index.html`                              | 3604 字节、无缓存头                                                                                   | 3604 字节、`cache-control: no-cache`，带 `If-None-Match` 回 304 |

整页对比（headless chromium、禁缓存、同一份对话）：改后 ready **575ms**、**75 个请求**、resource timing 传输合计 **3.86MB**（js 822KB / css 219KB / 字体 630KB / API 2.28MB）；改前基线是 ready 1.6–2.4s、114–119 个资源、9.4–10.2MB（见 [web 模块](../web/README.md) 同一段实测）。resource timing 之外还有一次性的 SSE 首包（当时是 `full` 2,125,149 字节），第二轮已改成带 `rev` 的 `patch`，见上面 `/events` 那条。

前端配套：`web/src/components/tasks/TaskView.tsx` 的 `applySeen` 用 `web/src/lib/tasks.ts` 的 `withTurnSeenAt` 把返回值合进本地，未读判定仍只在 `shared/task.ts` 的 `taskTurnUnread` / `taskDoneDot`（细节见 [web 模块](../web/README.md)）。回归：`server/task-seen.test.ts`（`/seen` 只回 `{ turnSeenAt }`、不改非对话字段时对话文件一个字节都没被重写、已看过时什么都不改、`/presence` 不改对话文件且任务不存在时 404、`updateMeta` 同步内存里那份完整对话）、`server/static.test.ts`（文本资源 gzip 变小、`/assets/*` 长缓存、不要 gzip 的客户端拿原文、字体不压、入口页 no-cache、内容没变回 304 且两份 ETag 分开、越界路径交给 SPA 兜底、`q=0` 不算接受 gzip）、`web/src/lib/tasks.test.ts` 的 `withTurnSeenAt`。

第二轮之后的页面配套（细节见 [web 模块](../web/README.md) 的「打开对话页的加载链路」）：`TaskView.tsx` 打开时一律带 `limit=OPEN_MESSAGE_LIMIT`（50），`loadEarlier` 用 `?before=<最早那条>` 往前翻，分页信息跟当前那份任务走（`truncated`），SSE 推来整份后收起「显示更早的消息」；建连的 `boot` 带 `?rev=` 只在手上有整份时才有值，没有基线就先不建连（否则服务端发的增量合并不了）；`web/src/lib/api.ts` 的 `task(id, { limit, before })` 只拼真正给了的参数，不拼出结尾的 `?`。

优化优先级（按收益/风险）与进度：

1. seen 只回 delta（或直接 204）——**2026-10-27 已完成**，现在只回 `{ turnSeenAt }`；
2. presence 用 `getMeta` 而不是 `current`——**2026-10-27 已完成**；
3. SSE 支持「我已经有到 X 版本」直接发 patch——**2026-10-27 第二轮已完成**（`?rev=` / `Last-Event-ID`，对上前缀发 `patch`，对不上发 `full`）；
4. children 把 git 结果缓存拉长或改成按需——**2026-10-27 第二轮已完成**（`UNMERGED_TTL` 15s，前端空列表不轮询、静止 15s、在跑 4s）；
5. 给静态资源加压缩——**2026-10-27 已完成**（gzip + 长缓存 + ETag）；
6. 打开对话只回最近一段——**2026-10-27 第二轮已完成**（`?limit=` / `?before=`，首屏 6.11MB → 77KB）；
7. 列表接口带 ETag、子对话计数共享一份——**2026-10-27 第二轮已完成**（304 不带响应体；SSE 空闲扫描 40 次 `store.list` → 11 次）。

第二轮实测（本机服务 + 真实前端，数据是一份 **4200 条消息 / 6.11MB** 的对话；没换机器、没清 OS 缓存，和上面第一轮那张 2.12MB 的表不是同一份数据，不要跨表对比绝对耗时）：

| 请求                                  | 改前                     | 改后                                      |
| ------------------------------------- | ------------------------ | ----------------------------------------- |
| `GET /api/tasks/:id`（全量）          | 6,401,729 字节 / 63.3ms  | ——（不传参数仍是这个行为）                |
| `GET /api/tasks/:id?limit=50`         | ——                       | 77,310 字节 / 3.9ms                       |
| `GET /api/tasks/:id?limit=50&before=` | ——                       | 77,310 字节 / 2.1–14.6ms                  |
| SSE 首包（`full` → `patch`）          | 6,401,764 字节 / 130.2ms | 78,851 字节 / 5.9ms（带 `rev`）           |
| 打开一个对话的总传输                  | 12.21MB（同一份传两遍）  | 6.18MB（GET 最近 50 条 + SSE 首包 patch） |
| `GET /api/tasks`                      | 每次 200 + 79KB 序列化   | 带 `If-None-Match` 时 304 / 0 字节        |
| SSE 空闲时 `store.list` 次数          | 两个对话开 10 秒 = 40 次 | 11 次（`CHILD_COUNT_TTL` 共享缓存）       |

第二轮的回归测试（本轮新增四个单测文件，按用例说明）：分页与版本的纯函数单测（`messagePage` 切片、锚点找不到时取最早一段、`taskMessageRev` / `taskRevOffset` 对号与对不上）、路由层单测 `task-open-page`（`limit` / `before`、响应带的 `messageTotal` / `messageHasMore` / `messageRev`、SSE 首包按 `rev` 发 `patch` 或 `full`）、`task-list-etag`（ETag / 304 / 数据变化换 ETag）、`task-children-count`（子对话计数正确、缓存命中结果一致）。

## 数据落盘与损坏恢复

用户数据都是数据目录下的 JSON 文件，写入集中在 `server/store.ts` 的 `writeJsonAtomic`，任务记录和对话文件在 `server/task-store.ts`。断电、强制重启后「文件长度对得上、内容全是 `0x00`」是这里必须防住的失败模式（起因见 [bugs/restart-lost-conversations.md](bugs/restart-lost-conversations.md)）。

**写入路径**：`open(tmp)` → `writeFile` → **`fh.sync()`** → `close` → `rename(tmp, file)` → `fsyncDir(父目录)`。

- **每次写都 fsync 临时文件**，不能省：`rename` 是原子的，但它只保证「名字换代」，不保证数据已经在盘上。省掉 fsync 就会在断电后读到空洞文件。
- **fsync 失败就不 rename，直接抛错**：留着旧文件比换成一个可能全 0 的新文件安全。
- **rename 之后刷父目录**（`fsyncDir`）：Windows 上打不开目录句柄，`process.platform === 'win32'` 时直接跳过；其他平台打开或 fsync 失败也静默跳过（部分网络盘、容器挂载不支持）。目录项丢了最坏是回到上一个版本的文件，不会出现内容全 0 的文件。
- **性能**：消息文件前面有 `MSG_GAP`（400ms）合并窗口，流式输出时每秒最多几次写盘，fsync 的代价被摊掉；`compact` 参数只影响是否缩进，走同一条落盘路径。

**读取路径**：三种状态分开。

| 函数                                    | 返回                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `readJsonDetailed(file)`                | `{ state: 'missing' }` / `{ state: 'ok', value }` / `{ state: 'broken', broken: { file, backup, reason, size } }` |
| `readJson(file)`                        | 旧签名，返回 `readJsonDetailed().value`（坏文件和不存在都得到 `undefined`），老调用方不用改                       |
| `archiveBrokenFile(file, reason, size)` | 把文件挪进 `cache/broken/<原文件名>.broken-<时间戳>` 留档，返回同一份 `BrokenJson`（`archived` 说明真的挪走没有） |

留档约定：坏文件**只挪不改**，原始字节原样保留；旁边另写一份 `<backup>.broken.json` 说明（`file` 原路径、`backup` 备份路径、`reason` 原因、`size` 字节数、`at` 时间、`stamp`）。备份名已被占用时自动往后加序号（`-2`、`-3`…），同一毫秒里归档两次同名文件不会覆盖前一份。`archived: false` 表示文件被别的进程占着没挪动，它还在原位，下次启动会再处理一遍——日志会写明，不让调用方以为已经留档。除了 JSON 解析失败，「能读成 JSON 但内容用不了」的文件（任务记录、对话文件）也走 `archiveBrokenFile`，免得每次启动重读同一个用不了的文件。例外：`server/settings.ts` 的「JSON 能解析但字段不合法」分支仍是自己 `rename` 到 `cache/broken/`、不写 `.broken.json` 说明（那里只求不让每个接口都 500）。`cache/broken/` 是缓存目录，设置里清理缓存会一起删掉。

**任务记录丢失时的自动恢复**：`server/task-store.ts` 的 `load()` 在同一次扫描里同时收集 `<id>.json`（任务记录）和 `<id>.messages.json`（对话），对「有对话、但记录缺失或坏掉」的 id 调 `rebuildMeta()`。

- **什么时候重建**：对话文件能读出来、且 `TaskMessage.array().safeParse` 通过，反推出的记录也过 `Task.safeParse`。重建出的记录形态固定：`mode: 'chat'`、`status: 'stopped'`、`stopReason: 'restart'`、`simulated: false`、标题取用户第一句（没有用户消息时 `t('恢复的对话')`）、`createdAt` / `updatedAt` 取首尾消息的 `at`、`messages` 只放用户消息、`turnSeenAt` 取最后一条消息（不亮成未读）。写回磁盘后放进内存的 map，下次启动不用再重建。
- **什么时候只留档不重建**：对话文件本身坏了 / 全 0 / 能读成 JSON 但不是消息数组 / 是空数组，或者反推出的记录过不了 schema。这时不写任何任务记录（不伪造、不写半截），把用不了的文件归档并打出带 id 和字节数的日志。归档后下次启动看不到它，因此不会反复重试。空对话不重建一个 0 条消息的空任务（断电后可能出现「记录全 0 + 对话为 `[]`」）。
- **对话文件读不出来时不拖垮列表**：`rebuildMeta()` 的读取包在 try/catch 里，`EBUSY` / `EPERM` / `EACCES` 这类读错误只跳过这一个任务并打日志，下次启动再试；`all()` 里一次读失败会清掉 `loading`，下一次请求重新读，不让瞬时错误变成永久故障。
- **原记录没能留档时不覆盖**：`archiveBrokenFile` 返回 `archived: false`（文件被占用）时，重建只让任务本次可见、不写盘，原文件一个字节不动，下次启动再处理。日志也据此区分「已留档」和「没能挪进缓存目录」。
- **记录过不了 schema 时先留档再重建**：不直接覆盖原文件，原来那份（可能手修一下还能用）保留在 `cache/broken/` 里。
- **已有任务记录的 id 不会被重建覆盖**（用户自己改过的标题不能被盖掉）。重建写盘失败只打日志，本次启动仍然让它可见，下次启动再试。

**给以后改这块的人**：新增数据文件时用 `writeJsonAtomic`，别直接 `writeFile`；判断「数据不存在」之前先想清楚「文件坏了」和「文件没有」是不是一回事，需要区分就用 `readJsonDetailed`，不要拿 `readJson` 的 `undefined` 同时表示两种含义。

## 对话专属日志

每个对话在对话文件旁边有一份自己的日志：`tasks/projects/<项目 id>/<对话 id>.log`（聊天在 `tasks/chats/`），由 `server/task-log.ts` 的 `taskLog(id, 事件, 字段)` 写，一行一件事：`2026-10-30 09:07:12.123 [收到消息] messageId=… live=true status=running awaitingUser=true`。全局日志（`server/log.ts`）按启动分文件、各对话混在一起且主要记报错；这一份只回答「这个对话经历了什么」，查「消息发出去却没了」这类问题时先看它。

- 记的事件：收到消息（当时的执行位、状态、是否在等下一句）、走了哪条交付路径（等下一句 `wait=ok/none/stale`、插话 `how=steer/notes/held`、卡住重开、新开一轮、执行位被占被拒）、最后「消息已记下 / 消息没有记进对话」、启动 / 执行结束（状态、停止原因）、对话 CLI 进程启动和结束、停下等下一句 / 等子任务及其结束、取消等待、标成卡住、停止（原因）、预热、激活 / 关闭 Agent、用户停止。
- 不记模型输出；消息正文只留开头 80 字，字段超过 200 字截断。写满 2 MB 改名成 `.log.1`（只留一份旧的）。删除对话时连同日志一起删（`task-store` 的 `remove`）。
- 路径由任务存储注册（`setTaskLogPath`），只认内存里已知的对话；写失败吞掉，不影响执行。
- 新加会改变消息去向或对话状态的路径时，同时在这里补一行 `taskLog`。

## 附件落盘：只有图片拷一份进对话目录根，其它文件只引用原路径

- 只有图片（`shared/composer.ts` 的 `attachChip` 判出的 image：mime 是 `image/` 或扩展名是 png/jpeg/gif/webp/bmp）由 `server/attachments.ts` 的 `placeAttachments()` 拷进任务执行目录（对话目录）根下，提示里给的就是这个相对文件名（`截图-132004.png`）：Agent 的 cwd 就是这个目录，直接能读。重名时加序号（`note (2).png`），**对话目录里本来就有同名文件时也不覆盖**，同样加序号另起一个名字；同一个源文件再次放置时沿用任务上记的那份，不会越攒越多副本。超过 `MAX_ATTACHMENT_BYTES` 的图片不拷、保留原绝对路径。**其它文件（文本、代码、PDF、压缩包、音视频）一律不拷**，直接把原来的本机绝对路径交给 Agent；上传的文件只有 `~/.agent-panel/uploads/<uuid>/<名字>` 一份，任务目录里不出现第二份。`ref`（粘贴回来的路径）和 `quote`（引用原文落成的文件）本来就不拷。
- 拷进来的文件名记在任务上（`Task.placedAttachments`：源文件绝对路径 → 对话目录里的文件名，由 `server/tasks.ts` 的 `placeInTask` 合并进去）。面板自己的文件不算 Agent 的改动：`server/exec/git.ts` 的 `gitNumstat` / `gitChanges` / `gitSnapshot` / `reviewDiff` 都收这份名单，统计「更改」、评审差异时排除它们。不按文件名或 `attachments/` 前缀猜（图片搬到根目录后 `PANEL_DIR` 正则已经失效，已删掉）；名单只认对话目录里的相对路径，绝对路径和带 `..` 的不算。旧任务没有 `placedAttachments`：`placedFiles()` 按消息里记的 `attachments/名字` 原样补进名单（仍是按记录推，不是靠前缀猜），升级后当年拷进子目录的图片也不会重新冒进「更改」列表。回归：`server/exec/git-ignore.test.ts`、`server/attachments.test.ts` 的排除名单用例。
- 小文件的后台拷贝（`server/uploads.ts` 的 `POST /uploads/copy`、`POST /uploads/discard`）：浏览器选 / 拖 / 粘的文件只有文件名和大小，页面先走 `/uploads/locate` 找回原路径，再让服务端拷一份到 `~/.agent-panel/uploads/<uuid>/<名字>`（和上传同一套命名）。**只接受面板确认过的路径**：`pick` / `resolve` / `locate` 返回时把路径登记进内存里的 `confirmed`（24 小时、最多 5000 条），`/copy` 和 `/discard` 都只认这些路径——不能凭前端传来的一段任意字符串让服务端拷或删本机的文件。拷贝失败（被占用、权限、源文件在查找之后没了）或超过 `MAX_ATTACHMENT_BYTES` 的不在结果里返回，页面降级成引用原路径、不拦发送；`/discard` 只删附件目录里那一个副本目录（`uploadDirOf` 判过在 `UPLOADS_DIR` 下），没确认过的路径不删。回归：`server/uploads-copy.test.ts`。
- 两种形态在提示里的说明由 `shared/task.ts` 的 `withAttachments` 按实际内容写：只有相对路径时说「图片已放进对话目录」，有绝对路径时说「本机绝对路径、直接读取」，免得模型把绝对路径当相对路径去找。
- 用绝对路径的附件在执行目录之外，要放行的目录由 `attachmentAddDirs()` 按附件实际位置算：上传的合并成 uploads 根，粘贴路径引用的文件（`ref`）各自放行它所在的目录，执行目录里的和相对路径不放行。`server/exec/runner.ts` 建 `addDirs` 时取整个对话里的附件，设计会话（`server/designs.ts`）也调它，不再固定只放行 `UPLOADS_DIR`（以前 `ref` 引用的、在 worktree 执行时项目原目录里的文件会被挡掉）。实际用到的参数只有 Claude Code 的 `--add-dir`（`shared/clis.ts` 的 `addDirs`）；Codex 的 `--sandbox` 限制的是写和命令、读文件不受目录白名单限制，Command Code / Pi 的 CLI 定义里没有目录参数（permission 是工具批准模式），所以它们读绝对路径不需要额外参数。
- 源文件被删掉或移走时读不到，附件只保留原路径：CLI 自己报找不到，不静默换成别的路径、也不把附件从消息里去掉——不拷贝的代价就是「源文件没了就读不到」，报错就是如实告知用户。设计会话（`designs.ts` 每轮建临时工作目录、结束后删）仍把附件复制进那个临时目录，因为设计工具按工作目录内的路径找图，和任务附件不是一回事。
- 附件图片的缩略图（`server/thumbnail.ts`，挂在 `/api/uploads/raw` 的 `?w=` 上，`server/uploads.ts`）：消息里的卡片只有 1.25em 见方，却一直取原图（单张 100–300KB）。这里用 `server/image.ts` 已有的 PNG 解码 / 缩放 / 编码，**不引入图片库**：服务端要打成单文件（`scripts/package.mjs` 的 esbuild `bundle`），原生模块带不进去，纯 JS 的 JPEG 解码又要多一份依赖。缩略图缓存在 `<DATA_DIR>/cache/thumbs/<sha1(路径+大小+mtime+宽)>`（按文件大小和 mtime 而不是文件内容算 key，不用为了判断缓存是否新鲜先读一遍原图），同一张图的并发请求只算一次、解码缩放串行做（它是同步计算，一起来会把服务端卡住），响应带 `cache-control: private, max-age=86400`。解不开的格式（JPEG / WebP / 隔行扫描 PNG）和比目标还小的图返回 null，接口退回原图；看大图、复制图片、任务目录里的图（`/uploads/raw/file`）都不带 `w`。回归：`server/thumbnail.test.ts`。
- 回归：`server/attachments.test.ts`（文本/PDF 不拷、图片拷到对话目录根、超上限的图片不拷、重名图片加序号、目录里已有同名文件不覆盖、同一源文件复用、`ref` / `quote` 不拷、放行目录的计算）、`server/task-text.test.ts`（两种形态的说明）、`server/exec/git-ignore.test.ts`（面板图片不进更改列表和评审差异）、`scripts/e2e/05-workflow-edge.mjs` 的附件段（图片拷进对话目录根、提示里给相对文件名；文本文件不拷、给了原绝对路径）。

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

**两段回收时长和保活上限只收真空闲的会话**：`server/presence.ts` 的 `evict` 和 `server/tasks/keepalive.ts` 的 `enforceKeepAlive` 都先问同一个判定（`server/tasks/keepalive.ts` 的 `keepAliveBusy` → `shared/task.ts` 的 `keepAliveHolding`）：

- 有执行位时按任务事实判（`convActive`：在跑、等子对话 / 子任务 / 后台命令 / 工作流、有没回复的提问和请求），再加上正在启动和还有排队的消息；
- **没有执行位时**（这一轮已经结束、进程也退了，例如工作流节点、压缩 / 审查这类操作，或者对话页已经关了）看名下还在跑的子对话（`childrenRunning`，和 `childActive` 同一套判定）和还没回来的后台命令：它们的结果还要交回这条对话，按「没人看就回收」收掉会把它落成「已中断」（用户报的「父对话被回收」）。

子对话全部结束、自己也空下来之后照旧回收，不是永不回收。宽限到点还在跑的会话在 `server/presence.ts` 里进 `pending` 之后会排一个复查（`scheduleRecheck`，间隔 `BUSY_RECHECK_MS`，用独立的 `rechecks` Map，不占宽限计时）：子对话被用户停掉、后台命令被停时不会再交回结果，也不会走 `onKeepAlive` 的 `resetIdleCountdown`，只记标记就成了永不回收，所以到点要再判一次（间隔不取宽限期，宽限期可以设成 0，按 0ms 重排会自旋）。`evict` 开头读回收开关：用户关掉「按时间回收」后，已排出去的计时器和它排出的复查也不再收。重启迁移的条目构造也走 `shared/task.ts` 的 `childEntryOf`（从 `childFacts` 派生），以后 `childFacts` 加判定字段不会在迁移这一侧漏掉。回归：`shared/task-stage.test.ts` 的 `keepAliveHolding` 用例、`server/presence.test.ts` 的「父对话在等子对话」「宽限到点还在跑的对话留一个复查」「关掉自动回收」「复查不占宽限计时」、`server/task-restart.test.ts` 的「重启时名下有子对话在跑的父对话」、`scripts/e2e/04-subagents.mjs` 的同名段；排查和旧实现对照见 [bugs/parent-reclaimed-while-children-running.md](bugs/parent-reclaimed-while-children-running.md)。

**定时核对兜底（ADR 0033）**：`server/tasks/state-sweep.ts` 每 60 秒按 `shared/task-settle.ts` 的 `stateBreaks` 找两种矛盾——记录说在做、面板里却没有执行位 / 启动队列 / 后台命令（`orphan`），收尾停在「合并中」却没在合并（`merging`）。连着两次看到、中间任务没被写过才收：`orphan` 落成已中断（`stopReason: 'lost'`）并在对话里写一句，`merging` 退回「已请求收尾」并告诉父对话。日志里出现「定时核对：记录和实际对不上」就说明某条收尾路径漏了落状态，按日志里的任务去补那条路径。回归：`server/tasks/state-sweep.test.ts`。

## 强制更新后：把被打断的任务列进恢复名单

「强制更新」会停掉所有 CLI（`server/update.ts` 的 `stopForUpdate`）。停之前先把这一批任务记下来，新版本启动后问用户要不要接着跑：

- **记录**：`stopForUpdate` 调 `tasksApi` 的 `interruptedTasks()`（`server/tasks.ts`，`server/index.ts` 里接到 `updateApi` 的 `interrupted`），把 `{ id, doing }` 列表写进数据目录的 `cache/interrupted-by-update.json`（`server/interrupted.ts` 的 `recordInterrupted`：覆盖上一次，空名单不写，免得把上次没处理完的记录冲掉）。`doing` 由 `restartDoing` 生成，按「正在执行的节点标题 → 没做完的计划进度（`计划 6/8`）→ 最后一条要求的第一行」取第一个有的：重启后节点状态会变回 pending，这些只能在停之前存下来。
- **弹窗**：新版本启动后 `interruptedApi`（`server/interrupted.ts`）提供 `GET /app/interrupted` 和 `POST /app/interrupted/ack`，`web/src/components/layout/UpdateResumeDialog.tsx` 读它、默认全勾选，勾选的逐个调 `POST /tasks/:id/resume`（`server/tasks/conversation-routes.ts` 的 `routes.post('/:id/resume')`，界面侧是 `api.resumeTask`）。读取时再过滤一遍：任务已删除、归档、导入，或者在弹窗出现前就已经跑完的不列。点「稍后再说」或关掉弹窗写 `acknowledged: true`，记录留着但不再自动弹。
- **名单口径**（`shared/task.ts` 的 `interruptedTaskIds(tasks, working)`）：现在真在跑的（`working`）+ 名下还有在跑子对话的父对话（`working` 条目带的 `parentTaskId`，子对话的结果要交回它，它不在名单里就没人接）+ `restartUnfinished` 成立的。旧实现只按 `working` 挑，漏掉「这一轮已经说完、停在等下一句、计划 12/17」的父对话：子对话进了名单被继续，父对话被启动迁移（`ready`）落成 `stopped` + `stopReason: 'restart'` 后只能手动点「继续执行」（用户报的现象，见 [bugs/update-resume-missed-parent.md](bugs/update-resume-missed-parent.md)）。

**`restartUnfinished` 与 `restartInterrupted` 的分工**：`restartInterrupted` 回答「界面还会不会画成在跑」（含独立分支还没合回、由 `ready` 落成 stopped 的那种），`restartUnfinished` 回答「重启后该不该列进继续名单」。后者四种不算：

- 用户手动暂停（`stopReason: 'user'`）：弹窗默认全勾选，列出来等于推翻用户上一步的决定；
- 待收尾（`wrapRequest.state` 不是 `failed`）：剩下的事是等父对话合并，不靠 CLI 进程，重启后照样能收；
- 独立分支还没合回：同上，重启不影响合并；
- 后台命令：`jobs` 不存盘（见 `shared/schema.ts` 的 `Task.jobs`），重启后无从判断，`restartUnfinished` 也就列不进名单。

**判定和名单都在纯函数里**（`shared/task.ts`），服务端只负责取任务列表：`store.list()` 不带完整对话（只保留用户消息），但 `plans` / `steps` / `stopReason` / `wrapRequest` 都在，判「计划没做完」够用；在跑的任务用 `live` 里那份（比落盘的新）。**不要在这里改用 `store.get` 逐个读完整任务**：那是完整对话文件（长的几 MB），强制更新停 CLI 前同步读上百 MB 会卡在磁盘上（评审 R1）。`workingTasks()` 仍然保留，给清扫独立目录（`sweepStaleWorktrees`）用。

回归：`server/task-restart.test.ts` 8 条（本轮新增 3 条：`restartUnfinished` 的判定、`interruptedTaskIds` 的名单、`tasksApi().interruptedTasks()` 里父对话的 `doing` 写成「计划 6/8」）。反向验证：把 `interruptedTasks` 的名单临时退回「只看 `working`」后，该用例失败（`parent` 不在名单里），恢复后 8/8 通过。

## 技能库的多文件管理

`server/library.ts` 除主文件（Skill 的 `SKILL.md`、命令的 `.md` / `.toml`）外，还能单独读写一个 Skill 目录里的附带文件。前端的文件树、编辑、改名、删除都走这里，契约在 `shared/library.ts`。

**数据结构**：`LibraryFile` 是 `{ content, files, tree? }`。`content` 是主文件内容；`files` 保持旧语义（`tree.entries` 里 `type === 'file'` 的 path 扁平列表，前端老代码照旧能用）；`tree` 是 `{ entries, truncated? }`，`entries` 是 `{ path, type: 'file' | 'dir', size? }` 的扁平列表——**目录和文件混在一张表里**，路径统一用 `/`，前端按 `/` 分段就能画出树。排序约定：**同一层目录在前、再按名字排**，并且用广度优先展开，所以父目录一定排在子项前面，截断时留下的也是浅层。命令（`kind: 'command'`）没有附带目录结构，`tree` 是 `undefined`、`files` 是 `[]`。

**接口**（都在 `libraryApi()` 里，错误统一 `400` + `{ error }` 文案）：

| 方法   | 路径                    | 参数                                                         | 返回                                               |
| ------ | ----------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| GET    | `/library/file`         | `cli` / `kind` / `name`                                      | `LibraryFile`                                      |
| GET    | `/library/entry`        | `cli` / `kind` / `name` / `path`                             | `{ path, exists, binary?, content, size, mtime? }` |
| PUT    | `/library/entry`        | body：`cli` / `kind` / `name` / `path` / `content`           | `{ path, bytes }`                                  |
| DELETE | `/library/entry`        | `cli` / `kind` / `name` / `path`                             | `{ path, deleted }`                                |
| POST   | `/library/entry/rename` | body：`cli` / `kind` / `name` / `from` / `to` / `overwrite?` | `{ from, to }`                                     |

路径都放在 query 和 body 里、不拼进 URL，所以 `..` 不会在路由层被 normalize 掉，全交给下面那道校验判断。读一个还不存在的文件不报错，返回 `exists: false`（新建前先看一眼很方便）。

**路径安全**（`shared/library.ts` 的 `libraryEntryPath` + `server/library.ts` 的 `entryOf`，两道关）：

1. 字符串层：`..`、`.`、空段、绝对路径、盘符（`C:`）、`\0` 和 Windows 非法字符（`< > : " | ? *`）一律拒绝；反斜杠统一当 `/`，末尾斜杠去掉。
2. 真实路径层：把路径拼到 `realpath(Skill 目录)` 上，再对「已存在的那一段」`realpath` 一次，确认它仍在 Skill 目录里（`insideDir`）。只靠第 1 道挡不住软链接——Skill 目录里放一个指向外面的目录链接，`link/secret.txt` 字符串上完全合法。找「已存在的那一段」用的是 **`lstat`**：`existsSync` 会跟随软链接，断链时报「不存在」而一路退到 Skill 目录本身，校验就放行了，真正写的时候 OS 会把链接解开、在目录外创建文件。`realpath` 失败（断链、`EACCES`）**直接拒绝**，不回退成字符串路径。

**软链接**：Skill 目录本身是链接时，附件的读写落到**链接指向的真实目录**（`skillRootOf` 先 `realpath`），删文件不动原文件夹——和 `deleteLibrary` 只删链接的约定一致。

Skill 目录**里面**的软链接按「看得见、删得掉、改不了」处理，读、写、删、树四处口径一致：

- 树里标成 `type: 'link'`（不是 `file`，也不给 `size`），不跟进去（可能是链到外面的大目录）；`files` 只放普通文件，不含链接。
- 读接口返回 `{ exists: true, link: true, content: '', size: 0 }`——**不给内容**：链接的目标可能是目录、可能在 Skill 目录外，给一份前端改完又存不回去的正文只会让人困惑。
- 写接口拒绝，文案「这是个链接，不能直接改内容」（不是「路径不合法」，用户能据此知道该去改目标文件）。
- 删接口删的是链接本身，不动目标：链接（文件链接、目录链接、junction）统一走 `rm`——Node 的 `rm` 对链接只删链接本身、不跟进，而且 Windows 上删目录重解析点**不能**走 `unlink`（`DeleteFile` 会报 `EPERM`，必须让 rmdir 系来删）。

**路径校验只校验父目录**（`entryOf`）：把「最后一段的父目录」`realpath` 后要求仍在 Skill 目录内，拦住 `link/secret.txt` 这种穿过软链接目录的访问；最后一段本身是不是链接，交给各操作按 `lstat` 自己决定。最后一段也一起 `realpath` 的话，树里列出来的链接一读就报「路径不合法」，和上面那条口径打架。`realpath` 失败（断链、`EACCES`）**直接拒绝**，不回退成字符串路径——否则一条断链的软链接就能让写入落到目录外。

**二进制与大小**：单个附带文件上限 `LIBRARY_FILE_MAX_BYTES`（1 MiB），读写超限都直接报错、不截断。报错文案按 `LIBRARY_FILE_MAX_KIB`（1024 KB）说，和前端「1.0 MB」的显示口径一致——用 1048 KB 会和 MB 那条自相矛盾。链接和目录的判断放在大小检查**之前**：一个超限的链接该说「这是个链接」，不该让人以为要去删内容。二进制靠「头部有 `\0` 字节」判定（和 `server/files.ts` 的 `readInDir` 一致）：大多数图片、压缩包、可执行文件都带 `\0`，比按扩展名白名单稳（无扩展名的文本不会误判），也不依赖 UTF-8 解码是否报错（非法 UTF-8 会被静默替换成 U+FFFD，判不出来）。命中时返回 `binary: true`、`content: ''`，**`size` 照常返回**（前端要显示「二进制文件，{kb} KB」）。误请求一个目录时返回 `size: 0`，不把目录的元数据大小（64 / 4096 这类）当成文件大小。

**文件树上限**：`LIBRARY_TREE_MAX_ENTRIES`（1000 项，**目录也算一项**），超过就截断并在 `tree.truncated` 标出来。排除规则分两张表：`LIBRARY_TREE_EXCLUDE_DIRS`（依赖和版本库目录：`node_modules`、`.git`、`.svn`、`__pycache__`、`.venv`、`venv`）**只对目录生效**，`LIBRARY_TREE_EXCLUDE_FILES`（`.DS_Store`、`Thumbs.db`）**只对文件生效**。不拿搜索用的 `DEFAULT_SEARCH_EXCLUDE`：那份清单的语义是「搜代码时跳过的噪音目录」，会把技能里真放内容、刚好叫 `logs` / `build` / `out` 的目录一起抹掉。主文件 `SKILL.md` 不进树（大小写无关判，`skill.md` 也算它），它单独用 `content` 返回。

**删目录与改名**：删目录是递归删，但先用 `countEntries` 数一遍，超过 `LIBRARY_DIR_MAX_DELETE_ENTRIES` 就拒绝（让用户先清掉里面的文件），数条目时不跟进软链接。改名默认 `overwrite: false`，目标已存在报「「{name}」已经有了」；目录不能并进已存在的目录（单独一条文案），也不许把目录移到它自己里面。覆盖时**不先删目标再 rename**：先把目标挪到 `.old-<pid>-<时间戳>` 留底，rename 成功再删留底，失败就把留底改回去，否则 rename / mkdir 任一步失败（Windows 上目标被占用很常见）旧内容就找不回来了；回滚本身也失败时，错误文案带上留底文件名，让用户能自己找回来。源和目标是不是同一个文件用 `sameFile` 判——比 `dev` + `ino`（真实文件身份），**不按字符串小写归一**：小写归一会把 Linux 上 `Notes.md → notes.md` 这种合法改名当成同一文件、返回成功却什么都没做。只差大小写的改名走「先改到临时名、再改到目标」两步，真把名字换掉，也不会在覆盖分支里删掉源文件；第二步失败时把名字改回去，回滚也失败就用「改名失败，原内容留在 {name}」把临时文件名告诉用户，不让文件「改名成功一半」。

**主文件保护**：`entryOf` 用 `rel.toLowerCase() === 'skill.md'` 判（主文件不许走附件接口），文件树也同样大小写无关——NTFS / APFS 不区分大小写，只比大写会让人用 `skill.md` 覆盖或删掉 `SKILL.md`。

**回归**：`server/library.test.ts`（文件树排序与截断、`files` 与 `tree` 一致、路径穿越各种写法、软链接越界与软链接 Skill 的读写落点、二进制识别、读写超限、增删改往返、目录删除上限、命令没有附件）、`server/project-skills.test.ts`（项目技能的 `files` / `tree` 两个字段一致）、`npm run test:e2e` 里「Skills / 命令库」那段（附件写读改删和路径穿越）。

## GitHub 出网与代理回退

Node 自带的 `fetch` 不走代理，国内常常连不上 GitHub。`server/net.ts` 把「用哪条路、失败了再试哪条」收在一处，调用方只管传 `timeoutMs` / `signal`。

**出网优先级**（`defaultPlan` → 纯函数 `planFor`）：

1. 设置里的 `proxy`（在「设置 · 网络与代理」），但先过 settings 的「启用代理」开关（`Settings.networkProxyEnabled`，默认 true，加开关之前的老设置按 true 处理，迁移见 `server/settings-migrate.test.ts`）：`server/net.ts` 的 `configuredProxy(settings)` 在开关关闭时返回空串，于是这一条等于没填，直接落到第 2 条环境变量、第 3 条直连。地址没写协议时用 `httpProxy` 补 `http://`，否则 `ProxyAgent` 解析不了；socks 这类不支持的地址照原样交给回退，由请求失败后的回退处理。本机代理自动探测（`localProxies`、`discover`）在第一次尝试失败后照旧执行，不受开关影响。
2. 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`，此时 `NO_PROXY` 照常生效。
3. 直连。

本机地址（`127.0.0.1`、`localhost`、`[::1]`）永远直连，失败也不探测。`NO_PROXY` 只在走环境变量代理时参与判断：命中时直接直连、不进入回退；设置里填了 `proxy` 时以设置为准，不受 `NO_PROXY` 影响。

**失败后的回退**（`netFetchWith` + `attemptOrder`）：第一次尝试失败、且调用方没有中止自己的 signal 时，先探测本机代理，再把没试过的路试完：从直连起步时依次试探测到的本机代理；从配置的代理起步时依次试本机代理、最后再试直连。任何一条成功就返回它的响应，配置的代理也在回退链里，所以「配置了但连不上」不会直接判死。

**本机代理怎么找**（`localProxies`）：

- 系统代理：Windows 读注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer`（`reg query`，https 优先于 http，分号格式也认）；macOS 跑 `scutil --proxy`；Linux 没有统一读法，交给环境变量。解析函数是纯函数：`windowsProxy`、`parseWindowsProxy`、`parseScutilProxy`。
- 常见端口：顺序和取值只看 `shared/proxy.ts`（`LOCAL_PROXY_PORTS` 与默认端口 `DEFAULT_PROXY_PORT`），文档不重复枚举。按常见程度排依次是（不写具体数字）：Clash / mihomo 的混合端口、v2rayN 的默认入站、老版 v2rayN 的 http 入站、Clash 的 socks 口（历史兼容，探测大概率失败）、Clash Verge Rev 的混合端口、通用的 1080。探测时全部并发跑一遍，真正拿去请求时本地端口最多 `MAX_LOCAL_PROXIES`（3）个、系统代理不算在内，由 `pickLocalProxies` 按顺序挑，所以默认端口必须排在前几个，不会被 Clash 的端口挤掉。默认代理地址只在 `shared/proxy.ts` 定义一次（`rules-check` 会拦住别处再写的字面量）。
- 只认 http 代理：`undici` 的 `ProxyAgent` 只处理 http/https，socks5 地址传进去也用不了（`httpProxy` 会把非 http(s) 的筛掉，`probeProxy` 同样只认 http/https）。默认端口在不同客户端里可能是纯 socks（v2rayN 默认入站就是 `socks`，它的 mixed 入站在 10814）、也可能是 socks+http 的 mixed 同口，就看客户端怎么配的；是纯 socks 时探测会失败，按「没找到代理」回退直连，用户需要在设置里填 http 入站端口。
- 只连上端口不算数：`probeProxy` 向候选发 `CONNECT api.github.com:443`，返回 200 或 407（要认证）才算在运行的代理。所有候选并发探测，单个握手超时 `PROBE_TIMEOUT_MS`（1200ms），另有一条独立的硬超时兜底（连接阶段卡住时也会结束）；系统代理读取本身最多 2 秒，所以没代理时一次探测在几秒内结束。
- 一个都没探测到就保持直连失败，不会强行走代理。
- 缓存：探测到代理缓存 60 秒，没探测到缓存 30 秒（用户刚开代理软件也能较快用上），系统代理读取缓存 60 秒；某条代理请求失败会经 `markProxyBad` → `dropBadProxy` 从缓存里去掉，列表因此变空时把间隔改成「没找到」的 30 秒，代理软件关掉后能重新检测。

**超时与取消**：每次尝试单独计时（`attemptControl`），上一次因为 `timeoutMs` 超时了，下一次会重新计时；`timeoutMs` 只覆盖等响应头，body 由调用方自己管。调用方自己的 `signal` 被中止（主动取消，或用 `AbortSignal.timeout` 给自己的总预算用完）时不再换路径，把原因原样报出去；换路径只由每次尝试自己的 `timeoutMs` 触发。

**失败文案**（`failure` + `netError`）：保留原始原因（连接超时 / 无法解析域名 / 代理拒绝连接等）。最后一条失败的是直连时，附上原来的 `访问不了 GitHub 时，可以在「设置 · 网络与代理」里填写本机代理`；最后一条是代理时，先用 `当前使用代理 xxx，请确认代理能访问 GitHub`，再补一句同样的设置页提示。试过多条路时追加 `尝试过的路径：直连、本机代理 http://…`；探测过、但没有任何本机代理进入尝试列表时追加「没有发现运行中的本机代理。」。报错里的代理地址会去掉账号密码。

**谁在用**（都因此共用同一套回退）：

- `server/update.ts`：检查 releases（`GET /repos/.../releases`，`timeoutMs: 15_000`）和下载 `SHA256SUMS`（同样 15 秒）。
- `server/download.ts`：探测（`probe`）、单连接下载（`stream`）、分片下载（`fetchSpan`）都经过 `DownloadOptions.fetch`（默认就是 `netFetch`，测试可以替换），每处都带 `HEAD_TIMEOUT_MS`（20 秒）的响应头超时，这一段超时会换下一条路。下载中途「太久没收到数据」由 `watch` 计时（分片 45 秒、单连接 90 秒）；`netFetch` 每次换一条路重试前会调用 `init.onAttempt`，下载借此重置空闲计时，所以空闲预算只管单条路径，不会因为整轮回退把「body 卡住」的判定拉长。
- `server/update.ts` 和 `server/download.ts` 不再用 `AbortSignal.timeout`（触发一次后就永久处于中止状态，没法用同一条 signal 重试），改用 `netFetch` 的 `timeoutMs`；其它调用方（例如 `server/comfy-templates.ts`、`server/remote.ts`）仍可用自己的 signal，中止后按上面的规则停止回退。

## 版本更新（GitHub Releases）

`server/update.ts` 的 `updateApi()` 负责设置页的「版本更新」和托盘菜单的「检查更新」，路由挂在 `/app` 下（`/releases`、`/install`、`/install/:id`、`/install/:id/force`、`/install-current`、`/rollback`）。

- 检查结果缓存在数据目录的 `cache/updates/releases.json`：`{ at, list, etag?, limitedUntil? }`。`at` 是上次成功读到列表的时间；自动检查最多每 `CHECK_EVERY`（6 小时）用一次缓存，点「检查更新」带 `refresh=1` 时马上请求。
- 减少请求：缓存里的 `etag` 下次作为 `If-None-Match` 带上，GitHub 回 304 时直接沿用缓存（conditional request 不计入配额），只把 `at` 挪到现在。环境变量 `GITHUB_TOKEN` 存在时带 `Authorization: Bearer`，配额从 60 次/小时提到 5000 次/小时；token 只从环境变量读，不落盘。
- 限流回退：403 / 429 时按响应里的 `retry-after`、其次 `x-ratelimit-reset` 算出 `limitedUntil`（都没有时默认 15 分钟，计算在 `shared/version.ts` 的 `rateLimitUntil`）。有缓存就写进缓存并返回上次的列表，`/releases` 响应里的 `limitedUntil` 让页面显示「显示的是上次检查的结果」的温和提示；没有缓存才报错，文案里带「约 N 分钟后恢复」。冷却期内点「检查更新」也只回缓存，不再请求 GitHub。
- 托盘 `checkAndInstall` 走同一个 `releases(true)`：限流时用缓存列表判断有没有新版本，没有缓存才报失败。
- 在线演示（`web/src/lib/demo-backend.ts`）没有服务端缓存，用浏览器 localStorage 记上次的列表，403 / 429 时同样回退并带 `limitedUntil`。
- 回归：`server/update.test.ts` 覆盖 403 无缓存报错、403 有缓存回退并标出恢复时间、`retry-after` 计算、冷却期不再请求、ETag 304 复用缓存、带 `GITHUB_TOKEN` 时发 `Authorization`。

## 账号与登录

路由把 `server/accounts.ts` 的 `accountsApi()` 挂在 `/accounts` 下（账号列表、`/:cli/login` 的起 / 查 / 取消、粘贴授权码、`/:cli/save`、切账号、登出、凭据检查、API 模型、模型探针与余额）。CLI 定义里 `auth` 各个字段的含义见 [cli-config.md](../../cli-config.md) 的「账号登录 `auth`」，这里只记服务端的做法。

- 全局 API 的三个出网接口都在服务端带密钥请求（页面不直连第三方）：`fetchApiModels`（`POST /accounts/api-models`，列模型）、`probeApiModel`（`POST /accounts/api-probe`，用一个模型真的跑一次最小推理）、`fetchApiBalance`（`POST /accounts/api-balance`，查余额）。探针按协议构造请求：anthropic `/v1/messages`（地址自带 `/v1` 时不重复）、openai-responses `/v1/responses`、openai-chat `/v1/chat/completions`；认证头跟着 `authHeader`（`x-api-key` / `bearer`）和协议走，不写死。提示词只有 `ping`、输出 1 个 token，避免探测花额度。
- 探针的失败一律透传上游原因（`errorDetail` 兼容 `error.message` / `error` / `message` 几种写法，`error` 是对象但没有 `message` 时退到 `type` / `code`，都没有才用状态文本，避免输出 `[object Object]`；截 200 字），200 但正文里没有模型输出也算不通（`looksLikeAnswer` 按协议看 `content` / `output` / `choices`），超时用 `PROBE_TIMEOUT_MS`（60 秒）换成人话，不重试、不把密钥拼进文案。**读 body 阶段的超时单独处理**：上游先回 200、body 迟迟不吐时 `AbortSignal.timeout` 在 `res.text()` 阶段触发，不能 `.catch(() => '')` 吞成空正文，否则会掉进「不是模型回复」分支把超时报成内容不对。列模型和余额原先各自内联的取错误原因写法也收敛到同一个 `errorDetail`。回归：`server/api-config.test.ts` 的「API 探针」几条（成功 / 404 模型不存在 / 401 带上游原因 / 200 非模型回复 / 读 body 阶段超时 / 错误体无 message 时不输出 `[object Object]` / 没填地址、密钥、模型时不发请求）。

- 现在登录着的是谁：`server/accounts.ts` 的 `readLive` 按定义读 `auth.files`、`auth.fields` 和 macOS 钥匙串，一个都读不到就返回空（= 没登录）；`identityOf` 从凭据里认邮箱（认不出的返回空），`fingerprint` 只看凭据内容（sha256(files + keychain) 截 16 位）用于比对和去重。`matchSlot` 把现在的凭据对上已存的账号，`sync` 顺手把变了的凭据写回槽位、更新 active，`saveAs` 存成账号（同邮箱或同指纹的不重复存）。
- 登录的判定：`startLogin` 先 `sync` 一次，现在登录着但还没存下来的账号先 `saveAs` 存好（否则登录新账号会把旧的弄丢），记下 `before = fingerprint(live)` 后跑 `auth.login`。结局由纯函数 `loginOutcome` 定，共五种：`done`、`spawn-error`、`cancelled`、`no-credential`、`unchanged`。
- 默认按「凭据变没变」判：`poll`（600ms）里指纹一变就成功（登录后不自己退出的 CLI 也能判对），进程结束时 `.then` 再比一次。
- `auth.loginAlreadyLoggedIn` 为 `true` 的 CLI（目前只有 Command Code）：退出码 0 且 `readLive` 读得到凭据就算成功，不看指纹。因为这个 CLI 发现已经登录时只打印一句 `Already logged in` 就以退出码 0 结束，凭据文件一个字节都不改，只看指纹会把用户本来好好的登录报成「登录没有完成（退出码 0）」。界面上的「登录」和「登录其他账号」走的是同一个登录流程（`POST /accounts/:cli/login`）：已登录时它同样直接说已登录，结论是「现在仍是这个账号」——`finish(true)` 里 `readLive` 拿到的还是原凭据，`saveAs` 按邮箱或指纹去重，账号列表不会多出一条，也不算失败。
- 真正的失败照旧报失败：退出码非 0，或退出码 0 但读不到凭据（后者是 `登录没有完成：没有找到登录凭据`）。
- 输出：stdout / stderr 经 `onLine` / `onStderr` 进 `take`，`take` 先调 `shared/ansi.ts` 的 `stripAnsi` 再拼进 `job.output`（留最后 4000 字符），并从中找登录网址。存进 `job.output` 之前就清 ANSI，界面 `<pre>`、失败文案的尾部 3 行、「AI 处理」拿到的才是同一份干净文本——CLI 发现标准输出接终端就上色，浏览器不认识 ESC 只会吞掉，留下 `[32m` 这种残码。`stripAnsi` 只清 CSI / OSC / 两字符转义和 `\r`，普通方括号文本（没有 ESC 的 `[32m`、Markdown 链接 `[文字](...)`）原样保留。

## 每轮改动卡片与撤销（2026-10-31）

对话每轮总结下面的「已更改 N 个文件」：`server/turn-changes.ts` 记，`TaskMessage.turnChanges` 存，`web/src/components/tasks/TurnChanges.tsx` 画。

- 只在 git 仓库里记。runner 在对话自己的一轮开始时用 `gitSnapshot` 给工作区拍快照（不碰暂存区和提交，从真正的暂存区拷一份起步，只重新读改过的文件），`endTurn` 时再拍一张，差就是这一轮的改动，挂在这一轮最后一条有正文的回复上。被停下、出错的一轮在进程收尾时照样记。
- 范围：用户的新消息重新拍起点（空档里用户自己改的、子对话合进来的都不算）；子任务、计划交回结果后接着做的一圈（`AgentCall.carry`、runner 里等子任务时收到的消息）沿用上一圈终点，子任务和工作流节点在空档里改的算进来。子对话合回这个目录的那一下（`children.ts` 的 `integrate`、`mergeWorktree`）用 `aroundMerge` 切掉，一轮可能因此有几段 `spans`。
- 撤销（`POST /tasks/:id/turn-revert`，`undoSpans`）：每个文件从现在的内容按从后往前撤每一段；现在就是改完的样子直接换回，之后又改过就用 `git merge-file` 三方合并只撤这段；改到同一处、二进制、新建后又改、删掉后又建回都算冲突，有冲突时一个文件都不写，把冲突交回页面。内容按 `cat-file --filters` 取，Windows 的 autocrlf 不会让每一行都对不上。对话正在回复、或有节点 / 子任务在跑时拒绝。快照树没有引用，过了 git 的清理期限（默认两周）就撤不了，会报「改动记录已经被 git 清理」。
- 跟踪状态只在内存里：面板重启时进行中的那一轮没有卡片。

## 回归验证

- `npm run typecheck`
- `npm run test:unit`（`server/**/*.test.ts`，每个模块基本都有同名测试）
- 动了定时计划：`server/schedules.test.ts`（到点启动一次、单次执行后不再触发、错过不补跑、立即执行不改排期、启动失败只记原因不重试、删除后不再触发、启动期间用户改排期不会被写回覆盖、同一分钟改名字不重置状态，时钟由测试注入）
- `server/settings-migrate.test.ts`：旧默认值 16 迁移成 64 并写回、已删掉的 `childConcurrency` 被忽略；`server/settings-migrate-keep.test.ts`：显式设过的 32 和已经迁移过的设置里显式选的 `autoCompact: 0` 都保持不动、不写盘；`server/settings-defaults.test.ts`：新装/没存过这一项时自动压缩是 70%、旧默认值 0 迁成 70（50 保持）、迁移后选回 0 不再被改
- 动了存储和落盘：`server/store.test.ts`（`writeJsonAtomic` 写成功后 `readJson` 能读回、覆盖写读到新内容、tmp 不残留；`readJson` 对不存在的文件报 `missing`；坏 JSON 被留档且调用方拿到「存在但坏了」和原路径、字节数，旁边有 `.broken.json` 说明；全 0 的空洞文件判成损坏并记下真实字节数）、`server/task-store.test.ts`（只有 `.messages.json` 时重建任务、记录全 0 时空洞文件留档后重建、对话文件全 0 时不重建不伪造且第二次启动不重复归档、对话内容不是消息数组时不重建只留档、已有记录不被重建覆盖）、`server/store-concurrency.test.ts`（集合的「读快照 → 改 → 写盘」整体串行）
- 动了任务重启迁移：`server/task-restart.test.ts`（这一轮还在跑的任务落成已停止并标出被打断的节点；计划没做完、独立分支没合回的子对话重启后不再画成在跑；彻底做完的不动；待收尾的保留收尾请求）
- 动了页面宽限回收 / presence：`server/reclaim.test.ts`（进程已回收、状态还写着 `running` 的等下一句任务被收口成 `stopped` + `stopReason: 'presence'`，`childSpinning` 转假、图标 `idle`；`working` 的真在跑任务不碰；已停下的不覆盖 `stopReason: 'user'`）
- 动了任务执行、项目、设置等跨界面流程时跑 `npm run test:e2e`（Windows 上在 WSL 里）
- 动了账号与登录：`server/accounts.test.ts`（`loginOutcome` 的各种结局、`loginFailure` 的文案分支、Command Code 的 `loginAlreadyLoggedIn`）、`shared/ansi.test.ts`（SGR 颜色、加粗 / 暗色开关、8 位 CSI、普通方括号文本不被改），以及 `npm run test:e2e` 里「已登录再登录」和「退 0 但没凭据」两条用例（模拟 CLI 用 `scripts/fake-cli/fake-cli.mjs` 的 `FAKE_AUTH_ALREADY` / `FAKE_AUTH_NO_CREDENTIALS`）
- 动了出网 / 代理：`server/net.test.ts` 覆盖系统代理解析（Windows 注册表输出、macOS `scutil --proxy`）、候选列表与 `pickLocalProxies` 的挑选顺序（默认端口在尝试范围内、只开默认端口也能被选中）、`planFor` 的优先级 / 无协议补全 / `NO_PROXY`、缓存失效（`markProxyBad`）、本机地址识别、直连失败换代理、配置代理失败后回退、全部失败时的文案、本机地址不探测、用户取消或总预算用完时停止、超时后重试、代理握手探测（起真实只处理 CONNECT 的本地服务）。`netFetch` 的回退路径通过 `netFetchWith` 注入 `NetDeps`（`plan` / `direct` / `viaProxy` / `discover` / `proxyFailed`）来测，不用真的连代理。`server/download.test.ts` 通过 `DownloadOptions.fetch` 断言探测、单连接下载和每个分片都经过统一入口、都带 20 秒响应头超时，并带 `onAttempt` 供回退时重置空闲计时；`net.test.ts` 另有用例确认每次尝试前会调用它。

## 待确认

- `server/` 下文件较多（API 路由集中在 `server/index.ts`），新增接口前先确认应该加在路由里还是拆成独立模块（待确认）。
