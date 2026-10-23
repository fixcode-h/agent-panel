---
paths: server/exec/runner.ts, server/tasks.ts, shared/task.ts, shared/plan.ts, shared/plan.test.ts, web/src/components/tasks/ChildAskCard.tsx, server/assist.ts, server/designs.ts, server/exec/delivery.ts, server/exec/invoke.ts, server/exec/rpc/**, server/exec/hints.test.ts, scripts/e2e.mjs, scripts/fake-cli/fake-cli.mjs
---

# 一轮执行怎么收尾

## 空回合和补充重放都按「这一轮」算，不按进程或回包算

- 规则：CLI 报一轮成功、但正文、工具、用量一条都没有时按空回合处理：不保活、交给兜底自动接一轮，并在对话里留下可见说明。保活时一个进程连着处理多条消息，`runAgent` 攒的 `mine`、`touched` 是整个进程的；判「这一轮做没做事」（空回合、补充要不要重放、重试发什么）只看这一轮开始之后的输出，重发的是这一轮的用户消息。
- 起因：0 token、0 输出的一轮被标成完成并保活，用户催「分析啊」时消息被插进死回合；9e7674d 只修了第一轮，第二句起一个字没回被前一轮正文盖住。
- 防线：`server/exec/hints.test.ts`；`scripts/e2e.mjs` 的 `FAKE_SILENT`、「保活中的第二句一个字都没回」用例。

## 交出去没被消费的消息要留到下一轮重放

- 规则：面板替别人往对话里投消息（子对话回答、催合并、后台结果）时，CLI 回了包不等于模型看见了：这一轮结束没有任何产出就交回下一轮。`read_user_notes` 没取走的、插话通道送出的都走 `holdForNextTurn`；`followUp` 报 `TaskBusyError`（不在 running 但执行位还占着，是正常的收尾窗口）时同样记进对话并 hold，收尾结束还没人取就补开一轮，不能只记 `log.warn`。
- 起因：`steerTask` 只要回包就返回 `'steer'`，网关吞掉请求时那条补充永久丢失；ADR 0002 那次用户回答撞上子对话刚结束一轮，消息被吞，e2e 约一半失败。
- 防线：`server/exec/delivery.test.ts`；`scripts/e2e.mjs` 的「子对话请父对话决定」。

## 每个收 CliEvent 的地方都要把工具行收尾

- 规则：任务页之外自己拼消息的地方（`server/assist.ts` 的 AI 创建 / 分析、`server/designs.ts` 的 UI 设计）和 runner 一样处理工具事件：`tool_result` 删掉 `running`、`tool_delta` 的 `snapshot` 直接替换输出，结束（停止、超时、退出）时把还在跑的行全部收掉。给 CLI 新加工具字段时把这几处一起过一遍。
- 起因：Pi 的 `tool_execution_start` 带 `running: true`，c5e408d 加标记时只改了 runner，AI 分析里 codemode 一直转圈；任务页被打断时 `endTool` 也没清 `running`。
- 防线：`scripts/e2e.mjs` 的「工具结束后不再显示运行中」。

## 停下要有原因，保活要有上限，彻底完成就结束进程

- 规则：`stopTask(id, reason)` 的 `reason` 是必填的 `StopReason`，只有用户点暂停的 `/stop` 传 `'user'`；父对话收尾、换 CLI、归档、删除、面板重启、页面切走、新消息打断各传对应的值。`Live.stopReason` 经 `EngineHost.stopReason()` 写进 `Task.stopReason`，界面按 `childIcon` 和 `stopReasonText` 显示，只有 `'user'` 才画暂停。进程异常退出（`spawnError`、非 0 退出码）走失败并显示原因，不要归成停止。
- 规则：会话「彻底完成」（`resolved` 且 `childHolds` 为空）时不管有没有独立分支都要 `cancelWait/stopTask` + `await entry.done` + `background.stop`，worktree 回收才只在 `isolated` 里做。保活中的会话（`awaitingUser`）超过 `Settings.keepAliveLimit` 时用 `keepAliveVictims()` 挑最久没用的结束（`stopTask(id, 'idle')`），排除正在看的页面、刚进入保活的自己、名下还有子对话在跑/排队的父对话。
- 起因：主工作区 `node_modules` 被清空那段时间，父对话收尾 abort 名下子对话，`ctx.signal.aborted && !r.killed` 全判成 `stopped`，用户没点暂停却看到「已暂停」；12 个 `pi` 进程只有 7 个对得上在跑的任务，共用目录的子对话 `resolved` 后 CLI 一直留着。
- 防线：`shared/task-stage.test.ts` 的 `stopReasonText`、`keepAliveVictims` 用例；`stopTask` 第二参数必填由 `npm run typecheck` 拦住。
