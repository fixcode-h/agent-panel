# 强制更新弹窗累计显示历史上被打断的任务

- 状态：已修复（相关单测 `server/task-restart.test.ts`、`server/interrupted.test.ts`、`server/update.test.ts`、`shared/child-flow.test.ts` 共 46/46 通过；反向验证见「回归验证」）
- 症状：面板强制更新后弹窗写「有 24 个任务被强制更新打断」，列表里混着很多早就停下、计划没做完的历史任务（很多条「被打断时：计划 0/6」），不是这次强制更新真正打断的对话
- 入口：`server/tasks.ts` 的 `interruptedTasks`、`server/update.ts` 的 `stopForUpdate`、`server/interrupted.ts` 的 `recordInterrupted`、`shared/task.ts` 的 `interruptedTaskIds` / `restartUnfinished`
- 根因类型：恢复名单把「这一轮说完了、计划没做完」的闲置任务也算成本次被打断，记录又只在非空时覆盖
- 模块：`server`（`server/tasks.ts`、`server/interrupted.ts`、`server/update.ts`）、`shared`（`shared/task.ts`）
- 关键词：强制更新、继续执行弹窗、24 个任务、名单累计、历史任务、计划 0/6、restartUnfinished、openPlan、interruptedTaskIds、recordInterrupted、空名单不写、interrupted-by-update

## 现象

用户强制更新面板，新版本启动后弹窗标题写「有 24 个任务被强制更新打断」，列表里大量是早就停下、这一轮已经说完、只是计划没做完的历史对话（`doing` 多为「计划 0/6」）。用户原话：「针对这个打断不要累计，只需要记住当前打断，然后只显示当前打断要恢复的对话」。

期望：弹窗只列这次强制更新真正打断、需要恢复的对话；实际：把历史上所有「计划没做完」的闲置任务都列了进来，越更新越多。

## 根因

名单由 `shared/task.ts` 的 `interruptedTaskIds(tasks, working)` 生成，它对全部任务用 `restartUnfinished` 判：

- `restartUnfinished` 的最后一个分支是「这一轮说完了，但计划还没做完（`openPlan`）」（`shared/task.ts:1618`）。这个判定本来是给启动迁移的崩溃名单和界面「还有没有活要干」用的（`server/tasks/startup.ts:45`），对历史闲置任务同样成立。
- `interruptedTasks()`（`server/tasks.ts:328`）把它当成本次强制更新的名单：`working` 之外的所有任务只要 `restartUnfinished` 成立就进名单。于是每条历史上「停在等下一句、计划没做完」的任务都会被算成这次被打断的。
- `recordInterrupted`（`server/interrupted.ts:32`）在空名单时直接 return，上次没处理完的旧记录不会被清掉；下一次更新继续沿用旧名单，看起来就是不断累计。

真正的打断只有两类：CLI 正在产出（`working`），或者这一轮还在执行、被停掉的 CLI 结果回不来（`status === 'running'` 且不在等下一句，包括在等子任务）。停在等下一句的闲置任务不是这次打的断，重启后也不该默认被拉起来。

## 修法

- `shared/task.ts` 的 `interruptedTaskIds`：循环里只收 `!imported && !archived && status === 'running' && !awaitingUser && restartUnfinished(tk)` 的任务。仍然复用 `restartUnfinished` 的排除项（已收口、等诊断确认、用户暂停、待收尾），只是不再收它的 `openPlan` 闲置分支。
- `restartUnfinished` 本身不改：崩溃路径（`server/tasks/startup.ts` 的 `migrateOnStart`）还要用它判「重启前还有没有活」，那里没有「本次打断了谁」的记录。
- `server/interrupted.ts` 的 `recordInterrupted`：去掉空名单提前返回，每次都覆盖写。弹窗只显示当前这次打断；没有任务时写空名单，把上次没处理完的旧记录清掉。
- 父对话仍通过 `working` 条目的 `parentTaskId` 进名单（子对话的结果要交回它），`update-resume-missed-parent` 的修复不回归。

## 防复发护栏

- 强制更新 / 正常退出名单只用 `interruptedTaskIds`，不要在别处再按 `restartUnfinished` 或 `status === 'running'` 自己挑一遍；`restartUnfinished` 与「本次名单」口径不同：前者答「还有没有活」，后者答「这次停了谁的 CLI」。
- `interruptedTaskIds` 的 running 分支必须带上 `restartUnfinished` 的排除项，不能简化成只看 `status`，否则用户手动暂停的任务会被强制更新重新拉起来。
- `server/task-restart.test.ts` 覆盖：闲置但计划没做完的不进名单、在等后台命令 / 子任务的（`running` + `working: false`）进名单、父子都进名单、`awaitingUser` 的 `running` 任务不进名单。

## 回归验证

- `npx tsx --test server/task-restart.test.ts server/interrupted.test.ts server/update.test.ts shared/child-flow.test.ts`：46/46 通过。
- 反向验证：把 `interruptedTaskIds` 的循环临时退回旧口径（直接对全部任务用 `restartUnfinished`），`server/task-restart.test.ts` 有 3 条失败——「强制更新的恢复名单只记本次真正被打断的：闲置但计划没做完的不算」「强制更新名单里不再累计闲置的历史任务」「重启恢复名单：已收口的不再拉起，只在等下一句的不算被打断」；恢复后全文件通过。
- 待确认：真实强制更新的弹窗列表需要在打包版本上跑一次（会重启面板），由父对话合并后统一验证，本记录不声称已实测。

## 落地改动

- `shared/task.ts`：`interruptedTaskIds` 收窄名单口径，同步 `restartUnfinished` 的注释分工。
- `server/interrupted.ts`：`recordInterrupted` 空名单也覆盖写，更新 `restartDoing` 的注释。
- `server/tasks.ts`：`interruptedTasks` 的口径注释。
- `server/task-restart.test.ts`、`server/interrupted.test.ts`、`server/update.test.ts`：按新口径改断言、补覆盖。
- 文档：`docs/modules/server/lifecycle.md` 的「强制更新后：把被打断的任务列进恢复名单」「面板退出 / 重启后：首页『全部继续』」两节。
