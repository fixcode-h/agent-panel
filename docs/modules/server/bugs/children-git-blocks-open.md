# 打开有多条子对话的对话时「读取子对话」和「连接实时更新」一起卡 20 秒以上（/children 同步等每个子对话的 git）

- 状态：已修复（`server/worktree-cache.ts` 新增、`server/tasks.ts` 的 `/children` 改成不等 git；回归用例 `server/task-children-load.test.ts` 2/2、`server/worktree-cache.test.ts` 13/13 通过，`npm run typecheck`、`npm run lint`、增量单测 13 个文件通过；实测见「回归验证」）
- 症状：打开一条子对话很多的父对话，加载日志停在「读取子对话 进行中 · 已等 20s」和「连接实时更新 进行中 · 已等 21.2s」两行同时往上涨；「读取对话」「标记已读」「渲染消息」都已完成（1.2s / 1.2s / 45ms）。关掉再开、开第二个页面都一样。
- 入口：`server/tasks.ts` 的 `GET /:id/children`（每个子对话 `await childWorktree()` → `server/exec/worktree.ts` 的 `worktreeStatus`，3~4 条 git）、`GET /:id/events` 首包（`liveKey()` → `childCountsOf`）、`web/src/components/tasks/TaskView.tsx` 的 `children` / `stream` 两步和 `web/src/lib/task-stream.ts` 的 `open` 回调
- 根因类型：热点接口在请求里同步跑外部进程（git）+ 没有 in-flight 去重，慢查询被轮询反复放大；同进程的 SSE 首包被拖住，于是一个慢点表现为两条步骤一起卡
- 模块：`server`（`server/tasks.ts` 的 `childWorktree` / `/children`、新增 `server/worktree-cache.ts`）、`web`（`TaskView` 的子对话轮询）
- 关键词：打开对话慢、读取子对话、连接实时更新、21 秒、20 秒、/children、SSE 首包、childWorktree、worktreeStatus、git status、worktreeSeen、UNMERGED_TTL、STOPPED_TTL、gitGate、in-flight 去重、stale-while-revalidate、worktreeChecked、59 个子对话、LoadTrace、加载日志

## 现象

用户截图里的加载日志（50 条消息的父对话）：

| 步骤         | 状态                |
| ------------ | ------------------- |
| 读取对话     | 完成 · 1.2s         |
| 连接实时更新 | 进行中 · 已等 21.2s |
| 读取子对话   | 进行中 · 已等 20s   |
| 标记已读     | 完成 · 1.2s         |
| 渲染消息     | 完成 · 45ms         |

「读取对话」和「标记已读」都秒回，说明消息和落盘都不慢；卡住的两条一个等 SSE 首包、一个等 `/children`。用户补了一句「加载对话真慢啊」，说明不是偶发。

## 复现

数据：生产实例（`node server.mjs --prod`，8787）上父对话 `93b08721…`，名下 **59 个子对话**，其中 5 个 `worktree.state === 'active'`。

```
GET /api/tasks/93b08721…/children                     冷缓存：41.6s / 17.2s / 39.1s
GET /api/tasks/93b08721…/children（同一进程再打）      缓存命中：2.7ms
GET /api/tasks                                       同期：6ms ~ 0.9s
GET /api/tasks/93b08721…/events（单独打）              首包：74ms
两个 /children 并发 + /events 一起打                   180 秒都没返回
```

排除过的几层（都量过，不是猜的）：

- **不是 `store.list()`**：它是纯内存（`server/task-store.ts` 的 `all()` 只读一次盘），同期 `/api/tasks` 6ms~0.9s。
- **不是 git 本身慢**：`rev-parse` / `status` / `rev-list` 单条 26~56ms，两个 worktree 各 4 条 × 两个并发（16 次）总耗时 300ms。
- **不是 SSE 首包自己慢**：单独打 `/events` 首包 74ms；首包前的 `activeChildren` / `cliChildren` 走 `childCountsOf`，是 1 秒 TTL 的内存缓存，一条 git 都不跑。
- **不是 `streamBoot`**：`useTaskStream` 要等 `GET /tasks/:id`，那一步 1.2s 已经完成。

## 根因

`/children` 把「子对话栏要显示的独立分支状态」当成请求的一部分，同步等 git：

