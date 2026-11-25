# OpenSpec · 阶段 0 前置检查、阶段 1 需求收敛

通用规则和命令用法见同目录的 `SKILL.md`。

## 阶段 0 · 前置检查（缺什么装什么）

1. 按 `project-documentation` 的规则确定 `PROJECT_ROOT` 与 `DOC_ROOT`；确认后所有 OpenSpec CLI、斜杠指令、文件读写和归档都只针对这同一个 `DOC_ROOT`。
2. `openspec --version` 可执行；命令不存在时直接 `npm install -g @fission-ai/openspec@latest` 安装，装完再确认版本，不先停下问用户。所有 OpenSpec CLI 命令 MUST 在 `DOC_ROOT` 下运行（`openspec new change` 也在此目录）；从别处运行会输出空列表或直接报错，容易误判成「无未归档 change」。每次调用前显式设置到 `DOC_ROOT`，第一步失败时先检查当前目录再下结论。未初始化时直接在 `DOC_ROOT` 下 `openspec init --tools <当前 CLI> --no-animation .`（`--tools` 取 `claude` / `codex` / `command-code` / `pi` 中对应当前 CLI 的值，`openspec init --help` 列出全部可选值）。
3. 当前 CLI 的 OpenSpec 指令文件存在：`/opsx-propose`、`/opsx-apply`、`/opsx-archive`（其他写法见 `SKILL.md`「OpenSpec 命令怎么用」）。缺失时在 `DOC_ROOT` 下重跑上面的 `openspec init --tools <当前 CLI> --no-animation .` 补装（已初始化的项目只补指令文件，不动已有 specs 和 changes），装好继续。指令文件装在 `DOC_ROOT` 下，斜杠菜单里看不到不算缺失，用到时读文件照着做。只有安装或初始化本身失败才停止，并报告命令和完整报错；不臆造指令，也不手工模拟其产物。
4. 扫描 `DOC_ROOT/openspec/changes/`：每个子目录必须有 `.openspec.yaml`。缺失者视为非 OpenSpec 目录，不复用、不修改、不归档，报告并建议迁到 `DOC_ROOT/worklog/<task-id>/`。`openspec/changes/` 只允许 `openspec new change` 创建目录，非 OpenSpec 的任务记录不得放进来。

## 阶段 1 · 需求收敛 + 压测

需要时配合 `brainstorming`（澄清目标、范围、约束，2–3 个方案，一次性设计摘要：目标、非目标、技术路线、验收标准初稿）和 `grilling`（压测设计树）技能。决策分三类处理：

- **用户决策**：影响目标、非目标、技术路线、验收标准、对外行为或不可逆结果的，必须问用户。
- **机械决策**：change 名称（kebab-case）、目录与文件布局、命名、格式，由 Agent 按项目约定自决，在 `grilling.md` 标注「Agent 自决」，不打断用户。
- **事实**：自己查，不问用户。

**确认内容**：先完成路径检查，再用一次选择交互同时取得两项结论，不拆成两次打断。

- 路径检查：用 `openspec list` / `openspec status --change <名字>` 检索未归档 change，检查 `DOC_ROOT/openspec/specs/` 下的主 specs；按领域对象、需求边界、验收标准和实现范围判断是否存在强关联候选，不得仅凭关键词相似。
- 一次交互包含：(a) 设计共识（目标/非目标/技术路线/验收标准）是否确认；(b) 承载方式 ——「新建规范」，或「增补已有规范」（仅在存在强关联候选时展示，选项描述写明候选路径和关联依据；若只有主 spec 强关联，则基于它新建承载本次 delta 的 change，不直接改主 spec）。不得替用户默认决定。
- 承载方式只决定 change 如何承载，不影响后续阶段的要求。
- 用户确认后，Agent 推导 change 名并宣布，不再单独询问；用户答复里自带名称时采用其名称。

**产物**：确认后执行 `openspec new change <name>`，再把结论一次性落盘到 `DOC_ROOT/openspec/changes/<change>/grilling.md`。确认前的访谈过程只保留在会话中，不落残缺文件。格式按 grilling 技能的落盘格式（问题 + 候选项 + 结论，只记结论不记过程），P4 项目落在外部 `DOC_ROOT`。候选项必须使用 GFM task list（`- [ ]` / `- [x]`）呈现；选中状态不得依赖删除线，选项文字和说明必须保持正常显示。用户填写自定义内容后，直接将内容填入并替换对应候选项，不再保留「用户答复」占位符或重复展示用户输入。
