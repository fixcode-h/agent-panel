---
paths: shared/engine/prompt-parts.ts, shared/capability-router/find/**, server/capability-router/find/**, server/tool-gateway/takeover/**, shared/mcp-catalog/code-index.ts, shared/mcp-catalog/tool-params.ts, server/hooks/tool-after-hints.ts, server/mcp-catalog/code-index.ts, server/mcp-catalog/external-titles.ts, skills/project/**
---

# 找代码的提示词（MCP 优先）

## 有专门的 MCP 工具就先用，找代码的规则只写一处

- 规则：给 Agent 的提示词不能只教 rg / grep。通用约束「工具选择」写明先用专门的 MCP 工具，只看得到名字的先加载说明；找代码的具体顺序（代码索引 MCP → 带排除的 rg → find）只写在引擎注入的「搜索（这个项目）」一节（`shared/engine/prompt-parts.ts` 的 `searchPart`），角色、Skill 里只引用它，不另写一份 rg 用法。项目接的索引工具由 `server/mcp-catalog/code-index.ts` 认出来，把服务名和工具名写进那一节，项目设置「代码索引工具」可手动指定。
- 起因：2026-11-14 用户报协调器查 GM 无效时先 grep 整个目录（还失败一次），追问后用 UEToVS 的 `search_lua` 一下就定位；C++ 也一样。搜索规则散在 7 处、都只写 rg，UEToVS 的工具名从没出现在提示词里，Claude Code 还把 MCP 工具延迟加载。
- 规则：常见服务的代码查找工具（UEToVS、JetBrains IDE、EmmyLua 的 `lua_code`）按用途登记在 `shared/mcp-catalog/code-tools.ts`，名字正则只给陌生服务兜底；新认一个工具只加一行，不再改正则（2026-11-21：正则认不出 `get_members`、`suggest_include`、`lua_code`，写 C++ 时「看签名」「该 include 哪个头」从没进过提示词）。
- 规则：一个工具兼管两类事（`lua_code` 既找声明又查引用）时，用 `also` 在另一组里再列一行、写那一类的用法；只列在「找」一组时，Agent 找调用点想不到它，会在 search 之后再全文 grep 一遍（2026-11-23 用户截图）。查引用的写法是「有结果就直接用、不再 grep 核对；返回空或已经看到动态调用才 rg 并说明原因」，不做硬拦截；写成「怀疑是动态调用才 rg」时 haiku 实跑 3 次里 2 次照样再 grep 一遍「排除动态调用」。
- 防线：`server/engine-steps.test.ts`「搜索一节先列代码索引 MCP 工具」、`shared/mcp-catalog/code-index.test.ts`。（含按用途分组）

## 别家工具的参数名不手写进提示词，从探测到的参数表生成

- 规则：提示词里要说某个别家 MCP 工具该传什么参数时，从缓存的参数表生成（`shared/mcp-catalog/tool-params.ts`，`ideMcpLines` 的写法），没有参数表就只写「照工具自己的参数表传」，不点名参数。面板自己工具的参数名写进提示词、说明、报错时，用真实的参数名（「`knowledge_lookup` 的 query 写 id」，不写「带 id」）。
- 起因：9545c4d（#398）提示词里手写了「传 `projectPath`」，Agent 照着给 `lua_code` 也传了，被当成未知参数整次失败；A2 的扫描又查出面板自己的提示词里三处写了不存在的参数（`knowledge_lookup` 带 id、`end_turn` 的 blocked、`message_workflow` 的 later）。
- 防线：`server/panel-tools/prompt-params.test.ts`、`shared/mcp-catalog/code-index.test.ts`；运行时由内置提醒「参数传错时补参数表」兜底。

## IDE 的 projectPath 是 IDE 定项目用的，不按工具参数表决定传不传

- 规则：JetBrains IDE 的 MCP 服务器在调任何工具（含插件的 `lua_code`）之前先按调用里的 `projectPath`、请求头 `IJ_MCP_SERVER_PROJECT_PATH`、客户端 roots 定项目，开着多个项目又都没有时直接报 `Unable to determine the target project`，工具跑不到。提示词不再写「只有参数表里列了 projectPath 的工具才传」；报这个错时由工具后提醒（`server/hooks/tool-after-hints.ts` 的 `ideProjectHint`）按工作目录从报错的 `Currently open projects` 挑出路径让 Agent 带上重调，并记下来写进之后每轮的调用规矩，挑不出来就列编号让用户选。
- 起因：#398 之后提示词按参数表只让带 projectPath 的工具传它，`lua_code` 的参数表里没有，Agent 不传，IDE 开着两个项目时整次失败（2026-11-23 用户截图）。
- 防线：`server/hooks/tool-after-hints.test.ts`、`shared/mcp-catalog/ide-project.test.ts`、`shared/mcp-catalog/code-index.test.ts`。

## 能力路由按目标类别选路，不一条路挨个试到底

- 规则：查找按目标类别走（`shared/capability-router/find/categories.ts`）：项目和引擎的 C++ 先问 VS、Lua 先问 IDEA，给了扩展名但不是代码的（json、ini、csv……）只走面板（文件索引 + rg），看不出类型的先走面板、没查到才问外部服务。新能力有几条路时同样先按目标认类别再排路，不把所有外部服务挨个试一遍。
- 起因：2026-11-27 用户截图：Grep `glob=*.json` 被改道成 find 后先调了 `uetovs·find_references` 和 `idea·lua_code` 才走面板，白等一秒多；当时语言推不出（other）就把外部路都试一遍。
- 防线：`shared/capability-router/find/categories.test.ts`、`server/capability-router/find/order.test.ts`。

## 代答结果走钩子拒绝，CLI 会标成出错

- 规则：面板代答（拒绝说明里带结果）的开头统一用 `SERVED_HEAD`；CLI 加的拒绝前缀登记在 CLI 定义 `takeover.denyMark`，工具行按 `servedResult` 去掉前缀、不标红。
- 起因：同一张截图里 OUT 显示成红色「PreToolUse:Grep hook error: 结果（面板）…」。
- 防线：`shared/tool-gateway/served-result.test.ts`。
