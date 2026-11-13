---
paths: shared/plugins/host-modules.json, server/image.ts, server/exec/invoke.ts, shared/assist.ts, shared/cli-spec.ts, server/mcp-catalog/**
---

# 插件开放模块的导出

## host-modules.json 里列的模块，导出就是插件的接口，不当「转手导出」删

- 规则：清理「拆走后照旧导出」的转出时，先查 `shared/plugins/host-modules.json`：列在里面的模块被插件仓库（fixcode-h/agent-plugins）直接 import，它的导出形状就是插件接口，转出也要留着，并在那几行写明是给插件的。
- 起因：65f4874 删了 `server/image.ts` 转出的 `crop`、`resize`、`Img` 等，UI 设计插件编不过，PR #284 的 CI `plugins` 检查红了。
- 防线：CI 的 `plugins` 检查（用当前面板代码跑插件仓库的类型检查和单测）。

## 清单字段不分组时，别按另一个列表逐项展开

- 规则：插件清单里的 `toolNames`（工具名 → 显示名）不分 MCP 服务；按 `mcpServers` 逐个展示时，不能每个服务都塞一遍全部工具。不知道归属就合成一块列一次。
- 起因：设置 → MCP 的旧插件兜底（`server/mcp-catalog/plugins.ts` 的 `legacyServers`）把 Blender 的 8 个工具列了两遍（提交见 docs/modules/plugins/bugs/mcp-legacy-tools-twice.md）。
- 防线：`server/mcp-catalog/catalog.test.ts`「旧插件」一条。
