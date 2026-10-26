# 内置 Agent 与工作流职责清单

这份清单是**判定标准**：新增、合并、删除内置 Agent 和工作流之前先对照它，避免又按具体操作把角色拆碎。

## 分工原则

1. **一个 Agent 管一个能力块**，不是管一个动作。能力块是「能独立交付一类结果」的职责，例如「测试与验收」交付带证据的结论；
   「跑单元测试」「跑 e2e」「编译」都是这一类里的具体步骤，交给参数和项目配置决定。
2. **具体做法由参数和项目配置决定**。同一个 Agent 在 Node 项目和 UE 项目里跑的命令不同，靠 `TestStep` 和 `AgentParam` 区分，
   不靠新建 Agent。
3. **工作流负责顺序和门禁**，Agent 负责一类工作。工作流里不要为了「多一个节点」而引入职责重复的 Agent。
4. **通用 Agent（`common: true`）之间不能重复**：同一件事只能有一个通用 Agent 能接（`server/agent-params.test.ts` 会检查测试 Agent 只有一个）。

## 判定标准

| 判定     | 什么时候用                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **删除** | 职责被别的 Agent 完整覆盖；没有任何内置工作流用到；只是换个名字的重复项                                                            |
| **合并** | 同一能力块被切成多个（例如测试 / 验收 / 编译那四个，`docs` 和 `docsync`）                                                          |
| **扩充** | 能力块太大但缺参数或交付标准，换个项目就不能用（例如测试 Agent 缺环境 / 范围参数；版本控制缺 SVN、分支 / worktree 模式和合并方向） |
| **新增** | 现有能力链里确实缺这个角色，且不会被同批 Agent 顺手做掉                                                                            |

新增时的硬条件：写清职责、参数、要用的 Skill（必须是 `skills/` 里存在的，或 `{{槽名}}`），
并且回答「为什么现有 Agent 做不了」。

## 必备角色

`orchestrator`（统筹）、`worker`（执行）、`docsync`（文档）、`reviewer`（评审）、`tester`（测试验收）、`vcs`（版本控制）、`helper`（子任务）、`analyzer`（分析）是项目对话离不开的八个能力块，
定义在 `shared/builtin/core.ts`：启动时自动装好、不能删除，名称、角色设定、Skill、能力开关和参数定义每次启动按内置定义同步，
用户只能改参数取值和运行配置（CLI、模型、思考强度、权限），项目里还能在 `Project.agentParams` 按项目覆盖参数。
它们之间靠名字协作（统筹和执行把要落盘的文档派给「文档」、把验证派给「测试验收」、收尾时在完整测试前派「评审」、把改完文件后的版本管理交给「版本控制」），所以不能被改成别的角色。
「评审」的时机是子对话收尾：改完并跑过快速检查之后、跑完整测试和编译之前，派它看限定范围的 diff。
评审必须在子对话的计划里占一条独立的主步骤（标 `review: true`）：派的时候标等待中、拿回结论后标完成，
计划面板上能看到这一步和它的状态；按意见修改、复看也各自单列成步。
`submit_merge` 前面板会校验：计划里有标 `review` 的步骤、那一步已完成、评审第一行写了验收结论
（`shared/review-gate.ts`；先读首行，首行没有结论才退回全文最后一条——子任务输出太长时只保留开头，结论写在末尾会被截掉）；
评审列了高级（🔴）或中级（🟠）时，执行角色要逐条写处置（`review_triage`）才合得回去；评审只看代码、不跑测试（[ADR 0010](adr/0010-review-code-only.md)）。
「分析」是面板上所有「AI 分析」「AI 排查」开出的对话默认用的角色，开在哪里由 `shared/analysis-home.ts` 统一决定（见 [ADR 0014](adr/0014-ai-analysis-home.md)）。
「子任务」（`helper`）保留定义、但**不作为可选角色展示**：它是 `spawn_agents` 不点名时的默认执行角色（`shared/engine.ts` 按 `isHelperAgent` 找它），删了所有子任务就没有默认角色和提示词了；
角色页、内置角色弹窗和角色选择器都按 `shared/builtin/core.ts` 的 `listableAgents` 把它去掉，计数、分组、搜索也不算它，停用和删除由必备角色保护拦下。
改这几个的定义时不用补旧指纹，同步会直接换成新版本；只要保证参数 key 不乱改（改了 key 用户填的值会丢）。
其他内置角色也一样（[ADR 0015](adr/0015-builtin-roles-follow-definition.md)）：设定由面板维护、每次启动和保存都按定义同步，用户只改参数取值、运行配置、分类、标签和启用；区别只是可以删除、可以停用。

