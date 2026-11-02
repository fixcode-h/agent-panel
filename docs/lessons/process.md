---
paths: server/exec/process.ts, server/exec/orphans.ts, server/exec/proc-stats.ts, server/presence.ts, server/tasks/**, shared/task.ts
---

# CLI 进程：停止、保活和回收

## 停下要有原因，保活有上限，收口后不留进程

- 规则：`stopTask(id, reason)` 的 `reason` 必填，只有用户点 `/stop` 传 `'user'`，其余按原因传（收尾、换 CLI、归档、删除、重启、页面切走、打断）；异常退出走失败，不归成停止。
- 规则：会话「彻底完成」时不分独立分支都 `cancelWait/stopTask` + `await entry.done` + `background.stop`，worktree 回收只在 `isolated` 做；`awaitingUser` 超过 `keepAliveLimit` 时 `keepAliveVictims()` 停最久没用的，「正在看」只认前台开着的页面（`isViewing`，不是 `hasViewer`）。
- 规则：任务收口后不能拿「进程还活着」当理由留着它：收尾落 `resolved` 后按 owner 再核对一次，另有启动 + 每小时的兜底回收（判定只用 `taskSettled`）；发出停止后确认退出才丢登记（杀不掉就写回）。
- 规则：面板起的 CLI 记在 `run/cli-pids/<面板 pid>.json`，每个实例只写、只删自己那份（共用一份再读盘合并会被别的实例退出清空、并发登记覆盖）；清理只写已退出实例的文件，「面板还活着」要 pid 在**且**命令行像 `server.mjs` / `server/index.ts`（认 `./` 和引号路径，宁多认）。
- 起因：12 个对话各留一个进程没被保活上限收住；共用目录的子对话 `resolved` 后 CLI 一直留着，用户报「4 小时前启动的进程没退」。
- 防线：`server/presence.test.ts`、`shared/task-stage.test.ts` 的保活用例；`server/exec/orphans.test.ts` 的登记分账、启动清理、兜底回收、写回登记；`server/task-restart.test.ts` 的「已收口的不再拉起」。

## 驱动转圈、计时的字段必须进 messageStamp；停止要杀到孙进程

- 规则：界面靠 `messageStamp` 判断消息变没变，工具行的 `running`、`ms` 这类决定转圈和耗时的字段必须进 stamp，否则服务端收掉了界面也不刷新。停止后台命令用 `killTreeDeep`：先拍进程表快照，按 ppid 把子孙都杀掉，Windows 上父进程先退、孙进程被改挂（或 setsid）也能找到。
- 起因：用户 2026-10-23 反馈「强制停止对话，不会终止后台运行命令」，截图里 `git config…` 一直转圈：stamp 没包含 `running`，停止的更新推不到界面；`taskkill /T` 找不到已经脱离父进程的孙进程。
- 防线：`shared/task-stage.test.ts` 的 `messageStamp` 用例；`server/exec/proc-stats.test.ts` 的 `descendants` 用例。

## 等不到执行收尾就收口并让出执行位，不能只写「不再等它」

- 规则：限时等一份执行收完（`endLive`、停止后）等不到时，走 `server/tasks/keepalive.ts` 的 `abandonLive`：杀进程、按停止（收尾的按完成）落盘、`release` 执行位、`abandon()` 让 `done` 结束；之后引擎收完也不写盘（`Live.orphaned`）。执行位留着不放，`runningConv` 就一直把消息交给这份没有进程的执行，排着的消息永远等不到「这一轮结束」。「停下没有」按进程判断：用户停止后名下 CLI 进程没了就是停下了（`watchStop`），不等引擎走完收尾。
- 起因：用户 2026-11-02 报「子对话完成后父对话再交代任务，子对话一直等待模型；停止再继续也不知道那条任务」——4fd28a6 给 `endLive` 加了限时，但超时后只是「不再等它」，执行位没让出来。
- 防线：`server/tasks/keepalive-endlive.test.ts` 的「强制停止后执行仍收不完」「用户停止后进程已经没了」。
