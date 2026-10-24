---
paths: shared/task-export.ts, server/task-export.test.ts
---

# 导出报告的口径

## 报告里的时间项要满足「各项之和 = 跨度」，跨度把还在跑的算到导出时刻

- 规则：改 `taskReport` 的时间行时，`durationMs + childBusyMs + idleMs` 必须正好等于 `spanMs`——这是**经过旧数据迁移之后**的不变式（`taskStats` 先把 `waitMs > durationMs` 的历史等待挪进 `idleWaitMs` 再算），新记录直接成立；新增一项就同时想清楚它是谁的子集（等确认在「执行」里、等下一句在「空闲」里），别让它独立成项、更别让「其中 X」比主数大。
- 规则：任务的等待分两种，必须分开记：`waitMs` 是等确认 / 提问（期间 `runMs` 不清空，是执行的子集，报告写「等你确认/提问 X 已含在其中」）；`idleWaitMs` 是答完后停在等下一句（`pauseRun` 记，**不在** `runMs` 里，是空闲的子集，报告写「空闲 V（其中等你回下一句 Y）」）。混成一个数会写出「执行 8m（其中等你处理 23h55m）」这种装不下的数，还会和空闲重复计时；括号里的数一律按 `min(子集, 主数)` 写，别把它当平行项。
- 规则：旧记录（加 `idleWaitMs` 之前）的 `waitMs > durationMs` 时，超出执行的那部分其实是历史「等下一句」，`taskStats` 要把它挪进 `idleWaitMs`、从 `waitMs` 里减掉，否则同一段又算「等你确认」又算「空闲」。
- 规则：`idleWaitAt` 这类 live 开始时间只在任务 `status === 'running'` 时算到 `now`。面板重启落盘不清它，已经停下的任务再按现在算，跨度和等待时间会随查看时间一路涨。
- 规则：跨度用 `recordSpan(rec, now)`，导出入口把 `now` 一路传到 `taskStats`。还在跑的轮次、节点没有 `endedAt`，不传 now 就是零长窗口，导出执行中的任务会得到比执行时间还短的跨度。
- 规则：同理，正在执行的这一段还没结算进 `runMs`/`waitMs`，`taskStats` 要把 `runStartedAt` 到 `now` 补进执行、用 `waitDuration(task, now)` 取等待；只补跨度不补执行，报告会写「执行 0s、空闲一整段」，和界面上的「总耗时」（`taskDuration` 含 live）对不上。
- 规则：子对话的时间先裁进父记录跨度、并行/重叠的合并成一次，再整体按 `min(子对话占用, 跨度 - 执行)` 夹一次；**不要**按轮次/节点的时间窗逐段相减——对话轮从 `beginTurn` 到被停止一直是 `running`，会把「答完等下一句」那段也算成父在跑，子对话占用直接被减成 0，用户投诉的「两个差不多的数字」原样保留。
- 规则：跨度取 `max(recordSpan(rec, now), durationMs)`：没有轮次/节点的旧记录时间戳不全，跨度会小于执行时间，等式就不成立了。
- 规则：还没结束的轮次单独算「还在执行」（`turnEnds.running`），不要混进「没有正常结束」，也不要写成「原因没记录」。
- 规则：`sharedState`（`read_state`/`write_state` 的注册条件）不能只看 `runRecord(task)`：对话里跑过 `start_plan` 之后 `task.runs` 会留着上一次运行，连对话里的子任务都会拿到旧状态；判据用 `!ctx.chat && !!runRecord(task)`，`runHelper` 要把 `ctx.chat` 透传下去。
- 规则：导出执行中的任务时（`exportedBody`），把还在跑的轮次、节点按导出这一刻收尾（`status` 改掉、`endedAt` 补上、轮次给 `end: 'panel'`），并把 live 的 `runMs`/`waitMs`/`idleWaitMs` **先结算进累计值**再清 `*StartedAt`（只清不结算，导入后执行时长会凭空少一截），`exportTask` 的 `stats` 用同一份记录体算；已停下任务里残留的 `idleWaitAt` 要留着（它是等待结束的时间点，清掉跨度会前后不一致）。用 `exportedWhileRunning` 标明是快照；不收尾的话导入后再算统计时 `recordSpan` 会拿「现在」当结束时间，跨度一路涨到导入那天，而且「状态 stopped」和「还在执行」会同屏出现。
- 起因：修「子对话在跑的时间被算成父对话空闲」时，评审连着退回七次：第一轮四项之和超过跨度（2h 的跨度报出 2h50m），第二轮导出执行中的任务时跨度比执行时间还短、还在跑的轮次被写成「原因没记录」，第三轮只补了跨度没补正在执行的这一段（报出「执行 0s、空闲 1h」），第四轮把两种等待混成一个数（「执行 8m（其中等你处理 23h55m）」）且导出执行中的任务再导入跨度被拉长，第五轮把「等你回下一句」写成「空闲 0s（其中 23h55m）」、重启残留的 live 等待让跨度随查看时间涨、旧口径 `waitMs` 里的历史等待又和空闲算了两遍，第六轮导出记录体没结算 live 的 `runMs`（导入后执行时长少一截）、残留 `idleWaitAt` 清掉后跨度前后不一致，第七轮回到最初的问题：按轮次时间窗减父忙时，把子对话占用减成了 0，而且对话里跑过 `start_plan` 之后子任务又拿到了上一轮运行的共享状态；七次都是新增时间项没加全局等式约束、用例只造已结束 / 单一时序 / 没有 runs 的任务。
- 防线：`server/task-export.test.ts` 里所有涉及时间项的用例都断言「执行 + 子对话占用 + 空闲 = 跨度」，并覆盖导出时仍在跑、二次导入、面板重启残留、旧口径记录四种场景；`server/task-time.test.ts` 覆盖两种等待的拆分；`npm run test:unit` 会跑。
