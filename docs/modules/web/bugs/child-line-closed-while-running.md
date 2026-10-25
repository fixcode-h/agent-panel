# 子对话还在等后台命令，行上却显示「已关闭」

- 状态：已修复（回归 `web/src/components/tasks/child-line.test.ts` 7 条用例全过：`tsx --test web/src/components/tasks/child-line.test.ts` 退出码 0；`scripts/rules-check.mjs` 通过；类型检查、lint、全量单测由同一改动的代码提交一并跑）
- 模块：`web`（`web/src/components/tasks/child-line.ts` 的 `childLabels`）
- 关键词：子对话、已关闭、等后台命令、状态标签同屏、`cliAlive`、`childIcon`、`convClosed`、`childClosedHint`

## 现象

用户看父对话的运行区，两行子对话都是同一个毛病（截图 `attachments/截图-221503.png`）：

```text
子对话 设置页代理挪位与右栏分类菜单 | 已关闭 | 计划 13/14 | 等结果 等 1 个后台命令 | 2m 21.9s
子对话 独立分支分类展示与右键菜单   | 已关闭 | 计划 8/9   | 等结果 等 1 个后台命令 | 1m 46.6s
```

用户原话：「子对话没有完成为什么显示已关闭？」——同一行里既有「已关闭」，又有「计划 13/14」「等结果」「等 1 个后台命令」，状态自相矛盾：关闭意味着进程没了、不该还在等东西。用户随后补充的真实担心是「对话还在运行不要关闭那个对话 CLI」，即怀疑面板把还在跑的对话的 CLI 提前回收了。

## 复现

1. 父对话派出的子对话跑到计划中途，发起一条后台命令（或子任务 / 工作流），进入等结果状态。
2. 等结果期间子对话没有需要常驻的 CLI 进程：`cliAlive` 为假，而这一轮逻辑上还在跑（`childIcon` 仍是 `running`）。
3. 打开父对话运行区的那一行（或子对话切换下拉、子对话卡片），行上就同时出现「已关闭」和「计划 n/m」「等结果」。

纯逻辑的最小复现见 `web/src/components/tasks/child-line.test.ts` 的 `closedWaiting()`：`cliAlive: false` + `plan: { done: 13, total: 14 }` + `waiting: { kind: 'background', n: 1 }`。

## 根因

「已关闭」是 `childLabels` 里唯一没走 `childIcon` 派生的标签。修复前：

```ts
if (!c.cliAlive) out.push({ text: t('已关闭'), tone: 'plain' })
if (c.resolved && icon === 'done') …
if (icon === 'waiting') …
if (icon === 'running' && c.plan) out.push({ text: t('计划 {done}/{total}') …)
```

`cliAlive` 是服务端按真实进程算的（`server/exec/process.ts` 的 `taskCliAlive` 读进程登记表，`server/tasks.ts` 里以 `cliAlive: taskCliAlive(task.id)` 挂到 `/children` 的响应上），它只说明「这一刻有没有活着的 CLI 进程」，不说明「这一轮做完了没有」。而子对话在等后台命令、等子任务、等工作流时，自己的 CLI 进程本来就可能已经退出（不需要常驻），`shared/task.ts` 的 `childWait` 里 `background` / `helpers` / `workflow` 三种等待也都和 `cliAlive` 无关，只有 `next`（等下一句）才要求 `cliAlive`。于是「进程没了」和「还在跑」同时为真，一个按 `cliAlive`、一个按 `childIcon` 的两套判定把矛盾画进了同一行。

函数上方的注释本来写着「同一行只说一件事，全部从 childIcon / childState 派生」，「已关闭」正是这条约定的例外。另外运行区那一行是快照：CLI 回收后标签会留到下一次 `/children` 请求刷新，陈旧状态也会加重这个观感。

## 排除的另一种可能：回收判定没有把还在跑的对话关掉

用户担心的「CLI 被提前关掉」不是回收 Bug，回收侧没有改。依据：

- `server/tasks.ts` 的 `keepAliveBusy(id)`（约 3309 行）：先看 `startQueue` / `hasHeld`，再把 `background: pendingJobs(id)` 和名下还在运行的子对话数传给 `shared/task.ts` 的 `keepAliveBusy`。
- `pendingJobs(id)`（约 1512 行）统计 `background.list(id)` 里 `queued` / `running` 的后台命令，所以「有后台命令在跑 / 排队」是显式算进「忙」的，不依赖 `task.working`。
- `shared/task.ts` 的 `keepAliveBusy`（约 1549 行）：`working` / `prewarming`、`status === 'running' && !awaitingUser`，最后落到 `convActive(convState(taskFacts(t) + background + children))`。
- `convState`（`shared/task.ts:500`）：`pending = background || workflow || helpers || children` 时返回 `'waiting'`；`convActive`（`shared/task.ts:519`）把 `'running'` / `'waiting'` / `'needs'` 都算在运行。ADR 0012 的「两个回收时长、保活上限都先问它」就走这条链。
- 两个时长（约 296 / 305 行）和保活上限（约 3367 行的 `pool`）都先问 `keepAliveBusy`，名字里带着后台命令的对话不参与按「离开多久」的回收。

