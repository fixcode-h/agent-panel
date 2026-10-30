# ADR 0033：对话状态的收口只有一种写法并定时核对，server/tasks.ts 按功能拆开、大文件只许变小

状态：已接受 · 2026-10-30

## 背景

2026-10-30 的优化分析（`/mnt/project-files/agent-panel/优化扩展分析-2026-10-30.md` 第 1、6、7 条）统计了 `docs/modules/*/bugs/`：用户报的 Bug 里大约一半是同一类——「状态收口缺口」「两处信号不同源」：子对话卡在等待模型、重启后还显示进行中、父对话被回收而子对话还在跑、继续执行漏掉父对话。用户同意按分析的建议顺序做。

核对代码后，状态的**读法**其实早已集中：`shared/task.ts` 的 `convState`（ADR 0005）是唯一判定，`childIcon`、`taskStage`、`taskState` 都从它派生。出问题的是**写法**：

| 位置                                       | 改动前                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `server/tasks.ts` 启动迁移 `ready`         | 自己写一份「落成已停止」：结轮次、步骤、等待时长、工作流运行                                                       |
| `server/exec/reclaim.ts` `settleReclaimed` | 又写一份，少了工作流运行                                                                                           |
| 各条收尾路径                               | 哪条忘了落状态，记录就一直写着 `running`，界面一直转圈，「继续执行」只在 `stopped` / `failed` 时出现，用户没有入口 |

同时 `server/tasks.ts` 一个 `tasksApi` 闭包装下全部对话逻辑：10-26 记的是 5704 行，10-30 已经 6775 行；并行的子对话同时改它最容易冲突，上面那类状态问题也大多出在这里。

## 决策

### 一、「落成已停止」只有一种写法

`shared/task-settle.ts` 的 `settleStopped(task, reason)` 是纯函数：结掉还在跑的轮次、步骤（记为被打断，继续执行时续接会话）、工作流运行（计划里绑着它的那一步按没走完收口）和三段等待时长，结算基准是最后一次落盘的时间，不改消息和列表时间。启动迁移（`server/tasks/startup.ts`）、页面回收（`settleReclaimed`）、定时核对都只调它，调用方只决定「什么时候收、原因是什么、要不要加一句说明」。

### 二、定时核对：记录和实际对不上就收口，并告诉用户

`shared/task-settle.ts` 的 `stateBreaks` 只判面板自己能确定的两种矛盾：

- `orphan`：记录说在做（`running` / `working` / 预热 / 工作流运行中），面板里却没有执行位、不在启动队列、也没有后台命令会把结果推回来；
- `merging`：收尾请求停在「合并中」，面板却没有在合并它。

`server/tasks/state-sweep.ts` 每 60 秒（`AGENT_PANEL_STATE_SWEEP_MS` 可改）扫一遍；**连着两次看到同一个矛盾、中间任务没被写过（`updatedAt` 不变）才动手**，避开「先放执行位、后落盘」「先清合并标记、后改记录」那几毫秒。`orphan` 按 `settleStopped(task, 'lost')` 落成已中断，在对话里写一句原因；`merging` 退回「已请求收尾」并在父对话收件箱里留一句让它重新 `finish_child`（和重启后同一个 `reopenMerge`）。新增停下原因 `lost`（「执行已经中断，面板核对时收口」），父对话继续执行时和 `restart` 一样连带拉起（`resumeKids`）。

这是兜底，不替代各条路径自己落状态：日志里每次收口都有一条「定时核对：记录和实际对不上」，出现了就说明某条路径漏了，按日志里的任务去补那条路径。

### 三、server/tasks.ts 按功能拆到 server/tasks/

`tasksApi` 只留共用的状态（`store`、`live`、`startQueue`、`claims`……）、小工具、路由的组装和对外返回的接口（6775 → 约 800 行）。其余按功能拆成 `server/tasks/` 下的模块（清单和每个函数在哪见 [modules/server](../modules/server/README.md)「server/tasks.ts 拆分后的位置」）。

- 每个模块导出一个工厂 `createXxx(s: TasksScope)` / `registerXxxRoutes(s)`，在 `tasksApi` 里原来那段代码的位置调用，返回的函数解构回闭包。路由按原来的顺序登记（Hono 按登记顺序匹配，`/trash` 要在 `/:id` 前面）。
- 模块要用闭包里的名字时经 `s.<名字>` 取。`TasksScope`（`server/tasks/scope.ts`）是这些名字的类型；值由 `lazyScope` 建，每个名字是一个取值函数，**取值时才读**，所以闭包里后声明的常量也能放进去。`TasksScope` 和真实类型对不上时 `lazyScope<TasksScope>({...})` 那一行类型检查不过，不会悄悄漂移。
- 不依赖闭包状态的常量和小工具放 `server/tasks/helpers.ts`，类型放 `server/tasks/types.ts`。
- 搬代码用语法树做（把引用闭包名字的标识符改成 `s.名字`，同名局部变量自动换参数名），函数体一行没改；全量单测和端到端测试在拆分前后都通过。

### 四、大文件只许变小

`scripts/file-caps.json` 记下超过 1200 行的源码文件（不含测试、英文词典）各自的上限（当前行数加 50 取整到 50），`server/tasks.ts` 也在里面；没列的文件上限 1200。`npm run lint` 的规则检查第 15 条超了就失败，提示把新加的部分拆到独立模块。文件变小后跑 `node scripts/file-caps.mjs --update` 把上限降下来（只降不升）；确实要放宽就手改那一项并在提交说明里写原因。

## 放弃的做法

- **把状态改成显式的状态机（每次写状态都走转移表）**：读法已经集中在 `convState`，真正缺的是「漏写」的兜底；把几十处写 `status` / `working` / `wrapRequest` 的地方都改成转移调用，改动面大、并行冲突多，收益不如先把收口写法统一 + 定时核对。核对的日志会告诉我们哪些路径真的会漏。
- **按领域重写成 `ctx` 参数的普通函数**：要改每一处调用，等于重写 6000 行；工厂 + `TasksScope` 只改标识符引用，行为不变。
- **一次把大文件都拆完**：其余大文件（`shared/engine.ts`、`server/exec/runner.ts`、`TaskView.tsx`、`demo-backend.ts`）先用上限挡住继续变大，按需再拆。

## 风险与代价

- 其他正在改旧 `server/tasks.ts` 的分支合并时会大面积冲突：改动要搬到对应的 `server/tasks/` 模块里重做（函数名没变，按上面的清单找）。
- `TasksScope` 是手写的类型（拆分时生成），新加一个闭包名字给模块用时要同时改 `scope.ts` 和 `tasksApi` 里的 `lazyScope` 那一项。
- 定时核对每分钟读一次任务列表（`store.list()`，内存里的元数据，不读对话文件），成本可以忽略。
