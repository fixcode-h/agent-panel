# ADR 0063：对话的运行时状态只由服务端算，页面只读 live，列表变化由全局事件流推

状态：已接受（2026-11-12，重构文档第 1、2、8 条） · 2026-11-12

## 背景

- `Task` 一个类型同时当三种东西用：存盘记录、交给页面的完整对话、列表摘要。服务端在不同路由里往它身上叠运行时字段（`cliAlive`、`jobs`、`childrenWorking`、`childrenCli`、`childrenNeeds`），有的路由叠、有的不叠；`jobs` 等还会被顺手写回磁盘。
- 页面拿到任务后自己调 `taskState` / `taskBusy` / `taskDoneDot` 推状态。哪个接口没叠全运行时字段，那一处的状态就静默算错：侧栏转圈、项目首页、标签页计数、浮条各有各的口径。
- 列表靠「有对话在跑时每 2.5 秒轮询」刷新。进程退出、后台命令结束这类不改任务记录的变化，要等下一次轮询；没有在跑的对话时干脆不轮询，CLI 关掉后流光一直不撤。

## 决策

1. **运行时状态是单独的 `TaskLive`**（`shared/live/task-live.ts`）：`state`、`need` / `wait` / `report`（文字分类）、`next`（CLI 还活着、等下一句）、`cliAlive`、`jobs`、子对话的三项计数。算法只有 `taskLiveOf(task, runtime)` 一个，服务端只在 `server/tasks/live.ts` 调它；演示后端扮演服务端，调同一个函数。
2. **交给页面的任务都带 `live`**：列表、详情、实时推送、全局事件流都经 `liveOf` / `withLive`；`server/tasks.ts` 的中间件给漏带的 JSON 响应补上。运行时字段从 `TaskData` 里去掉，`NOT_STORED_FIELDS` 写盘前剥掉，旧文件里存过的由数据迁移清掉。
3. **页面只读 live**：`web/src/lib/api.ts` 和 `task-stream.ts` 拿到响应就把 `live` 取下放进 `web/src/lib/live/store.ts`，组件经 `useLive` / `useLiveOf` / `useLiveById` 读，判断用 `liveWord` / `liveBusy` / `liveActive` / `liveDot` 等。web/src 里（演示后端除外）不再调 `taskState` 一类，`scripts/rules-check.mjs` 第 22 条拦。
4. **全局事件流**：服务端每秒比一次顶层对话的列表指纹和 live（`server/tasks/page-feed.ts`，有页面连着才比），列表变了推 `tasks`（页面带 ETag 重新拉一次列表），live 变了只推变了的那几个。页面连不上 5 秒以上才退回旧的 2.5 秒轮询。
   - 挂在已有的页面事件流 `/api/app/events` 上（`server/page-events.ts` 的 `addPageFeed`），页面只开这一条（`web/src/lib/live/page-stream.ts` 按引用计数共用）。
   - 放弃：单开 `/api/events`。浏览器对同一地址最多 6 条 HTTP/1.1 连接，每个页面已经有托盘信号和打开对话的实时推送两条常驻连接，再多一条，开到第二个标签页就占满，普通请求排队卡住。

## 后果

- 新增运行时事实（比如以后要显示的进程内存）加进 `TaskLive` 和 `taskLiveOf`，不往 `Task` 上叠。
- 子对话的 live 不进全局事件流（侧栏、首页只列顶层对话），由打开着的对话页各自的实时推送和列表接口带。
- 状态字面量比较（`task.status === 'running'` 一类）在组件里还有几十处，多数是「对话记录本身的状态」而不是运行时状态，这次不动；工具行「还在不在跑」由页面猜的那一处等后台命令那条重构一起改。
