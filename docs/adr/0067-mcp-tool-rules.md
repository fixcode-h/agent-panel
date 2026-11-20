# ADR 0067：MCP 工具规范：准入、命名、说明和返回都有上限，不随手加工具

状态：已接受 · 2026-11-15

## 背景

- 用户 2026-11-15 在会话栏「最大的工具结果」里看到 `request_build` 每次约 2k token（6135 字），以为每轮都带着。
  - 查下来：编译跑完后，面板把输出结尾 6000 字接在对话里 `request_build` 那一行后面（`jobOutput`），会话栏按这一行估算。CLI 实际收到的是推回的摘要，不是这 6000 字，所以估算是虚高的。
  - 推回给 Agent 的摘要本身也不短：失败时有 30 条错误、10 条警告、40 行结尾，再加命令原文，常常两三千字。
- 同一张截图最上面的 `LOG="C:/Users/…/.agent-panel/…"`（约 2.7k）不是 MCP 工具。它是 Agent 自己跑的一条 Bash 命令，按推回结果里的日志路径去搜编译日志。工具结果按「动作和对象」显示，Bash 显示的就是命令开头。
- 面板和插件的工具是一个个加起来的。一共一百多个，没有统一的准入标准，返回多长也各写各的：
  - 面板：注册表里 42 个（含 4 个过渡的旧名字），另有提问、补充、等下一句、操控软件 5 个。
  - 插件：UE 19 个、Blender 8 个、UI 设计 29 个（只在设计页自己的对话里给）、视频截帧 1 个、表格 9 个面板动作。
- 用户要求：只保留必要且有用的工具，定一份规范，以后不能随意加工具。

## 决策

### 1. 准入：加工具之前先答这四问，有一问答不上就不加

1. **CLI 自带的工具做不到或做不好吗？** 读文件、搜代码、跑命令用 CLI 自己的工具。只有需要面板状态、需要用户确认、要跨进程或跨对话、要连外部程序（UE、Blender）时才做成 MCP 工具。
2. **能并进已有的工具吗？** 同一个对象上的操作合成一个工具，用 `action` 区分（例如 `ue_editor`、`ue_asset`、`blender_session`）。一个工具的 `action` 不超过 10 个，再多按对象拆。
3. **Agent 拿到结果能接着干活吗？** 结果只能在页面上看、Agent 拿不到的操作，做成页面按钮，不做成工具（例如 `ue_editor` 的 `build`，见下面的梳理）。
4. **说得清什么时候用吗？** 写不出具体的 `useWhen` 和与相近工具的分界 `avoidWhen`，说明它和已有的工具分不开（ADR 0064 的 `ToolGuide`）。

### 2. 命名

- 小写下划线，3 到 30 个字符，动词开头（`request_build`、`submit_merge`）或「对象」加 `action` 参数（`ue_asset`）。
- 插件工具带插件前缀（`ue_`、`blender_`、`video_`），面板工具不带。
- 改名或删除时，旧名字留作只认调用的条目（`aliases`，或返回一句「改用哪个」的错误），不列进清单。保活的旧进程、记住旧名字的模型还会这么调，不能悄悄吞掉。

### 3. 定义的长度

- 一个工具的定义（名字、说明、参数 schema 的 JSON）不超过 3000 字。说明只写作用、时机和关键约束。参数的细节放进返回（交错了说清缺什么）或用法查询（`more_tools` 只写 name 时返回用法）。
- 不常用的面板工具收进 `more_tools`（`DEFERRED_TOOLS`，ADR 0028）。
- 规范之前已经超了的只许变短：`submit_diagnosis` 约 15k、`update_bug_case` 约 14k、`spawn_agents` 约 3.6k。前两个只在 Bug 对话里给，但仍是面板工具里最占上下文的，下一步要瘦身。
- 面板各类对话拿到的工具个数也设了上限（父对话 42、子对话 30、子任务 13、工作流节点 23、Chat 4；含 ADR 0066 保留一个版本的四个教训、经验旧名字，删掉时跟着减）。

### 4. 返回的内容

