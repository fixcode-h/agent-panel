# server · 打开对话页的服务端开销

[server 模块](README.md)的子页面：打开一个对话页时服务端重复付的代价和两轮优化的实测。模块的状态块、`server/tasks.ts` 拆分表、入口、依赖和回归验证见 [README.md](README.md)，Bug 记录见 [bugs.md](bugs.md)。

2026-10-31 从 `README.md` 原样挪出（文字没改），各条的日期和结论以当时为准。

## 打开一个对话页时服务端重复付的代价（2026-10-26 实测，2026-10-27 两轮更新）

单次打开对话页会打到下面几组接口，它们合起来就是「打开慢」的服务端那一半（热数据、本机 loopback，均已复测）。**2026-10-26 的数字是优化前的基线，保留作背景；下面这些到 2026-10-27 都已改掉——第一轮是 `/seen`、`/presence`、静态资源 gzip + 长缓存，第二轮是打开对话分页、SSE 增量首包、`/children` 两档轮询、`GET /tasks` 的 ETag、子对话计数的共享缓存。每条后面写的是现在的行为和实测，这一节已经没有遗留的 P1 待办。**

- **`/seen` 不再读整份对话、也不再回完整任务（2026-10-27 已完成）**：`current()`（`server/tasks.ts:493`）→ `store.getFull`（`server/task-store.ts:448`）每次都 `readJson` + `TaskMessage.array().safeParse` 整份 `.messages.json`，2.0MB / 611 条的那份实测 91–133ms；`POST /seen`（`server/tasks.ts:4323`）以前走的就是这条路径，还把完整任务 2467KB 原样回给前端（前端只拿它做 apply）。现在它取 `live` 里那份、没有才 `getMeta`，只回 `{ turnSeenAt }`（`shared/schema.ts` 的 `TaskSeenResult`）；要落盘时走 `server/task-store.ts` 的 `updateMeta()`——只改任务记录文件，**不读也不写 `.messages.json`**，并且带 `keepUpdatedAt: true`，所以「只是看过了」不算任务更新，列表顺序和更新时间都不动。
- **`/presence` 只做存在性检查（2026-10-27 已完成）**：`POST /presence`（`server/tasks.ts:4312`）以前同样走 `current()`，为一次心跳把整份对话读一遍再校验。现在只用 `getMeta(id)`（`server/tasks.ts:504`，底层 `store.getMeta` 只查有没有这条任务），之后照旧只动内存里的 viewer。
- **`GET /:id/events` 首包能只发增量（2026-10-27 第二轮已完成）**：以前建连后先发一次 `full`（实测 2726KB，和那次 `GET /:id` 是同一份数据）。现在建连时读浏览器重连自动带的 `Last-Event-ID`、或首次建连由页面带的 `?rev=`，交给 `shared/task.ts` 的 `taskRevOffset(messages, rev)` 判「页面上那份是不是当前对话的前缀」：版本由 `taskMessageRev` 拼成 `<条数>:<最后一条消息 id>`，对得上就返回补发起点（**含最后一条**，正在流式增长的那条不会漏），对不上返回 -1。对得上发 `patch`（`{ meta, messages: messages.slice(offset), total }`），对不上才发 `full`；两种事件都带 `id: <版本>`，浏览器自己记住它，重连时当 `Last-Event-ID` 带回来。消息被删（返工时重跑节点）或换了对话一律回 `full`，不猜着拼。实测同一份 4200 条 / 6.11MB 的对话：首包 `full` 6,401,764 字节 / 130.2ms → 带 `rev` 的 `patch` 78,851 字节 / 5.9ms。
- **`GET /:id/children` 的 git 结果留更久、前端按状态分档（2026-10-27 第二轮已完成）**：每个子对话一次 `childWorktree` → `worktreeStatus`（4 条 git），首跑实测 1131ms，之后靠 `worktreeSeen` 的 TTL 降到 2–10ms。`UNMERGED_TTL` 从 10s 提到 **15s**（和前端静止档对齐，没合并的分支状态 15 秒内不重复跑 git），`STOPPED_TTL` 仍 60s。前端不再固定每 4 秒刷一次：`web/src/components/tasks/TaskView.tsx` 的 `CHILD_POLL_ACTIVE_MS`（4000）/ `CHILD_POLL_IDLE_MS`（15000）按「有没有在跑」分档，判定读 `shared/task.ts` 的 `childSpinning`（和子对话行的图标、执行中计数同一处，不另写一套），**列表为空时一次都不轮询**——子对话产生由 SSE 推来的 `childrenWorking` / `childrenCli` 和上报信号 `childSignal` 触发重拉（`childrenReload` ref）。实测：有子对话但都静止时请求间隔 15.2 / 15.0 / 15.0 / 15.0 秒；没有子对话时 12 秒内只有首拉 1 次、之后 0 次。
- **`GET /:id` 可以只回最近一段（2026-10-27 第二轮已完成）**：`?limit=N` 只回最近 N 条、`?before=<messageId>` 取这条之前的 N 条（往前翻页的锚点），纯函数是 `shared/task.ts` 的 `messagePage`；响应体在任务之外多带 `messageTotal`（完整条数）和 `messageHasMore`（还有更早的），**整份都在这一份里时**再带 `messageRev`（`taskMessageRev` 的版本，前端建 SSE 时带上它，首包就只补发增量；截断的那段不是整份的前缀，不能当版本用）。**不传参数行为完全不变**（导出、AI 处理、老版本页面照旧拿整份）。锚点找不到时（那条消息被返工删掉了）取最早的一段而不是尾部那页，否则前端一条都接不上、卡在同一页。实测同一份对话：全量 6,401,729 字节 / 63.3ms → `?limit=50` 77,310 字节 / 3.9ms，`?before=` 同样 77,310 字节 / 2.1–14.6ms。演示后端 `web/src/lib/demo-backend.ts` 的 GET 单任务同步支持这两个参数。
- **`GET /tasks` 带 ETag（2026-10-27 第二轮已完成）**：列表被前端每 2.5 秒拉一次（有任务在跑时），以前每次都要 `store.list()` + 序列化 79KB。现在对最终响应体算 sha1（`createHash`）当 `ETag`，`If-None-Match` 命中就回 304、不带响应体。前端 `web/src/lib/api.ts` 的 `allTasks` 带上次的 `If-None-Match`，304 时返回 `null`，`web/src/lib/data.tsx` 的 `reloadTasks` 收到 `null` 不动 state（侧栏不重渲染）。实测：第一次 200 带 ETag，带 `If-None-Match` 再请求 304、0 字节。
- **SSE 每秒的全量扫描改成共享缓存（2026-10-27 第二轮已完成）**：以前每秒对每个打开的对话各调一次 `activeChildren` / `cliChildren`，每次内部都 `store.list()` 全量遍历。现在统一走 `server/tasks/children.ts` 的 `childCountsOf(parentId)`（`CHILD_COUNT_TTL = 1000`）：一次 `store.list()` 把所有父对话的 `childrenWorking` / `childrenCli` 都算出来，`activeChildren` / `cliChildren` / `withLive` 都读它，多个打开的对话共享同一份。实测：两个对话各开一条 SSE 连接跑 10 秒，`store.list` 调用 40 次 → 11 次。
- **静态资源改成 gzip + 长缓存（2026-10-27 已完成）**：托管从 `serveStatic`（原 `server/index.ts:1053`）换成 `server/static.ts` 的 `serveDist` / `serveIndex`（挂在 `server/index.ts:1056`）。文本类型（js / css / html / json / svg / map / webmanifest 等）用 Node 内置 `zlib` 的 gzip（level 6），压缩结果按文件缓存、同一文件的并发请求只压一次、构建产物换了（mtime / 大小变）就重压；字体和图片本身已是压缩格式，不压。`/assets/*` 的文件名带内容哈希，回 `public, max-age=31536000, immutable`；`index.html` 和其余不带哈希的文件回 `no-cache`（每次校验，命中就是 304），发版后一定拿得到新入口。两者都带 `W/"…"` 的 ETag 并处理 `If-None-Match`，gzip 与未压缩两份的 ETag 分开（否则会拿压缩版去回不要 gzip 的请求），可压缩类型一律带 `vary: accept-encoding`。**只作用于打包产物**：`npm run dev` 下前端仍由 Vite 自己服务，完全不经过这套缓存头。SPA 兜底照旧——`serveDist` 找不到文件就交给 `serveIndex`，所以任何找不到的路径（含 `/assets/*`）都回 `index.html`（200 + HTML），排查「资源 404」时用 content-type 判。

