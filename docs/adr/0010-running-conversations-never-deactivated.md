# ADR 0010：对话「在运行」只有一个判定，在运行的对话和它的子对话不失活

状态：已接受 · 2026-10-24

## 背景

用户 2026-10-24 提出：

- 子任务（`spawn_agents` 派出的）要有终止按钮，对话也要有工具能终止子任务。
- 父对话标题前也要转圈；对话对外的状态要统一，包括左侧项目列表里对话前面的图标和转圈。只要「子对话没完成、子任务没完成、后台任务 / 后台命令没完成、提问没回复」，这个对话就还在运行。
- 在运行的对话、子任务不能因为对话在后台、不是当前选中的就被失活；失活逻辑去掉一堆参数控制，明确一点：在运行的对话不能杀，包括它的子对话。
- 只要对话还在运行，输入框右边就是停止按钮；停止会停掉它附属的一切（子对话、子任务、后台命令、待回复的提问）。

## 事实核对（改动前）

| 位置                                                     | 现状                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `shared/task.ts` `taskBusy`                              | 顶层对话的「在跑」自己拼一套，不看提问和请求；`childrenWorking` 只数 `working` 的子对话                  |
| `server/tasks.ts` 列表接口                               | 只在列表摘要里给 `childrenWorking`；`GET /:id`、SSE 不给，标题栏只在子对话正在回话时才可能转圈           |
| `server/tasks.ts` `setPresenceIdleHandler`               | 宽限到期 `cancelWait` + `closeChildren`：父对话页切走一小时，名下还在跑的子对话被连带停掉                |
| `server/tasks.ts` `stopTask`                             | 不管什么原因都 `closeChildren`：保活上限（idle）、换 CLI（switch）、打断重发、CLI 卡住重开都会杀掉子对话 |
| `server/tasks.ts` 换 CLI / 模型                          | 空闲时重启父对话后再 `closeChildren`                                                                     |
| `server/presence.ts` / `keepAliveBusy`（1ced9bb 刚加的） | 又一套「在不在跑」：后台命令、活着的子对话（不管闲不闲）、这一轮没收尾                                   |
| 子任务                                                   | 只能整个对话停止；没有单独终止的入口                                                                     |
| 输入框                                                   | 只在 `working` 时是停止按钮：子任务、子对话、后台命令还在跑时显示发送箭头                                |

## 决策

### 一、「在运行」= `convActive(convState)`，只此一处

- `ConvFacts` 加 `children`（名下还在运行的子对话数），归入 `waiting`。
- 还有会推回来的结果（子对话、子任务、后台命令、工作流）时，这一轮失败了也算 `waiting`，不算 `failed`：结果回来会接着开一轮。
- `convActive(s)`：`running` / `waiting` / `needs`。这就是「在运行，不能杀」。
- 顶层对话用 `taskFacts(task)` → `taskState` / `taskActive` / `taskBusy`（转圈 = running 或 waiting；needs 画提问图标）；子对话照旧用 `childFacts`。
- `keepAliveBusy`（两个回收时长、保活上限都先问它）改成 `convActive` 加上「这一轮没收尾、在预热、有排队的消息」；名下子对话只数还在运行的（`childActive`）。

### 二、服务端补齐事实

- `childActive(tk)`：子对话 `convActive`（带后台命令数）或者在排队、有交过来的消息。
- `withLive(task)`：给完整任务补 `jobs` 和 `childrenWorking`（还在运行的子对话数）。列表、`GET /:id`、SSE 都走它，SSE 的比较键里也带上这个数，子对话开始、做完时标题栏跟着变。

### 三、失活规则只剩一条

在运行的对话不回收：宽限到期（presence 的 busy）、保活上限（`enforceKeepAlive`）都先问 `keepAliveBusy`。

子对话只在用户自己停止（`'user'`）、归档（`'archive'`）、删除父对话时一起结束。闲置回收、换 CLI、打断重发、CLI 卡住重开只是父对话自己这一轮的事，子对话有自己的进程和状态，做完结果照样推回父对话（父对话空闲时开新一轮）。`stopTask` 里 `closeChildren` 放在「父对话没在 live 里就返回」之前：父对话这一轮已经说完、只剩子对话在跑时，用户停止也能停掉它们。

### 四、终止子任务

- 引擎：`stopHelper(taskId, stepId, why)`。每个子任务一个 `AbortController`，经 `AgentCall.signal` 交给 runner（和整个任务的信号合在一起）；排队中的从队里拿掉、不占名额。被终止的标成 `skipped`，交回给对话的结果写「已终止：原因」。
- 界面：输入框上方「子任务」弹层每行、子任务窗口标题栏都有终止按钮（`POST /tasks/:id/subtasks/stop`）。
- 工具：`stop_subtask(ids?, reason)`，只能终止自己派出的；不写 ids 就是全部还没结束的。显示成「终止子任务 · 原因」。

### 五、输入框和停止

- 对话还在运行（`working || taskActive`）输入框就显示停止按钮。
- `/stop`：停掉这一轮和名下子对话、后台命令（含子对话的），子任务跟着任务信号结束；自己和子对话的提问、请求、请用户决定的选择一起作废。

## 没选的方案

- **保留 1ced9bb 的 `keepAliveBusy` 自成一套**：又是一处判定，和列表、标题、上报对不上；合并成 `convActive` 之上的一层。
- **父对话被回收时继续连带停子对话，只靠「父对话在跑就不回收」挡住**：父对话这一轮说完、只剩子对话在跑时 CLI 会退出，那一刻仍会误杀；子对话本来就不依赖父对话的进程。
- **设置里删掉回收开关和两个时长**：用户可见的设置，删掉要另说；这次只把「在运行的不受它们管」做实。

## 风险与代价

- 父对话被回收后子对话还在跑：结果推回时父对话冷启动一次（`--resume`），比误杀便宜。
- `withLive` 每次要扫一遍任务列表（内存里），SSE 每秒一次，量不大。

## 分期

一次做完。出口：类型检查、lint、单元测试（`shared/task-stage.test.ts` 的统一状态和 `keepAliveBusy`、`server/engine-steps.test.ts` 的终止子任务、`server/orch-mcp.test.ts` 的工具表）、e2e（`04-subagents` 的「父对话切走：宽限到期不连带停掉还在跑的子对话」）。
