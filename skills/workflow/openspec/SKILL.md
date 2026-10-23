---
name: openspec
description: OpenSpec 规范驱动开发的规则：前置检查（CLI 必须在 DOC_ROOT 下运行、.openspec.yaml 判定）、各阶段产物（grilling.md、proposal/specs/design/tasks、acceptance.md）与出口门禁、设计假设被证伪时的回流、归档前证据门禁、CLI / 斜杠指令 / 直接改文件的分工和 ADR 门槛。执行 OpenSpec 流程的任一阶段、续接未归档的 change 或验收归档时使用。
user-invocable: true
---

# OpenSpec 开发流程

阶段顺序（0 前置检查 → 1 需求收敛 → 2 落规范 → 3 实现 → 4 验收归档）由 Agent 面板的工作流驱动：工作流的节点决定当前处于哪个阶段、何时请用户确认、何时回到上一步。本技能只规定每个阶段要做什么、产出什么、满足什么门禁才算完成。执行当前节点对应的阶段，不越过它去做后续阶段的事。

## 通用规则

- 每个阶段都要有可核对的证据；门禁不满足时报告缺什么，不得绕过门禁继续写代码。
- AI 无法执行或客观确认的非阻塞验证，登记为「延期验证」：原因、影响、建议执行者、验证步骤、当前证据、状态（`deferred` / `accepted-risk`），写入 `acceptance.md`；不得伪造通过，也不因此中断其余安全步骤。
- **阶段切换检查**：进入阶段 2、3、4 以及续接恢复时，先重新确认当前 change、`PROJECT_ROOT`、`DOC_ROOT`、`tasks.md` 状态。不得把前一阶段未完成的决策或未验证的产物当作已完成事实。

## 阶段 0 · 前置检查（只读）

1. 按 `project-documentation` 的规则确定 `PROJECT_ROOT` 与 `DOC_ROOT`；确认后所有 OpenSpec CLI、斜杠指令、文件读写和归档都只针对这同一个 `DOC_ROOT`。
2. `openspec --version` 可执行。所有 OpenSpec CLI 命令 MUST 在 `DOC_ROOT` 下运行（`openspec new change` 也在此目录）；从别处运行会输出空列表或直接报错，容易误判成「无未归档 change」。每次调用前显式设置到 `DOC_ROOT`，第一步失败时先检查当前目录再下结论。未初始化时先向用户说明，经确认后再 `openspec init`。
3. 当前 CLI 提供 `/opsx-propose`、`/opsx-apply`、`/opsx-archive`（`/opsx:propose` 写法是同一指令，以 CLI 实际列出的名称为准）；缺失则停止并报告，不臆造指令，也不手工模拟其产物。
4. 扫描 `DOC_ROOT/openspec/changes/`：每个子目录必须有 `.openspec.yaml`。缺失者视为非 OpenSpec 目录，不复用、不修改、不归档，报告并建议迁到 `DOC_ROOT/worklog/<task-id>/`。`openspec/changes/` 只允许 `openspec new change` 创建目录，非 OpenSpec 的任务记录不得放进来。

## 阶段 1 · 需求收敛 + 压测

需要时配合 `brainstorming`（澄清目标、范围、约束，2–3 个方案，一次性设计摘要：目标、非目标、技术路线、验收标准初稿）和 `grilling`（压测设计树）技能。决策分三类处理：

- **用户决策**：影响目标、非目标、技术路线、验收标准、对外行为或不可逆结果的，必须问用户。
- **机械决策**：change 名称（kebab-case）、目录与文件布局、命名、格式，由 Agent 按项目约定自决，在 `grilling.md` 标注「Agent 自决」，不打断用户。
- **事实**：自己查，不问用户。

**确认内容**：先完成路径检查，再用一次选择交互同时取得两项结论，不拆成两次打断。

- 路径检查：用 `openspec list` / `openspec status` 检索未归档 change，检查 `DOC_ROOT/openspec/specs/` 下的主 specs；按领域对象、需求边界、验收标准和实现范围判断是否存在强关联候选，不得仅凭关键词相似。
- 一次交互包含：(a) 设计共识（目标/非目标/技术路线/验收标准）是否确认；(b) 承载方式 ——「新建规范」，或「增补已有规范」（仅在存在强关联候选时展示，选项描述写明候选路径和关联依据；若只有主 spec 强关联，则基于它新建承载本次 delta 的 change，不直接改主 spec）。不得替用户默认决定。
- 承载方式只决定 change 如何承载，不影响后续阶段的要求。
- 用户确认后，Agent 推导 change 名并宣布，不再单独询问；用户答复里自带名称时采用其名称。