### 在哪类对话里能启动（禁止子对话执行）

角色上有一个运行方式开关，字段内部名 `runIn`，界面上叫「禁止子对话执行」，语义是**子对话里不能执行这个角色**（见 [ADR 0019](adr/0019-agent-run-in-parent.md)）：

- `any`（默认）：任何对话里都能直接派它，行为和以前完全一样。
- `parent`：子对话里点名它时不在子对话里跑，面板把它转交父对话创建子任务；子对话点名的计划步骤立即标完成、不挂等待，收尾不被它拦住。
  父对话接不了（没有父对话、父对话自己也是被派出来的子对话）时 `spawn_agents` 返回明确原因，不静默。
- 内置角色默认值：只有 `docsync`（文档）是 `parent`——补文档是长活，而且不依赖子对话本地的分支和 diff。
  `tester`、`vcs`、`reviewer` 保持 `any`：测试重活由 [ADR 0018](adr/0018-test-steps-run-in-parent.md) 的「测试步骤只在父对话里跑」兜住，版本控制在子对话里本来就禁止派，评审必须在子对话看本地 diff。
- 用户可以给任意角色（包括内置角色）改这个开关，保存后下一次 `spawn_agents` 立即生效；内置角色的设定同步（`syncCore`）保留用户选的值，只对已装的旧副本做一次「文档」默认值升级。

## Agent 清单

| key            | 名称             | 能力块                     | 通用 | 用到它的工作流                                                       | 关键参数                                                                        |
| -------------- | ---------------- | -------------------------- | ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `rules`        | 通用约束         | 常驻规则                   | —    | 全部（includes）                                                     | —                                                                               |
| `orchestrator` | 统筹（必备）     | 项目对话调度               |      | general、ue（主 Agent）                                              | `vcs` `route` `split` `confirm` `report`                                        |
| `worker`       | 执行（必备）     | 子对话执行                 |      | 项目对话运行路径                                                     | `vcs` `mode` `batch` `verify` `commit`                                          |
| `helper`       | 子任务（必备）   | 并行收集、核实、计划       |      | —（spawn_agents 不点名时默认用它，不作为可选角色展示）               | —                                                                               |
| `docsync`      | 文档（必备）     | 文档落盘                   | ✓    | 改代码的工作流最后一个节点都是它；architecture、release              | `docRoot` `lang` `index` `adr` `bug`                                            |
| `tester`       | 测试验收（必备） | 构建/测试/验收             | ✓    | openspec（延期验证项）、migration（旧数据验证）、release（产物验证） | `scope` `env` `regress` `onFail` `write` `serial`                               |
| `explorer`     | 调研             | 只读调研（可回写模块文档） | ✓    | ue、review                                                           | `target`（定位代码 / 影响面 / 外部资料）`depth` `stack` `focus` `tests` `scene` |
| `reviewer`     | 评审（必备）     | 独立评审与复核             | ✓    | review；子对话收尾前由执行角色直接派                                 | `target`（代码改动 / 方案或结论）`vcs`                                          |
| `analyst`      | 方案设计         | 需求、方案与架构契约       |      | general、ue、openspec、architecture、migration                       | `scene` `scale`（spike / bounded / architectural）`grill` `stack`               |
| `spec`         | 规范撰写         | OpenSpec 产物与门禁        |      | openspec                                                             | `scene` `stage`                                                                 |
| `developer`    | 开发             | 写代码                     |      | general、ue、openspec、bugfix、migration                             | `task`（实现 / 修 Bug / 性能问题）`scene` `lang` `vcs` `tdd` `records`          |
| `deps`         | 依赖与安全       | 依赖体检与升级             |      | deps                                                                 | `vcs` `mode` `audit` `license`                                                  |
| `vcs`          | 版本控制（必备） | 版本控制与交付收尾         | ✓    | release（发布范围）；子对话没有 submit_merge 时由执行角色派          | `vcs` `branch` `merge` `mergeReview` `commit`                                   |
| `blender`      | Blender 建模     | 建模、动画与质检           |      | blender                                                              | `stage`（含「质检」）                                                           |
| `worklog`      | 每日工作总结     | 按天汇总报告（只读）       |      | general                                                              | `day` `projects`                                                                |