所以「等后台命令期间对话被回收掉」在判定上不成立：CLI 进程退出是设计内的省资源结果，不是回收逻辑误判。用户看到的「已关闭」纯粹是显示口径问题。

顺带核实的续接链路也没断：`server/tasks.ts` 约 993 行「结果推回去会开新一轮；开不起来时（已停止、已经合并好的）就在这里再试一次回收独立分支」，后台命令结果推回来会重新拉起 CLI 接着做，进程回收不影响这一轮做完。

## 修复

- 新增私有判定 `convClosed(c) = !c.cliAlive && childIcon(c) === 'done'`：只有这一轮真的结束（图标 `done`）**且** CLI 已回收时才说「已关闭」。「已关闭」由此并入 `childLabels` 的 `childIcon` 派生，不再有第二套判定。
- 执行中、等结果、等你处理、未完成、待收尾（`childIcon` 为 `running` / `waiting`）一律不显示「已关闭」：那时对话还在跑，说它关了就是矛盾。
- 停下（`stopped` / `idle`）也不显示：行上已经用 `stopReasonText` 写清「已暂停」或别的结束原因，再叠一句「已关闭」是同一件事说两遍。
- 为什么只认 `done` 而不是「不算 running 就说」：这一行要表达的是「本来已经没事可做，所以进程回收了」。`done` 正好是「彻底做完、CLI 关了」那一档（见 `shared/task.ts` 的 `childIcon` 注释），停下和未完成各有自己的话说，不该共用这句话。
- 进程回收的事实不丢，挪到悬停提示：新增导出 `childClosedHint(c)`，只在 `!c.cliAlive` 且图标是 `running` / `waiting` 时返回「CLI 进程已回收，继续会重新拉起」（英文 `'CLI 进程已回收，继续会重新拉起': 'The CLI process was reclaimed; continuing will start it again'` 已进 `shared/locales/en/tasks.ts`）。接入三处：`web/src/components/tasks/RunningNow.tsx` 的行下说明 title、`web/src/components/tasks/ChildSwitcher.tsx` 的列表行标题 title、`web/src/components/tasks/TaskView.tsx` 的子对话卡片 title。这样「进程没了」这个真实信息还在，只是不占状态标签那一行，也不会和「等结果」同屏。
- 没有只改文案：如果仍把「进程已回收」放进状态标签那一行，矛盾照旧（「进程已回收」+「等 1 个后台命令」还是自相矛盾），用户要的是状态一致。

## 回归

`web/src/components/tasks/child-line.test.ts`（新文件，文件开头 `setLang('zh')` 固定语言）：

1. 还在等后台命令（`cliAlive: false` + 计划 13/14 + 等 1 个后台命令）时不能出现「已关闭」，此时标签正好是「计划 13/14」+「等结果」。
2. 派出的子任务 / 工作流 / 等用户回答还没完时同样不出现「已关闭」。
3. 这一轮真的结束（`status: 'done'`、计划做完、没有待推回的结果）且进程回收：只说「已关闭」，不再带别的状态标签。
4. 做完了但 CLI 还开着：不写「已关闭」。
5. 停下（`stopReason: 'user'`）时写「已暂停」，不写「已关闭」。
6. `childClosedHint` 只在还在跑时给出提示，进程活着时为空；真的结束了的对话也不提「继续会重新拉起」。

## 防复发

- 「已关闭」已经并入 `childLabels` 的 `childIcon` 派生，和「已解决」「执行中」同一套：以后往这一行加标签，判定必须从 `childIcon` / `childState` 出来的结论里取，不要直接读 `cliAlive`、`resolved` 这类单一原始字段。
- 进程存活（`cliAlive`）是运行时事实、不是状态：它只适合放悬停提示、进程面板这类「补充说明」，不上状态标签那一行。同样的取舍见 [sidebar-chat-row-dashed](sidebar-chat-row-dashed.md)（`cliAlive` 曾被画成侧栏整行虚线边框）。
- 想再确认「有没有把还在跑的对话关掉」，看 `shared/task.ts` 的 `keepAliveBusy` / `convState`，别从界面上的「已关闭」反推回收逻辑。
