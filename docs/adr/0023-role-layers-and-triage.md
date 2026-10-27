# ADR 0023：角色分基本 / 高级两层，父对话先分诊再派单，可做护栏内的就地微改动

状态：已接受 · 2026-10-28

## 背景

用户 2026-10-27 提出：角色和对话位置绑死（顶层 = 统筹、子对话 = 执行、子任务 = 子任务），能力又被拆成一个个独立角色（文档、评审、测试验收、版本控制），用一次就要派一次子任务冷启动；父对话被规定「只统筹不动手」，改一个文案也要等子对话起来，也没有固定的「先分析、不懂就问、再决定怎么处理」的流程。要的效果像 Claude Code：在父对话里说一句，它自己分析、需要时追问、决定自己做还是分出去。

完整设计和取舍见 `docs/openspec/changes/role-composition-and-dispatch/design.md`，用户确认了其中 D1–D7 七项决策（按推荐），并说明不必受已有 ADR 约束。

## 事实核对

| 位置                                       | 改动前                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `shared/schema.ts` 的 `AgentInput`         | 只有 `canDelegate` / `canPlan` / `common` / `runIn` / `includes`；`includes` 把被引入角色的设定全文拼进来 |
| `shared/builtin/agents.ts` 的「统筹」      | 「只统筹不动手」：不改、不建、不删文件，改动再小也交给子对话                                              |
| `shared/engine.ts` 的 `conversationPrompt` | 父对话一段「你的定位：父对话只统筹，不动手」，固定注入                                                    |
| `shared/engine.ts` 的 `spawn`              | 点名的角色只要存在就能派；`runIn: 'parent'` 时转交父对话（ADR 0019）                                      |
| `server/orch-mcp.ts`                       | 没有就地加载能力的工具；派单工具没有分诊记录                                                              |

## 决策

**角色分两层；高级角色挂载基本角色并决定每个能力就地用还是派出；父对话（主理）每条消息先理解、澄清、分诊，分诊记录画成可改派的卡片；父对话可以在面板强制的护栏内就地做微小改动。**

1. **基本角色 / 高级角色**（`AgentInput.kind`，旧数据由 `roleKind` 推导：`canDelegate`、`canPlan` 或有挂载的是高级）。基本角色多了 `when`（什么时候用，进能力索引）、`modes`（允许就地 / 派出）、`independent`（必须独立视角，只能派出，评审是它）。
2. **挂载**（`AgentInput.mounts`）：高级角色挂基本角色，每个挂载有用法 `auto` / `inline` / `subtask` / `parent`、`preload`（就地用时全文常驻）、`rule`、`params`。用法超出能力允许的由 `mountMode` 收紧。只挂一层：高级角色不能挂高级角色。
3. **按需加载**：`composeRole` 只给挂载能力写一行索引（名字、什么时候用、用法、规则），`preload` 的才放全文；就地用时调用 `use_capability` 取全文（同一轮重复加载只回一句）。挂成「就地用」的能力不能再 `spawn_agents` 派出；挂成「转交父对话」的在子对话里点名时按 ADR 0019 转交。
4. **主理**（原「统筹」，key 仍是 `orchestrator`）：角色设定改成「理解 → 澄清 → 分诊 → 派发 → 汇总」流水线和一张分诊表；子对话的提问先由主理接，能答就答，要用户拍板的用 `ask_user` 带背景转问（「主理先接」）。「大改动先确认」默认打开。
5. **就地微改动**（`AgentInput.inlineEdit: 'off' | 'tiny'`，主理默认 `tiny`）：`begin_inline_edit` 声明文件（最多 2 个）和理由，面板拦下「子对话正在合回 / 合回后测试」「要改的文件被子对话认领、划了范围或正在改」；改动期间不能 `finish_child`、不能新开子对话；`end_inline_edit`（或这一轮结束时自动）按 git 真实改动核对文件数、行数（20 行）和没声明的文件，越界写一条警告。Bug、要排查的、改公共接口或数据格式的不走这里。
6. **分诊记录**（`Task.routes`）：`create_conversation`、`send_to_conversation`、`spawn_agents`、`begin_inline_edit` 带 `route`（理解、理由、假设），父对话的每次派出都记一条，界面在对应用户消息下画分诊卡，「改为就地 / 子任务 / 子对话」一键发改派消息给主理。
7. **子对话选角色**：`create_conversation` 的 `role` 只能写启用的高级角色（不含能开子对话的主理类），不写用「执行」。

没选的方案：