**产物**：确认后执行 `openspec new change <name>`，再把结论一次性落盘到 `DOC_ROOT/openspec/changes/<change>/grilling.md`。确认前的访谈过程只保留在会话中，不落残缺文件。格式是 grilling 格式的轻量文档（❓问题 + ➡️推荐 + 用户答复 + 结论，只记结论不记过程），P4 项目落在外部 `DOC_ROOT`。候选项必须使用 GFM task list（`- [ ]` / `- [x]`）呈现；选中状态不得依赖删除线，选项文字和说明必须保持正常显示。用户填写自定义内容后，直接将内容填入并替换对应候选项，不再保留「用户答复」占位符或重复展示用户输入。

## 阶段 2 · 落规范

1. `/opsx-propose` 将 proposal.md、specs/、design.md、tasks.md 写入 `DOC_ROOT/openspec/changes/<change>/`。普通项目 `DOC_ROOT` 是 `PROJECT_ROOT/docs`；P4 项目是外部 `ProjectDoc/doc/<实际项目文件夹名>`，不得写回 P4 项目目录。`grilling.md` 作为 design.md 的决策依据保留。
2. proposal 必须写明**非目标**和**可核对的验收标准**；specs 的每条需求都要能被验收步骤逐条对上。
3. `tasks.md` 的形状：按可验收能力分组，保持 3–7 组；每条 task 写明验证方式（命令或检查步骤）和对应的 spec 需求。勾选的含义是「验证已通过」，不是「代码已写完」。
4. 建立 `acceptance.md` 骨架：逐条列出 spec 需求、对应验证方式、状态（待验证），并留出「本轮成本观察」三项（非必要用户打断次数、重复探索、验证失败及修复）。阶段 3、4 往里填证据。
5. 确定受影响模块后，读取 `DOC_ROOT/modules/<模块名>/README.md` 和 `bugs.md`。`bugs.md` 命中相同症状、入口、错误信息或根因类型时，在 `design.md` 记录引用和本次如何避免复发；没有命中则明确记录「未命中历史 Bug」。

**阶段 2 出口门禁**：`openspec validate <change>` 通过；每条 spec 需求至少被一条 task 的验证覆盖，没有遗漏；`design.md` 不含「待定」项（有则回到对应决策分支重新压测，不得带着待定进入实现）。

## 阶段 3 · 实现

先做阶段切换检查。修改文件前按 `project-vcs` 识别 VCS（P4 细则在它的 `p4.md` 里），P4 项目按该细则将明确任务文件纳入 default changelist。只有跨会话、跨多个独立验收边界或明确要求时，才在外部 `DOC_ROOT` 创建简化的 `p4change/<任务标识>.p4change.md`，普通任务不创建；台账不替代 `tasks.md`，也不加入 pending。

按 `tasks.md` 连续执行，每条 task 的顺序：

1. 检查相关 Bug 的防复发约束和回归测试；
2. 修改；
3. 运行该 task 声明的验证；
4. 验证通过后，勾选 `[x]` 并在 `acceptance.md` 对应行追加证据（命令、结果）；
5. 继续下一条。

- 验证失败不勾选。同一根因连续失败两次回到根因分析；三次仍未解决则重新规划该任务或报告阻塞。
- 无法执行的非阻塞验证登记为延期验证后继续安全任务；单条任务的实际阻塞或安全风险才暂停并记录。
- 发现新的易错点时，先记录到模块 Bug 文档再继续后续任务。

### 回流：设计假设被证伪

实现中发现 `grilling.md` / `design.md` / specs 的某个假设不成立，或验收标准无法满足时，按下列顺序处理，不得继续按原设计写代码：

1. 停止当前 task，把事实证据记入 `acceptance.md`。
2. 只对受影响的分支做局部压测（该分支及其下游），不重走整棵决策树。
3. 更新 `grilling.md` 对应结论、`design.md`、受影响的 specs 和 tasks；已完成但受影响的 task 改回 `[ ]`。
4. 重新 `openspec validate <change>`。
5. 变更触及目标、非目标、技术路线或验收标准时，用一次选择交互请用户确认；只是实现细节则自决并记录。
6. 回到剩余 tasks。

### 跨会话交接

change 预计跨会话或有多个独立验收边界时，在 change 目录维护 `handoff.md`：最后确认事实、当前里程碑、阻塞、下一动作、恢复入口。每完成一组 tasks 更新一次；单会话即可完成的 change 不创建。

## 阶段 4 · 验收、归档与项目收尾

先做阶段切换检查，然后按顺序执行：

