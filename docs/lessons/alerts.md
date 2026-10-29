---
paths: shared/alerts.ts, shared/locales/en/alerts.ts, server/exec/runner.ts, server/exec/invoke.ts
---

# 执行出错和没有响应

## Agent 的错误一律显示，不悄悄重试

- 规则：断流、退出码异常先把完整错误显示在节点上，再按规则续接（最多 2 次）；不吞错误、不静默重试。
- 防线：人工。

## 错误写进对话并带分类；交给 CLI 后没有输出要提醒，下一句要能救回来

- 规则：执行和面板自己出的错都写进对话，系统消息带 `alert`（分类和说明在 `shared/alerts.ts`），界面画成可点开的警告行；只写 `log.warn` 不算处理过。交给 CLI 一句话、工具结果或开始一次模型请求后 `NO_RESPONSE_MS` 内没有真正的输出，写 `no_response` 警告并登记卡住；之后来的消息不再插话进那一轮，`HARD_STOP` 直接结束进程、接回会话重开，带上没被处理的那条。新加一类报错时 `AlertKind`、`alerts.ts`、`shared/locales/en/alerts.ts` 各加一项。
- 起因：2026-10-24 后台命令「等待 PR 42 检查」的结果交给保活的 Command Code 后它一个字都没输出，用户的新消息又插话进卡住的那一轮，界面上没有任何错误。
- 防线：`scripts/e2e/03-chat.mjs` 的「CLI 收下消息后没有输出」；`shared/alerts.test.ts`。
