# ADR 0083：工具网关（第一期只观察）

状态：已接受 · 2026-11-26

- 关系：接着 [0081 能力路由](./0081-capability-router.md)（网关推算「能改到哪」用的就是能力表，查找的几条路取路由现成的状态）；和 [0072 文件索引](./0072-project-file-index.md) 的关系是查找的兜底路要项目开着索引，网关本身不碰索引。
- 钩子派发照 [0049](./0049-hooks-continue-in-turn.md)，网关只套在 `onHook` 外面。

## 背景

用户 2026-11-25 定：同一件事有几条路时由面板选（0081）。查找已经有了面板的 `find`，但 Agent 照样直接 `rg` / `grep`、调 CLI 自带的 Grep，跑 `luac -p` 而不用自建工具，自己起 UBT 编译。要把这些调用改走面板，先得知道它们有多少、长什么样、改了会不会误伤。所以先做一层**所有工具调用都过面板**的网关，第一期只记录、只推算，不改任何一次调用；看过数据再开改道。

## 事实核对

| 位置                                                                          | 现状                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `server/hooks/dispatch.ts` 的 `hookOptions`                                   | 按身份装内置守卫、推送、用户钩子；`hookTools` 只装需要的类别（shell / edit / read），读文件、MCP、面板工具多数不装 |
| `server/hooks/run.ts` 的 `noteTrigger`                                        | 每个钩子触发都记一条「最近触发」：谁、结果（deny / context）、说明                                                 |
| `shared/hooks/index.ts` 的 `HookFacts`                                        | 钩子拿到的事实：kind、name、input、path(s)、panel、工具后的 result                                                 |
| 内置钩子（guards、knowledge-push、module-push、situational、p4、pace、hints） | 都先判 kind 自己挑要管的；hookTools 改成 `any` 不会让它们误管别的类别                                              |
| `server/capability-router/router.ts` 的 `route()`                             | 返回走过的每一步（steps）和给出结果的路（outs）；路由记录在 `log.ts`                                               |
| `server/panel-tools/find-tool.ts`                                             | find 的结果只有文字，对话里的工具卡片看不出最后走了哪条路                                                          |

## 决策

1. **网关套在钩子回答外面**（`server/tool-gateway/gateway.ts` 的 `openGateway`）。一轮（一次 CLI 调用）开一个；`wrap(onHook)` 里工具前：认调用（`shared/tool-gateway/classify.ts`）→ 交给原来的守卫和钩子 → 按能力表推算（`shared/tool-gateway/decide.ts` + `shared/capability-router/capabilities.ts`）→ 记一条调用记录。工具后按「工具名 + 输入」配对补上用时、失败、工具后推的东西。网关开着时工具前、工具后都装，`hookTools` 加 `any`，所有类别的调用都进来。
2. **第一期只观察**：回给 CLI 的永远是原来那一份回答，网关一个字不改。实际决定只有放行和拒绝（拒绝来自原来的守卫）；`wouldRoute` 写「打开改道后会改到哪」（rewrite / serve / redirect + 去哪 + 按什么认的）。设置里模式只有关闭 / 观察（默认观察），`enforce` 登记了但标「第二期开放」，接口拒绝设成它。
3. **网关出错一律放行**：认不出、推算出错、项目事实读不到，都照样返回原回答，调用记录里记一条带 `error` 的，日志里记警告。记录是给人看的，不能因为它让 Agent 停下。
4. **多段命令不改道**：管道、`&&`、`;` 连起来的只归类不推算改道（改写会改变语义）。CLI 自带的搜索工具名写进 CLI 定义（`hooks.searchTools`），不按 CLI 名字写分支。
5. **调用记录**：内存里每个项目最近 500 条，磁盘追加写 `logs/tool-calls/<日期>.jsonl`（留 14 天，只追加不改写）；新记录和补上结果的都经页面推送（`tool-call`），页面不轮询。耗时分开记：`ms` 是网关自己（认调用 + 推算 + 记录），`hookMs` 是整个工具前回答（守卫、钩子、网关合计），`durMs` 是工具前到工具后。
6. **工具卡片显示实际走的路**：经面板路由的调用（现在是 find）把走过的路挂在 `ToolUse.route` 上（`shared/capability-router/tool-route.ts`），卡片耗时旁画小标（`web/src/components/ui/route-badge.tsx`），点开看每一步。观察模式下网关推算的「会改到哪」**不**上卡片，只在调用记录里看；以后网关真的改写 / 代答时写同一个字段并填 `from`。

