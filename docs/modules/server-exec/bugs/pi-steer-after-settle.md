# 子对话莫名卡在「等待模型」：Pi 停下后才收到的插话没人处理

- 状态：已修复（`server/exec/pi-rpc.test.ts` 通过，真 Pi 复现并验证）
- 症状：子对话一直显示「等待模型 · 已 Xm」，没有输出、没有报错，也不会出现「没有任何输出」的提醒
- 入口：`server/exec/rpc/spec.ts` 的 `steer` / 结束判断；`server/exec/rpc/session.ts` 的 `steer`；`server/exec/runner.ts` 的 `accepted`
- 根因类型：插话和这一轮的结束擦肩而过，CLI 回「已收下」不等于会处理
- 模块：`server-exec`（`server/exec/rpc/spec.ts`、`server/exec/rpc/session.ts`、`server/exec/runner.ts`）
- 关键词：等待模型、卡住、steer、插话、queued、agent_settled、clear_queue、保活、子对话、合并结果

## 现象

子对话快做完时收到父对话的消息、合并或后台命令的结果，之后一直停在「等待模型」，CLI 进程空闲，消息在对话里，却没有任何回复。

## 根因

1. 子对话正在执行（`working`）时，面板把新消息用插话（Pi 的 `steer`）交给它。
2. Pi 一轮的最后一次检查插话队列之后才收到这条：它照样回 `{"disposition":"queued"}`，但已经 `agent_settled`，排着的插话要等下一次 `prompt` 才处理（真 Pi 上在 `turn_end` 时插话即可复现）。
3. 面板按「已交出」处理：消息记进对话、`working` 重新标成 true；而 runner 已经停在保活上等下一句，`awaitingUser` 让卡住检测一直不计时，于是无声地挂着。保活中再插话也是一样。

## 修复

- RPC 会话这一轮结束后（`finished`）、配置驱动的适配器收到结束记录后，插话一律返回交不进去，面板按下一句消息送（保活的进程同一进程接着做）。
- 这一轮交出过插话的，结束前先按 `redirect.take`（Pi 的 `clear_queue`）收一次：收回了就按 `redirect.then` 作为新的一句交给它，同一轮接着做，不报结束；收回为空才照常结束。
- runner 收下插话时也开始计时，真没有输出照样写「没有任何输出」的警告。

## 防线

- `server/exec/pi-rpc.test.ts`：「插话和结束擦肩而过时收回接着做」：排在结束之后的插话收回并接着做、已被取走时照常结束、保活时不再插话。
