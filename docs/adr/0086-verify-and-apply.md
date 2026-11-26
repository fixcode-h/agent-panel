# ADR 0086：校验和改动生效接进工具网关（第三期）

状态：已接受 · 2026-11-26

- 关系：接着 [0084 工具网关](./0084-tool-gateway.md)（能力表 verify、apply 两行第一期只推算，这里接上真的路）和 [0082 自建工具](./0082-custom-tools.md)（自建工具加 `role` 字段）。改道模式的通用部分（`enforce` 打开、CLI 定义 `takeover`、find 的改写 / 代答）另做（并行在做的「find 接管 + 改道模式」），这里只是「校验」「改动生效」两个能力的那条路。
- 设计稿：`designs/技能与自建工具按情境加载-设计稿.md` 第 6.2 节 verify / apply 两行、第 8 节、9.4、第 10 节第三期。

## 背景

用户用 /createtool 做了 Lua 检查工具，Agent 改完 Lua 还是自己跑 `luac -p`（项目里不一定有 luac），或者干脆不查。真实评测（DeepSeek Flash）里这是常态：提示词里那一行自建工具清单、情境规则 `custom-tool-instead` 的提醒，弱模型都守不住。用户 2026-11-26 定：**改完 Lua 由面板自己跑检查，只把报错推回去，没报错不打扰**。

编译也一样：UE 项目里 Agent 常自己拼 `Build.bat` / UBT / RunUAT，绕过面板按编译目录排队的 `request_build`，几个对话同时编同一个目录。

## 事实核对

| 位置                                                 | 现状                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `shared/custom-tools/schema.ts`                      | 有 `capability` 字符串（只是标记，路由没接），没有「这是检查工具、管哪些文件」的字段                                         |
| `shared/custom-tools/match.ts` 的 `customToolSigs`   | 只按工具自己命令里的程序名认（`python tools/lua_check.py` 认成 `lua_check.py`），Agent 跑 `luac` 认不出是同一件事            |
| `server/custom-tools/run.ts` 的 `prepare`、`execute` | 自建工具唯一的执行入口：校验参数、按 shell 转义、P4 签出、起进程、写日志、按 `errorPattern` 认报错                           |
| 能力表 verify / apply 两行（0084）                   | verify 认「和自建工具同一个程序」的命令推算 serve；apply 认 UE 编译推算 serve 到 request_build——编译要排队，不能在钩子里代答 |
| `request_build`（`server/panel-tools/build.ts`）     | 只在 UE 项目的对话里挂：父对话向面板占位编译（note + children），子对话向父对话申请（note）                                  |
| CLI 等钩子回答                                       | Claude Code 的 http 钩子超时 70 秒（CLI 定义 `hooks`）；钩子回答里能带补充说明（context），工具前能拒绝并带说明              |
| 收尾前判断（`turn.beforeEnd`）                       | dispatch 里内置的「改完没验证」只看有没有跑过命令，不知道检查过没过                                                          |

## 决策

1. **自建工具加可选字段 `role`**（`ToolRole`）：`kind: verify | build`；verify 配 `paths`（相对项目根的通配，如 `**/*.lua`）；`replaces: [程序名]`（如 `luac`）；`arg` 指定改过的文件填进哪个参数（不写用第一个 path 参数）；`listFile` 把文件写成清单一次查完（UE 插件那类增量编译工具收的就是清单）。可选字段、旧文件不写照常读，**不写迁移**。校验工具必须只读（面板自己跑、不弹授权卡），`draftProblems` 会拦；/createtool 的提示词和 `custom_tool` 的草稿格式让 Agent 一起填，编辑抽屉加「用途」页能看能改。
2. **改完自动校验**（`server/tool-gateway/verify/`，判定在 `shared/tool-gateway/verify/`）：
   - Agent 改了对得上某个校验工具 `paths` 的文件，先记进这一轮的「一批」（`batch.ts`），改的时候不跑；
   - 它去做别的事（下一个不是改文件的工具调用：跑命令、读别的文件、调面板工具）时，每个校验工具只跑一次，查这一批里归它的文件；跑之前整批取走清空，**同一批不重复跑**，并行来的几个工具前只有第一个跑；
   - 结果**只推报错**：随这次工具前回答的补充说明（context）交回去，开头「【面板】改完自动校验」；全部通过什么都不说；
   - 要收尾时还有没查的改动，收尾前先跑一次：有报错就拦下收尾，把报错交回去（Chat 页一问一答不拦）；
   - **超时、工具本身起不来照实写**：整次限时 45 秒（钩子 70 秒超时留余量），超过就停、写「还没校验完」；程序找不到（spawn 出错、shell 退出码 127 / 9009）、参数填不上写「检查工具本身的问题，不是你的代码，告诉用户去修」。都进调用记录，不悄悄算通过；
   - 调用记录里单独记一行（`CallRecord.verify`，`shared/tool-gateway/verify/record.ts`），设置页显示「校验 · lua-check · 1 处报错 / 通过 / 超时 / 没跑起来」，点开看文件、原因、日志；触发它的那次调用的 `pushes` 记一条 `verify:<id>`；
   - 执行走自建工具同一个入口（`prepare` + `execute`），按文件一个个跑最多 10 个，`listFile` 的一次跑完。
   - 观察和改道模式都跑：它只补说明、不改 Agent 的调用；网关关着时不跑。
