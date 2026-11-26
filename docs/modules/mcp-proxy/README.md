# mcp-proxy：外部 MCP 服务代理

- 状态：documented
- 职责：开跑时决定给 Agent 哪些工具（ExposurePolicy），外部 MCP 服务经面板代理（CLI 只挂面板一个服务），被能力接管的外部查找工具不给 Agent，代理不了的退回直接挂
- 源码：`server/mcp-proxy/`、`shared/mcp-proxy/`、`server/mcp-client/call.ts`、`shared/cli/takeover.ts`、`shared/api-contract/mcp-proxy.ts`、`web/src/components/settings/agent-tools/ExposureGroup.tsx`、`web/src/lib/demo/demo-mcp-proxy.ts`
- 入口：`server/mcp-proxy/launch.ts`
- 关键词：McpProxy、ExposurePolicy、外部服务代理、只挂面板、mcpOnlyPanel、strict-mcp-config、more_tools、服务/工具、被接管、给 Agent 的工具、直接挂、退回
- 更新：2026-11-26

为什么这么定见 [ADR 0085](../../adr/0085-mcp-proxy-and-exposure.md)。这里只写现在怎么工作、怎么接。

## 一轮怎么走

1. `server/exec/invoke.ts` 在挂面板服务之前调 `proxyForRun(def, …)`（`launch.ts`），只在这一轮挂编排工具（`o.orch`）时调：
   - `discover.ts` 收这一轮 CLI 会挂的外部服务：全局配置里装给它的（`mcpOverview`，`activation` 是 global 且 `clis` 有它）、全局配置里只对这个目录生效的（`agentProjectServers`）、CLI 自己读的项目文件（CLI 定义 `mcpProbe.files`）、面板库按项目打开的条目（`o.projectMcp`）。同名后面的为准；面板和插件的服务不算；
   - 能代理（设置开着、CLI 定义有 `takeover.mcpOnlyPanel` 和 `mcpStore.inject`、有面板服务）时经 `listMcpTools`（`server/mcp-client/pool.ts`）问工具表，最多等 `LIST_WAIT_MS`（5 秒）；HTTP 4xx、回的不是 JSON 算 `protocol`，其余错和超时算 `unreachable`，最近代理出过错的算 `failed`（`state.ts`，10 分钟）；
   - `exposurePlan`（`shared/mcp-proxy/exposure.ts`）出结论，`noteExposure` 记下给设置页。
2. 有服务经代理时：面板服务带上 `ProxySession`（`session.ts`，`openAskBridge({ proxy })`；单独一个文件，面板服务不带上开跑才用的模块）；CLI 参数里只在面板服务真的接上时（`run.build !== build`）加 `takeover.mcpOnlyPanel`，再把 `direct` 的服务按 `mcpInjectArgs` 带上。没有服务经代理、或面板服务没接上时，完全按原来的做法（`projectMcpArgs`）。
3. 面板服务上（`server/ask-mcp.ts`）：`splitDeferred(all, proxiedTools(session))` 把给 Agent 的外部工具写进 `more_tools` 的说明（`shared/mcp-proxy/names.ts` 的 `externalToolsText`，1200 字预算）；`more_tools` 的调用先问 `serveProxied`（`serve.ts`），不是外部工具的交回原来的 `moreTools`。

## more_tools 里的外部工具

| 写法                             | 回什么                                                       |
| -------------------------------- | ------------------------------------------------------------ |
| `name: "idea/"`                  | 这个服务给 Agent 的工具和第一句说明；被接管的写「改用 find」 |
| `name: "idea/lua_debug_session"` | 外部工具自己的说明和参数 JSON Schema                         |
| 再带 `arguments`                 | 代调：`callExternalTool`（`server/mcp-client/call.ts`）      |
| 被接管的（`idea/lua_code`）      | 不执行，`isError`，写改用哪个面板工具                        |

`callExternalTool` 和能力路由的查找路（`server/capability-router/find/external.ts`）共用：JetBrains 的 projectPath（报「定不了项目」时按工作目录挑一个记住重调）、仅路由器（经 `execute_tool`）、`indexing` 时等到 60 秒。代调连不上、断了：回「这次没有执行」和下一步，`noteProxyFailure` 记一笔。

## 记录和卡片

- 调用记录：网关（`server/tool-gateway/gateway.ts`）认调用时先 `proxiedCallOf`，`more_tools` 的代理调用记成 `kind: mcp`、`CallRecord.mcp = { server, tool, proxied: true }`，能力表按外部工具认。CLI 直接调的外部工具也记 `mcp`（不带 `proxied`）。
- 卡片：`serve.ts` 调 `noteRoute(proxyRoute(...), "服务/工具")`，`server/capability-router/tag-route.ts` 按 `capability: 'mcp'` 认 `· more_tools` 那一行挂上；界面 `web/src/lib/tasks.ts` 的 `panelTool` 用 `unwrapProxied` 按「服务 · 工具」显示，小标写 MCP。

## 接管登记

`externalClaims(findSources)`：自带 `BUILTIN_CLAIMS`（find 接管 `EXTERNAL_FIND_TOOLS`），加上项目里打开的插件登记的查找路用到的工具（`pluginFindSources`，`by` 是插件 id）。加新的接管：在 `BUILTIN_CLAIMS` 加一行，或插件登记查找路。只有这一轮给了 `use`（例如 find）时才接管。

## 设置页

「Agent 工具 → 工具路由」最下面的「给 Agent 的工具」（`ExposureGroup.tsx`）：代理开关（`PUT /mcp-proxy/settings`，存在 `HooksData.gateway.mcpProxy`）、每个 CLI 最近一次开跑时每个服务是代理还是直接挂、原因（`EXPOSURE_WHY_TEXT`）、没给的工具。数据是开跑时记的（缓存目录 `mcp-exposure.json`），打开页面不去连外部服务。界面检查分片 `scripts/ui/05d-mcp-proxy.mjs`。

## 注意

- 加「只挂面板」的 CLI：在 CLI 定义的 `takeover.mcpOnlyPanel` 写参数，并确认 `mcpStore.inject` 能把退回的服务带上；两样缺一样就照旧直接挂。
- 插件的服务（`o.mcp`）不经代理，照旧按 `mcp.args` 挂。
- 测试：`shared/mcp-proxy/exposure.test.ts`（取舍、more_tools 长度）、`server/mcp-proxy/proxy.test.ts`（假 stdio 服务：开跑、代调、出错退回、开关、网关记录）。
