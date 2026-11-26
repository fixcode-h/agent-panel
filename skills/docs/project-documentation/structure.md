# 项目文档管理 · 目录结构与各文档职责

入口 `SKILL.md` 指到这里时读：要新建文档、拿不准一类内容该写进哪个文件、或要分模块时。

## 推荐结构

```text
DOC_ROOT/
├── README.md                 # 项目入口、用途、快速开始和文档索引
├── MODULE-MAP.md             # 可选：模块路径、职责、入口和关联文档
├── modules/<模块名>/
│   ├── README.md             # 模块职责、入口、依赖、边界、数据流、陷阱、回归验证
│   ├── bugs.md               # 第一次记录这个模块的 Bug 时才建：Bug 索引（有生成脚本时不手工编辑）
│   └── bugs/<bug-id>.md      # 单个 Bug 的根因、修复和回归（手写，元数据头生成索引）
├── CONTEXT.md                # 领域术语和概念边界（有稳定术语时才建）
├── CONTEXT-MAP.md            # 多个上下文之间的关系（只有多个上下文时才建）
├── architecture.md           # 当前已落地的架构快照
├── adr/                      # 难逆转、有真实权衡的决策
├── tech/                     # 资产、API、持久化等跨模块契约
├── runbooks/                 # 构建、部署、迁移和排障操作
├── openspec/                 # 用 OpenSpec 流程时：specs/ 和 changes/<change>/
├── contributing.md           # 人类开发者协作说明
├── p4change/                 # 仅 P4 项目：外部文件变更台账（各分支共用 DOC_ROOT 时在 branches/<分支>/p4change/）
├── lessons/<id>.md           # 项目教训，一条一个文件，由面板维护
├── agent-knowledge/experience/<id>.md  # 项目经验（找位置、叫法、命令），由面板维护
└── CHANGELOG.md              # 有发布或用户可感知变化时维护
```

`tests/` 属于 `PROJECT_ROOT`，跟随代码的版本控制；测试结果、验收命令和报告属于 `DOC_ROOT`。**没有内容依据的类别不建空文件或空目录**：`adr/`、`tech/`、`runbooks/`、`openspec/`、`bugs.md` 都在第一次有内容时才建。

## 模块怎么划

模块按职责划，不按目录层级机械地取一级目录：

- 一级目录就是职责边界时（`server/`、`web/`、`shared/`）直接用它。
- 代码都在 `src/` 下时往下一层，按 `src/<子目录>` 划。
- monorepo 按包（`packages/*`、`apps/*`）划；UE 项目按 `Source/<模块>` 和 `Plugins/<插件>` 划，Lua 脚本按功能目录划。
- 资源、生成物、第三方代码（`vendor/`、`ThirdParty/`、`Content/`）不建模块文档，在文档根 README（或已有的模块地图）里一行说明即可。
- 小项目（不到 3 个职责块）不拆模块，只写 `README.md`，也不建 `CONTEXT.md`、文档根索引；大项目不预先列全：模块第一次用到时才建文档（见「模块文档：按需建、简要」），按构建文件定模块（UE 按 `Build.cs`、Node 按包）。

模块名用目录名或项目里通用的叫法，不自造名字。

## 文档职责

- `modules/<模块名>/README.md`：职责、入口、依赖、边界、数据流、扩展点、常见陷阱、回归测试、证据来源和待确认项。
- `modules/<模块名>/bugs.md`：按症状、关键词、入口、根因类型、状态和单 Bug 文档链接帮助检索，不重复排查过程。项目有生成脚本时**它是生成物，不要手工编辑**：内容由同目录 `bugs/<bug-id>.md` 的元数据头按 ID 字母序聚合而成，改完详情文件跑一次生成脚本；没有脚本时按同样的字段手工加一行（见下面「Bug 索引的生成」）。
- `modules/<模块名>/bugs/<bug-id>.md`：现象、复现条件、影响范围、根因、排查路径、修复、回归测试和防复发护栏。
- 什么样的问题写 Bug 记录：见入口 `SKILL.md` 的「Bug 记录」。
- `CONTEXT.md` 只记稳定术语、概念定义和边界；`CONTEXT-MAP.md` 只记多个上下文的关系、责任边界和交叉术语。
- `architecture.md` 只描述当前已落地的模块、依赖、数据流和运行边界；架构变了同步更新。
- `adr/` 只记难逆转、缺少背景会令人困惑、且确实有取舍的决策；被替代的 ADR 标状态并链接新 ADR。
- `tech/` 记跨模块必须遵守的资产、API、持久化和兼容性契约；已有 schema 或生成文档时引用它们，不维护重复字段表。
- `runbooks/` 记人能照做的构建、部署、迁移和排障步骤，关键命令写适用条件和验证结果。
- `openspec/specs/` 是已确认行为的规范；`openspec/changes/<change>/` 记一个变更从提案到验收的过程，不当永久架构总览。
- `contributing.md` 面向人类开发者，不替代 AGENTS.md。
- `CHANGELOG.md` 只记发布或用户可感知的变化。
- P4 项目的 `p4change/<任务标识>.p4change.md` 只记文件操作时间线和 P4 证据。

## 读取顺序

开始开发前按需读：`AGENTS.md` → `README.md` → `MODULE-MAP.md`（有的话）→ 对应模块 README（和 `bugs.md`）→ `CONTEXT.md` → `architecture.md` → 相关 ADR、技术契约、runbook 和当前 OpenSpec change。小改动不必读全部。

分析某个模块时：先读模块 README（和 `MODULE-MAP.md`，有的话），再读模块入口、配置和必要代码。分析完把确认的职责、入口、依赖、边界、数据流、扩展点、陷阱和回归验证写回模块 README，没有证据的留在「待确认」；有手写的 `MODULE-MAP.md` 时同时修正受影响的行。模块文档和代码不一致时以代码、配置和测试为准，回写文档，不沿用已知过期的内容。

## 规范与交付状态

区分三个状态：**工作区已实现**（本地通过验证，可能还没提交）、**已提交**（进入版本控制历史：Git commit、P4 submit 等）、**已发布**（用户能拿到的版本已更新）。不把「仅工作区已实现」写成已提交或已发布；提前记录时标注「已验收，待提交」。
