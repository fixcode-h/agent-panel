# tool-gateway：工具网关

- 状态：documented
- 职责：所有 Agent 工具调用都过面板：认调用、按能力表推算能改到哪，改道模式下查找真的改走 find（结果是面板和原命令的并集）、记调用记录和统计；改完对得上的文件面板自己跑校验工具、只推报错；工具卡片上显示经面板路由的调用实际走的路
- 源码：`server/tool-gateway/`、`shared/tool-gateway/`、`shared/capability-router/capabilities.ts`、`shared/capability-router/tool-route.ts`、`shared/api-contract/tool-gateway.ts`、`web/src/components/settings/agent-tools/`、`web/src/components/ui/route-badge.tsx`
- 入口：`server/tool-gateway/gateway.ts`
- 关键词：工具网关、调用记录、CallLog、wouldRoute、观察模式、改道、查找接管、takeover、updatedInput、代答、并集、能力表、本可以并行、网关耗时、路由小标、ToolUse.route、parallelTools、searchTools、改完自动校验、verify、apply、replaces、request_build
- 更新：2026-11-26

为什么这么定见 [ADR 0084](../../adr/0084-tool-gateway.md)；校验和改动生效见 [ADR 0086](../../adr/0086-verify-and-apply.md)。这里只写现在怎么工作、怎么接。

## 一次调用怎么走

1. `server/hooks/dispatch.ts` 的 `hookOptions` 调 `gatewayForCall`（`for-call.ts`）：模式不是 off 就开一个网关，把 `onHook` 包起来、工具前 / 工具后都装、`hookTools` 加 `any`。
2. 工具前（`gateway.ts`）：
   - `classifyCall`（`shared/tool-gateway/classify.ts`）认成 read / edit / shell / mcp / panel / other，shell 再按 `parseCommand`（`commands.ts`）认程序、类别（search / lint / test / build / vcs / read / long）和段数；CLI 自带搜索工具名来自 CLI 定义 `hooks.searchTools`；
   - 原来的守卫、推送、用户钩子照旧跑，跑的时候 `noteTrigger` 把谁拒绝、补了哪些说明交给收集器（`sink.ts`）；
   - `decide`（`decide.ts`）按能力表 `CAPABILITIES` 的 `claims(call)` 推算：实际决定 pass / deny，`wouldRoute` 写打开改道后去哪；多段命令、被拒绝的不推算；
   - 改道模式（`enforce`）且没被拒绝时调 `enforceTakeover`（`takeover/index.ts`，见下一节），按它换掉回答、并进记录；
   - 记一条 `CallRecord`（`shared/tool-gateway/types.ts`），回原来的（或接管后的）回答。
3. 工具后：按工具名 + 输入配对（改写过的按改写后的输入），补 `durMs`、`failed`、工具后推的东西，再落盘、推送一次。
4. 网关里任何一步出错：原回答照样返回，记一条带 `error` 的记录。

## 查找接管（改道模式）

- 认：`shared/tool-gateway/search-args.ts` 的 `parseSearchCommand`（单段 rg / grep -r / git grep / Select-String / findstr，参数按表一个个认，关键词得是原文）和 `parseGrepTool`（CLI 定义 `takeover.tools` 里登记成 grep 的自带工具，换成等价的 rg）。find -name / fd / Glob 认出来但放行。
- 定：`shared/tool-gateway/takeover.ts` 的 `planTakeover` 按 CLI 定义 `takeover`（`takeover-spec.ts`：`rewrite` / `serve` / `hideBuiltin` / `mcpOnlyPanel` / `tools`）和钩子有没有 `tool.before.rewrite` 模板选改写 / 代答 / 放行；放行原因在 `PASS_WHY`。
- 跑（`server/tool-gateway/takeover/`）：`index.ts` 查 find（4 秒时限）→ `panelExtras` 取范围内的声明和原命令按原文搜不到的；改写时 `script.ts` 把那段写成 `<临时目录>/agent-panel-takeover/<id>.mjs`，命令换成 `node "<脚本>"; <原命令>`，回答带 `rewrite`（`server/hooks/bridge.ts` 按模板翻成 Claude Code 的 `updatedInput`）；代答时 `original.ts` 照原样跑原命令，回答是 `deny` + 「结果（面板）」开头的全文。
- 任何一步出错、超时、拿不准都放行，记 `takeoverWhy`（出错另记 `error`）。
- 记录：`decision` 是真实决定（rewrite / serve），`rewritten` 改写后的输入，`route` 走过的路（`from` 是原调用）；`ms` 不含查找和跑原命令的时间，那部分在 `route.ms`。被接管的那张卡片也挂路由小标（`tag-route.ts` 对带 `from` 的按输入原文认行）。
- 演示：`web/src/lib/demo/demo-takeover.ts` 用同一份 `planTakeover` / `panelExtras` / `rewriteCommand` 算。
- 测试：`shared/tool-gateway/takeover.test.ts`（命令解析、并集、选改写还是代答）、`server/tool-gateway/takeover/takeover.test.ts`（接进网关、钩子输出、放行和出错）。

## find 收数组

`find` 的 `query` 可以给数组（最多 10 个，`server/panel-tools/find-multi.ts`）：同时查、按词分组（`## 词`），几组平分 4000 字。共用身份提示（`server/orch-hint.ts`）有 find 时说「查几个名字时 query 给数组」。

## 调用记录（call-log.ts）