本次实测（同一份 2.12MB / 1000 条消息的对话，本机 loopback、预热 OS 缓存，`curl -s -o /dev/null -w '%{size_download} %{time_total}'`）：

| 请求                                      | 改前                                                                                                  | 改后                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `POST /api/tasks/:id/seen`                | 以前走 `current()`、回整份任务：本份是下一行的 2,125,105 字节，2.0MB / 611 条那份实测 2,467KB / 133ms | 41 字节 / 1.0–1.1ms                                             |
| `GET /api/tasks/:id`（旧 `/seen` 也走它） | 2,125,105 字节 / 11–21ms                                                                              | 带 `?limit=50` 只回最近 50 条（数字见下面第二轮那张表）         |
| `POST /api/tasks/:id/presence`            | 与上面同一条路径（`current()`）                                                                       | 204 / 1.3–2.3ms                                                 |
| `index-tnFgKEWT.js`                       | 705,555 字节（未压缩）                                                                                | 200,850 字节（gzip）                                            |
| `fonts-DFrIiuit.css`                      | 459,218 字节（未压缩）                                                                                | 200,798 字节（gzip）                                            |
| woff2 字体                                | 不压缩                                                                                                | 不压缩（已是压缩格式）                                          |
| `index.html`                              | 3604 字节、无缓存头                                                                                   | 3604 字节、`cache-control: no-cache`，带 `If-None-Match` 回 304 |

