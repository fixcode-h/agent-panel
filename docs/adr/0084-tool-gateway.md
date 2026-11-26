# ADR 0084：工具网关（第一期只观察，第二期查找接管）

状态：已接受 · 2026-11-26（第二期同日补充）

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
2. **第一期只观察**：回给 CLI 的永远是原来那一份回答，网关一个字不改。实际决定只有放行和拒绝（拒绝来自原来的守卫）；`wouldRoute` 写「打开改道后会改到哪」（rewrite / serve / redirect + 去哪 + 按什么认的）。设置里模式只有关闭 / 观察（默认观察），`enforce` 登记了但标「第二期开放」，接口拒绝设成它（第二期已开放，见下文）。
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
| `GET/PUT /tool-gateway/settings` | 模式 off / observe / enforce（第二期开放，默认 observe）                                                      |
| `GET /tool-gateway/capabilities` | 能力表：接管哪些调用、各条路现在的状态、最近归它几次能改几次                                                  |

契约在 `shared/api-contract/tool-gateway.ts`，演示后端调同一份统计和筛选（`shared/tool-gateway/stats.ts`、`views.ts`）。CLI 定义加 `features.parallelTools`（yes / no / unknown），共用身份提示里「互不依赖的调用一起发」一句按它加。

## 与现有实现的关系

- 守卫、推送、用户钩子不变，网关只包在外面；`noteTrigger` 顺手把结果交给网关的收集器（`server/tool-gateway/sink.ts`，AsyncLocalStorage，并行的调用各收各的）。
- 能力表 `CAPABILITIES` 和 0081 的能力路由共用 `CapabilityId`；查找的几条路的状态取路由现成的（`server/tool-gateway/routes-state.ts`）。
- 技能推送记账走 `server/skills/push-ledger.ts`（另一个开发在做的「技能」页签用同一份）。

## 运行时

`dispatch.ts` 里 `gatewayForCall` 按 CLI 定义、自建工具表、已知 MCP 服务开网关；关着时返回 undefined，派发和以前完全一样。设置存在钩子设置里（`HooksData.gateway`）。读文件、MCP 这些以前不装钩子的类别现在每次多一次钩子往返：Claude Code 走 HTTP 钩子约 1ms，命令类钩子起 curl 约 8ms，没有 curl 起 node 转发脚本约 55ms（`scripts/bench-tool-gateway.mjs` 量的，本机）。网关自己每次约 0.02ms。

## 分期

1. 第一期：观察模式、调用记录和统计、设置「Agent 工具」两个页签、卡片的路由小标。出口条件：用户看过一段时间的调用记录，误伤面清楚。
2. 第二期（2026-11-26，下一节）：`enforce` 开放，搜索命令和自带的按内容搜改走 find，`find` 收数组。
3. 第三、四期：校验（自建工具）、改动生效（编译申请、Live Coding、Lua 热重载）、读资源。

## 第二期：查找接管

用户 2026-11-26 定：改道的结果必须是「索引 + 原命令」的并集，不比原命令少；拿不准的一律放行；网关出错放行；改道做好但默认仍是观察，用户要先观察一阵，设置里可切到「改道」。

