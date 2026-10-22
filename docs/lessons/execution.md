---
paths: server/exec/runner.ts, server/exec/delivery.ts, server/exec/invoke.ts, server/exec/rpc/**, server/exec/hints.test.ts, scripts/e2e.mjs, scripts/fake-cli/fake-cli.mjs
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