整页对比（headless chromium、禁缓存、同一份对话）：改后 ready **575ms**、**75 个请求**、resource timing 传输合计 **3.86MB**（js 822KB / css 219KB / 字体 630KB / API 2.28MB）；改前基线是 ready 1.6–2.4s、114–119 个资源、9.4–10.2MB（见 [web 模块](../web/README.md) 同一段实测）。resource timing 之外还有一次性的 SSE 首包（当时是 `full` 2,125,149 字节），第二轮已改成带 `rev` 的 `patch`，见上面 `/events` 那条。

前端配套：`web/src/components/tasks/TaskView.tsx` 的 `applySeen` 用 `web/src/lib/tasks.ts` 的 `withTurnSeenAt` 把返回值合进本地，未读判定仍只在 `shared/task.ts` 的 `taskTurnUnread` / `taskDoneDot`（细节见 [web 模块](../web/README.md)）。回归：`server/task-seen.test.ts`（`/seen` 只回 `{ turnSeenAt }`、不改非对话字段时对话文件一个字节都没被重写、已看过时什么都不改、`/presence` 不改对话文件且任务不存在时 404、`updateMeta` 同步内存里那份完整对话）、`server/static.test.ts`（文本资源 gzip 变小、`/assets/*` 长缓存、不要 gzip 的客户端拿原文、字体不压、入口页 no-cache、内容没变回 304 且两份 ETag 分开、越界路径交给 SPA 兜底、`q=0` 不算接受 gzip）、`web/src/lib/tasks.test.ts` 的 `withTurnSeenAt`。

第二轮之后的页面配套（细节见 [web 模块](../web/README.md) 的「打开对话页的加载链路」）：`TaskView.tsx` 打开时一律带 `limit=OPEN_MESSAGE_LIMIT`（50），`loadEarlier` 用 `?before=<最早那条>` 往前翻，分页信息跟当前那份任务走（`truncated`），SSE 推来整份后收起「显示更早的消息」；建连的 `boot` 带 `?rev=` 只在手上有整份时才有值，没有基线就先不建连（否则服务端发的增量合并不了）；`web/src/lib/api.ts` 的 `task(id, { limit, before })` 只拼真正给了的参数，不拼出结尾的 `?`。

优化优先级（按收益/风险）与进度：

1. seen 只回 delta（或直接 204）——**2026-10-27 已完成**，现在只回 `{ turnSeenAt }`；
2. presence 用 `getMeta` 而不是 `current`——**2026-10-27 已完成**；
3. SSE 支持「我已经有到 X 版本」直接发 patch——**2026-10-27 第二轮已完成**（`?rev=` / `Last-Event-ID`，对上前缀发 `patch`，对不上发 `full`）；
4. children 把 git 结果缓存拉长或改成按需——**2026-10-27 第二轮已完成**（`UNMERGED_TTL` 15s，前端空列表不轮询、静止 15s、在跑 4s）；
5. 给静态资源加压缩——**2026-10-27 已完成**（gzip + 长缓存 + ETag）；
6. 打开对话只回最近一段——**2026-10-27 第二轮已完成**（`?limit=` / `?before=`，首屏 6.11MB → 77KB）；
7. 列表接口带 ETag、子对话计数共享一份——**2026-10-27 第二轮已完成**（304 不带响应体；SSE 空闲扫描 40 次 `store.list` → 11 次）。

第二轮实测（本机服务 + 真实前端，数据是一份 **4200 条消息 / 6.11MB** 的对话；没换机器、没清 OS 缓存，和上面第一轮那张 2.12MB 的表不是同一份数据，不要跨表对比绝对耗时）：

| 请求                                  | 改前                     | 改后                                      |
| ------------------------------------- | ------------------------ | ----------------------------------------- |
| `GET /api/tasks/:id`（全量）          | 6,401,729 字节 / 63.3ms  | ——（不传参数仍是这个行为）                |
| `GET /api/tasks/:id?limit=50`         | ——                       | 77,310 字节 / 3.9ms                       |
| `GET /api/tasks/:id?limit=50&before=` | ——                       | 77,310 字节 / 2.1–14.6ms                  |
| SSE 首包（`full` → `patch`）          | 6,401,764 字节 / 130.2ms | 78,851 字节 / 5.9ms（带 `rev`）           |
| 打开一个对话的总传输                  | 12.21MB（同一份传两遍）  | 6.18MB（GET 最近 50 条 + SSE 首包 patch） |
| `GET /api/tasks`                      | 每次 200 + 79KB 序列化   | 带 `If-None-Match` 时 304 / 0 字节        |
| SSE 空闲时 `store.list` 次数          | 两个对话开 10 秒 = 40 次 | 11 次（`CHILD_COUNT_TTL` 共享缓存）       |

第二轮的回归测试（本轮新增四个单测文件，按用例说明）：分页与版本的纯函数单测（`messagePage` 切片、锚点找不到时取最早一段、`taskMessageRev` / `taskRevOffset` 对号与对不上）、路由层单测 `task-open-page`（`limit` / `before`、响应带的 `messageTotal` / `messageHasMore` / `messageRev`、SSE 首包按 `rev` 发 `patch` 或 `full`）、`task-list-etag`（ETag / 304 / 数据变化换 ETag）、`task-children-count`（子对话计数正确、缓存命中结果一致）。