3. **replaces 是能力 verify 的一条路**：`customToolSigs` 把 `role.replaces` 收进 `CustomToolSig`，同时记 `effect`、文件参数、有没有填不上的必填参数。判定在 shared（`shared/capability-router/verify-apply.ts` 的 `verifyClaims`、`shared/tool-gateway/verify/plan.ts` 的 `takeoverPlan`）：
   - 只读、参数填得上（命令里找得到对得上 `paths` 的文件）的 → **serve**：改道模式下面板改用自建工具跑，结果放进拒绝说明，开头「结果（面板）」；这一批里归它的改动顺手一起查；工具起不来时放行原命令、把原因补给 Agent（网关出错放行）；
   - 会改文件、参数填不上的 → **redirect**：不执行，说明改用 `custom_tool action=run id=…`、文件填哪个参数。会改文件的要过授权卡，路由不能绕过确认（设计稿 6.1）；
   - 观察模式只记 `wouldRoute`，情境规则 `custom-tool-instead` 留作这时的提醒（它的 `customToolFor` 也认 `replaces`）。
4. **apply 最小版**（`applyClaims`）：认 `Build.bat` / UBT / RunUAT / msbuild / devenv 这类 UE 编译命令，这一轮挂了 `request_build`（`ClaimCtx.build`，取自 `orch.ueBuild`）时 **redirect** 到它，说明按父 / 子对话写清 note、children 怎么填；没挂时改用项目里 `role=build` 的自建工具；Agent 跑 `role=build` 工具自己的程序也指到它。**编译一律只改用、不代答**：要排队、可能几分钟，不能在钩子回答里替它等完。项目自己的编译脚本常也叫 build.bat，挂了 `request_build` 时 UE 编译它优先。
5. **Live Coding、VS 编译、Lua 热重载这些路留给插件接口 22（第四期）**：它们要按编辑器 / VS 的状态挑，状态在 UE、IDEA 插件里，等插件接口 22 把 `findSources` 推广成通用的 `providers` 再登记成 apply 的路；这一期 apply 的说明写清楚。
6. 网关里只留调用：`gateway.ts` 在原来的回答和推算之后交给 `openVerify(...).before`，收尾前判断由 `dispatch.ts` 交给 `gw.wrapEnd`。校验自己用的时间不算进网关的 `ms`（那是网关自己的开销，统计页单独看）。

## 放弃的做法

- **在工具后（tool.after）马上跑**：Agent 连改五个文件就跑五次，而且这时它还没改完，报的错多半是半成品。等它去做别的事再跑一次（设计稿第 8 节）。
- **只提醒 Agent 去跑**：就是现在的 `custom-tool-instead`，真实评测里守不住（用户 2026-11-26 选了面板自己跑）。
- **自动校验也拦工具调用**：报错只是补充说明，Agent 照样能读、能跑命令，拦了反而不能去看报错的上下文；只在收尾时拦一次。
- **编译代答**：见决策 4。
- **把校验结果写进对话消息**：对话只放 Agent 和用户看的东西；面板替它跑的检查结果给 Agent（补充说明）和用户（调用记录）各一份，不另造一种消息。

## 影响

- 网关开着（默认观察）时，项目里有 `role=verify` 的工具就会在改完对得上的文件后自动跑；没有这类工具什么都不变。
- `WouldRoute.to` 的自建工具写成 `custom_tool:<id>`（以前是中文名），调用记录和设置页的「几条路」都按 id 对。
- 演示版：调用记录里有一行「改完 Lua 面板自动检查」（`web/src/lib/demo/demo-tool-gateway.ts`，批次和记录用 shared 的同一份逻辑），自建工具「Lua 语法检查」标了 `role=verify`。
- 测试：`shared/tool-gateway/verify/verify.test.ts`（一批的记法、replaces 的真实命令样本、redirect 的说明、只推报错）、`server/tool-gateway/verify/verify.test.ts`（真起进程：同批不重复、没报错不打扰、超时和起不来、改道代答、收尾前补跑）。界面检查 `07b-custom-tools`（用途页）、`05c-agent-tools`（校验行）。
