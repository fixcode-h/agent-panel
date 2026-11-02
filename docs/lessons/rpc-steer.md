---
paths: server/exec/rpc/**, server/exec/runner.ts, shared/clis/pi.json, shared/clis/commandcode.json
---

# 常驻协议的插话

## CLI 回「已收下」不等于会处理：插话要对上这一轮还没结束

- 规则：适配器的 `steer` 在这一轮结束后（结束记录已到、保活等下一句）直接返回 false，交给面板按下一句消息送；这一轮交出过插话的，结束前用 CLI 的收回命令（`redirect.take`）看有没有没被取走的，有就作为新的一句接着做。加新 CLI 的插话时，先用真 CLI 试「停下后再插话」会怎样。
- 起因：子对话卡在「等待模型」——Pi 在 `agent_settled` 之后才收到的 `steer` 照样回 queued 却不处理，面板标回执行中后无声挂着（见 `docs/modules/server-exec/bugs/pi-steer-after-settle.md`）。
- 防线：`server/exec/pi-rpc.test.ts`「插话和结束擦肩而过时收回接着做」。

## 同一次调用里可能并发的等待，各自收尾只摘自己

- 规则：常驻进程每报一次结束都会进一次保活等待，CLI 自己多跑一轮（处理排在输入里的插话）时上一次还没等到就又挂上一个。登记 / 摘除只走 `server/exec/waiters.ts`，每个等待在收尾时摘自己那个对象；同一次调用的「等下一句」用 `userWaitSlot`，新的换下旧的。不要用一个闭包变量记「当前的等待」。
- 起因：用户 2026-11-02 复现消息发出去一闪就没了（`waiters=2` → 「消息没有记进对话」），见 `docs/modules/server-exec/bugs/keepalive-double-wait.md`。
- 防线：`server/exec/waiters.test.ts`。
