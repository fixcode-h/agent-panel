---
paths: web/src/components/projects/caps/**, web/src/components/ui/capability-item.tsx, server/projects/mcp*.ts
---

# 项目「技能与 MCP」页

## 能力条目的「生效范围」标签照实际挂在哪写

- 规则：「技能与 MCP」这类列能力的页面，标签写的是 Agent 实际在哪拿到它：项目目录里有的（含已导入的）归「项目自己的」，全局那块按名字去重；写在各 Agent 全局配置里的照实标「全局生效」并给改回按项目的入口；插件 MCP 只在某些页面对话里挂的，用插件 `catalog()` 的 `attach` 标「按场景」，不笼统写「全局」。同一类筛选只留一排，不在上面再叠一排同义页签。
- 起因：用户 2026-11-17 指出项目页两排页签重复、项目导入的 idea / uetovs 被列成「全局」、UI 设计插件的 MCP 标「全局」（实际只在 UI 设计页挂）。
- 防线：`scripts/ui/07-projects.mjs` 的「技能与MCP」几步；`caps-items.test.ts` 的 attach 用例。