1. **模式**：`GATEWAY_MODE_DEFS` 里 `enforce` 开放（默认还是 `observe`），接口按注册表的 `available` 放行。改道模式下只有查找真的改，校验、改动生效、读资源照旧只推算。
2. **认哪些**（`shared/tool-gateway/search-args.ts`）：单段的 `rg` / `grep -r` / `git grep` / `Select-String` / `findstr`，和 CLI 定义 `takeover.tools` 里登记成 `grep` 形状的自带工具（Claude Code 的 `Grep`）。参数一个个按表认，关键词要是原文（正则元字符、`-e` 给两次、`-v` 反选、`--pre`、变量、命令替换、重定向到文件、读标准输入的都不认）。`find -name`、`fd`、`Glob` 认出来但**不接管**：文件索引不收排除目录，结果只会比原命令少或一样，改道得不到好处。
3. **改写还是代答**按 CLI 定义的 `takeover` 走（`shared/tool-gateway/takeover.ts` 的 `planTakeover`）：`rewrite` 为真且钩子有改写模板时改写，否则 `serve` 为真且面板能照原样跑这条命令时代答，都不行放行。自带工具换不成 shell 命令，只能代答。
4. **并集怎么保证**：
   - 改写：命令换成 `node "<临时目录>/agent-panel-takeover/<id>.mjs"; <原命令>`。脚本只打印面板补的那段（声明、原命令按原文搜不到的），原命令照样由 CLI 在它自己的 shell 里跑，输出一字不少，退出码也是原命令的。为什么不 `echo`：内容里的引号、换行、中文在 bash 和 PowerShell 里转义规则不同，写成脚本后命令里只有一个正斜杠路径，两种外壳一样跑；`node` 本来就是钩子转发脚本的前提。面板没有可补的就不改写（放行）。
   - 代答：面板照原样跑一遍原命令（参数拆好直接起进程，不经 shell；cmdlet 交给 PowerShell 跑原文；走 `server/exec/tracked.ts`），原输出原样放在「结果（面板）」后面，面板补的放前面并去掉原输出里已有的行。跑不出来（找不到程序、`.cmd` 包装、退出码不是 0 / 1、超时 15 秒、输出超过 3 万字、二进制）就放行。
   - 补的那段只放范围内的（命令给的目录、通配、扩展名），最多 3000 字（ADR 0067 的返回预算）。
5. **时限**：查找最多等 4 秒（钩子在每次调用的路上，能力路由自己能等一分钟，这里不能），等不到放行。查找、跑原命令的时间记在 `route.ms`，不算进网关自身耗时 `ms`。
6. **记录和卡片**：`CallRecord` 记真实决定（`rewrite` / `serve`）、改写后的输入（`rewritten`）、走过的路（`route`，和卡片同一份）、放行原因（`takeoverWhy`）。被改道的那张卡片（Bash、Grep）也挂 `ToolUse.route`，`from` 写原调用，小标前面写「面板改走 find ·」；`tag-route.ts` 对带 `from` 的路按输入原文认行（命令行的输入就是命令原文，自带搜索按带引号的关键词）。
7. **CLI 定义 `takeover`**（`shared/tool-gateway/takeover-spec.ts`，字段表见 [cli-config](../cli-config.md)）：Claude Code `rewrite` / `serve` / `hideBuiltin` / `mcpOnlyPanel` 都为真，`tools` 登记 `Grep`（grep）、`Glob`（glob）；改写用 PreToolUse 钩子的 `permissionDecision: allow` + `updatedInput`（模板在 `hooks.events.tool.before.rewrite`），不用 `can_use_tool`：跳过确认时 CLI 不发 `can_use_tool`，钩子每次都过。Codex、Command Code 只填 `serve`，Pi 另有 `hideBuiltin`；没实测的按保守值。`hideBuiltin`、`mcpOnlyPanel` 这一期只登记，外部服务经面板代理（ADR 0085）用后者。
8. **`find` 收数组**（设计稿 15.3 方案 B）：`query` 可以给数组（最多 10 个），每个词同时查、按词分组，几组平分 4000 字，没列完的那组写清怎么单独查（`server/panel-tools/find-multi.ts`）。共用身份提示里「互不依赖的调用一起发」改成「读几个文件、跑几条只读命令」，查几个名字改说「find 的 query 给数组」（有 find 时才说，不看 `parallelTools`）。
9. **能改写时也接「搜索 + 截行 / 打印」的多段命令**（2026-11-26 Flash 实测后加）：模型常写 `grep -rn X . ; echo "exit:$?"`、`rg X src | head -50`，单段才接的话改道一次都没触发。第一段是认得的搜索、后面每段都是 `head` / `tail` / `sort` / `uniq` / `echo` / `printf` / `true` 时，改写照样是「先打印面板那段、再原样跑整条原命令」，并集不变；数行数（`wc`）、再过滤（`grep -v`）、读标准输入的、代答的仍然放行。
10. **多段命令只要「一个搜索段、输出不再过滤、不换目录」就接；「或」的正则拆开查**（2026-11-26 第二轮 Flash 实测后加）：Flash 几乎总把看文件、打印分隔和搜索串成一条（`cat a.lua && echo === && grep -rn X scripts | head`），也几乎总用 `grep 'A\|B'`、`rg 'A|B'` 一次搜几个名字，第 9 条下改道仍是 0 次。现在按引号切命令（`shared/tool-gateway/shell-split.ts`，引号里的 `|` 不算管道），整条里只有一个搜索段、它不是被管道喂进来的、前面不是 `||`、整条没有 `cd`、它的输出只再管道给截行类时就改写（类别按第一段认成 read 的也接）；原命令仍一字不动地整条跑。只有「或」和转义点的正则拆成几个原文分开查、命中合起来，任一个出现就算原命令搜得到；有别的元字符的照旧放行。
11. **多段命令逐段改道**（2026-11-26 用户提）：第 10 条只接「整条里一个搜索」、面板那段插在整条开头。现在按引号切段（`shared/tool-gateway/takeover-segments.ts`），每个接得住的搜索段各自交给 find（几段并发查），在它前面原地插 `node "<脚本>" && `，别的段、连接符和顺序一字不动：脚本只打印、退出码 0，`&&`、`;` 的语义不变，管道比 `&&` 绑得紧，`| head` 截不到面板那段。一段接不住（被管道喂进来、前面是 `||`、输出再过滤或数行数、放后台）只跳过那一段；有换目录、循环条件关键字、子 shell 或花括号组时整条不接。`luac` 这类替换不逐段做：自建工具有自己的 shell 和工作目录，塞进 Agent 的命令里跑不稳，要保序得让段里的脚本回调面板执行，留作后续。

