# 子对话收尾后父对话再交代任务，子对话没反应

- 状态：已修复（`server/tasks/child-messages.test.ts`、`server/tasks/keepalive-endlive.test.ts` 通过）
- 症状：子对话做完、父对话收尾后，父对话用 `send_to_conversation` 再交代任务，工具调用转圈到 1 分钟超时；查子对话状态停在「收尾那一刻」，重发一次照样超时，子对话一直没被叫起来
- 入口：`server/tasks/child-messages.ts` 的 `sendToChild`、`server/tasks/asks.ts` 的 `wakeConv`、`server/tasks/children.ts` 的 `completeChild`、`server/tasks/keepalive.ts` 的 `endLive`、`server/exec/invoke.ts` 的保活结束
- 根因类型：等进程退出没有时限，执行位一直占着，后面所有交给这个对话的消息都排在它后面
- 模块：`server`、`server-exec`、`web`（已收尾子对话的输入框）
- 关键词：子对话收尾、已完成子对话、交代任务超时、send_to_conversation 超时、收尾那一刻、执行位、cancelWait、entry.done、completing、resume、重新打开

## 根因

收尾（`completeChild`）先 `cancelWait` 让停在等下一句的 CLI 结束，再无限期等 `entry.done`。`cancelWait` 只让保活返回 null、关掉 CLI 的输入，不结束进程；CLI 关了输入也不退出（还挂着自己起的后台任务等）时，这一份执行永远收不完，执行位一直占着，`completing` 也一直不结束。

父对话这时交代任务：`wakeConv` 看到执行位还在，把消息排进对话再去等同一个 `entry.done`（或 `followUp` 等 `completing`），父对话的工具调用跟着挂到 CLI 的 1 分钟超时，父对话以为没送到又重发一遍。

## 修复

- `invoke.ts`：保活结束、关掉输入后 15 秒 CLI 还没退出就结束进程；这一轮早已报完结果，按正常退出交回，不显示成「已停止」。
- `keepalive.ts` 的 `endLive`：取消等待后限时（20 秒）等执行位释放，没收完就按原因停掉。收尾（`completeChild`）和「关闭 Agent」都走它。
- 收尾停掉的（`stopReason` 为 `finish`）不算没正常结束：收尾时交来的消息照样在收尾后开新一轮处理，不再被标成「没送出去」。
- `sendToChild` 最多等 40 秒：还没开起来就先回父对话「上一轮还在收尾，收尾完会自动处理，不用重发」，之后起不来照样在子对话里报警告。
- 界面：已收尾的子对话不显示输入框，换成「此子对话已收尾。请重新打开以发送更多消息。」和「重新打开」按钮；重新打开会取消已解决，并用 `--resume` 把它的 CLI 拉起来（同菜单「激活 Agent」）。父对话交代任务时同样按 `--resume` 续接原会话，不管上下文多大（取代 ADR 0007 的换新会话）。
