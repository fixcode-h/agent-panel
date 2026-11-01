---
paths: shared/alerts.ts, shared/locales/en/alerts.ts, server/exec/runner.ts, server/exec/invoke.ts, server/exec/rpc/**
---

# 执行出错和没有响应

## Agent 的错误一律显示，不悄悄重试

- 规则：断流、退出码异常先把完整错误显示在节点上，再按规则续接（最多 2 次）；不吞错误、不静默重试。
- 规则：面板自己换做法重跑（丢会话重开、去掉思考强度）也算重试：`return runAgent` 前先用 `restartNote` / `recoveryNote` 在对话里写一行（原因、带没带上之前的对话、CLI 原始报错），对话的重开带 `restartCarry`（按预算裁剪）；判断「会话找不到」只用 `SESSION_NOT_FOUND`，别写宽正则。
- 规则：CLI 自己的重试映射成 `notice(kind:'retry')` + `retry_ok`；协议没有成功信号时（Codex 的 `error.willRetry`）由适配器在模型又出内容时补发 `retry_ok`，不能拿出错前就在跑的命令输出当信号。
- 起因：审计发现（df820f2 起） runner 的会话找不到 / 在别的目录 / 接口拒绝历史 / 强度被拒四处只写 log 就重跑，Codex 的 willRetry 整个丢掉。
- 防线：`server/exec/hints.test.ts`「自动重跑的每个 runAgent 调用点」「会话找不到」；`server/exec/parsers.test.ts` 的 Codex 重试用例。

## 错误写进对话并带分类；交给 CLI 后没有输出要提醒，下一句要能救回来

- 规则：执行和面板自己出的错都写进对话，系统消息带 `alert`（分类和说明在 `shared/alerts.ts`），界面画成可点开的警告行；只写 `log.warn` 不算处理过。交给 CLI 一句话、工具结果或开始一次模型请求后 `NO_RESPONSE_MS` 内没有真正的输出，写 `no_response` 警告并登记卡住；之后来的消息不再插话进那一轮，`HARD_STOP` 直接结束进程、接回会话重开，带上没被处理的那条。新加一类报错时 `AlertKind`、`alerts.ts`、`shared/locales/en/alerts.ts` 各加一项。
- 起因：2026-10-24 后台命令「等待 PR 42 检查」的结果交给保活的 Command Code 后它一个字都没输出，用户的新消息又插话进卡住的那一轮，界面上没有任何错误。
- 防线：`scripts/e2e/03-chat.mjs` 的「CLI 收下消息后没有输出」；`shared/alerts.test.ts`。
