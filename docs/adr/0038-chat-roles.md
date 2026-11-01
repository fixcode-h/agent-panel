# ADR 0038：Chat 模式用 Chat 角色：角色分 Chat / Agent 两类，能力按角色和有没有项目给

状态：已接受 · 2026-11-01 · 部分取代 [ADR 0037](./0037-chat-and-agent-modes.md)

## 背景

用户 2026-11-01：「Chat 模式不再使用统筹角色，设计一个聊天专用的角色，然后 Chat 模式包含一些基本的内容，比如计划等常用的，只是不会开启子对话……不能开启工作流等……把之前针对 Agent 模式的角色来适配 Chat 模式的限制和调整去掉，就让 Agent 的角色专门处理 Agent 的对话就行」。中途又定了四点：

1. Chat 用精简版的通用约束（「聊天约束」）。
2. Chat 模式不派子任务。
3. 旧的 Chat 对话怎么处理由实现方判断（选了「运行时按内置助手跑，不迁移」）。
4. 角色分 Chat / Agent 两大类，各自只能在对应模式里用。

之后补充：「Agent 都有自己的计划模式，这个自带的计划模式可以用在 Chat 模式的聊天，然后软件实现的计划就用在 Agent 模式聊天中」。

## 事实核对

| 位置 → 现状（改动前）                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/engine.ts` 的 `Orchestra.plain` → 按「是不是 Chat 页」一刀切：`server/orch-mcp.ts` 的 `PLAIN_TOOLS` 只留后台命令三件                                                                                                                                                                                |
| `shared/engine.ts` 的 `conversationPrompt` → Chat 页和项目对话共用一套。沙盒实测 Chat 页读到「## 授权情况 …… 调用面板工具 ask_push」（这一轮没有 `ask_push`）、「## 搜索排除（这个项目）」「## 工作流」「## 执行方式 …… 你是用户直接对话的项目对话」「## 总结格式」，都是项目对话那套漏进来的               |
| Chat 页的对话 `agentId` 为空，按「无角色」跑，只追加 `DEFAULT_CHAT_PROGRESS`；用户的自建角色在 Chat 页选不了（`TaskComposer` 的 `standalone` 时 `wanted = ''`）                                                                                                                                             |
| `server/ask-mcp.ts` 握手 `orchestration.enabled = !!s.orch && !s.orch.plain` → 按身份字段声明，Pi 桥接扩展据此核对 `CORE_TOOLS`                                                                                                                                                                             |
| CLI 自带的待办 → Claude Code 的 `TodoWrite`、Codex 的 `turn/plan/updated` 已经解析成 `task.todos`（`server/exec/parsers.ts`、`server/exec/rpc/codex.ts`），没有被禁用，但只有工作流任务的「任务进度」面板显示它；Chat 页看不到。面板计划段里写着「不要用 CLI 自带的待办」，只在项目对话（`planPart`）里出现 |

## 决策

1. **角色分两类**：`AgentInput.scope: 'agent' | 'chat'`，没写（旧数据、导入的旧文件）按 `agent` 算（`scopeOf`），不迁移、不写盘。建好不能改（`PUT /agents/:id` 一律取原值），要换就「复制为另一类」。
2. **两个新内置角色**（`shared/builtin/chat-agents.ts`）：`chat-rules`「聊天约束」（基础分类，通用约束的精简版，去掉子对话、父对话、收尾、推送、工作流、共用工作区、项目搜索范围）；`chat`「助手」（必备角色，引入聊天约束）。必备角色从 8 个变 9 个；助手不进项目设置的必备角色参数区，运行配置不生效（Chat 页在输入框选 CLI 和模型）。
3. **模式上限**（Chat 模式本身的规则，不看角色）：不派子任务、不开子对话、不跑工作流、不挂能力、没有就地微改动。判定只在 `makeOrchestra` 一处（`isChatMode`），算成 `canSpawn` / `team` 两个能力字段：
   - `canSpawn`（`spawn_agents` / `stop_subtask` / `wait_agents`）：`!helper && !Chat 模式`；
   - `team`（`get_status` / `send_message` / `read_messages`）：`!Chat 模式`；
   - 推送授权、教训、版本管理、worktree、子对话照旧按「有没有项目」这个客观条件给。Agent 模式 12 个身份的工具清单一个不变（`server/orch-mcp.test.ts` 的 IDENTITIES）。
4. **计划的分工**：面板计划（`set_plan` / `finish_plan`、计划段、计划推进、收尾步骤）只在 Agent 模式；Chat 模式用各 CLI 自带的待办 / 计划（`TodoWrite`、Codex 的 plan），面板把 `task.todos` 显示在 Chat 页输入框上方（`TodoButton`，和面板计划同一个位置）。只有 CLI 定义写了 `todos: true` 的（Claude Code、Codex，面板真的解析它们的待办）才在提示词里说「面板会显示」，其余 CLI（Pi 没有待办工具、Command Code 的不解析）让模型在回复里用编号列表列计划（`chatModePart`，按 `EngineHost.cliTodos`）；助手设定是静态的，写成「有自带待办就用、没有就在回复里列」。待办全部做完后，用户发下一条消息时收起；对话换了 CLI 时清掉旧待办。Claude Code 的 `EnterPlanMode`（只读规划模式）仍关着，理由见 `shared/clis/claude.json` 的 `why`；放不放开等用户定。
5. **Chat 模式提示词单独拼**（`shared/chat-prompt.ts` 的 `chatConversationPrompt`）：用户消息、回复语言、对话目标和规则、后台命令、「## Chat 模式」一段；不带授权情况、工作流、执行方式，也不带总结格式（用户 2026-11-01 定：Chat 页不写总结卡）。
6. **旧 Chat 对话（`agentId` 为空）运行时按内置助手跑，不迁移**（`chatRoleFor`；Chat 页选的自建 Chat 角色被删了也一样回退到助手，`turnRole`，记日志）：只取设定、引入、参数、Skill，id 仍是空字符串，所以「按 CLI 署名、输入框里随时换 CLI / 模型 / 强度」（`canPickRun`）都保住；新建时选内置助手也存空字符串。本机没有助手时退回无角色。`DEFAULT_CHAT_PROGRESS` 只给项目里的「无角色」对话。
7. **各入口的类别兜底**：新建对话、换角色、定时任务保存（`scopeError`）；项目默认角色、工作流的主角色 / 成员 / 节点 / 步骤（`agentOnlyError`）；角色保存（`normalizeScope`：Chat 角色的通用、分派、计划、挂载、就地改动、对话范围归零，引入只留同类，Agent 角色不能挂 Chat 角色）；`create_conversation` 的 `role` 和 `spawn_agents` 的 `agent` 点名到 Chat 角色时拒绝，按名字找时先找本模式这一类的（`findRole`，两类可以同名）。前端选择器按类别过滤。
   - 换角色接口只在角色真的变了时才校验：旧对话带着原来的 `agentId` 改别的设置不会被拒。
   - **定时任务的保存和启动都按类别校验，旧数据不做兼容**（用户 2026-11-01 定的）：改动前没有项目的计划可以选 Agent 角色，这种计划到点启动、「立即运行」会失败（原因记进运行记录），保存（包括启停开关的整份 PUT）也会被拒，要先把角色换成 Chat 角色。
   - 已经存在的对话照常能打开；Chat 页对话选的自建 Chat 角色被删了，运行时回退到助手（`turnRole`）。
8. **「分析」是唯一跨模式的面板专用角色**：归不到项目的 AI 分析开在 Chat，按 `analysis` 字段放行，受 Chat 模式上限管。
9. **握手 `orchestration.enabled` 按清单现算**：三件核心工具（`ORCH_CORE_TOOLS`）都在才是 true，不认身份；单测核对它和 `shared/clis/pi.json` 扩展模板里的 `CORE_TOOLS` 一致。

候选方案：

- **新加 `TaskMode`**：没选，理由同 0037（「有没有项目」已能准确区分）。
- **Chat 页继续不用角色，只改 `plain` 的工具清单**：没选。用户要的是「Agent 角色只管 Agent 对话」，并且提示词漏项要按模式整套分开。
- **迁移旧对话的 `agentId` 成助手的 id**：没选。Chat 页「随时换模型」靠空 id（`canPickRun`、`TaskMeta`、`TaskView` 的按 CLI 署名、`newTask` 存不存模型），改成存 id 要连改五处以上并丢掉这个能力，收益只是数据上看得见 id。
- **允许改类别**：没选。Agent 角色可能已被挂载、写进工作流、设成项目默认、当通用角色，改成 Chat 会让这些引用全部失效；复制一份简单安全。
- **Chat 允许派子任务**：用户否决。
- **Chat 也用面板计划**：用户改主意否决（「Agent 都有自己的计划模式……软件实现的计划就用在 Agent 模式」）。

## 操作清单 / 契约

| 改动                                                                                                                            | 位置                                                    |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `AgentInput.scope`                                                                                                              | `shared/schema.ts`                                      |
| `isChatMode`（原 `isPlainChat` 改名）、`scopeOf`、`chatRoleFor` / `emptyRole`、`scopeError`、`normalizeScope`、`agentOnlyError` | `shared/conv-mode.ts`                                   |
| `turnRole`（删掉的 Chat 角色回退助手）、`findRole`（同名先找本类）、`settledTodos`（做完的待办收起）；CLI 定义 `todos`          | `shared/conv-mode.ts`、`shared/cli-spec.ts`             |
| `chatConversationPrompt`、`backgroundPart`（从 engine 搬来，两边共用）                                                          | `shared/chat-prompt.ts`                                 |
| `Orchestra.plain` 删除，加 `canSpawn` / `team`；`planning` 加 `!isChatMode`；`commonAgents` 去掉 Chat 角色                      | `shared/engine.ts`、`shared/agent-role.ts`              |
| `PLAIN_TOOLS` 删除，按 `team` / `canSpawn` 给工具；`orchHint` 搬到单独文件，`!o.team` 分支只讲后台命令                          | `server/orch-mcp.ts`、`server/orch-hint.ts`             |
| `ORCH_CORE_TOOLS`；握手现算                                                                                                     | `shared/panel-tools.ts`、`server/ask-mcp.ts`            |
| 推送授权按 `!task.projectId` 判                                                                                                 | `shared/push-auth.ts`                                   |
| runner 的空 id 角色走 `emptyRole`，`defaultChatPrompt` 按「有没有角色」判                                                       | `server/exec/runner.ts`、`shared/agent-role.ts`         |
| 内置 `chat-rules`、`chat`；`CORE_AGENTS` 加 `chat`；`syncCore` / `sameCore` 带 `scope`                                          | `shared/builtin/chat-agents.ts`、`agents.ts`、`core.ts` |
| 角色页三页、类别徽标、「复制为另一类」；Chat 页角色选择；待办行；各选择器按类别过滤                                             | `web/src/pages/AgentsPage.tsx`、`web/src/components/…`  |

## 取代 ADR 0037 的部分

- 决策表「编排工具」一行（Chat 页只留后台命令三件）：改成按 `canSpawn` / `team` 能力给，Chat 模式的结果仍是后台命令三件（加提问、`app_*`、`more_tools`）。
- 操作清单里 `Orchestra.plain` 那一行。
- 「风险」最后一条（「Chat 页拿不到 `spawn_agents`：要并行拆活请到项目里开对话」）：改为「Chat 模式按设计不派子任务」。

0037 的其余决策保留：Chat 一问一答、推进只 1 次；Agent 模式同一进度最多推 3 次；`DEFAULT_CHAT_PROGRESS`（现在只给项目里的无角色对话）；通用约束的措辞；Command Code 不再每轮提示等待。

## 风险与代价

- 旧 Chat 会话下一轮拿到助手设定，回答风格可能和之前「无角色」略有不同；更新说明里写明。
- 旧的「聊天」定时任务选着 Agent 角色的，到点启动失败、保存（含停用）也被拒，用户要先换成 Chat 角色；按用户的决定不做兼容。
- 只有 Claude Code、Codex 的自带待办会被解析显示（CLI 定义的 `todos`）；Pi、Command Code 没有对应的待办事件，Chat 页不显示计划行，提示词让模型把计划写在回复里。
- 自建 Chat 角色不能在对话里临时换模型（`canPickRun` 只认空 id）。等用户提出再做。
- 导入一个 `scope: chat` 的角色后在项目里引用它，会在保存项目或工作流时被拒，界面显示原文。

## 开放问题

- Claude Code 的 `EnterPlanMode` 要不要在 Chat 里放开（用户说的「Agent 自带的计划模式」可能指它）：放开要确认面板能显示并批准 `ExitPlanMode`，否则对话会停在只读里。
- 「提问」开关关着时 Chat 的提问会被自动作答，要不要给 Chat 补一句「先把选项写在回复里」：倾向不补，和项目对话一致。
- 以后面板还要在 Chat 开别的面板专用角色时，把 `analysis` 放行抽成「面板专用」标记，不按名字堆分支。
