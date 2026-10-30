---
paths: server/exec/runner.ts, server/exec/delivery.ts, server/exec/hints.test.ts, server/exec/rpc/**, server/assist.ts, server/designs.ts, web/src/lib/peer-dedupe.ts, scripts/fake-cli/fake-cli.mjs
---

# 一轮执行怎么收尾

## 空回合只认「什么都没收到」并报错，补充重放按这一轮算，没消费的消息留到下一轮

- 规则：CLI 报一轮成功但正文、工具、改动都没有（`silentTurn`）时按错误报出来：不保活、写红色报错、这一轮按失败结束，不自动重试。保活时一个进程连着多条消息，`runAgent` 的 `mine`、`touched` 是整个进程的；判断这轮做没做事只看这轮开始后输出，重发的是这轮的用户消息。
- 规则：面板替别人往对话投消息（子对话回答、催合并、后台结果）时，CLI 回包不等于模型看见了，这轮没产出就交回下一轮。`read_user_notes` 没取走的、插话通道送出的都走 `holdForNextTurn`；`TaskBusyError`（执行位还占着，正常收尾窗口）同样记进对话并 hold，收尾没人取就补开一轮，不能只 `log.warn`。
- 规则：不按回复文字猜「没做完」去催（「我先…」「已转给子对话」这类）：寒暄、反问会被误判，还白跑一轮；只说了一句的回复照常收尾。起因：2026-10-29 对话模式回「你好」被挂上「这一轮没有产出」并自动接一轮，用户要求去掉、只把报错暴露出来。
- 起因：0 token、0 输出的一轮被标成完成并保活，用户催「分析啊」时消息被插进死回合；9e7674d 只修了第一轮，第二句起一个字没回被前一轮正文盖住。
- 起因：`steerTask` 只要回包就返回 `'steer'`，网关吞请求时补充永久丢失；ADR 0002 的用户回答撞上子对话刚结束一轮，消息被吞，e2e 一半失败。
- 防线：`server/exec/hints.test.ts`；`server/exec/delivery.test.ts`；`scripts/e2e/03-chat.mjs` 的 `FAKE_EMPTY`、`FAKE_SILENT`、「保活中的第二句一个字都没回」「子对话请父对话决定」用例。

## 每个收 CliEvent 的地方都要把工具行收尾

- 规则：任务页之外自己拼消息处（`server/assist.ts` 的 AI 创建 / 分析、`server/designs.ts` 的 UI 设计）和 runner 一样处理工具事件：`tool_result` 删掉 `running`、`tool_delta` 的 `snapshot` 直接替换输出，结束时（停止、超时、退出）收掉在跑的行；给 CLI 加字段时一起过。
- 起因：Pi 的 `tool_execution_start` 带 `running: true`，c5e408d 只改了 runner，AI 分析一直转圈；任务页被打断时 `endTool` 没清 `running`。
- 防线：`scripts/e2e.mjs` 的「工具结束后不再显示运行中」。

## 一轮结束只发一次回调，result 和保活等待同出口

- 规则：一轮结束的两个信号（CLI `result`、保活等待 `listen()`）只走 `runner.ts` 的同一个 `endTurn()`，`markTurnDone`、`ctx.onTurnEnd` 各只调一次；用户下条消息或子任务结果交回才复位。`reportChild` 的毫秒级 `turnDoneAt` 挡不住相隔几百毫秒的两次回调；前端 `dedupePeerReports`（相邻、同子对话、同标题同正文、10 秒内，不同来源不合并）只作兜底。
- 起因：2026-10-24 2 个子对话的同一份汇报各显示两条（同 `peer.id`、同标题同正文，相隔约 0.3 秒），`result` 与 `listen()` 各结束一次。
- 防线：`scripts/rules-check.mjs` 第 8 条能拦住——剥掉块注释、行注释后数 `server/exec/runner.ts` 的 `markTurnDone(task)`、`ctx.onTurnEnd?.()` 调用，共 2 次（只从 `endTurn()` 一处发出），拆回两处报「实际 4 处」；`scripts/e2e/04-subagents.mjs` 的「保活的子对话跑完一轮」只是行为断言，fake CLI 两次回调只隔约 3ms、reportKey 碰巧去重，拦不住；`web/src/lib/peer-dedupe.test.ts`。
