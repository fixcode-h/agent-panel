# 设置 → MCP 里旧版 Blender 插件的工具列了两遍

- 状态：已修复（`server/mcp-catalog/catalog.test.ts`「旧插件」一条通过）
- 症状：Blender 3.1.0-alpha.3（插件接口 8 以前）的页面上出现两张一样的服务卡（blender、blender-model），下面各列一遍同样的 8 个工具，左栏计数 16
- 入口：`server/mcp-catalog/plugins.ts` 的 `legacyServers`
- 根因类型：清单字段的含义没对上（`toolNames` 不分服务，却按每个服务各列一遍）
- 模块：`plugins`（`server/mcp-catalog/`）
- 关键词：MCP、能力目录、旧插件、重复、两遍、Blender、blender-model、toolNames

## 现象

插件没有 `catalog()` 时，设置 →「MCP」只能按清单列出服务名和工具名。Blender 清单里有两个服务，页面上就成了两张卡、两份一模一样的工具。

## 根因

`legacyServers` 对 `mcpServers` 里的每个服务都塞了全部 `toolNames`。清单只给了「工具名 → 显示名」，并不知道哪个工具属于哪个服务。

## 修复

旧插件的服务合成一块（名字用逗号连起来），工具只列一次。升到插件接口 8 的插件由 `catalog()` 按服务给出各自的工具，不走这条路。
