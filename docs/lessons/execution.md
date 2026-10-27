---
paths: server/exec/runner.ts, server/tasks.ts, server/exec/orphans.ts, server/exec/process.ts, shared/task.ts, shared/plan.ts, shared/plan.test.ts, web/src/components/tasks/ChildAskCard.tsx, server/assist.ts, server/designs.ts, server/exec/delivery.ts, server/exec/invoke.ts, server/exec/rpc/**, server/exec/hints.test.ts, web/src/lib/peer-dedupe.ts, scripts/e2e.mjs, scripts/fake-cli/fake-cli.mjs
---

# 一轮执行怎么收尾

## 空回合、补充重放按这一轮算，没消费的消息留到下一轮

- 规则：CLI 报一轮成功但正文、工具、用量都没有时按空回合处理：不保活、交给兜底接一轮并留下说明。保活时一个进程连着多条消息，`runAgent` 的 `mine`、`touched` 是整个进程的；判断这轮做没做事只看这轮开始后输出，重发的是这轮的用户消息。
- 规则：面板替别人往对话投消息（子对话回答、催合并、后台结果）时，CLI 回包不等于模型看见了，这轮没产出就交回下一轮。`read_user_notes` 没取走的、插话通道送出的都走 `holdForNextTurn`；`TaskBusyError`（执行位还占着，正常收尾窗口）同样记进对话并 hold，收尾没人取就补开一轮，不能只 `log.warn`。
- 规则：说「已转给子对话」却没调发送工具（`claimsUnsentHandoff`）也按没做完接一轮。
- 起因：0 token、0 输出的一轮被标成完成并保活，用户催「分析啊」时消息被插进死回合；9e7674d 只修了第一轮，第二句起一个字没回被前一轮正文盖住。
- 起因：`steerTask` 只要回包就返回 `'steer'`，网关吞请求时补充永久丢失；ADR 0002 的用户回答撞上子对话刚结束一轮，消息被吞，e2e 一半失败。
- 防线：`server/exec/hints.test.ts`；`server/exec/delivery.test.ts`；`scripts/e2e.mjs` 的 `FAKE_SILENT`、「保活中的第二句一个字都没回」「子对话请父对话决定」用例。

## 每个收 CliEvent 的地方都要把工具行收尾

- 规则：任务页之外自己拼消息处（`server/assist.ts` 的 AI 创建 / 分析、`server/designs.ts` 的 UI 设计）和 runner 一样处理工具事件：`tool_result` 删掉 `running`、`tool_delta` 的 `snapshot` 直接替换输出，结束时（停止、超时、退出）收掉在跑的行；给 CLI 加字段时一起过。
- 起因：Pi 的 `tool_execution_start` 带 `running: true`，c5e408d 只改了 runner，AI 分析一直转圈；任务页被打断时 `endTool` 没清 `running`。
- 防线：`scripts/e2e.mjs` 的「工具结束后不再显示运行中」。

## 停下要有原因，保活有上限，收口后不留进程

- 规则：`stopTask(id, reason)` 的 `reason` 必填，只有用户点 `/stop` 传 `'user'`，其余按原因传（收尾、换 CLI、归档、删除、重启、页面切走、打断）；异常退出走失败，不归成停止。
- 规则：会话「彻底完成」时不分独立分支都 `cancelWait/stopTask` + `await entry.done` + `background.stop`，worktree 回收只在 `isolated` 做；`awaitingUser` 超过 `keepAliveLimit` 时 `keepAliveVictims()` 停最久没用的，「正在看」只认前台开着的页面（`isViewing`，不是 `hasViewer`）。
- 规则：任务收口后不能拿「进程还活着」当理由留着它：收尾落 `resolved` 后按 owner 再核对一次，另有启动 + 每小时的兜底回收（判定只用 `taskSettled`）；发出停止后确认退出才丢登记（杀不掉就写回）。
- 规则：面板起的 CLI 记在 `run/cli-pids/<面板 pid>.json`，每个实例只写、只删自己那份（共用一份再读盘合并会被别的实例退出清空、并发登记覆盖）；清理只写已退出实例的文件，「面板还活着」要 pid 在**且**命令行像 `server.mjs` / `server/index.ts`（认 `./` 和引号路径，宁多认）。
- 起因：12 个对话各留一个进程没被保活上限收住；共用目录的子对话 `resolved` 后 CLI 一直留着，用户报「4 小时前启动的进程没退」。
- 防线：`server/presence.test.ts`、`shared/task-stage.test.ts` 的保活用例；`server/exec/orphans.test.ts` 的登记分账、启动清理、兜底回收、写回登记；`server/task-restart.test.ts` 的「已收口的不再拉起」。

## 后台命令交出去不等于做完：没结果就一直转圈

- 规则：后台命令那一行按输出里「还没拿到结果的编号」（`bgPendingIds`，不锚定开头）判断转圈，结果段带编号接在后面（`settleJobRow`）；跑得久、没输出要提醒对话；推送失败重试并留在对话里。命令一律静默跑，不新开窗口。见 ADR 0006。
- 起因：带前缀的工具名被当成「运行命令」0.09 秒完成；Command Code 在结果前插 `<repair_note>`，锚定开头的匹配认不出编号，又显示完成；模型 `start cmd` 弹窗跑测试。
- 防线：`server/background.test.ts`「那一行收口」「监管」；`web/src/lib/tasks.test.ts`。

## 一轮结束只发一次回调，result 和保活等待同出口

- 规则：一轮结束的两个信号（CLI `result`、保活等待 `listen()`）只走 `runner.ts` 的同一个 `endTurn()`，`markTurnDone`、`ctx.onTurnEnd` 各只调一次；用户下条消息或子任务结果交回才复位。`reportChild` 的毫秒级 `turnDoneAt` 挡不住相隔几百毫秒的两次回调；前端 `dedupePeerReports`（相邻、同子对话、同标题同正文、10 秒内，不同来源不合并）只作兜底。
- 起因：2026-10-24 2 个子对话的同一份汇报各显示两条（同 `peer.id`、同标题同正文，相隔约 0.3 秒），`result` 与 `listen()` 各结束一次。
- 防线：`scripts/rules-check.mjs` 第 8 条能拦住——剥掉块注释、行注释后数 `server/exec/runner.ts` 的 `markTurnDone(task)`、`ctx.onTurnEnd?.()` 调用，共 2 次（只从 `endTurn()` 一处发出），拆回两处报「实际 4 处」；`scripts/e2e/04-subagents.mjs` 的「保活的子对话跑完一轮」只是行为断言，fake CLI 两次回调只隔约 3ms、reportKey 碰巧去重，拦不住；`web/src/lib/peer-dedupe.test.ts`。
