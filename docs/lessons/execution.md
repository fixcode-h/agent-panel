---
paths: server/exec/runner.ts, server/tasks.ts, shared/task.ts, shared/plan.ts, shared/plan.test.ts, web/src/components/tasks/ChildAskCard.tsx, server/assist.ts, server/designs.ts, server/exec/delivery.ts, server/exec/invoke.ts, server/exec/rpc/**, server/exec/hints.test.ts, scripts/e2e.mjs, scripts/fake-cli/fake-cli.mjs
---

# 一轮执行怎么收尾

## 空回合、补充重放按这一轮算，没消费的消息留到下一轮

- 规则：CLI 报一轮成功但正文、工具、用量都没有时按空回合处理：不保活、交给兜底接一轮并留下说明。保活时一个进程连着多条消息，`runAgent` 的 `mine`、`touched` 是整个进程的；判断这轮做没做事只看这轮开始后输出，重发的是这轮的用户消息。
- 规则：面板替别人往对话投消息（子对话回答、催合并、后台结果）时，CLI 回包不等于模型看见了，这轮没产出就交回下一轮。`read_user_notes` 没取走的、插话通道送出的都走 `holdForNextTurn`；`TaskBusyError`（执行位还占着，正常收尾窗口）同样记进对话并 hold，收尾没人取就补开一轮，不能只 `log.warn`。
- 起因：0 token、0 输出的一轮被标成完成并保活，用户催「分析啊」时消息被插进死回合；9e7674d 只修了第一轮，第二句起一个字没回被前一轮正文盖住。
- 起因：`steerTask` 只要回包就返回 `'steer'`，网关吞请求时补充永久丢失；ADR 0002 的用户回答撞上子对话刚结束一轮，消息被吞，e2e 一半失败。
- 防线：`server/exec/hints.test.ts`；`server/exec/delivery.test.ts`；`scripts/e2e.mjs` 的 `FAKE_SILENT`、「保活中的第二句一个字都没回」「子对话请父对话决定」用例。

## 每个收 CliEvent 的地方都要把工具行收尾

- 规则：任务页之外自己拼消息处（`server/assist.ts` 的 AI 创建 / 分析、`server/designs.ts` 的 UI 设计）和 runner 一样处理工具事件：`tool_result` 删掉 `running`、`tool_delta` 的 `snapshot` 直接替换输出，结束时（停止、超时、退出）收掉在跑的行；给 CLI 加字段时一起过。
- 起因：Pi 的 `tool_execution_start` 带 `running: true`，c5e408d 只改了 runner，AI 分析一直转圈；任务页被打断时 `endTool` 没清 `running`。
- 防线：`scripts/e2e.mjs` 的「工具结束后不再显示运行中」。

## 停下要有原因，保活有上限，彻底完成就结束进程

- 规则：`stopTask(id, reason)` 的 `reason` 必填 `StopReason`，只有用户点 `/stop` 传 `'user'`；父对话收尾、换 CLI、归档、删除、重启、页面切走、新消息打断各传对应值，经 `Task.stopReason` 和 `stopReasonText` 显示，只有 `'user'` 画暂停；异常退出（`spawnError`、非 0 码）走失败并显示原因，不归成停止。
- 规则：会话「彻底完成」（`resolved` 且无 `childHolds`）时不分独立分支都 `cancelWait/stopTask` + `await entry.done` + `background.stop`，worktree 回收只在 `isolated` 做；`awaitingUser` 超过 `Settings.keepAliveLimit` 时 `keepAliveVictims()` 停最久没用的（`stopTask(id, 'idle')`），排除正在看的、刚保活的自己、有子对话在跑的父对话；「正在看」只认前台开着的页面（`presence.ts` 的 `isViewing`）而不是 `hasViewer`（切走后宽限期里也算有人），只决定回复完留不留进程。
- 起因：真实 Pi 下 12 个对话各发一句，12 个进程（约 1.5 GB）一直留着，`keepAliveLimit` 4 没生效；改用 `isViewing` 后留 4 个，靠 `--resume` 续接。
- 起因：`node_modules` 被清空时父对话收尾 abort 子对话，`ctx.signal.aborted && !r.killed` 全判成 `stopped`，用户没点暂停却看到「已暂停」；12 个进程只有 7 个对得上，共用目录的子对话 `resolved` 后 CLI 一直留着。
- 防线：`shared/task-stage.test.ts` 的 `stopReasonText`、`keepAliveVictims` 用例；`server/presence.test.ts` 的「保活上限只放过前台开着的页面」；`stopTask` 第二参数必填由 typecheck 拦住。

## 后台命令交出去不等于做完：监管到结束

- 规则：面板替对话跑的后台命令（`run_background`、`request_build`）要盯到结束：发起行转圈到结束、换真实用时和结果（`settleJobTool`）；长时间没输出、跑得久提醒（`onNotice`）；推送失败要重试并留在对话里，不能只写日志。`taskBusy`、未读看 `jobs`。CLI 自带后台命令（Claude Code 的 `run_in_background`、`Monitor`）关掉，长命令走面板。见 ADR 0006。
- 起因：带前缀的 `panel_run_background` 被解析成「运行命令」，0.09 秒完成；结果没推回，模型前台 `sleep` 轮询，用户以为停了。
- 防线：`server/background.test.ts` 的「监管」「限时」用例；`server/exec/parsers.test.ts` 的「带服务名前缀的面板工具」；`web/src/lib/tasks.test.ts` 的旧数据用例。

## 一轮结束只发一次回调，result 和保活等待同出口

- 规则：一轮结束的两个信号（CLI `result`、保活等待 `listen()`）只走 `runner.ts` 的同一个 `endTurn()`，`markTurnDone`、`ctx.onTurnEnd` 各只调一次；用户下条消息或子任务结果交回才复位。`reportChild` 的毫秒级 `turnDoneAt` 挡不住相隔几百毫秒的两次回调；前端 `dedupePeerReports`（相邻、同子对话、同标题同正文、10 秒内，不同来源不合并）只作兜底。
- 起因：2026-10-24 2 个子对话的同一份汇报各显示两条（同 `peer.id`、同标题同正文，相隔约 0.3 秒），`result` 与 `listen()` 各结束一次。
- 防线：`scripts/rules-check.mjs` 第 8 条能拦住——剥掉块注释、行注释后数 `server/exec/runner.ts` 的 `markTurnDone(task)`、`ctx.onTurnEnd?.()` 调用，共 2 次（只从 `endTurn()` 一处发出），拆回两处报「实际 4 处」；`scripts/e2e/04-subagents.mjs` 的「保活的子对话跑完一轮」只是行为断言，fake CLI 两次回调只隔约 3ms、reportKey 碰巧去重，拦不住；`web/src/lib/peer-dedupe.test.ts`。