候选方案：

- 面板自己跑原命令再改写成打印全部结果：要替 CLI 选外壳（Git Bash、PowerShell、cmd 的引号规则都不同），跑出来的和 CLI 自己跑的可能不一样。不选：改写时原命令留给 CLI 自己跑。
- 用文本兜底源代替原命令：索引不收排除目录、不看 `.gitignore` 的差别，结果可能比原命令少，违反并集。不选。
- 找文件（`find -name` / `fd` / `Glob`）也接管：并集等于原命令，白白多一次索引查询。不选，记成放行原因。
- 用 `can_use_tool` 回 `updatedInput`：只有要确认的调用才走它，跳过确认、自动接受的权限下根本不发。不选。

拿不准、留到实测：

- Windows 上 Claude Code 的 PowerShell 工具跑 `node "C:/…/x.mjs"; rg …`：PowerShell 5 / 7 都认 `;` 和带引号的参数，但没在 Windows 上实跑；Git Bash 下同一条也能跑。
- 代答时面板跑出来的 `findstr` 输出按 UTF-8 读，系统代码页不是 UTF-8 时中文会乱（只影响 Codex 这类不能改写的 CLI）。
- 代答时面板起的 `rg` 不带 Agent 环境里的 `RIPGREP_CONFIG_PATH`（搜索排除），结果可能比 CLI 自己跑的多（不会少），超过上限时放行。

## 风险与代价

- 每次调用多一次钩子往返：HTTP 钩子可以忽略；只能用命令类钩子又没有 curl 的机器上每次多几十毫秒。网关模式关闭就回到以前。
- 调用记录里有命令原文和输入（截到 2000 字）：只存在本机数据目录，和钩子记录一样不外传。
- 「本可以并行」按工具前到达面板的先后和上一个工具后判断，CLI 报不出工具后的一律不算，宁可少报。

## 开放问题

- 搜索命令的识别和 `shared/knowledge/match/normalize.ts` 的 `searchText` 还是两份，第二期接管又多了一份参数级的 `shared/tool-gateway/search-args.ts`（只认能照原样跑的），三份以后合到一处；合之前各管各的。
- Codex、Command Code、Pi 能不能一条回复发几个调用还没实测（`parallelTools: unknown`），提示照常加；实测后改定义。第二期把「查几个名字」从并行提示里拿出来，改成 find 的数组，和 CLI 能不能并行无关。
- `hideBuiltin`（Pi 关自带搜索）、`mcpOnlyPanel` 这一期只登记在 CLI 定义里，还没有代码按它们走。
- 改写依赖 Agent 机器的 PATH 里有 `node`、PowerShell 认 `;`，没在 Windows 和真的 Claude Code 上实跑；`updatedInput` 配 `allow` 在旧版 Claude Code 上是否生效也待核对。
