---
paths: server/exec/runner.ts, server/tasks.ts, shared/task.ts, shared/plan.ts, shared/plan.test.ts, web/src/components/tasks/ChildAskCard.tsx, server/assist.ts, server/designs.ts, server/exec/delivery.ts, server/exec/invoke.ts, server/exec/rpc/**, server/exec/hints.test.ts, scripts/e2e.mjs, scripts/fake-cli/fake-cli.mjs
---

# 一轮执行怎么收尾

## 「成功」不等于「做完了」：没有任何输出的回合不能算完成

- 规则：CLI 报一轮成功、但正文、工具、用量一条都没有时，按空回合处理——不保活、交给兜底自动接一轮，并在对话里留下可见说明。判断要看这一轮实际收到的正文，不要只看 CLI 的结果码。
- 起因：用户发截图问问题，那一轮 0 token、0 输出却报成功，被标成已完成并保活等下一句；之后发的「分析啊」被当成执行中补充插进死回合，既没有回复也没有报错，用户只能反复催。
- 防线：`server/exec/hints.test.ts`、`scripts/e2e.mjs` 的 `FAKE_SILENT` 用例。

## 「已接受」不等于「已处理」：交出去又没被消费的补充要留到下一轮

- 规则：把用户消息转给正在跑的调用时，记下这条消息；这一轮结束后如果没有任何产出，说明模型根本没看见它，要交回下一轮重放。`read_user_notes` 没取走的已经这么做了（`holdForNextTurn`），插话通道也要一样。
- 起因：`steerTask` 只要 CLI 回包就返回 `'steer'`，那条补充不再进 held 队列；网关吞掉请求时它永久丢失。
- 防线：`server/exec/delivery.test.ts`、`scripts/e2e.mjs`。

## 保活进程里的判定按「这一轮」算，不按「这个进程」算

- 规则：保活时一个 CLI 进程会连着处理好几条用户消息，`runAgent` 里攒的输出（`mine`、`touched`）是整个进程的。凡是判「这一轮做没做事」（空回合、补充要不要重放、重试发什么）都只看这一轮开始之后的输出，重试重发的是这一轮的用户消息，不是进程启动时的提示词。
- 起因：9e7674d 只修了进程的第一轮；第二句起一个字没回时，前一轮的正文把它盖住，消息照样落进死回合（AI 分析里 17:54、17:55 两条消息没有回应）。
- 防线：`scripts/e2e.mjs` 的「保活中的第二句一个字都没回」用例。

## 「这一轮回复完了」不等于「子对话交付完了」：收口父计划要按面板的完成条件判断

- 规则：子对话回合结束时收口父对话计划（`shared/plan.ts` 的 `childTurnSettle`）不能只看 `working`/`requests`/`status`：还要看它自己有没有没做完的计划步骤、有没有正在跑或排队的后台命令（`background.list` 里 `state` 是 `queued`/`running`）、这一轮之后还要不要接着做（`hasHeld`、`startQueue`）。没收口时用 `holdWait` 让父计划那一步继续等、note 写清在等什么，不要标完成；`server/tasks.ts` 的 `reportToParent` 用同一个判据。计划做完了会收起（`activePlan` 是 undefined），不会永远挡住收口，所以判据里不要写计时。
- 起因：子对话跑完一轮停在等下一句时，父计划里等它的步骤被标成完成（截图里「计划 6/8」与实际不符），实际还有子对话在改代码、跑界面检查。
- 防线：`shared/plan.test.ts` 的「子对话这一轮结束」「三个子对话都在跑」用例。

## 交给另一个对话的任务要走实时交付，失败必须显示给用户

- 规则：让父对话去处理一件事（子对话的提问交给它决定之类）时，不能按 `working` 判断它空闲：停在等下一句、收尾中、预热时 `working` 都是 false，但执行位还占着，直接 `followUp` 会抛 `TaskBusyError`。用 `deliver`（等下一句就直接续上、能插话就插话、收不下记到这一轮结束后处理），只有 `live` 里没有进程时才 `followUp`；问题全文和选项一起交过去，续上同一个进程时收件箱不会重读。叫不起来时把原因返回给接口，界面显示原因并给重试，不能只写日志；卡片状态字段（如 `delegated`）必须进 `messageStamp`，否则服务端改了也不推送。
- 起因：点「交给父对话决定」好几次父对话都没动：它停在等下一句时 `working=false`，`followUp` 撞上执行位后只留了一条 `log.warn`，接口照样返回成功。
- 防线：`shared/task-stamp.test.ts`、`scripts/e2e.mjs` 的「父对话停在等下一句时点交给父对话决定」用例。

## 每个收 CliEvent 的地方都要把工具行收尾

- 规则：任务页之外自己拼消息的地方（`server/assist.ts` 的 AI 创建 / 分析、`server/designs.ts` 的 UI 设计）和 runner 一样处理工具事件：`tool_result` 删掉 `running`、`tool_delta` 的 `snapshot` 直接替换输出，结束（停止、超时、退出）时把还在跑的行全部收掉。给 CLI 新加工具字段时把这几处一起过一遍。
- 起因：Pi 的 `tool_execution_start` 带 `running: true`，AI 分析项目配置里只补了输出、没收掉标记，codemode 和里面的读取、查找一直转圈（c5e408d 加标记时只改了 runner）；任务页被打断时 `endTool` 也没清 `running`。
- 防线：`scripts/e2e.mjs` 的「工具结束后不再显示运行中」（用 Pi 跑 AI 创建）。

## 停下这一轮必须带原因，不能把非用户动作写成「已暂停」

- 规则：`stopTask(id, reason)` 的 `reason` 是必填的 `StopReason`，只有用户点暂停的 `/stop` 传 `'user'`；父对话收尾、换 CLI、归档、删除、面板重启、页面切走、新消息打断、自身完成收尾各自传对应的值。`Live.stopReason` 经 `EngineHost.stopReason()` 交给收尾，写进 `Task.stopReason`；界面按 `childIcon` 和 `stopReasonText` 显示，只有 `'user'` 才画暂停、说「已暂停」。进程异常退出（`spawnError`、非 0 退出码）走失败并显示原因，不要归成停止。
- 起因：主工作区 `node_modules` 被清空那段时间，父对话收尾把名下子对话一起 abort，`ctx.signal.aborted && !r.killed` 全判成 `stopped`，用户没点暂停却看到几只子对话「已暂停」，而且无从知道是谁结束的。
- 防线：`shared/task-stage.test.ts` 的 `stopReasonText` /父对话收尾用例；`stopTask` 的第二参数必填由 `npm run typecheck` 拦住。

## 保活进程要有全局上限，彻底完成就要结束进程

- 规则：会话「彻底完成」（`resolved` 且 `childHolds` 为空）时不管有没有独立分支都要 `cancelWait/stopTask` + `await entry.done` + `background.stop`，worktree 回收才只在 `isolated` 里做。保活中的会话（`awaitingUser`）超过 `Settings.keepAliveLimit` 时用 `keepAliveVictims()` 挑最久没用的结束（`stopTask(id, 'idle')`），排除正在看的页面、刚进入保活的自己、以及名下还有子对话在跑/排队的父对话。
- 起因：调研发现 12 个 `pi` 进程只有 7 个对得上在跑的任务：共用目录的子对话 `resolved` 后 CLI 一直留着，保活又没有全局上限和 LRU，叠加 presence 宽限期就是十几个常驻进程。
- 防线：`shared/task-stage.test.ts` 的 `keepAliveVictims` 用例。

## 交给对话的消息碰上上一轮收尾时不能丢

- 规则：面板替别人往对话里投消息（子对话回答、催合并、后台结果）时，对话「不在 running 但执行位还占着」是正常的收尾窗口。`followUp` 报 `TaskBusyError` 时把消息记进对话并 `holdForNextTurn`，等收尾结束还没人取就自己补开一轮，不能只记一条日志就算了。
- 起因：子对话完成即合并那次（ADR 0002）端到端测试偶发超时：用户回答了子对话的提问，`sendToChild` 撞上子对话刚结束一轮、还在回报父对话，消息被吞掉，对话里什么都没有。
- 防线：`scripts/e2e.mjs` 的「子对话请父对话决定」用例（偶发，修之前约一半失败）。