候选方案：

- 每个守卫自己记：记录口径散在十几个钩子里，读文件、MCP 根本不过钩子，看不全。不选。
- 在解析 CLI 输出那一层记（parsers）：拿得到所有工具，但那时调用已经执行了，以后改道接不进去，也拿不到守卫的拒绝。不选。
- 第一期就改道：没有数据不知道误伤面多大（Windows 命令、管道、外壳包装），用户也看不到依据。不选。

## 操作清单 / 契约

| 接口                             | 说明                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /tool-gateway/calls`        | 调用记录：按项目、对话、决定、能力、搜索词筛，分页（`limit` ≤ 200）                                           |
| `GET /tool-gateway/stats`        | 最近 N 条（≤ 500，默认 200）：各决定数、能改道条数和比例、本可以并行、推的技能、网关耗时中位 / P95 / 最慢一次 |
| `GET/PUT /tool-gateway/settings` | 模式 off / observe                                                                                            |
| `GET /tool-gateway/capabilities` | 能力表：接管哪些调用、各条路现在的状态、最近归它几次能改几次                                                  |

契约在 `shared/api-contract/tool-gateway.ts`，演示后端调同一份统计和筛选（`shared/tool-gateway/stats.ts`、`views.ts`）。CLI 定义加 `features.parallelTools`（yes / no / unknown），共用身份提示里「互不依赖的调用一起发」一句按它加。

## 与现有实现的关系

- 守卫、推送、用户钩子不变，网关只包在外面；`noteTrigger` 顺手把结果交给网关的收集器（`server/tool-gateway/sink.ts`，AsyncLocalStorage，并行的调用各收各的）。
- 能力表 `CAPABILITIES` 和 0081 的能力路由共用 `CapabilityId`；查找的几条路的状态取路由现成的（`server/tool-gateway/routes-state.ts`）。
- 技能推送记账走 `server/skills/push-ledger.ts`（另一个开发在做的「技能」页签用同一份）。

## 运行时

`dispatch.ts` 里 `gatewayForCall` 按 CLI 定义、自建工具表、已知 MCP 服务开网关；关着时返回 undefined，派发和以前完全一样。设置存在钩子设置里（`HooksData.gateway`）。读文件、MCP 这些以前不装钩子的类别现在每次多一次钩子往返：Claude Code 走 HTTP 钩子约 1ms，命令类钩子起 curl 约 8ms，没有 curl 起 node 转发脚本约 55ms（`scripts/bench-tool-gateway.mjs` 量的，本机）。网关自己每次约 0.02ms。

## 分期

1. 第一期（本条）：观察模式、调用记录和统计、设置「Agent 工具」两个页签、卡片的路由小标。出口条件：用户看过一段时间的调用记录，误伤面清楚。
2. 第二期：`enforce` 开放，搜索命令改走 find（结果是索引 + 原命令的并集，不比原命令少），CLI 自带 Grep / Glob 代答。
3. 第三、四期：校验（自建工具）、改动生效（编译申请、Live Coding、Lua 热重载）、读资源。

## 风险与代价

- 每次调用多一次钩子往返：HTTP 钩子可以忽略；只能用命令类钩子又没有 curl 的机器上每次多几十毫秒。网关模式关闭就回到以前。
- 调用记录里有命令原文和输入（截到 2000 字）：只存在本机数据目录，和钩子记录一样不外传。
- 「本可以并行」按工具前到达面板的先后和上一个工具后判断，CLI 报不出工具后的一律不算，宁可少报。

## 开放问题

- 搜索命令的识别和 `shared/knowledge/match/normalize.ts` 的 `searchText` 还是两份，倾向第二期合到 `shared/tool-gateway/commands.ts`；合之前两边各管各的。
- Codex、Command Code、Pi 能不能一条回复发几个调用还没实测（`parallelTools: unknown`），提示照常加；实测后改定义。
