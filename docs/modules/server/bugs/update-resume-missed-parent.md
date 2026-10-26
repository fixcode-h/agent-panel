# 强制更新后子对话接着跑，父对话却停在「已中断，等待继续执行」

- 状态：已修复（名单口径、`doing` 文案和界面侧的显示条件随同一批改动落地；`server/task-restart.test.ts` 8/8 通过，反向验证见「回归验证」）
- 症状：面板强制更新后弹出「继续执行」弹窗，子对话被继续、正常接着跑，父对话却停在「已中断，等待继续执行」——输入框占位写「继续输入要求」、右边是「继续执行」按钮，同一时间它名下的子对话在跑
- 入口：`server/tasks.ts` 的 `workingTasks` / `interruptedTasks`、`server/update.ts` 的 `stopForUpdate`、`server/interrupted.ts` 的 `recordInterrupted` / `interruptedApi` / `restartDoing`、`shared/task.ts` 的 `restartUnfinished` / `interruptedTaskIds`、`web/src/components/layout/UpdateResumeDialog.tsx`、`web/src/components/tasks/TaskView.tsx` 的「继续执行」按钮和输入框占位
- 根因类型：恢复名单口径只看进程（`working`），漏掉「这一轮已经说完、计划没做完」的父对话
- 模块：`server`（强制更新 `server/update.ts`、被打断记录与弹窗接口 `server/interrupted.ts`、任务 API `server/tasks.ts`、接线 `server/index.ts`）、`shared`（名单判定 `shared/task.ts`、英文文案）、`web`（弹窗 `web/src/components/layout/UpdateResumeDialog.tsx`、输入框「继续执行」与占位 `web/src/components/tasks/TaskView.tsx`）
- 关键词：强制更新、继续执行弹窗、父对话没继续、子对话在跑父对话等继续、继续输入要求、interrupted-by-update、强制更新打断的任务、workingTasks、interruptedTasks、restartUnfinished、interruptedTaskIds、stopForUpdate、stopReason restart、计划没做完

## 现象

用户强制更新面板，新版本启动后弹出「继续执行」弹窗（`UpdateResumeDialog`），勾选后子对话正常接着跑；同一时间父对话（统筹对话）停在：

- 对话流里一条系统提示：「面板关闭或重启时任务还在执行，已中断。点『继续执行』从中断的节点接着做（会续接那个节点的 Agent 会话）。」
- 输入框占位「继续输入要求」，右侧「继续执行」按钮 + 停止按钮。

用户的原话：「更新后弹出继续弹窗，为什么子对话正常跑了，但是父对话却还显示等待继续」。他不理解为什么子对话能自己接着跑、父对话要手动点一次。

## 查实的证据

- `~/.agent-panel/cache/interrupted-by-update.json`（本轮已读）：`at` 为 `2026-10-26T05:28:17.346Z`（本地 13:28:17），`acknowledged: true`，`tasks` 只有一项 `b41b2c3f-cec0-456c-937a-0e1d80dbc4f2`，`doing` 是「你停在「等下一句」已经 2 小时…请接着把这条做完并收尾。」——**父对话不在名单里**，所以新版本启动后没有任何东西把它拉起来；它被启动迁移（`server/tasks.ts` 的 `ready`）落成 `stopped` + `stopReason: 'restart'`，界面只能显示「已中断 · 面板重启时中断」和「继续执行」。
- 名单之所以只挑到子对话：强制更新停 CLI 前调的是 `workingTasks()`，它按 `working === true`（CLI 正在产出）过滤。父对话当时停在等下一句，`working: false`，计划只做到一部分，于是两头不沾：既不在「在跑」的名单里，也没人给它重新拉起。
- 待确认：排查时引用的面板日志 `logs/agent-panel-20261026-132825-77740.log`（13:28:28 只对子对话 `b41b2c3f` 继续执行，父对话 `93b08721` 直到 13:29:25 才被手动继续）在本轮写文档时已不在 `logs/` 下（目录里最早的只剩 13:42 那一批），未能重新复核；同一时刻的名单文件内容与上述结论一致（见上一条）。

## 根因

「重启后要不要把这条任务接着跑」和「这条任务现在有没有进程在跑」被当成了同一件事。

- 恢复名单来自 `workingTasks()`：它回答的是「CLI 进程此刻在不在产出」，是给清扫独立目录（`sweepStaleWorktrees`）用的口径。
- 父对话卡在「这一轮已经说完、在等下一句」时 `working` 是 `false`，但它的计划还没做完（用户报的那条是 12/17），重启后没有进程会自己往前走；它需要重新拉起。
- 名单里只要少一个 id，后果固定：`ready` 把它落成 `stopped` + `stopReason: 'restart'`，界面就画成「已中断 · 等继续」，而它名下的子对话因为在名单里被继续了——于是出现「子对话在跑、父对话却在等继续」的矛盾状态。

