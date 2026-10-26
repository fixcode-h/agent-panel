# 子任务还在跑，状态行却说「等待你的下一条消息」+「空闲」

- 状态：已修复（界面检查 `scripts/ui/02-task.mjs` 的「任务-等子任务时状态行 / 任务-等下一句时状态行」；纯逻辑回归 `shared/task-stage.test.ts` 的「childWait：这一轮结束、子任务还在跑时是在等子任务，不是在等下一句」）
- 症状：对话派出的子任务还在跑命令，状态行却写「等待你的下一条消息」+「空闲」
- 入口：`web/src/components/tasks/TaskView.tsx` 的 `ChatWaitLine`、`web/src/components/tasks/LiveStats.tsx`
- 根因类型：显示条件只判 `awaitingUser` + `cliAlive`，没复用 `childWait` 判「有没有子任务 / 后台命令 / 工作流在跑」
- 模块：`web`（`web/src/components/tasks/TaskView.tsx` 的状态行、`web/src/components/tasks/LiveStats.tsx`）
- 关键词：状态行、等待你的下一条消息、空闲、子任务在跑、`awaitingUser`、`childWait`、`cliAlive`、`LiveStats`、`data-chat-wait`

## 现象

用户报：「这个对话还在运行，且没有输出，为什么不显示」。同一时刻两张截图：

- 对话页最下面一条是运行区一行「⟳ 子任务　**评审后台命令输出弹窗**　评审　执行中　运行命令 `cd /c/Users/…`　4m 8.3s」——这个对话派出的子任务正在执行、还在跑命令，对话显然没结束。
- 状态行却是「💬 等待你的下一条消息 ⋯　　⚡ 空闲 ↑45.34M ↓94.0k」——既说在等用户，又说空闲。

即「子任务在跑」被说成了「在等你，而且没事做」。

## 复现

1. 对话回复完这一轮（`working` 回到 false，CLI 停在面板工具上等下一句，`awaitingUser` 和 `cliAlive` 都是 true）。
2. 它派出的子任务（`slot === 'sub'`、`status === 'running'`）还在跑命令。
3. 打开这个对话页，状态行同时显示「等待你的下一条消息」和「空闲」。

演示数据里 `web/src/lib/demo-backend.ts` 的 `demoWaitingHelper` 造的就是这一刻（对话「后台命令弹窗实时看输出」：`awaitingUser: true` + `cliAlive` 有登记 + 一个 `status: 'running'` 的 `@chat/sub/h1`），界面检查靠它当正例；对照是「整理一份 Claude Code 和 Codex 的能力对照」（只有 `awaitingUser` + `cliAlive`，没有子任务），那一刻写「等待你的下一条消息」才是对的。

## 根因

显示层的判定条件漏了「还有东西在跑」这一半：

```tsx
// 修复前
{running && task.mode === 'chat' && !working && task.awaitingUser && task.cliAlive && (…「等待你的下一条消息」…)}
```

只读 `awaitingUser`（CLI 停在面板工具上等下一句）和 `cliAlive`（进程还活着），完全不看派出的子任务、后台命令、工作流是否还没完。而这两件事可以同时成立：这一轮确实收尾了（所以 `awaitingUser` 为真），但子任务的结果还没交回，对话在等子任务而不是在等用户。

项目里本来已经有把这个顺序判对的函数——`shared/task.ts` 的 `childWait`，注释写明顺序是「等用户回答 → 等确认 → 等后台命令 → 等派出的子任务 → 等工作流 → 最后才是等下一句」，`if (helpers.length) return { kind: 'helpers', list: helpers }` 排在 `if (!tk.working && x.cliAlive) return { kind: 'next' }` 之前。子对话栏（`/tasks/:id/children` 的 `waiting`）、交给父对话的上报、`convState`（`pending = background || workflow || helpers || children` → `'waiting'`）都走这一套。**只有这个状态行没走**，两套判定给出的结论就不一致——这正是这次现象的直接原因。

同一个根因还带出第二个误导：`LiveStats` 把「没有 token 输出」一律写成「空闲」（`tps > 0 ? 'xx token/s' : t('空闲')`）。等子任务时父对话本来就不出 token，于是「在等子任务」被说成「空闲」。

服务端这一半没有改：`server/exec/runner.ts` 的 `listen(signal, helpers)` 在等子任务时只置 `waitingHelpers`、不置 `awaitingUser`（`if (helpers) waitingHelpers = true; else { task.awaitingUser = true; … }`），设计上是对的。`awaitingUser` 的语义是「停在等下一句」，`keepAliveBusy` / `keepAliveVictims` 都读它（见 `shared/task.ts` 约 1549–1575 行），动它的语义影响面大；而且「这一轮结束了、但派出的子任务还在跑」这个时刻本身是合法的（子任务结果会交回同一个进程接着做），服务端不需要改。显示层是唯一确定有问题的一层。

## 修复

