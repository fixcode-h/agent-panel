---
paths: server/exec/redirect.ts, server/exec/runner.ts, server/exec/rpc/spec.ts, server/designs.ts, web/src/components/design/DesignChat.tsx, server/tasks/**
---

# 插话和运行中发来的消息

## 为插话停下命令前，先分清命令是不是只读

- 规则：判定写成纯函数放 `server/exec/redirect.ts`，runner 只拿结果决定还要等多久。只读命令（`ls`、`rg`、`git log`、`git worktree list` 这类）等它自然跑完——这批工具结束时 CLI 自己会取走补充；会写文件、装依赖、跑测试、等外部状态的才按短阈值打断，只读的只在更长的兜底阈值才停。停下时给模型的说明要写明这条命令已取消、输出不完整、不要当结果，并让它需要时重跑。
- 起因：面板自己的执行记录 92dfd0da 里，`git worktree list` 跑 9.2 秒就被新消息打断重跑（随后出现「为了马上处理新消息，停下了正在执行的命令」）；用户每发一条消息，正在读的代码就白读一遍。
- 防线：`server/exec/redirect.test.ts` 覆盖只读判定和各阈值下的等待时间；`scripts/e2e/03-chat.mjs` 的 Pi 长命令（`sleep 120; gh pr checks 14`）用例证明非只读命令仍然会被打断。

## 运行中发的消息走服务端补充接口，页面不要自己维护队列

- 规则：会话运行中发消息走服务端的补充接口（设计对话是 `POST /designs/:id/steer`，输入复用 `DesignChatInput`，带附件、标注、引用、风格）：能插话就交给正在跑的这一轮，收不下就记进对话并在这一轮结束后自动开下一轮（`pendingTurns` + `drainTurns`），`delivery` 记清 `steer` / `held` / `next` / 停止后 `lost`，界面用共享的 `deliveryText` 显示，不要一直停在「结束后自动处理」；前端不要造本地 queue 冒充已送达。停止要连「准备新一轮」（`starting`）的窗口一起取消，取消后还得把停止期间登记进 `pendingTurns` 的消息接上，否则它们会一直停在「结束后自动处理」。
- 起因：2026-10-24 设计对话原来只把纯文字交给 `/steer`，带附件、引用、风格的消息塞进页面本地 queue（「排队中，这一轮结束后发送」），用户要求改成和 Chat 模式一致。
- 防线：`scripts/e2e/06-assist.mjs` 的「设计补充测试」「设计接续测试」「设计停止测试」；`npm run typecheck` 的漏翻检查。
