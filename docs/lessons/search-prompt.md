---
paths: shared/engine/prompt-parts.ts, shared/mcp-catalog/code-index.ts, shared/mcp-catalog/tool-params.ts, server/hooks/tool-after-hints.ts, server/mcp-catalog/code-index.ts, server/mcp-catalog/external-titles.ts, skills/project/**
---

# 找代码的提示词（MCP 优先）

## 有专门的 MCP 工具就先用，找代码的规则只写一处

- 规则：给 Agent 的提示词不能只教 rg / grep。通用约束「工具选择」写明先用专门的 MCP 工具，只看得到名字的先加载说明；找代码的具体顺序（代码索引 MCP → 带排除的 rg → find）只写在引擎注入的「搜索（这个项目）」一节（`shared/engine/prompt-parts.ts` 的 `searchPart`），角色、Skill 里只引用它，不另写一份 rg 用法。项目接的索引工具由 `server/mcp-catalog/code-index.ts` 认出来，把服务名和工具名写进那一节，项目设置「代码索引工具」可手动指定。
- 起因：2026-11-14 用户报协调器查 GM 无效时先 grep 整个目录（还失败一次），追问后用 UEToVS 的 `search_lua` 一下就定位；C++ 也一样。搜索规则散在 7 处、都只写 rg，UEToVS 的工具名从没出现在提示词里，Claude Code 还把 MCP 工具延迟加载。
- 防线：`server/engine-steps.test.ts`「搜索一节先列代码索引 MCP 工具」、`shared/mcp-catalog/code-index.test.ts`。

## 别家工具的参数名不手写进提示词，从探测到的参数表生成

- 规则：提示词里要说某个别家 MCP 工具该传什么参数时，从缓存的参数表生成（`shared/mcp-catalog/tool-params.ts`，`ideMcpLines` 的写法），没有参数表就只写「照工具自己的参数表传」，不点名参数。面板自己工具的参数名写进提示词、说明、报错时，用真实的参数名（「`knowledge_lookup` 的 query 写 id」，不写「带 id」）。
- 起因：9545c4d（#398）提示词里手写了「传 `projectPath`」，Agent 照着给 `lua_code` 也传了，被当成未知参数整次失败；A2 的扫描又查出面板自己的提示词里三处写了不存在的参数（`knowledge_lookup` 带 id、`end_turn` 的 blocked、`message_workflow` 的 later）。
- 防线：`server/panel-tools/prompt-params.test.ts`、`shared/mcp-catalog/code-index.test.ts`；运行时由内置提醒「参数传错时补参数表」兜底。
