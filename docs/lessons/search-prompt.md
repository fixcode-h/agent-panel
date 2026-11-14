---
paths: shared/engine/prompt-parts.ts, shared/mcp-catalog/code-index.ts, server/mcp-catalog/code-index.ts, server/mcp-catalog/external-titles.ts, skills/project/**
---

# 找代码的提示词（MCP 优先）

## 有专门的 MCP 工具就先用，找代码的规则只写一处

- 规则：给 Agent 的提示词不能只教 rg / grep。通用约束「工具选择」写明先用专门的 MCP 工具，只看得到名字的先加载说明；找代码的具体顺序（代码索引 MCP → 带排除的 rg → find）只写在引擎注入的「搜索（这个项目）」一节（`shared/engine/prompt-parts.ts` 的 `searchPart`），角色、Skill 里只引用它，不另写一份 rg 用法。项目接的索引工具由 `server/mcp-catalog/code-index.ts` 认出来，把服务名和工具名写进那一节，项目设置「代码索引工具」可手动指定。
- 起因：2026-11-14 用户报协调器查 GM 无效时先 grep 整个目录（还失败一次），追问后用 UEToVS 的 `search_lua` 一下就定位；C++ 也一样。搜索规则散在 7 处、都只写 rg，UEToVS 的工具名从没出现在提示词里，Claude Code 还把 MCP 工具延迟加载。
- 防线：`server/engine-steps.test.ts`「搜索一节先列代码索引 MCP 工具」、`shared/mcp-catalog/code-index.test.ts`。