`worklog`（每日工作总结）是唯一只输出报告的角色：`docsync` 负责写文档、`explorer` 只读调研代码、`orchestrator` 负责调度，
没有谁会按天把各项目执行过的对话压成一份报告，所以单独新增；它不动代码（`canPlan` / `canDelegate` 都关、不引 Skill）。
它挂进「通用项目」的 `members`：`ensureProjectAgents` 启动时按 `builtinAgentKeys(GENERAL)` 补建角色，
挂在这里才能保证它跟着最基础的安装集合一起建出来。

不用角色就是直接用 CLI：以前自带的「默认 Agent」已经去掉，Chat 页、默认工作流、AI 修复都不带角色，
旧数据里的 `default-agent` 读出来就是空字符串（`shared/schema.ts` 的 `dropLegacyAgent`）。

### 已合并的 Agent

这些 key 不再出现在 `BUILTIN_AGENTS` 里。启动时按 `MERGED_AGENTS` 处理用户机器上的旧副本：

1. 所有工作流（包括用户改过的）里指向旧副本的节点、步骤、主 Agent、成员改指到合并目标，节点参数按 `params` 换算；
   项目的默认对话角色也改过去。合并目标本机没有时先建出来。
2. 没人再引用、也没被用户改过（和 `LEGACY_AGENT_FIELDS*` 里的指纹一致）的旧副本删掉，
   删之前备份到数据目录的 `config/backup/`，旧 id → 新 id 记在 `config/agent-aliases.json`，
   旧对话、旧快照里的引用读出来时按它改写（`setAgentAliases`）。
3. 用户改过的、还被用着的保留，简介后面补一句合并说明。

| 旧 key         | 合并到      | 参数换算                                          | 原因                                         |
| -------------- | ----------- | ------------------------------------------------- | -------------------------------------------- |
| `verifier`     | `tester`    | —                                                 | 「跑验证 + 给验收结论」和测试 Agent 完全重合 |
| `projecttest`  | `tester`    | —                                                 | 只是换了个名字的测试 Agent                   |
| `ueintegrator` | `tester`    | —                                                 | 编译只是项目测试步骤里的一条                 |
| `docs`         | `docsync`   | —                                                 | 和 `docsync` 逐字重复，只差一个用途          |
| `deliver`      | `vcs`       | —                                                 | 和 `vcs` 逐字重复，推送授权说明已并入        |
| `researcher`   | `explorer`  | `target=外部资料`                                 | 只读查资料和只读查代码是同一个能力块         |
| `impact`       | `explorer`  | `target=影响面`                                   | 影响面分析就是带范围的只读调研               |
| `uescout`      | `explorer`  | `target=影响面` `stack=ue`（`focus` 原样保留）    | UE 侦察只是技术栈不同                        |
| `second`       | `reviewer`  | `target=方案或结论`                               | 复核结论和评审改动都是「独立找错」           |
| `architect`    | `analyst`   | `scale=architectural`（`stack` 原样保留）         | 架构方案是方案设计的一个规模档               |
| `debugger`     | `developer` | `focus=性能问题` → `task=性能问题`，否则 `修 Bug` | 修 Bug、查性能和实现都是写代码               |
| `blenderqa`    | `blender`   | `stage=质检`                                      | 质检是建模流程里的一个阶段                   |

