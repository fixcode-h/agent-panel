---
paths: server/exec/redirect.ts, server/exec/runner.ts, server/exec/rpc/spec.ts, scripts/e2e.mjs
---

# 插话和正在执行的命令

## 为插话停下命令前，先分清命令是不是只读

- 规则：判定写成纯函数放 `server/exec/redirect.ts`，runner 只拿结果决定还要等多久。只读命令（`ls`、`rg`、`git log`、`git worktree list` 这类）等它自然跑完——这批工具结束时 CLI 自己会取走补充；会写文件、装依赖、跑测试、等外部状态的才按短阈值打断，只读的只在更长的兜底阈值才停。停下时给模型的说明要写明这条命令已取消、输出不完整、不要当结果，并让它需要时重跑。
- 起因：面板自己的执行记录 92dfd0da 里，`git worktree list` 跑 9.2 秒就被新消息打断重跑（随后出现「为了马上处理新消息，停下了正在执行的命令」）；用户每发一条消息，正在读的代码就白读一遍。
- 防线：`server/exec/redirect.test.ts` 覆盖只读判定和各阈值下的等待时间；`scripts/e2e/03-chat.mjs` 的 Pi 长命令（`sleep 120; gh pr checks 14`）用例证明非只读命令仍然会被打断。