1. 每个子对话一次 `childWorktree()` → `worktreeStatus()`（`server/exec/worktree.ts`）最多 4 条 git（`rev-parse` 分支、`status --porcelain`、`rev-parse` baseBranch、`rev-list --count`），`capture` 的超时是 **60 秒**。
2. 59 个子对话里，`stopped` / `failed` 的一律要问（用户停了以后最想知道「改的东西还在不在」），一次请求就是上百条 git 进程，`gitGate = createGate(4)` 只是排队，总时间随子对话数线性增长。
3. **没有 in-flight 去重**：`worktreeSeen` 只在 git 返回**之后**才写，TTL（`UNMERGED_TTL` 15s / `STOPPED_TTL` 60s）一过，前端 4s/15s 的轮询各自再跑一遍全量 git，队列不断叠加——这就是「同一个接口第一次 41s、并发两个 180s 还没回来」。
4. **SSE 首包是被同一个进程拖住的**：`/children` 和 `/events` 在同一个 Node 进程里，上百个 git 子进程和它们的 stdout 回调把事件循环占满，于是 74ms 的首包也要等上几十秒。用户看到「连接实时更新」和「读取子对话」同步往上涨，是同一个原因的两个表现。

所以缺的不是「再快一点的 git」，而是**把「可以稍后补」的信息从请求路径里挪出去**：子对话栏的「合没合回 / 还有几个文件未提交」允许晚几秒到（前端本来就每 4~15 秒轮询一次），但消息和 SSE 首包不能等它。

## 修法

### 读缓存分两种读法（`server/worktree-cache.ts`）

- `peek(id, key, ttl, load)`：**立即返回**。有缓存就给手上这份（可能过期，同时后台补一次），从没查过就回 `{ value: null, checked: false }`；`key` 变了（子对话又动了新的一轮）不算核对过。
- `read(id, key, ttl, load)`：TTL 内沿用缓存，否则等这次的 git 结果。判定「子对话算不算做完」的路径用这个，行为与修复前完全一致。
- 同一个子对话同一时刻只跑一条 git（in-flight **按 id** 去重，不看 key）：`updatedAt` 一变就会换 key，按 key 去重等于没去重。
- 后台补走**单独一道闸**（`createGate(2)`），和 `read` / `/worktrees` 用的 `gitGate(4)` 分开：几十个子对话的后台刷新再慢也只排自己的队，不会把同步等结果的那两条挤到后面。
- 过时那一轮的结果不写进缓存（`latest` 记着最近一次**起**的是哪一轮）：否则慢的旧 key 回来会盖掉新 key，下一次又因为 key 不匹配重新查。只是 `peek` 问一句不算「起新一轮」，不能把在跑那条的结果丢掉。
- 判定读（`read`）碰到别的轮次在跑时先等它结束再看（最多 `MAX_STALE_WAITS` 次），绝不拿别的轮次的值拍板：同一子对话有两个判定调用撞在一起时，旧一轮的「没合回」会把已经可以收尾的子对话挡回去。
- load 失败时保留上一次的值、不写「已经合回」（和修复前「读不出来不当成没合并」的判断方向一致）。

### `/children` 改用 `peek`，并如实告诉界面「这次还没核对」

- `childWorktree(tk, project, { wait: false })`：`/children` 传它；`childUnmerged`（完成判定）不传，仍走 `read`。
- 每条多一个 `worktreeChecked`：false 表示 `unmerged` / `dirty` 这次是占位值、后台正在查。**不伪造进度**：没有把它写成「已核对」，也不改 `LoadTrace` 的步骤状态。
- 返回耗时超过 `SLOW_CHILDREN_MS`（500ms）时记一条 `warn` 日志，带上子对话数、未核对数、耗时——它已经不等 git 了，再慢就是别的地方，下次排查不必从头量。

### 没动的部分

- 前端一行没改：`unmerged` / `dirty` 的语义没变（没核对过时是 false/0，和修复前「git 读不出来」一致），下一次轮询（4s）就有真实值。
- 完成判定（`childUnmerged` → `childHoldsOf` 的 `unmerged`）、保活、回收、成本统计、`autoCompact` 都没动。

## 防复发护栏

`server/task-children-load.test.ts`（`npm run test:unit` 会跑）：

| 用例                                                             | 守着什么                                                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 子对话的独立分支状态不等 git：先回占位值，后台补完下一次轮询就有 | 第一次响应必须明显快于一次 git（注入的 git 睡 300ms，断言 <250ms）、`worktreeChecked` 为 false、占位值是 false/0；后台补完后变成 `unmerged: true` / `dirty: 2` |
| 轮询再快也不会把 git 叠成上百条：同一个子对话同时只跑一条        | 3 个请求并发时，git 调用次数不超过子对话数（in-flight 去重），补完后仍只是每个子对话一次（TTL 内不重复）                                                       |
| 每个子对话只查一次                                               | 补完之后再打一轮，git 调用次数不变                                                                                                                             |