- 内存：每个项目最近 500 条；`recentCalls(projectId?)` 新的在前。
- 磁盘：`<数据目录>/logs/tool-calls/<YYYY-MM-DD>.jsonl`，一行 `{"t":"call",…}` 或 `{"t":"done","id",…}`，只追加，留 14 天。写不进去后本次运行不再试，只记日志。
- 推送：`signalPages({ type: 'tool-call', call })`；页面用 `web/src/lib/live/tool-calls.ts` 的 `useToolCallFeed`，演示版发 `agent-panel:tool-call` 事件。

字段要点：`ms` 网关自己（认调用 + 推算 + 记录），`hookMs` 整个工具前回答，`durMs` 工具前到工具后；`pushes` 钩子补的说明（id + 字数），`skills` 推的技能（`server/skills/push-ledger.ts`）；`serial` 本可以并行（判定见 `stats.ts` 的 `isSerial`）。

## 能力表

`shared/capability-router/capabilities.ts`：一个能力 = id、显示名、说明、接管哪些调用（`takes`）、第几期改道、`claims(call, ctx)`。现在有 find（搜索命令 → rewrite 到 find，Grep / Glob 和外部查找 MCP → serve）、verify（和自建工具同一个程序、或工具 `role.replaces` 登记的程序 → `custom_tool:<id>`，只读且参数填得上 serve、否则 redirect）、read-asset（.uasset / .umap → ue_asset）、apply（UE 编译 → redirect 到 request_build，没挂时到 `role=build` 的工具）。verify、apply 的判定在 `shared/capability-router/verify-apply.ts`。加能力：在表里加一项，不改网关。设置页上每条路的状态在 `routes-state.ts`。

## 改完自动校验和 verify / apply 的改道（ADR 0086）

- `gateway.ts` 在原来的回答和推算之后调 `server/tool-gateway/verify/index.ts` 的 `before`：改文件时按校验工具的 `role.paths` 记进这一批（`shared/tool-gateway/verify/batch.ts`）；下一个不是改文件的调用前整批取走、每个工具跑一次（`verify/run.ts`，走 `server/custom-tools/run.ts` 的 prepare + execute，整次限时 45 秒），报错写成补充说明（`shared/tool-gateway/verify/text.ts` 的 `verifyNote`），通过时为空。每次跑记一行 `CallRecord.verify`（`verify/record.ts`）。
- 收尾前：`dispatch.ts` 把收尾前判断交给 `gw.wrapEnd`，还有没查的改动先跑，有报错拦下收尾。
- 改道模式：`shared/tool-gateway/verify/plan.ts` 的 `takeoverPlan` 定 serve（改用自建工具跑，拒绝说明开头「结果（面板）」）还是 redirect（说明改用哪个工具）；只管 verify、apply 两个能力，find 的改写 / 代答是改道模式的通用部分，另做。
- 演示：`web/src/lib/demo/demo-tool-gateway.ts` 用同一份批次和记录逻辑，检查结果写死。

## 工具卡片的路由小标

- 数据：`ToolUse.route`（`shared/capability-router/tool-route.ts`）：`capability`、`served`（给出结果的路，`{source, label, via: mcp | panel}`）、`steps`（每条路的结果、原因、用时）、`ms`、`from`（网关改写时原来的调用，第二期）。是这次调用的事实记录，跟着消息存盘。
- 写入：`find` 工具执行完调 `o.noteRoute(route, 查询词)`（`shared/host/tool-route.ts`），`server/exec/real-turn.ts` 接到 `server/capability-router/tag-route.ts`：在最近 3 条回复里按「`· find` 标题 + 输入里有这个查询词」找没挂过的那一行，挂上后推送；没找到等 1.5 秒再认一次。路由结果换成 route 用 `router.ts` 的 `toolRouteOf`，路的显示名和 via 登记在 `RouteSource.label` / `via`。找文件那一半写一条「文件索引」。
- 显示：`RouteBadge`（耗时前面，`RowShell` 的 `tail`）+ `RouteSteps`（点开最上面）。设置 → 组件微调「路由小标」能关（`--c-routeBadge-show`），示例在 `RouteBadgeSpecimen.tsx`。

## 设置「Agent 工具」

`web/src/components/settings/agent-tools/`：页签登记在 `tabs.tsx`（技能 10、工具路由 20、调用记录 30，新页签加一项）。「调用记录」：搜索 + 项目 / 对话 / 决定 / 能力筛选、五张统计卡、可展开的表格；「工具路由」：模式（关闭 / 观察 / 改道，默认观察）、每个能力接管什么和几条路的状态、各 CLI 支不支持一条回复发几个调用（CLI 定义 `features.parallelTools`）和查找接管能做到哪一步（CLI 定义 `takeover`）。调用记录展开后改写过的显示「改写成」、放行的显示原因、走过的路。

## 耗时

`node scripts/bench-tool-gateway.mjs [条数] [往返次数]`：网关自身（几百条样例调用的 `ms`）和三种钩子往返（HTTP 直连、起 curl、起 node 转发脚本）。

## 注意

- 观察模式下回给 CLI 的回答网关不改；`wouldRoute` 不上工具卡片，只在调用记录里看。改道模式只有查找真的改。
- 测内置钩子装不装哪类工具时先 `setGatewayMode('off')`（`server/hooks/dispatch.test.ts`），网关行为在 `server/tool-gateway/gateway.test.ts` 测。
