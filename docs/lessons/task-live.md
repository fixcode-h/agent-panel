---
paths: shared/live/task-live.ts, server/tasks/live.ts, server/tasks/page-feed.ts, web/src/lib/live/store.ts, web/src/lib/live/events.ts, web/src/lib/live/page-stream.ts, server/page-events.ts
---

# 对话的运行时状态（TaskLive）和全局事件流

## 运行时事实只进 TaskLive，页面不自己推状态

- 规则：进程、后台命令、子对话计数这类服务端才知道的事实加进 `shared/live/task-live.ts` 的 `TaskLive` 和 `taskLiveOf`，只在 `server/tasks/live.ts` 算；不往 `Task` 上叠字段，也不写盘（`NOT_STORED_FIELDS`）。页面只读 `live`，不调 `taskState` 一类。
- 起因：重构前各路由各叠一份运行时字段，漏叠的接口在页面上算出另一个状态（侧栏转圈和首页、浮条对不上）；`jobs` 还被顺手写回磁盘。
- 防线：`scripts/rules-check.mjs` 第 22 条；`shared/live/task-live.test.ts`、`server/task-store.test.ts`。

## 页面的常驻连接只开一条

- 规则：页面要服务端主动推的东西挂到 `/api/app/events` 上（服务端 `addPageFeed`，页面 `openPageStream`），不另开 SSE。浏览器对同一地址最多 6 条 HTTP/1.1 连接，多一条常驻连接，多开一个标签页普通请求就开始排队。
- 起因：全局事件流第一版单开 `/api/events`，算上托盘信号和对话实时推送每个页面三条。
- 防线：人工。
