---
paths: server/ask-mcp.ts, server/panel-mcp-files.ts, server/project-mcp.ts, server/exec/invoke.ts, shared/project-mcp.ts
---

# 面板往用户项目里临时写的文件

## 只撤自己那几项，并假设会来不及撤

- 规则：为一轮执行往项目目录写的东西（面板 MCP 条目、权限放行），结束时只撤自己加的键和数组项（`server/ask-mcp.ts` 的 `unmerge`），不整文件写回快照；另外要有兜底清理（`server/panel-mcp-files.ts` 的 `sweepPanelMcp`，执行前和启动时跑），面板被关掉、崩溃时 `finally` 不会执行。名字固定 `agent-panel`，并发时才加后缀；项目设置的扫描用 `isPanelMcpUrl` 认出面板自己的条目。
- 起因：Command Code、Gemini 每轮写一个 `panel-xxxxxx` 进 `.mcp.json`，关面板时保活的对话来不及还原，快照还原又把残留写回去，用户项目里积了 27 条，项目设置还当成可导入的 MCP（`docs/modules/server-exec/bugs/project-mcp-leftovers.md`）。
- 防线：`server/panel-mcp-files.test.ts`、`server/project-mcp.test.ts`。
