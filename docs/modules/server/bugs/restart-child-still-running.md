# 面板重启后子对话仍显示在跑：行首还在转圈、计进「N 个执行中」，同时又提示「CLI 进程已回收」

- 状态：已修复（代码和 `server/task-restart.test.ts` 随同一批改动落地；`npm run typecheck`、`npm run lint`、`npm run test:e2e:wsl` 通过，回归用例 5/5 通过，实测见「回归验证」）
- 症状：面板程序重启后，重启前还在跑的子对话在界面上仍显示「进行中」（行首转圈、计进侧栏分组的「N 个执行中」）
- 入口：`server/tasks.ts` 的 `ready` 启动迁移、`shared/task.ts` 的 `childIcon` / `childState`（`convState` 的 `unfinished` / `unmerged`）
- 根因类型：重启迁移范围不足 + 状态判定不看进程存活（两处信号不同源）
- 模块：`server`（启动迁移 `server/tasks.ts`，进程清理 `server/exec/orphans.ts`）、`shared`（状态判定 `shared/task.ts`）、`web`（子对话行的提示 `web/src/components/tasks/child-line.ts`）
- 关键词：重启、转圈、执行中、N 个执行中、CLI 进程已回收、继续会重新拉起、stopReason restart、unfinished、unmerged、childIcon、ready、cleanStaleCliProcesses

## 现象

用户在面板重启后看到（截图）：

- 左侧任务列表：「SilverPalace」分组右边挂着红色标签「1 个执行中」，分组里那条子对话仍是转圈状态。
- 右侧对话流里对应的一条卡片写着：

  > 子对话 对话列表小圆点与转圈同时出现 ｜ 计划 6/8 未完成 ｜ CLI 进程已回收，继续会重新拉起

也就是说面板自己知道「CLI 进程已回收」，但这条子对话在列表和任务树里仍然算「执行中」。用户的要求：重启会让这一轮断掉，看不到任何正在产出的过程，转圈就是在骗人，重启后应该显示成静止态（已停止 / 已中断）。

## 复现条件

1. 子对话这一轮已经说过话了（落盘里 `status` 是 `done`），但**计划没做完**（`openPlan` 有值，例如 6/8）或者**独立分支还没合回**（`worktree.state === 'active'`）。
2. 这时重启面板（关掉服务再开，或者崩溃后被重新拉起）。
3. 重启后 `server/exec/orphans.ts` 的 `cleanStaleCliProcesses` 按 `run/cli-pids.json` 把遗留 CLI 杀掉、清掉登记，但**不碰任务记录**；`server/tasks.ts` 的 `ready` 只迁移 `status === 'running'` 的任务，这一类 `status` 是 `done`，原样留在落盘里。
4. 界面按 `childIcon` 判定：`convState` 因为 `unfinished` / `unmerged` 返回 `unfinished`，`childIcon` 对它返回 `running` → 行首转圈、子对话栏算在跑；同一行 `cliAlive` 是 `false`，`convGone` 返回 `hint`，又挂一句「CLI 进程已回收，继续会重新拉起」。

本机真实数据里就是这样一条：子对话 `c8f2721d-f0e7-4057-b1ee-734aa377da0a`（父对话 `93b08721-4bab-4f55-93e6-0e2fe180eeab`），落盘里 `status: 'done'`、`working: false`、计划 6/8（`doneAt: ''`）、`worktree.state: 'active'`、没有 `wrapRequest`。

## 根因

先按三种候选分别查，结论是第三种为主、第二种是伴生现象：

1. **「启动时只清了进程、没把任务状态改成已停止」**：一半成立。`cleanStaleCliProcesses`（`server/exec/orphans.ts`）只按 pid 登记杀进程并清登记文件，确实不动任务记录；但 `server/tasks.ts` 的 `ready` 本来就有迁移，问题在它的**范围**——过滤条件是 `x.status === 'running'`。
2. **「状态改了、界面的 running 判定另算一处」**：成立，是伴生现象。行首图标和子对话栏读 `childIcon`（`unfinished` 也返回 `running`），而「进程还在不在」这句提示读 `cliAlive`（`convGone` / `childClosedHint`）。两处信号不同源，就出现「转圈 + CLI 进程已回收」同屏；侧栏分组的「N 个执行中」又走 `taskBusyCount` / `taskBusy` → `convState(taskFacts)`，和行首图标不是同一个函数。
3. **「重启后没有重新校验进程在不在就沿用旧状态」**：主因。`childIcon` 的输入 `ChildEntry.cliAlive` 只影响「已关闭」标签，**不参与图标判定**；`childIcon` 对 `unfinished` / `unmerged` / `wrapup` 一律返回 `running`。这个「还有事没做完 = 还在跑」的判定在进程活着时是对的，重启后 CLI 已经没了、后台命令和工作流的内存记录也一起没了，它就不再成立，而启动迁移没有把这一类任务收口。

所以缺的不是「再算一次进程在不在」，而是「重启后要把『界面还会画成在跑』的任务统一落成已停止」：判据要和图标同源，不能另写一套「算不算在跑」（项目教训 `lmvkmb75vog8n`）。

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

## 回归验证

### 用例（按项目教训 `lmvmabgjdi271`，先在旧实现上确认会失败）

| 实现                                     | 结果                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| 旧实现（`ready` 只过滤 `status === 'running'`） | 「计划没做完」「独立分支没合回」两条失败，其余 3 条通过          |
| 新实现                                   | 5/5 通过                                                               |

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

静态检查、单测和端到端（动了启动迁移，按大改动跑）：

```bash
npm run typecheck && npm run lint
npx tsx --test server/task-restart.test.ts   # 5/5 通过
npm run test:e2e:wsl                         # WSL Ubuntu-24.04，退出码 0，全部分片通过
```

## 落地改动

| 位置                          | 改了什么                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/task.ts`              | 新增 `restartInterrupted(task)`：按 `ChildEntry` 走 `childSpinning` / `childState`，返回「重启后界面还会画成在跑」；`wrapup` 排除                                       |
| `server/tasks.ts`             | `ready` 过滤条件扩成 `status === 'running' \|\| restartInterrupted(x)`；系统消息按「这一轮还在跑」和「已经说完但没收尾」分两种文案                                  |
| `shared/locales/en/server.ts` | 补新文案的英文 `This work was not finished before the panel restarted and is no longer running. Send a message to continue; the CLI will be started again.`                                      |
| `server/task-restart.test.ts` | 新增 5 条用例（见「防复发护栏」）                                                                                                                                                                |

## 待确认

- 另一个改动正在动 `shared/task.ts` 的 `childIcon` / `childSpinning` 附近和 `web/src/components/tasks/` 的圆点、转圈判定：`restartInterrupted` 依赖 `childSpinning` / `childState` 的语义（`unfinished` / `unmerged` / `wrapup` 返回 `running`），合并时若那边改了这几个状态的图标映射，这条迁移的覆盖范围和本记录的结论要一起重核。
