# ADR 0085：外部 MCP 服务由面板代理，开跑时按能力表收口工具表

状态：已接受 · 2026-11-26

- 关系：接着 [0084 工具网关](./0084-tool-gateway.md)（代理调用照样进调用记录）和 [0081 能力路由](./0081-capability-router.md)（被接管的外部工具就是 find 的那几条路）；工具个数和定义长度守 [0067 MCP 工具规范](./0067-mcp-tool-rules.md)；收起来的工具沿用 [0028](./0028-panel-tools-on-demand-and-input-sources.md) 以来的 `more_tools`。
- 设计稿：「技能与自建工具按情境加载」6.3、5.3、10、11 节。用户 2026-11-26 定：外部 MCP 服务全部改由面板代理，CLI 只挂面板一个服务；被能力接管的外部查找工具不再给 Agent，查找只用 find；其余外部工具照样给。

## 背景

外部 MCP 服务（项目 `.mcp.json`、CLI 全局配置里的 IDEA、UEToVS……）以前直接挂在 CLI 上：面板只在钩子里看得到调用，补不了 `projectPath`、等不了索引，同一件事（找 Lua 函数）Agent 手里有 `find`、`lua_code`、`search_symbols` 好几个入口，弱模型常挑错。能力路由（0081）已经由面板自己当客户端调这些服务，现在把「给 Agent 什么」也收到面板。

## 事实核对

| 位置                                        | 现状                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `server/exec/invoke.ts`                     | 面板服务 + 插件服务按 `mcp.args` 交给 CLI；面板库「按项目」条目按 `mcpStore.inject` 每轮带；其余外部服务由 CLI 自己读配置 |
| `shared/panel-tools.ts` 的 `splitDeferred`  | 不常用的面板工具收进 `more_tools`，只写 name 看用法、带 arguments 调用                                                    |
| `server/ask-mcp.ts`                         | 面板工具全部标 `anthropic/alwaysLoad`：Claude Code 的工具搜索会把 MCP 工具藏起来，连 `end_turn` 都得先搜                  |
| `server/panel-tools/registry.test.ts`       | 面板工具个数（父对话 43、子对话 31……）和单个定义 3000 字的上限                                                            |
| `server/capability-router/find/external.ts` | JetBrains 的 projectPath、仅路由器（execute_tool）、等索引都在这里，只给查找路用                                          |
| `server/mcp-client/pool.ts`                 | 按「服务 + 目录」复用会话，空闲 5 分钟关                                                                                  |
| Claude Code `--strict-mcp-config`           | 只用 `--mcp-config` 给的服务，不读项目和全局配置；`--mcp-config` 可以给多次                                               |

## 决策

1. **ExposurePolicy**（`shared/mcp-proxy/exposure.ts`，纯函数，演示后端用同一份）：开跑时对这一轮 CLI 会挂的每个外部服务给一个结论——`proxy`（经面板代理）或 `direct`（照旧直接挂），并写原因（`off` / `cli` / `no-panel` / `unreachable` / `protocol` / `failed`）。代理的服务里，被能力接管的工具不给 Agent；**这一轮没给接管后的入口工具（find）时不接管**，照样给。直接挂的服务面板管不了单个工具，全给。
2. **接管登记是一张表**（`ExternalClaim`：能力、改用的面板工具、接管哪些外部工具、谁登记的）：自带一行 find 接管 `EXTERNAL_FIND_TOOLS`；插件登记的查找路（`ExternalFindSource.tool`）自动算 find 接管的。以后 apply 接管 Live Coding 那几个工具只加一行。
3. **McpProxy**（`server/mcp-proxy/`）：一次 CLI 调用前收这一轮 CLI 会挂的外部服务（全局配置里装给它的、本目录的 local scope、CLI 自己读的项目文件 `mcpProbe.files`、面板库按项目打开的条目），经连接池问工具表（最多等 5 秒）。有服务能代理时 CLI 参数加 `takeover.mcpOnlyPanel`（Claude Code 是 `--strict-mcp-config`），代理不了的按 `mcpStore.inject` 逐个带上——Agent 不少工具。
4. **外部工具收在 `more_tools` 后面**，名字写「服务/工具」（`idea/lua_debug_session`）：`more_tools` 的说明里按服务列工具名（超出 1200 字的服务只写个数，`name` 写「服务/」列出），只写 name 看外部工具原样的说明和参数表，带 arguments 调用。面板服务的工具个数和单个定义长度都不变，`registry.test.ts` 的上限不用改。
5. **代理调用补的规矩沿用能力路由的那一份**：projectPath、仅路由器、等索引从 `external.ts` 挪到 `server/mcp-client/call.ts` 共用。工具自己报的错原样交回；等索引到 60 秒还没好、连不上、断了时写清这次没执行和下一步。
6. **进调用记录、上工具卡片**：网关认调用时把 `more_tools` 的代理调用认成 `kind: mcp`（`CallRecord.mcp = { server, tool, proxied: true }`），能力表照外部工具认（`lua_code` 归 find）；卡片上挂 `ToolUse.route`（`capability: 'mcp'`，`via: mcp`），界面按「服务 · 工具」显示那一行。
7. **出错退回**：开跑时连不上、协议不支持的服务这一轮直接挂；代理调用中途连不上的记一笔（`state.ts`，10 分钟），之后开跑时退回直接挂，过了再试。一个服务都代理不了时整轮按原来的做法（不加 `--strict-mcp-config`）。算代理的任何一步出错也按原来的做法，只记日志。
8. **用户能关**：设置「Agent 工具 → 工具路由 → 给 Agent 的工具」的开关（默认开，存在钩子设置的 `gateway.mcpProxy`）。同一处列出每个 CLI 最近一次开跑时每个服务怎么给、为什么、哪些工具没给、改用哪个。

