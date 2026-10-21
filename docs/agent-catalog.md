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

| 判定     | 什么时候用                                                                         |
| -------- | ---------------------------------------------------------------------------------- |
| **删除** | 职责被别的 Agent 完整覆盖；没有任何内置工作流用到；只是换个名字的重复项            |
| **合并** | 同一能力块被切成多个（例如测试 / 验收 / 编译那四个，`docs` 和 `docsync`）          |
| **扩充** | 能力块太大但缺参数或交付标准，换个项目就不能用（例如测试 Agent 缺环境 / 范围参数） |
| **新增** | 现有能力链里确实缺这个角色，且不会被同批 Agent 顺手做掉                            |

新增时的硬条件：写清职责、参数、要用的 Skill（必须是 `skills/` 里存在的，或 `{{槽名}}`），
并且回答「为什么现有 Agent 做不了」。

## 必备角色

`orchestrator`（统筹）、`worker`（执行）、`docsync`（文档）、`tester`（测试验收）是项目对话离不开的四个能力块，
定义在 `shared/builtin/core.ts`：启动时自动装好、不能删除，名称、角色设定、Skill、能力开关和参数定义每次启动按内置定义同步，
用户只能改参数取值和运行配置（CLI、模型、思考强度、权限），项目里还能在 `Project.agentParams` 按项目覆盖参数。
它们之间靠名字协作（统筹和执行把要落盘的文档派给「文档」、把验证派给「测试验收」），所以不能被改成别的角色。
改这四个的定义时不用补旧指纹，同步会直接换成新版本；只要保证参数 key 不乱改（改了 key 用户填的值会丢）。

## Agent 清单

| key            | 名称             | 能力块              | 通用 | 用到它的工作流                                                                        | 关键参数                                            |
| -------------- | ---------------- | ------------------- | ---- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `rules`        | 通用约束         | 常驻规则            | —    | 全部（includes）                                                                      | —                                                   |
| `explorer`     | 代码侦察         | 只读定位            | ✓    | bootstrap                                                                             | `depth`                                             |
| `researcher`   | 资料调研         | 查资料              | ✓    | —（作为子任务被派）                                                                   | —                                                   |
| `tester`       | 测试验收（必备） | 构建/测试/验收      | ✓    | general、ue、daily-dev、openspec、bugfix、ue-dev、bootstrap、deps、migration、release | `scope` `env` `regress` `onFail` `write` `serial`   |
| `second`       | 复核员           | 独立复核            | ✓    | —（作为子任务被派）                                                                   | —                                                   |
| `analyst`      | 需求分析师       | 需求与方案          |      | general、ue、daily-dev、openspec、ue-dev、architecture、migration                     | `scene` `scale` `grill`                             |
| `architect`    | 架构师           | 架构契约            |      | architecture                                                                          | `scene` `stack`                                     |
| `spec`         | 规范撰写         | OpenSpec 产物与门禁 |      | openspec                                                                              | `scene` `stage`                                     |
| `developer`    | 开发者           | 实现                |      | general、ue、daily-dev、openspec、bugfix、ue-dev、migration                           | `lang` `vcs` `tdd` `records`                        |
| `debugger`     | 调试员           | 定位与修复          |      | bugfix                                                                                | `scene` `lang` `vcs` `focus`（功能缺陷 / 性能问题） |
| `deps`         | 依赖与安全       | 依赖体检与升级      |      | deps                                                                                  | `vcs` `mode` `audit` `license`                      |
| `reviewer`     | 评审员           | 代码评审            |      | review                                                                                | `vcs`                                               |
| `impact`       | 影响面分析       | 影响面与测试缺口    |      | openspec、review、migration                                                           | `tests`                                             |
| `docsync`      | 文档（必备）     | 文档落盘            | ✓    | general、ue、ue-dev、architecture、bootstrap、release、migration                      | `docRoot` `lang` `index` `adr` `bug`                |
| `vcs`          | 交付员           | 版本控制收尾        |      | general、ue、ue-dev、daily-dev、openspec、bugfix、deps、release、migration            | `vcs` `docs` `bug` `commit`                         |
| `orchestrator` | 统筹（必备）     | 项目对话调度        |      | general、ue、bootstrap                                                                | `vcs` `route` `split` `confirm` `report`            |
| `worker`       | 执行（必备）     | 子对话执行          |      | 项目对话运行路径                                                                      | `vcs` `mode` `batch` `verify` `commit`              |
| `uescout`      | UE 侦察          | UE 只读侦察         |      | ue、ue-dev                                                                            | `scene` `focus`                                     |
| `blender`      | Blender 建模师   | 建模与动画          |      | blender                                                                               | `stage`                                             |
| `blenderqa`    | Blender 质检     | 模型质检            |      | blender                                                                               | —                                                   |