1. `openspec validate <change>`；在 `PROJECT_ROOT` 运行可执行的测试、构建、lint；对照 `PROJECT_ROOT` 与 `specs/` 逐条核对，补全 `acceptance.md`（命令、结果、逐条结论、延期验证项、成本观察）。
2. 若本次变更修复或发现模块易错点，确认 `DOC_ROOT/modules/<模块名>/bugs.md` 和对应单 Bug 记录已更新；没有新增问题时记录「未发现新的模块 Bug」。
3. 汇总所有延期验证项，一次选择交互展示：原因、影响、建议执行者、验证步骤、当前证据。用户要求立即验证则执行并更新 acceptance；选择暂缓则在 acceptance 和交付记录标记「待用户完成」，不伪造通过。
4. **归档前门禁**：逐条核对 `tasks.md` —— 未勾选条目为 0、且每条勾选项都有对应验证证据（`acceptance.md` 有命令与结果）。`/opsx-archive` 只统计未勾选项，不会校验勾选项是否真有证据；不满足门禁时先补验证并回填 `acceptance.md`，不得直接归档。门禁通过后执行 `/opsx-archive`（目录移动和主 specs 同步由该指令完成；主 specs 是否同步遵循 `project-documentation` 的交付状态规则，P4 pending 阶段同步时标注「已验收，待提交」）。
   归档操作包含归档副本内的收尾：在归档目录里更新 `tasks.md` 勾选状态、`acceptance.md` 结论等，这部分改动与目录移动、主 specs 同步一起进入同一次提交。
5. **归档先于版本控制收尾**：归档完成后再按 `project-vcs` 做项目收尾，变更范围包含归档产生的目录移动和主 specs 变更。Git 项目按工作流要求的提交方式收尾，P4 项目完成 default changelist 核对与最终 pending 分桶。
6. VCS 证据以提交本身（或最终 pending 状态）和最终回复为准；不得为了回填 commit hash 再产生一次提交。

`openspec validate` 通过、测试通过或代码写完都不是完成；缺少验证证据、延期验证决策、归档或版本控制收尾时，change 保持未完成。收尾失败时保留归档目录，需要回退时用 VCS 恢复，不手工移动目录。

## 续接未完成的 change

续接是受控恢复，先不要写代码，先确认状态：

1. 做阶段 0 的前置检查，再用 `openspec list` / `openspec status` 查看现有 change 与进度；P4 项目先按 `project-vcs` 的 `p4.md` 核对 default changelist 和任务文件范围。
2. 必需产物存在且属于同一个 change：`.openspec.yaml`、`proposal.md`、`grilling.md`、`design.md`、`specs/`、`tasks.md`。`acceptance.md` 缺失但其余完整时补建骨架，不视为无效。同时确认设计共识、验收标准、实施路径和 tasks 状态已记录；不能只凭目录存在或关键词匹配恢复。
3. 产物完整有效时，先读 `handoff.md`（若有）和 `tasks.md`：
   - **有未勾选条目** → 做阶段切换检查，从阶段 3 的剩余条目继续；
   - **条目全部勾选但未归档** → 进入阶段 4。
4. 缺少必需产物、校验未通过、设计共识或验收标准不完整、状态无法确认 → 不恢复，报告并从阶段 1 重新收敛。
5. 找不到对应 change → 说明这是新需求，从阶段 0 开始。

判断依据是 change 的完整产物、OpenSpec 状态和 `tasks.md` 勾选状态，不是目录是否存在。把判断结论写进节点输出，便于工作流决定下一步。

## OpenSpec 文档的操作分工

状态由 OpenSpec CLI 管理，内容由文件记录。

- **OpenSpec CLI（终端命令）**：`openspec new change`、`status`、`list`、`instructions <artifact>`、`validate <change>`、`archive <change>`。它们负责结构和状态；不得手工创建缺少 `.openspec.yaml` 的 change 目录，也不得手工移动目录归档。
- **斜杠指令**：`/opsx-explore`、`/opsx-propose`、`/opsx-apply`、`/opsx-archive`。它们不是 CLI，也不是 shell 命令，按当前 CLI 的指令规范执行；指令正文里提到的工具名（提问、清单、子 Agent 等）映射到当前 CLI 的等价能力，不要照字面调用不存在的工具。
- **直接改文件**：`proposal.md` / `design.md` 正文、specs 的需求条目、`tasks.md` 的勾选、`acceptance.md`、`handoff.md`。

CLI 与指令的参数和可用性以当前环境实际提供的为准，不臆造不存在的指令。

## 文档产出

- **决策**：同时满足「难以逆转、缺少上下文会让后来者困惑、是真实权衡的结果」才写 ADR，写在 `DOC_ROOT/adr/NNNN-slug.md`（顺序编号，取现有最大号 +1）；不满足就留在 `design.md`。
- **验收**：证据落 `DOC_ROOT/openspec/changes/<change>/acceptance.md`。
- **项目总览**：`DOC_ROOT` 应有 `README.md`；领域术语密的项目再补 `CONTEXT.md`。
- 改代码前先读 `DOC_ROOT/adr/`，那里记的是「有意为之、不要动」的地方。