- 返回的是 Agent 接着干活要用的，不是日志。成功只回状态和后面要用的 id、路径；失败回原因和去哪里看细节。
- 默认不超过 4000 字。读结构的工具（蓝图伪代码、控件树、属性表）可以到 12000 字，要提供分页、过滤或路径参数，超了截断并写明怎么取后面的。
- 日志、长列表、文件内容写进文件，只回路径和条数，让 Agent 用 `rg` 按需取。
- 长任务马上返回编号，结果由面板推回，不让 Agent 轮询。
- **数据用紧凑 JSON 返回**（2026-11-20 补）：返回的是一个对象时，`content` 放它的紧凑 JSON（不缩进，一个 text 块），同时带 MCP 的 `structuredContent`（同一个对象），脚本式调用（Pi 的 codemode、Claude Code 的代码模式）能直接取字段。超长时按列表截短并在对象里写明（不要把 JSON 从中间切断，切断的 JSON 脚本解析不了）。Claude Code 有 `structuredContent` 时只把它交给模型、不看 `content`：要追加提示就写进对象里；`content` 不是恰好一个 text 块、或超过上限时，面板会去掉 `structuredContent`（`server/plugins/mcp-clip.ts`）。对话里显示时面板再把 JSON 展开成缩进的样子。
- **UE 编译（`request_build`，以及 UE 项目里交给 `run_background` 的编译命令）**：成功只回「成功、退出码、用时」；失败只回「失败、退出码、用时、完整日志路径和认出的错误条数」，不带日志摘录和命令原文（`BgJob.brief`）。
- 对话里发起后台命令的那一行，跑完后接上的是推回给 Agent 的同一段，不再接输出结尾 6000 字。完整输出点那一行，在命令行窗口里看。这样会话栏「最大的工具结果」估的就是 Agent 实际拿到的。

### 5. 调用过程：等到结果再返回，出错让 Agent 一次改对（2026-11-20 补）

起因：用户 2026-11-20 看到 Agent 调 IDE 里 EmmyLua 的 `lua_code` 连着失败——`projectPath` 填了 P4 工作区根而 IDE 打开的是下面的 Project 子目录；经 `execute_tool` 转调时把命令写成 `action=search`；好不容易调通了，每次 search 又带「emmylua_ls 还有 854 个文件没索引完，稍后重试」，第一次还因此返回了空。面板、插件、UEToVS、EmmyLua 的工具都照这一节写。

- **能在一分钟内等到的就在工具里等**：服务器在启动、在建索引、短作业马上要完，工具自己隔一会儿再问，等到了再返回，上限默认 60 秒（会阻塞的参数照常给上限）。不返回「稍后重试」让 Agent 自己轮询；等到上限还没好才报错，写明等了多久。超过一分钟的按第 4 条做成长任务。
- **一直不变的情况不当成暂时状态报**：一批文件服务器永远不收、某个功能没装，认出来后记住、直接跳过，不在每次调用里重复同一句提示。只在它影响结论时说（例如没有命中时说「有 N 个文件没查，在哪些目录，要找用 rg」）。
- **结果不全要写明，但不全不等于「没有」**：截断、分页、跳过了什么写进 `note` 或 `truncated`，并给出取剩下部分的参数。
- **错误让 Agent 一次改对**：错误说明写原因和下一步具体怎么调——缺的参数名、合法的取值或格式、可选的对象列表（例如打开的项目）。不写「请重试」这种没有新信息的话。
- **说明、示例、报错里的调用写法和实际调用一致**：参数写成真实的参数名和类型。宿主有自己的调用约定的（JetBrains IDE「仅路由器」经 `execute_tool` 转调只认 `工具名 --参数名 值`；IDE 给每个工具加的 `projectPath` 只认 IDE 项目目录之内的路径），由面板在提示词「搜索（这个项目）」一节写明（`shared/mcp-catalog/code-index.ts` 的 `ideMcpLines`）。
- **Agent 一侧**：同一个错误不原样重试，也不只换个查询词就再调；先照报错改参数，改不了就停下说明或问用户（提示词同一处）。

### 6. 怎么守住

- `server/panel-tools/registry.test.ts`「MCP 工具规范」核对面板工具的名字格式、各类对话的个数上限、定义长度上限。要加工具必须在同一个提交里改这几个数，并在提交说明里写清过了准入的哪几问。
- 插件仓库的 AGENTS.md 照这份规范写了插件那一侧的规则。UE、Blender 的冒烟测试照旧核对每个工具都有 `useWhen`。
- 第 5 条（调用过程）没有自动检查，靠各仓库 AGENTS.md 引用这一节和评审；EmmyLua 的 `lua_code` 用单测核对「等索引」和「不收的文件不重复提」（`LuaCodeToolsTest`）。

## 2026-11-15 梳理结果