### 已合并的 Agent

这些 key 不再出现在 `BUILTIN_AGENTS` 里；用户机器上的旧副本**不删除**（旧工作流可能还在引用），
只在简介后补一句说明见 `MERGED_AGENTS`，并把引用重定向到合并目标（见下面的升级）。

| 旧 key         | 合并到    | 原因                                         |
| -------------- | --------- | -------------------------------------------- |
| `verifier`     | `tester`  | 「跑验证 + 给验收结论」和测试 Agent 完全重合 |
| `projecttest`  | `tester`  | 只是换了个名字的测试 Agent                   |
| `ueintegrator` | `tester`  | 编译只是项目测试步骤里的一条                 |
| `docs`         | `docsync` | 和 `docsync` 逐字重复，只差一个用途          |
| `deliver`      | `vcs`     | 和 `vcs` 逐字重复，推送授权说明已并入        |

## 工作流清单

| key               | 名称                 | 适用场景                               | 主 Agent       | 节点用到的 Agent                                                                       |
| ----------------- | -------------------- | -------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `daily-dev`       | 日常开发             | 边界清楚的功能和改动                   | `developer`    | analyst → developer（验收：tester）→ vcs                                               |
| `openspec`        | 功能开发（OpenSpec） | 需要完整规范的复杂功能                 | `developer`    | spec → analyst → spec（门禁）→ impact → developer（验收：tester）→ tester → spec → vcs |
| `bugfix`          | Bug 修复             | Bug、测试失败、线上问题                | `debugger`     | debugger（验收：tester）→ vcs                                                          |
| `ue-dev`          | UE 功能开发          | UE 的 C++ / Lua 改动                   | `developer`    | uescout → analyst → developer（验收：tester 编译）→ vcs                                |
| `architecture`    | 架构设计             | 新模块架构或现有架构评审               | `architect`    | architect → analyst → docsync（ADR 一律写）                                            |
| `review`          | 代码评审             | 评审分支 / 提交 / changelist，全程只读 | `reviewer`     | impact → reviewer                                                                      |
| `blender`         | Blender 建模与动画   | 可拆分模型、动画、导出 UE              | `blender`      | blender → blenderqa → blender → blenderqa → blender                                    |
| `bootstrap`       | 项目初始化           | 第一次接一个项目                       | `orchestrator` | explorer → docsync → tester（确认测试步骤）                                            |
| `deps`            | 依赖升级与安全       | 过期、漏洞、大版本升级                 | `deps`         | deps → deps（验收：tester）→ vcs                                                       |
| `migration`       | 数据与配置迁移       | 改 schema / 数据格式 / 配置结构        | `developer`    | analyst → impact → developer（验收：tester）→ tester（旧数据验证）→ vcs                |
| `release`         | 发布与回滚           | 出包、发版本、回滚预案                 | `vcs`          | vcs → tester（产物验证）→ docsync（发布说明 + 回滚）→ vcs                              |
| `project-general` | 通用项目             | 项目常驻流程（默认）                   | `orchestrator` | 需求与现状 → 方案与实现 → 文档与交付；另有文档初始化、测试验证、验收三条流程           |
| `project-ue`      | UE 项目              | UE 项目常驻流程                        | `orchestrator` | 识别与侦察 → 确认方案 → 实现 → 文档同步 → 交付；另有文档初始化、编译验收               |

### 为什么只新增这四个

| 新增                       | 缺口                                       | 为什么现有 Agent 做不了                                                                                    |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `bootstrap` 项目初始化     | 所有现有流程都假设文档根、测试步骤已经配好 | `docsync` 只同步已有改动；测试步骤要真的跑一遍才知道对不对，这是 `tester` 的活，但顺序和确认点需要独立流程 |
| `deps` 依赖升级与安全      | 没有任何一步会看依赖的漏洞和过期           | `tester` 只跑配置好的步骤；`impact` 只读代码；升级依赖需要「体检 → 分批 → 验证」的闭环                     |
| `migration` 数据与配置迁移 | 迁移需要「迁移脚本 + 回滚 + 旧数据验证」   | 普通功能开发没有回滚和旧数据样本验证这个环节                                                               |
| `release` 发布与回滚       | 现有流程只做到本地提交                     | 出包、产物验证、回滚预案和授权检查需要有顺序保证                                                           |

**没新增的**：性能排查（用 `debugger.focus` 扩充）、跨环境适配（由 `testSteps` + Agent 参数派生覆盖）、
安全审计之外的安全加固（`deps.audit` + `reviewer` 覆盖）、文档工程（`docsync.adr` 覆盖）。