## 工作流清单

自带工作流**启动时全部自动加入**（用户 2026-10-25 改掉了 10-19「手动添加」的决定），用到的角色随之建好；
装过的 key 记在数据目录的 `config/builtin-workflows.json`，用户删掉的不再装回来（「通用项目」「UE 项目」缺了照样补），
以后新加的自带工作流下次启动自动装上。删掉的可以在工作流页的「内置工作流」里重新添加。

### 改代码的工作流只做到「实现 + 快速检查 + 文档同步」

改代码的工作流由子对话（执行角色）用 `start_plan` 启动，只是子对话计划里的一个主步骤。收尾前评审（[ADR 0013](adr/0013-review-diff-only-with-brief.md)）、
评审后的完整测试和编译、`submit_merge` 合回父对话分支都由执行角色在工作流之后做，所以工作流里**不放**：

- 评审节点：评审要带交接单、只看 diff，由执行角色派，计划里单列一步；
- 完整验收（`review: 'check'` 挂测试验收）：那会把完整测试跑在评审前面，评审改完还得再跑一次；
- 提交 / 交付节点（`vcs`）：独立分支里收尾就是 `submit_merge`，没有它时执行角色自己派「版本控制」；
- UE 编译：编译归父对话（[ADR 0004](adr/0004-ue-build-by-parent.md)），子对话评审后申请。

实现节点改完只跑项目测试步骤里标「快速」的检查；最后一个节点是「文档」同步，Bug 记录只记用户报的 Bug。
测试步骤照样注入这些工作流的说明：带 `project-testing` 技能的角色（开发、执行、依赖）也算要跑测试（`withTestSteps`）。

| key               | 名称                 | 适用场景                               | 主 Agent       | 节点                                                                                   |
| ----------------- | -------------------- | -------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `project-general` | 通用项目             | 项目默认、边界清楚的功能和改动         | `orchestrator` | analyst（识别现场与方案，确认）→ developer → docsync                                   |
| `project-ue`      | UE 项目              | UE 的 C++ / Lua 改动                   | `orchestrator` | explorer（ue 侦察）→ analyst（确认）→ developer（不编译）→ docsync                     |
| `openspec`        | 功能开发（OpenSpec） | 需要完整规范的复杂功能                 | `developer`    | spec → analyst → spec（门禁）→ developer → tester（延期验证项）→ spec（归档）→ docsync |
| `migration`       | 数据与配置迁移       | 改 schema / 数据格式 / 配置结构        | `developer`    | analyst（含读写方）→ developer → tester（旧数据验证）→ docsync                         |
| `bugfix`          | Bug 修复             | `worker.mode=总是按工作流` 时的 Bug    | `developer`    | developer 修 Bug → docsync（用户报的 Bug 记录）                                        |
| `architecture`    | 架构设计             | 新模块架构或现有架构评审               | `analyst`      | analyst（architectural）→ analyst（压测）→ docsync（ADR 一律写）                       |
| `review`          | 代码评审             | 评审分支 / 提交 / changelist，全程只读 | `reviewer`     | explorer（整理评审交接单）→ reviewer（只评改动的行）                                   |
| `deps`            | 依赖升级与安全       | 过期、漏洞、大版本升级                 | `deps`         | deps 体检（确认）→ deps 分批升级 → docsync                                             |
| `release`         | 发布与回滚           | 出包前的范围、产物验证和回滚预案       | `vcs`          | vcs（发布范围）→ tester（产物验证）→ docsync（发布说明 + 回滚）；发布由父对话做        |
| `blender`         | Blender 建模与动画   | 可拆分模型、动画、导出 UE              | `blender`      | blender 按阶段：规格 → 建模 → 装配到减面 → 质检 → 导出                                 |