| 范围                | 工具                                                                                                                                                                                                                                 | 结论                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 面板 · 计划与结束   | `set_plan`、`finish_plan`、`end_turn`                                                                                                                                                                                                | 保留：状态只认工具调用（ADR 0041）                                                                             |
| 面板 · 子对话       | `create_conversation`、`send_to_conversation`、`list_conversations`、`finish_child`、`message_parent`、`suggest_next_step`、`submit_merge`、`claim_files`、`release_files`                                                           | 保留：各管一步，没有重叠                                                                                       |
| 面板 · 工作流       | `start_workflow`、`message_workflow`、`revise_workflow`、`answer_workflow`、`stop_workflow`、`finish_workflow`、`list_workflows`                                                                                                     | 保留；`list_workflows` 收进 `more_tools`：每轮提示里已有「名下的工作流」，状态变了也会来信                     |
| 面板 · 子任务与协作 | `spawn_agents`、`wait_agents`、`stop_subtask`、`get_status`、`send_message`、`read_messages`、`read_state`、`write_state`、`submit_result`、`submit_verdict`                                                                         | 保留：`get_status`、`send_message`、`read_messages` 是 Pi 桥接核对清单用的核心工具                             |
| 面板 · 后台与编译   | `run_background`、`check_background`、`stop_background`、`request_build`、`list_peers`、`message_peer`                                                                                                                               | 保留；`request_build` 的结果按上面第 4 条精简                                                                  |
| 面板 · 改动与版本   | `begin_edit`、`begin_inline_edit`、`end_inline_edit`、`use_capability`、`p4_split_changelists`、`cherry_pick`、`ask_push`                                                                                                            | 保留                                                                                                           |
| 面板 · 知识         | `knowledge_lookup`、`knowledge_record`、`remember`；旧名字 `project_lessons`、`record_lesson`、`project_experience`、`record_experience`                                                                                             | 保留：ADR 0066 已把教训和经验合成一个查、一个记的入口，四个旧名字收进 `more_tools` 留一个版本，之后删掉        |
| 面板 · Bug          | `submit_diagnosis`、`update_bug_case`、`request_logs`                                                                                                                                                                                | 保留；前两个定义超长，下一步瘦身                                                                               |
| 面板 · 提问与软件   | `ask_user`、`read_user_notes`、`wait_user_message`、`request_user_action`、`app_actions`、`app_do`                                                                                                                                   | 保留                                                                                                           |
| 面板 · 只认调用     | `start_plan`、`submit_build`（`submit_merge` 的旧名）、`dispatch`                                                                                                                                                                    | 不列出，只给老会话说清改用哪个                                                                                 |
| 面板 · 清理         | `close_run`                                                                                                                                                                                                                          | 从 `DEFERRED_TOOLS` 去掉：早就没有这个工具了，名字只留着认历史记录                                             |
| UE                  | `ue_status`、`ue_console`、`ue_gm`、`ue_find`、`ue_get`、`ue_set`、`ue_lua`、`ue_call`、`ue_asset`、`ue_blueprint`、`ue_save`、`ue_compile`、`ue_python`、`ue_log`、`ue_screenshot`、`ue_editor`、`ue_undo`、`ue_perf`、`ue_capture` | 保留；`ue_editor` 去掉 `build`：结果只能在 UE 页看、Agent 拿不到，又和面板的 `request_build` 重复（ue 0.11.2） |
| Blender             | `blender_session`、`blender_op`、`blender_py`、`blender_see`、`blender_run`、`blender_inspect`（上游 DSH）、`blender_python`、`blender_scene`（模型设计）                                                                            | 保留：两组给不同的对话，不会同时出现；DSH 一组按上游 1:1                                                       |
| UI 设计             | 29 个设计工具                                                                                                                                                                                                                        | 保留：只在设计页自己的对话里给，不进项目对话                                                                   |
| 视频截帧、表格      | `video_frames`；表格 9 个面板动作（经 `app_actions` / `app_do`）                                                                                                                                                                     | 保留                                                                                                           |

没有发现必须新加的工具。UE 读资源值的 `ue_values`、`ue_config`（2026-11-14 的设计）还在等用户拍板，不在这次加。

## 放弃的做法

- **把工作流的 7 个工具合成一个带 `action` 的工具**：省下的说明不多（每个三四百字），提示词、界面显示、测试里按名字引用的地方很多，合并的风险比收益大。
- **一刀切把所有工具结果限到 2000 字**：读蓝图、读属性表的结果本身就是要的内容，限死了 Agent 只能分好几次读，反而更费。改成默认 4000、读结构的可到 12000 并且必须能分页。
- **成功时也带最后几行输出**：UE 编译成功的最后几行是 UBT 的汇总，Agent 用不上；要看就去命令行窗口或日志。

## 后果

- UE 编译失败时 Agent 要自己按路径搜日志，多一次 `rg`。换来的是每次编译结果从两三千字降到一两百字，成功的那几次（大多数）完全不占。
- 会话栏「最大的工具结果」里 `request_build`、`run_background` 那几行不再虚高。
- 加面板工具要改测试里的上限，评审时一眼能看到。插件的工具没有同样的自动检查，靠插件仓库的规则和评审。
