---
paths: server/exec/runner.ts, server/tasks.ts, shared/plan.ts, shared/plan.test.ts, server/assist.ts, server/designs.ts, server/exec/delivery.ts, server/exec/invoke.ts, server/exec/rpc/**, server/exec/hints.test.ts, scripts/e2e.mjs, scripts/fake-cli/fake-cli.mjs
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

## 每个收 CliEvent 的地方都要把工具行收尾

- 规则：任务页之外自己拼消息的地方（`server/assist.ts` 的 AI 创建 / 分析、`server/designs.ts` 的 UI 设计）和 runner 一样处理工具事件：`tool_result` 删掉 `running`、`tool_delta` 的 `snapshot` 直接替换输出，结束（停止、超时、退出）时把还在跑的行全部收掉。给 CLI 新加工具字段时把这几处一起过一遍。
- 起因：Pi 的 `tool_execution_start` 带 `running: true`，AI 分析项目配置里只补了输出、没收掉标记，codemode 和里面的读取、查找一直转圈（c5e408d 加标记时只改了 runner）；任务页被打断时 `endTool` 也没清 `running`。
- 防线：`scripts/e2e.mjs` 的「工具结束后不再显示运行中」（用 Pi 跑 AI 创建）。
