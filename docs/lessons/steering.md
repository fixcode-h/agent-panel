---
paths: server/exec/redirect.ts, server/exec/runner.ts, server/exec/rpc/spec.ts, scripts/e2e.mjs, shared/alerts.ts, server/tasks.ts
---

# 插话、正在执行的命令和没有响应的 CLI

## 为插话停下命令前，先分清命令是不是只读

- 规则：判定写成纯函数放 `server/exec/redirect.ts`，runner 只拿结果决定还要等多久。只读命令（`ls`、`rg`、`git log`、`git worktree list` 这类）等它自然跑完——这批工具结束时 CLI 自己会取走补充；会写文件、装依赖、跑测试、等外部状态的才按短阈值打断，只读的只在更长的兜底阈值才停。停下时给模型的说明要写明这条命令已取消、输出不完整、不要当结果，并让它需要时重跑。
- 起因：面板自己的执行记录 92dfd0da 里，`git worktree list` 跑 9.2 秒就被新消息打断重跑（随后出现「为了马上处理新消息，停下了正在执行的命令」）；用户每发一条消息，正在读的代码就白读一遍。
- 防线：`server/exec/redirect.test.ts` 覆盖只读判定和各阈值下的等待时间；`scripts/e2e/03-chat.mjs` 的 Pi 长命令（`sleep 120; gh pr checks 14`）用例证明非只读命令仍然会被打断。

## 错误写进对话并带分类；交给 CLI 后没有输出要提醒，下一句要能救回来

- 规则：执行和面板自己出的错都写进对话，系统消息带 `alert`（分类和说明在 `shared/alerts.ts`），界面画成可点开的警告行；只写 `log.warn` 不算处理过。交给 CLI 一句话、工具结果或开始一次模型请求后 `NO_RESPONSE_MS` 内没有真正的输出，写 `no_response` 警告并登记卡住；之后来的消息不再插话进那一轮，`HARD_STOP` 直接结束进程、接回会话重开，带上没被处理的那条。新加一类报错时 `AlertKind`、`alerts.ts`、`shared/locales/en/alerts.ts` 各加一项。
- 起因：2026-10-24 后台命令「等待 PR 42 检查」的结果交给保活的 Command Code 后它一个字都没输出，用户的新消息又插话进卡住的那一轮，界面上没有任何错误。
- 防线：`scripts/e2e/03-chat.mjs` 的「CLI 收下消息后没有输出」；`shared/alerts.test.ts`。
