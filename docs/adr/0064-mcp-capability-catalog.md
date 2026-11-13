# ADR 0064：MCP 工具的使用时机由工具自己声明，设置页和 Agent 看到同一份

状态：已接受（2026-11-13，设置 →「MCP」能力菜单） · 2026-11-13

## 背景

- 面板交给 Agent 的 MCP 工具有三处来源：面板自己的 `agent-panel` 服务（编排、提问、操控软件，六十多个）、开着的插件各自的 MCP 服务、插件登记到面板动作表里的动作。用户看不到某个对话到底拿到了哪些、每个是干什么的。
- 工具说明只有一段 `description`，写法各异：有的写了什么时候用，有的只写参数。模型在相近的工具之间常选错，例如 `ue_python` 和 `ue_set`、`table.edit` 和 `table.propose`。
- 插件的 `tools(run)` 返回 `undefined` 就是不挂。用户问「为什么这个对话没有 UE 工具」时，只能去读插件代码。

## 决策

1. **每个工具声明 `ToolGuide`**：`title`、`summary`（作用，一句话）、`useWhen`（什么时候用）、`avoidWhen`（什么时候别用、改用哪个）、`group`。schema 在 `shared/mcp-catalog/types.ts`。
   - 面板工具的声明集中在 `shared/mcp-catalog/panel-guides.ts`，按工具名对应，`Record<PanelToolName, …>` 保证不会漏。
   - 插件工具写在 `McpTool.guide` 上；面板动作写在 `PluginAction.useWhen` / `avoidWhen` 上。这几项是插件接口 8 的新增。
2. **人和 Agent 看同一份**：交给 CLI 的说明由 `describeTool(description, guide)`（`shared/mcp-catalog/describe.ts`）生成。它保留原文，只在后面补「什么时候用：」「不要用：」两行，原文里已经写过的就不补。
   - 面板的 `tools/list`、插件 MCP 的 `tools/list`、UI 设计插件自己的 `tools/list` 都走它，设置页也显示这份。
   - UI 设计插件经开放模块 `shared/mcp-catalog/describe.ts` 使用它，不另写一份。
   - 原有的 description 不改写，只追加，免得一次性改变模型已经适应的措辞。
3. **列出能力不开对话**：`ServerPlugin.catalog()` 返回服务、什么时候挂、用法说明和工具定义（不带 `call`）。旧插件没有 `catalog()` 时，按清单的 `mcpServers` / `toolNames` 列出名字，并标明是旧插件。
4. **「检查 Agent 能拿到什么」照真实规则现算**：用户选项目、角色、CLI 和对话类型后，服务端这样算：
   - 面板工具：用各对话类型的代表身份（`server/mcp-catalog/audiences.ts`）走 `PANEL_TOOLS` 的 `when`。
   - 插件：传一个 `dryRun: true` 的 `PluginRun` 给 `tools(run)`。插件不挂时可以返回 `{ skip: 原因 }`，设置页照原文显示。出错和超时也照原文显示，不悄悄当成「没有」。
   - 每个对话类型的代表身份能拿到的工具，必须是真实身份的超集，`server/orch-mcp.test.ts` 会核对。
5. **只读页面**：设置 →「MCP」只展示、不提供开关。要控制工具给谁，仍然在角色、插件参数和 CLI 配置里改。你自己装的 MCP 由 CLI 自己连接，只给出到「MCP 工具」页的入口。

## 放弃的做法

- **在设置页单独维护一份说明文字**：会和交给 Agent 的说明漂移，用户看到的不是 Agent 实际拿到的。
- **自检时真的开一轮对话或起 CLI**：慢，还会碰到外部程序（UE、Blender Gateway）。改成预演模式，插件在 `dryRun` 时不起进程、不改数据；Blender 在这时只列已经加载的工具定义。
- **给插件工具补 `effect: 'edit'` 来显示「会改东西」**：`effect` 会进工具前守卫，只读角色会因此被挡住。徽标用独立的 `confirms`、`irreversible`，不影响执行。

## 后果

- 新增面板工具时，不写声明类型检查就不过；`more_tools` 的简介也取 `summary`。
- 插件升到接口 8 才有说明和不挂的原因。UE 0.10.0、Blender 3.1.0-alpha.4、UI 设计 1.2.0、视频截帧 1.1.0 的清单写了 `api: 8`，在旧面板上装不了。表格 1.2.1 只加了可选字段，仍是接口 7。
- 上一次真实对话拿到几个工具，只记在内存里（`server/mcp-catalog/last-run.ts`），面板重启后为空。