## 修法

名单口径改成 `shared/task.ts` 的 `interruptedTaskIds(tasks, working)`，三类都进：

1. 现在真在跑的（`working`）；
2. 名下还有在跑子对话的父对话（`working` 条目带的 `parentTaskId`）——子对话的结果要交回它，它不在名单里就没人接；
3. `restartUnfinished` 成立的：这一轮被打断（`status === 'running'`、还有派出的子任务 / 工作流在跑），或者这一轮说完了但计划没做完（`openPlan`）。

`restartUnfinished` 与 `restartInterrupted` 分工写清：后者回答「界面还会不会画成在跑」（含独立分支还没合回、由 `ready` 落成 stopped），前者回答「重启后该不该列进继续名单」。不算的三种：待收尾（`wrapRequest` 不是 `failed`，剩下的事是父对话合并，不靠 CLI 进程）、独立分支还没合回（同上）、后台命令（`jobs` 不存盘，重启后无从判断）。

记录里的 `doing` 由 `server/interrupted.ts` 的 `restartDoing` 生成：正在执行的节点标题 → 没做完的计划进度（`计划 6/8`）→ 最后一条要求的第一行。父对话没有在跑的节点，只写最后一条要求看不出还剩多少活没做完。判定和名单都在纯函数里，服务端只负责取完整任务（`store.list()` 的摘要把 `plans` 清空了），只在强制更新停 CLI 前调一次。`workingTasks()` 保留给清扫独立目录。

界面侧同时消掉「自相矛盾」：`web/src/components/tasks/TaskView.tsx` 的「继续执行」按钮在这一轮已说完、名下还有子对话 / 子任务 / 后台命令 / 工作流在跑时不显示（否则和旁边的停止按钮打架），输入框占位改成「{what}，可以直接输入要求」；`UpdateResumeDialog` 的说明从「停掉了这些正在执行的任务」改成「停掉了这些任务正在做的事」（名单里现在也有没在跑、但计划没做完的任务）。

## 防复发护栏

- 「要不要继续」只认 `restartUnfinished` / `interruptedTaskIds`，不要再按 `working` 或 `status === 'running'` 自己挑一遍：两个问题分开问（见上）。
- 名单判定必须拿完整任务：`taskSummary` 清空了 `plans`，用列表摘要判「计划没做完」会永远判假。
- `server/task-restart.test.ts` 的「强制更新的恢复名单」用例覆盖四种情形（子对话在跑 + 父对话计划没做完、没有任何任务在跑、父对话计划做完了也要记、归档 / 导入的不进名单），改这块先跑它。
- 界面上的「继续执行」必须和「有没有东西还在跑」一致：`taskWaitText` 非空时不显示，避免又出现「子对话在跑、父对话等继续」。

## 回归验证

- `npx tsx --test server/task-restart.test.ts`：8/8 通过（本轮新增 3 条：`restartUnfinished` 的判定「计划没做完算、做完了不算、独立分支没合回不算」、`interruptedTaskIds` 的名单、`tasksApi().interruptedTasks()` 里父对话的 `doing` 写成「计划 6/8」）。
- 反向验证（按项目教训 `lmvmabgjdi271`）：把 `interruptedTasks` 的名单临时退回「只看 `working`」后，「恢复名单里的父对话说明它被打断时在做什么」这条失败（`parent` 不在名单里）；恢复后 8/8 通过。
- 待确认：按验收标准做的实测（起面板 → 父对话有子对话在跑 → 强制更新 / 模拟 `ready` 迁移 → 看父对话是否自动继续）需要重启面板服务，由父对话在合并后统一做，本记录不声称已实测。

## 落地改动

- `shared/task.ts`：新增 `restartUnfinished`、`interruptedTaskIds`。
- `server/tasks.ts`：新增 `tasksApi` 的 `interruptedTasks()`。
- `server/interrupted.ts`：新增 `restartDoing`（`doing` 的取值顺序）。
- `server/update.ts`：`stopForUpdate` 的 `interrupted` 允许异步（名单要读任务文件，读不出来也照常停 CLI）。
- `server/index.ts`：`updateApi` 的 `interrupted` 接到 `tasks.interruptedTasks()`。
- `web/src/components/tasks/TaskView.tsx`：「继续执行」不显示的条件、输入框占位。
- `web/src/components/layout/UpdateResumeDialog.tsx`：说明文案。
- `shared/locales/en/tasks.ts`、`shared/locales/en/server.ts`：对应英文文案。
- `server/task-restart.test.ts`：新增 3 条用例。
- 文档：`docs/modules/server/README.md` 的「强制更新后：把被打断的任务列进恢复名单」、`docs/modules/web/README.md` 的对应条目。
