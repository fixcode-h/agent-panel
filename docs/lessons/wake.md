---
paths: shared/wake.ts, server/tasks/peer.ts, server/tasks/child-messages.ts, server/tasks/budget.ts, server/tasks/state-sweep.ts, server/tasks/asks.ts
---

# 面板替别人叫醒对话

## 叫不叫醒只走一个函数：holdWake / wakeHold

- 规则：面板替别人叫醒一个对话（子对话上报、提问 / 修复请求、转交子任务、交回子对话、定时提醒）之前一律过 `holdWake`（规则只写在 `shared/wake.ts` 的 `wakeHold`）：用户亲手停下（含执行位上刚按停止）、因用量上限停下、核对收成 `lost`、整棵树已超限（`budget.ts` 的 `overBudget` 现算：空闲的父对话不会被记成 budget）、发件的子对话自己正在停 → 不叫，只进收件箱；上级交代（`fromAbove`）只看超限。新加叫醒入口不要再手写 `stopReason === 'user'`；用户自己发的消息走 followUp，不经过这里。
- 规则：叫醒前写进父对话的收件箱、消息用执行位那份（`live.get(id)?.task ?? 读盘的`），落盘也用它；叫醒文案直接带上报错正文，不只说「在收件箱里」。
- 起因：复核 2bb92363 发现 noteParent、messageParent 各写一份守卫且只认 `user`：预算停下、`lost` 的父对话被子对话上报叫起来空转，超限后父子来回叫；messageParent 写进读盘的旧对象，修复请求被执行器盖掉。
- 防线：`shared/wake.test.ts`、`server/tasks/peer.test.ts`、`server/tasks/child-messages.test.ts`。

## 计划挂着等父对话的请求，交出时就要叫醒父对话

- 规则：子对话给步骤挂上 kind `parent` 的等待后，`planStalled`、`reportChild`、idle-ask 都不会再替它推父对话，请求本身（`message_parent` 的 wait_fix）必须在父对话没在执行时 `wakeConv`（过 holdWake）；叫醒丢了（重启）或那一轮没回它，由定时核对（`state-sweep.ts` 的 `remindParent`）连看两次后提醒一次。新加「挂等待 + 发消息」的工具照这条检查。
- 起因：审计发现（df820f2 起）父对话空闲时修复请求只进收件箱，父子互等到用户介入；带了提问标记的还会被并进阶段汇报、永远交不出去。
- 防线：`server/tasks/peer.test.ts`、`server/tasks/state-sweep.test.ts`。

## 兜底收口把子对话落成停下后也要上报父对话

- 规则：任何把子对话落成 stopped 的路径都走 `reportToParent`，父计划里等它的那一步才会收口、该叫的父对话才会被叫醒；兜底模块的依赖（上报、提醒）写成必填参数，不写成可选回调（漏接线时 tsc 会报）。
- 起因：审计发现 ADR 0033 的定时核对只留了可选的 `settled` 又没接，孤儿子对话落成「已中断」后父对话一直停在等它。
- 防线：`server/tasks/state-sweep.test.ts`「子对话落成已中断后交给父对话上报」。