- **把文档、评审、测试验收、版本控制并回执行角色的设定里**：角色设定会膨胀到每次都全文注入，而且评审需要独立上下文，并进来就失去意义。挂载 + 按需加载既能就地用又保留独立派出。
- **高级角色可以挂高级角色**：提示词和权限推导都变成递归，「谁能开子对话」说不清；需要多能力时多挂几个基本角色就够。
- **父对话完全不改文件（维持现状）**：用户明确要「直接在当前对话处理」，改个文案冷启动一个子对话（二十万 token 起步）不值；风险用面板护栏兜住，`inlineEdit: off` 可以一键回到现状。
- **每条消息都调一次「分诊」工具**：多一次工具调用、多一段输出，就地回答的消息也要付；改成派出类工具带 `route` 参数，就地回答不出卡。
- **主理在父对话里直接起工作流（设计稿 D4 的一部分）**：改代码的工作流需要独立分支和收尾，只读的也交子对话按剧本跑更清楚；主理的 `canPlan` 保持关闭，工作流的主 Agent 规则不变（见「开放问题」）。

## 操作清单 / 契约

| 工具                                    | 谁有                                  | 参数                                   | 结果                                               |
| --------------------------------------- | ------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `use_capability`                        | 角色挂了能力的对话（父、子）          | `name`、可选 `params`                  | 能力全文 + Skill；只能派出、没挂载的拒绝并说怎么做 |
| `begin_inline_edit`                     | 项目父对话，角色 `inlineEdit: 'tiny'` | `files`（≤ 2）、`reason`、可选 `route` | 放行或拒绝原因；放行后记 `Task.inlineEdit` 基线    |
| `end_inline_edit`                       | 同上                                  | —                                      | 改了几个文件几行、没提交的文件、越界提示           |
| `create_conversation`                   | 父对话                                | 新增 `role`、`route`                   | 同前；记一条 `child` 分诊                          |
| `send_to_conversation` / `spawn_agents` | 父对话（`route` 只给父对话）          | 新增 `route`                           | 同前；记 `resend` / `subtask` 分诊                 |

## 与现有实现的关系

- 数据：`shared/schema.ts`（`AgentMount`、`AgentInput` 新字段、`TaskRoute`、`Task.inlineEdit`、`Task.routes`），旧数据全部按默认值读，不迁移。
- 逻辑：`shared/agent-role.ts`（`roleKind`、`mountMode`、`mountedAgents`、`capabilityIndex`、`loadCapability`）、`shared/inline-edit.ts`（护栏判定）、`shared/engine.ts`（工具实现、`spawn` 按挂载拦截 / 转交、分诊记录、父对话提示词）、`server/orch-mcp.ts`（工具定义）、`server/tasks.ts`（`beginInlineEdit` / `endInlineEdit`）。
- 内置定义：`shared/builtin/agents.ts`（主理、执行、分析是高级角色并带挂载；评审 `independent`）；`shared/builtin/core.ts` 的 `syncCore` 同步挂载（定义决定挂哪些，用户改的用法和参数取值保留）、`upgradeRunIn` 一次性把旧的统筹副本升级成 `inlineEdit: 'tiny'`、`DEFAULT_CHANGES` 把「大改动先确认」升级成默认开。
- 界面：角色详情新增「能力」页（`web/src/components/agents/CapabilityFields.tsx`），列表副标题写角色层；对话里的分诊卡（`web/src/components/tasks/RouteCard.tsx`）。
- 与已有 ADR：ADR 0019 的 `runIn` 保留，挂载用法 `parent` 是同一语义的挂载级覆盖；ADR 0015 的同步范围加上挂载；子对话收尾、评审门禁、测试分档（0005、0009、0013、0018、0020、0022）不变。

## 运行时

挂载在启动同步时由内置定义的 key 换成本机 id（`builtinMounts`），用户自建的高级角色在「能力」页里选。每轮对话 `makeOrchestra` 按调用者自己的角色算 `capabilities`、`inlineEdit`；`spawn` 先按挂载用法拦截就地能力，再按 `runIn` / 挂载 `parent` 决定转交。就地改动的护栏状态存在 `Task.inlineEdit`，重启后仍在，下一轮结束时会被自动收掉。失败一律以工具结果的错误文本交回模型，越界写成对话里的警告，不悄悄放过。

## 分期

一次做完：数据模型、按需加载、主理流水线、就地微改动、分诊卡、角色页「能力」。工作流主 Agent 改由宿主角色调度留作开放问题。

## 风险与代价

- 就地微改动可能重演「父对话自己查到底、自己改」（`docs/lessons/builtin.md` 记过）：护栏只放「不用排查、≤ 2 文件 ≤ 20 行」，越界有警告，角色设定写明 Bug 不走这里；不放心的项目在角色「能力」页关掉。
- 模型可能不调 `use_capability` 就凭印象做：常用的主能力用 `preload`，有门禁的能力（评审、收尾）门禁在面板，不靠模型记得。
- 父对话提示词变长了一段分诊表：换来的是少开子对话；能力全文改成按需加载后，执行角色的提示词总量不增。

## 开放问题

- **工作流的主 Agent 由宿主对话角色担任（设计稿 D4）**：倾向做，但要先验证宿主角色续接节点结果时上下文的增长。定下来之前保持现状：工作流自己的主 Agent 调度，主理不在父对话里起工作流。
- **分诊指标**（改派率、各去向的 token 和耗时）：数据已在 `Task.routes`，统计和展示放到工作总结页再做。