### 已合并的工作流

启动时按 `RETIRED_WORKFLOWS`（`shared/builtin/workflows.ts`）处理本机副本：和合并前的定义（`shared/builtin/legacy-workflows.ts`）一致的删掉，
项目和项目分类里指向它的（默认工作流、可选列表、暴露项取值）改指到接替的那个；用户改过的保留。

| 旧 key      | 合并到            | 原因                                                                           |
| ----------- | ----------------- | ------------------------------------------------------------------------------ |
| `daily-dev` | `project-general` | 和「通用项目」的主流程是同一件事                                               |
| `ue-dev`    | `project-ue`      | 和「UE 项目」的主流程是同一件事                                                |
| `bootstrap` | `project-general` | 项目设置里的「AI 初始化项目」已经写 AGENTS.md 和文档框架、推荐测试步骤和工作流 |

改工作流定义时把改前那一版追加进 `LEGACY_WORKFLOWS`（只登记真改了的，登记了没变的会每次启动重写一遍），没改过的副本启动时升级。

### 为什么留着这三个补环节的

| 工作流                     | 缺口                                     | 为什么现有 Agent 做不了                                                |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `deps` 依赖升级与安全      | 没有任何一步会看依赖的漏洞和过期         | `tester` 只跑配置好的步骤；升级依赖需要「体检 → 分批 → 验证」的闭环    |
| `migration` 数据与配置迁移 | 迁移需要「迁移脚本 + 回滚 + 旧数据验证」 | 普通功能开发没有回滚和旧数据样本验证这个环节                           |
| `release` 发布与回滚       | 现有流程只做到合回父对话分支             | 发布范围、产物验证和回滚预案需要有顺序保证；对外的发布动作仍由父对话做 |

**没新增的**：性能排查（用 `developer.task` 扩充）、跨环境适配（由 `testSteps` + Agent 参数派生覆盖）、
安全审计之外的安全加固（`deps.audit` + `reviewer` 覆盖）、文档工程（`docsync.adr` 覆盖）、
Git / Perforce / SVN 分开建角色（版本控制本来就是同一个能力块，按 `vcs` 参数和 project-vcs 技能里的细则区分）。

## Bug 怎么分工

参考 Claude Code 找 Bug 的习惯（先钉住现象、用报错原文限定搜索、只读出错的那条路径、先看最近改动、拿不准就加日志或写测试复现、找到能解释现象的原因就修），
整理成「按模块逐层定位」，正文是 `shared/builtin/agents.ts` 的 `BUG_METHOD`，`systematic-debugging` 技能里有同样的「查到哪一层为止」：

| 谁                                         | 做到哪                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 父对话（`orchestrator`）                   | 只定位到模块：看现象、报错原文、用户点名的部分和模块文档，不找具体哪一行、不试着修；把现象、复现、模块入口交给子对话                 |
| 子对话（`worker`）                         | 从用户点名的模块或父对话交来的模块开始，在这一层查清楚才下一层；找到能完整解释现象的原因就修、修完就停；下到第三层还没找到就停下报告 |
| 工作流节点（`developer` 的 `task=修 Bug`） | 同一套方法，用在「Bug 修复」工作流里                                                                                                 |

**不新增找 Bug 的角色**：`debugger` 已经合并进 `developer`（见上面的合并表），方法差异放在角色设定里，不再拆一个角色。

**Bug 不固定启动工作流**：子对话默认（`worker.mode=自动`）在对话里直接按方法找和修。定位时下一步查哪里取决于上一步查到了什么，
拆成固定节点每次交接都会丢掉中间线索；验证和提交子对话本来就会做（合并编译、测试验收）。
`worker.mode=总是按工作流` 时才用「Bug 修复」工作流，它的节点用的是同一套方法。
