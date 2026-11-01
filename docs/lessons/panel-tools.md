---
paths: server/orch-mcp.ts, shared/panel-tools.ts, server/ask-mcp.ts
---

# 面板工具按身份裁剪

## 各身份的工具清单只认快照测试，改工具时一并核对握手和名字总表

- 规则：`orchTools` 每个身份拿到哪些工具以 `server/orch-mcp.test.ts` 的 IDENTITIES 表为准，加、删、改条件时同一个提交改表和 `docs/modules/server-exec/README.md`，README 只写「工具 → 条件」不写个数；新工具名进 `shared/panel-tools.ts` 的 `PANEL_TOOL_NAMES` 并在 `web/src/lib/tasks.ts` 给显示分支；新加的身份要核对 `server/ask-mcp.ts` 握手声明的 `orchestration.enabled` 和 Pi 扩展核对的核心工具对得上。
- 起因：审计发现（df820f2 起）README 五组工具数全和代码不符；`stop_workflow`、`cherry_pick` 没登记、对话里露原始名字；186443c 加 Chat 页身份后 Pi 误报「工具清单不完整」。
- 防线：`server/orch-mcp.test.ts`「面板工具按身份裁剪」、`server/ask-mcp.test.ts` 的握手用例。