- `TaskView.tsx` 新增 `chatWait`：`task.mode === 'chat' ? childWait(task, { background: task.jobs?.length, cliAlive: task.cliAlive }) : undefined`。`background` 取 `task.jobs?.length`（服务端 `withLive` 给它带上还在跑 / 排队的后台命令），`cliAlive` 用服务端按真实进程算的那个。**不另写第三套「有没有东西在跑」的判定**——这个项目已经有 `convState` 和 `childWait`，各处再 filter 一遍就会重演 `visibleChildren` 注释里写的「条目数对不上」老问题。
- 新增 `ChatWaitLine` 组件按 `kind` 出文案，全部用已有的 key：`helpers` → `等待 {n} 个子任务完成`（和 `RunPhase` 里同一句）、`background` → `等 {n} 个后台命令`、`workflow` → `等工作流跑完`、`next` → `等待你的下一条消息`。等别人的结果时左边是转圈的 `Loader2`，等下一句才是对话气泡 + `WaitDots`——一眼能分开「它在干活」和「它在等你」。
- `answer` / `confirm` 两种情况返回 `null`：等用户回答、等确认已经由对话里的提问卡片表达，状态行再说一遍是重复。
- `next` 额外要求 `awaitingUser` 为真才显示（`ChatWaitLine` 的 `if (wait.kind === 'next' && !awaiting) return null`）：只是预热完、还在启动时不能写成「在等你」。
- 行上带 `data-chat-wait={kind}`：界面检查按它定位和断言，不靠中文文案猜。
- `LiveStats` 加 `waiting` 入参：没在出 token、但对话在等别人的结果时，速度位写已有的 `t('等待中')` 而不是 `空闲`。只在 `ChatWaitLine` 传 `waiting`，**而且只有 `!next` 才传**——真的停在等下一句时它确实空闲，写「空闲」是对的，不能一起改掉。其它调用点（运行区、工作流）行为不变。

## 回归

- `shared/task-stage.test.ts`「childWait：这一轮结束、子任务还在跑时是在等子任务，不是在等下一句」：`awaitingUser: true` + 一个 `running` 子任务 + 一个 `pending` 子任务时，`childWait(…, { cliAlive: true })` 返回 `{ kind: 'helpers', list: ['评审后台命令输出弹窗'] }`（只报在跑的，排队的不算「等着它完事」），不是 `next`；同时有后台命令时 `background` 排在前面；子任务都 `done` 之后才轮回到 `next`。这条用例锁的是**优先级**，防止以后有人把 `!working && cliAlive` 挪到 `helpers` 前面。
- `scripts/ui/02-task.mjs`「任务-等子任务时状态行」：打开「后台命令弹窗实时看输出」，断言 `[data-chat-wait]` 的 kind 是 `helpers`、文字含「等待 1 个子任务完成」、不含「等待你的下一条消息」、不含「空闲」、含「等待中」。
- 同文件「任务-等下一句时状态行」（反例）：打开「整理一份 Claude Code 和 Codex 的能力对照」，断言 `[data-chat-wait="next"]` 且文字含「等待你的下一条消息」。有这条才能证明上面那条不是靠「永远不显示这句话」通过的。
- 两个用例都按标题在演示数据里查 id、拼 `#/chat/<id>` 打开：侧栏的对话列表跟着筛选和滚动走，按 `title` 定位不稳。

## 防复发

- 状态行的「在等什么」只有一个事实源：`shared/task.ts` 的 `childWait`。往这一行加东西时从它返回的 `kind` 取，不要直接读 `awaitingUser` / `working` / `cliAlive` 中的一两个原始字段——这次就是漏了「还有东西在跑」。
- `awaitingUser` 是「停在等下一句」，不是「这一轮做完了」：子任务、后台命令、工作流没完时它照样可以为真。要判「做完没有」用 `convState`，要判「在等什么」用 `childWait`。
- 「没有 token 输出」不等于「空闲」：等别人的结果时用 `等待中`，见 `LiveStats` 的 `waiting`。同一类取舍见 [api-queue-while-streaming](api-queue-while-streaming.md)（在出 token 时不能写成在排队）和 [child-line-closed-while-running](child-line-closed-while-running.md)（进程回收不等于这一轮结束）。
- **演示数据里不要用 `live` 登记来表达「停在等下一句」**：`live` 在演示后端的语义是「有一轮正在跑」——`followUp` 直接 `fail('任务正在执行…')`，`/tasks/:id/messages` 有 `cur` 时把消息记成 `held` 并推进 `cur.held`，进程面板的 `demoLive` 也算 running。给一条 `awaitingUser: true` 的对话写 `live.set(id, { stop: false })`，页面显示「等待你的下一条消息」、输入框能输入，但**发出去的消息只会 `held` 在队列里没人接手**（没有 `cur.done` promise 来 finally 接一轮），要刷新页面才恢复。这次我自己就踩了：探针实测修复前 messages 停在 4 条、末条 `delivery.how === 'held'`、`working` 仍 false。表达「进程活着」用 `demoCliAlive`（它已经把 `awaitingUser` 算进去），不要额外写 `live`。
- 演示后端的 `cliAlive` 不能只按内存里的 `live` 登记算：`live` 只在本次页面加载里有效，**刷新后就空了**，存盘里明明 `awaitingUser: true` 的对话会变成「进程已回收」，`childWait` 也就算不出 `next`（这次界面检查的反例就是这样失败的：日志里没有等待行，正例却过——`helpers` 分支不看 `cliAlive`）。所以统一走 `demo-backend.ts` 的 `demoCliAlive(task) = live.has(id) || task.working || task.awaitingUser`，`/tasks` 列表、`/tasks/:id` 详情、`/children` 的 `cliAlive` / `waiting` 四处都用它；「这一轮在跑」和「停在等下一句」本身就意味着进程活着。这是对正式后端 `taskCliAlive`（读真实进程登记表）的演示替代，正式侧不需要改。
- 演示数据里补「故意停在某个状态」的对话时，注意已有用例的等待条件：`02-task.mjs` 等「分析对话跑完」用的是「新出现的任务里没有 running 的」，别把它写成「所有任务里没有 running 的」，否则新加的常驻 running 演示对话会让它一直等下去。