`server/worktree-cache.test.ts` 13 条：peek 不等 git、并发只跑一条、过期的先给旧的并后台补新的、key 变了不算核对过、失败时界面保留上一次的值、`read` 等结果、`read` 查不出来回 null（判定不被过期数据拍板）、后台补走单独那道闸、key 变了也不并发第二条 git、`read` 遇到别的轮次在跑时等它结束再按当前这一轮查、两个判定同时撞上别的轮次不串整、只是问一句不丢掉在跑那条的结果、缓存不会无限长。

其中 5 条是评审之后补的：

- R1 那条（后台补和判定用的闸分开）在「共用一道闸」的旧行为上红；
- R2 两条（换了 key 也只允许一条 git、旧那轮不算新的一轮）在「按 (id,key) 去重 + 无条件写缓存」的旧行为上红；
- R3 复看时补的两条：两个判定同时撞上别的轮次时不能串整（去掉 `read` 的等待循环就红）、只是用新 key 问一句不能把在跑那条的结果丢掉（`latest` 在入口无条件更新就红）。

## 回归验证

### 用例先在旧实现上确认会失败（项目教训 `lmvmabgjdi271`）

| 实现                                                 | 结果                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 旧实现（`git checkout -- server/tasks.ts`，HEAD 版） | 两条都失败：「这次还没核对过，要如实告诉界面」断言失败；第二条卡到 `5.35s` 超时（它在同步等 git，没有 `worktreeChecked` 可等） |
| 新实现                                               | 2/2 通过                                                                                                                       |

### 改前 / 改后对照（本机，同一份数据，真实 git）

场景：父对话 + **59 个子对话**，全部 `stopped`、都挂着 `worktree.state === 'active'`，`project.path` 指向真仓库、`worktree.path` 指向真实存在、带 `node_modules` 的 worktree 目录；用 `tasksApi` 直接打路由（不起服务、不换端口），先打一个不存在的对话把任务列表读进内存再计时。

| 指标                         | 改前（HEAD 版）       | 改后                               |
| ---------------------------- | --------------------- | ---------------------------------- |
| 第一轮 `/children`（冷缓存） | **2184ms**            | **1ms**                            |
| 第二轮（缓存已满）           | 1ms                   | 1ms                                |
| 三轮并发（模拟轮询叠在一起） | 1ms                   | 3ms                                |
| 后台把 59 个的 git 全查完    | —（请求本身就在等它） | 1924ms，下一次轮询（4s）拿到真实值 |
| 已核对 `worktree` 的子对话   | —（没有这个字段）     | 59/59                              |

改前的「三轮并发 1ms」是缓存刚被第一轮填满的结果；真实的叠加发生在 TTL 过期那一轮（生产实例上就是「两个 `/children` 并发 + `/events` 一起打，180 秒没返回」）。真实盘面每个子对话是 3~4 条 git（本机对照里分支名不存在，`worktreeStatus` 少跑两条），这也解释了为什么生产实例是 17~41s 而本机对照是 2.2s。

### 生产实例上的原始现象（修复前实测）

| 接口                                          | 冷缓存                | 缓存命中 |
| --------------------------------------------- | --------------------- | -------- |
| `GET /api/tasks/<父>/children`（59 个子对话） | 41.6s / 17.2s / 39.1s | 2.7ms    |
| `GET /api/tasks`                              | 6ms ~ 0.9s            | —        |
| `GET /api/tasks/<父>/events` 首包             | 74ms                  | —        |

### 检查

```bash
npm run typecheck && npm run lint
npx tsx --test server/task-children-load.test.ts server/worktree-cache.test.ts   # 10/10 通过
# 增量单测（changed-tests 定位了 13 个文件）逐个通过
```

## 落地改动

| 位置                                | 改了什么                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/worktree-cache.ts`          | 新增：`peek`（立即返回、可能过期、后台补）/ `read`（等结果）/ in-flight 去重 / 失败保留旧值 / 条目上限                                         |
| `server/tasks.ts`                   | `childWorktree` 加 `{ wait: false }` 走 `peek`；`/children` 用它并返回 `worktreeChecked`；`childUnmerged` 仍走 `read`；慢于 500ms 记 warn 日志 |
| `server/task-children-load.test.ts` | 新增 3 条回归用例（见「防复发护栏」）                                                                                                          |
| `server/worktree-cache.test.ts`     | 新增 8 条缓存用例                                                                                                                              |

## 待确认

- 端到端与界面检查由父对话合并后跑（本轮只跑了 typecheck、lint 和增量单测）。
- 前端没有显示 `worktreeChecked`：第一次打开父对话时，子对话行的「N 个文件未提交 / 未合并」要等下一次轮询（4 秒）才出现。如果用户反馈这几秒的占位不可接受，可以把「正在核对」写进子对话行（例如先不显示，而不是显示成 0）。