候选方案（外部工具怎么出现在面板的工具表里）：

- **原样转进面板的工具表**（`mcp__panel__idea__lua_debug_session` 这类，每个一项）：Agent 用法和以前最像，但一个 JetBrains 服务就三十来个工具，面板服务的个数、定义总长随外部服务一起涨，ADR 0067 的上限形同虚设，每轮都整份带着。不选。
- **靠 Claude Code 的工具搜索延迟加载**（不标 alwaysLoad，让 ToolSearch 按需取定义）：只有 Claude Code 有，Codex、Pi 走不了；而且面板自己的工具必须 alwaysLoad，同一个服务里一半延迟一半不延迟要分两个服务挂，又回到 CLI 挂多个服务。不选。
- **新加一个 `mcp_call` 工具**：和 `more_tools` 做的是同一件事（列名字、看用法、按名字调），按 ADR 0067 准入第二问应并进已有工具。不选。
- **只藏被接管的那几个，其余照旧直接挂**（设计稿第 11 节备选）：用户没选；这些调用面板只看得到、补不了参数。

## 操作清单 / 契约

| 接口                      | 说明                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| `GET /mcp-proxy/exposure` | 代理开关、各 CLI 能不能只挂面板、接管登记、每个 CLI 最近一次开跑的结果 |
| `PUT /mcp-proxy/settings` | `{ enabled }`                                                          |

契约在 `shared/api-contract/mcp-proxy.ts`，视图 `shared/mcp-proxy/view.ts`，演示后端 `web/src/lib/demo/demo-mcp-proxy.ts` 调同一份 ExposurePolicy。CLI 定义的 `takeover`（`shared/tool-gateway/takeover-spec.ts`，和工具网关第二期的改写、代答同一个对象）加 `mcpOnlyPanel` 和启动参数 `mcpOnlyArgs`。

## 风险与代价

- **Agent 调外部工具多一步**：要先看用法再调（以前定义就在工具表里）。外部工具本来多是不常用的调试、诊断工具，常用的查找已经由 find 接管；换来的是每轮少带几十个工具定义。
- **`--strict-mcp-config` 也关掉 CLI 自己另外挂的服务**（Claude Code 插件市场的服务、托管的 managed-mcp、claude.ai 连接器）：面板只收得到上面列的四处配置。用户发现少了服务时可以在设置里关掉代理。
- **开跑多一次工具表询问**：连接池里有现成会话时几毫秒；冷启动的 stdio 服务最多等 5 秒，等不到这一轮直接挂。
- **外部工具的返回不截短**：和直接挂时一样原样交回，长度由外部服务自己守。

## 开放问题

- Codex、Command Code、Pi 有没有「只用面板给的 MCP」的参数还没实测：没写 `takeover.mcpOnlyPanel` 的照旧直接挂，设置页写明原因。
- 插件的服务（`ue_*`，面板自己起的）现在照旧按 `mcp.args` 直接挂，不经代理：调用本来就在面板里，暂不收进 `more_tools`，免得常用的 `ue_*` 多一步。倾向等 UE 插件按能力拆完再定。
- 代理调用出错后的「退回直接挂」从下一轮起生效：这一轮剩下的调用只能等那个服务恢复。
