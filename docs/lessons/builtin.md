---
paths: shared/builtin/**, skills/**, server/builtin*.ts, server/bundled-skills.ts, server/agent-params*.ts, shared/agent-*.ts, shared/dispatch.ts, shared/expose.ts, shared/test-steps.ts, shared/assist.ts, shared/engine.ts, docs/agent-catalog.md, docs/agent-test-steps.md
---

# 内置角色、工作流、Skill 和提示词

## 按能力块加角色，不按动作拆

- 规则：增删合并内置 Agent 前对照 `docs/agent-catalog.md`；测试、构建、编译、回归都归 `tester`，差别放参数和 `Project.testSteps`。合并掉的记进 `MERGED_AGENTS`。引用的 Skill 名必须在 `skills/` 里存在。
- 起因：c3678e9 把「编译 / 单测 / 验收」等切碎的角色收回成能力块。
- 防线：`server/agent-params.test.ts`（通用测试 Agent 只能有一个）、`server/builtin.test.ts`（Skill 名存在）。

## 改内置定义要带升级

- 规则：改 `shared/builtin/` 的定义时同步 `shared/builtin/legacy.ts`，已装副本的升级要幂等（跑两次结果一样），并补升级测试。必备的四个角色（`core.ts`）例外，启动时直接同步，只要别改参数 key。
- 起因：5edc8a2 补漏掉的升级测试。
- 防线：`server/builtin.test.ts`。

## 改提示词或文案前先搜断言

- 规则：改给 Agent 的提示词、角色设定、界面文案前，先 `grep` 一下 `scripts/e2e.mjs` 和 `server/*.test.ts` 里有没有断言原句，一起改。
- 起因：baffddd、875a11b、ab95653 都是改了提示词、测试还断言旧写法。
- 防线：`npm run test:e2e`。

## 提示词要求 Agent 在一个回合里做完

- 规则：派工、执行类的提示词写明「本回合内完成，不以计划或『我先读取一下』结束」，派工失败要有兜底说明。
- 起因：d94526a，Agent 说一句「我先读取」就结束了回合。
- 防线：人工。

## 等待写死亡上限，不只写原则

- 规则：提示词里写“不要轮询”没用，要写成可执行的数字：用工具自带的等待 / 后台推送；确实主动等时单次不超 30 秒、同一件事累计不超 2 分钟；超时就必须判阻塞并给出可选做法，等待期间要求做不依赖它的实事。另外要写“自己已验证过的结论不要再等子任务重复验证”。
- 起因：一条只写「`Start-Sleep` 单次不超 60 秒、累计不超 2 分钟」的规则被完整违反：实际连发 `sleep 90/100/120/150/180` 共 640 秒，最后一条被 abort，任务停在半路；期间 307 秒完全空等。
- 防线：`server/core-agents.test.ts`（「通用约束」里必须有这一段）；旧措辞在 `shared/builtin/legacy.ts` 登记为指纹，已装的旧副本启动时自动升级。

## 提示词要求 Agent 在一个回合里做完

- 规则：派工、执行类的提示词写明「本回合内完成，不以计划或『我先读取一下』结束」，派工失败要有兜底说明。
- 起因：d94526a，Agent 说一句「我先读取」就结束了回合。
- 防线：人工。

## 工具操作期间要保留可见进度

- 规则：连续工具调用前先说明当前目标，完成一组工具后报告阶段结果；模型没有返回思考内容时不编造内部思考，至少输出简短的可见进度。
- 起因：Pi 任务只显示连续工具操作，原始 JSON 没有 `thinking_delta`；用户要求轮内能看到中间进度。
- 防线：`server/core-agents.test.ts`。

## 让 CLI 替用户做选择时，给它判断依据

- 规则：AI 配参数这类「让 CLI 按项目定值」的提示词，每个选项要附上它实际改变什么（`paramEffect` 按取值渲染角色设定取差异）和节点上已有的预设，写明判断顺序「项目事实 → 选项差别 → 默认值」，并告诉它结果要用户确认才生效、不要把取舍拿去问用户。只给标签和一句说明时，CLI 只能把开关原样问回来。
- 起因：c3678e9 的参数提示词只列标签，还要求写「哪些参数需要用户确认」；用户在「通用项目」上看到 AI 把 TDD / 任务记录 / 先识别现场 / 串行全部问回来。
- 防线：`server/agent-params.test.ts`（提示词带取值差异和节点预设）。

## 父对话只统筹，改文件、编译、计划步骤都在子对话里

- 规则：父对话（统筹角色）只收集到模块、相关代码和文档为止就分派，不改文件、不开 worktree，留在当前分支；子对话在父对话所在分支上开独立分支，自己编译测试，跑通后 `submit_merge`（带 `tests`）就是完成标记，面板合回父对话分支并标记完成（见 [ADR 0002](../adr/0002-child-merge-on-done.md)）。父对话不改文件靠角色说明约束，不要给父对话关掉 CLI 的写文件工具（用户纠正，093a41e 之后撤回）。
- 起因：父对话先把问题查到底、自己动手改，还开 worktree；编译又要合并到父对话那边才跑。
- 防线：`server/orchestrator.test.ts`、`scripts/e2e.mjs` 的子对话合并用例。

## 改参数默认值要升级已装的副本

- 规则：角色参数的取值存在副本的 `default` 里，只改内置定义不会影响已装的副本（分不清用户关掉的和旧默认）。改必备角色的参数默认值时，在 `shared/builtin/core.ts` 的 `DEFAULT_CHANGES` 加一条，启动时只升级一次并记进 `upgrades`。
- 起因：89dbf5a 把文档角色「写 Bug 记录」改成默认开，用户界面上还是关的。
- 防线：`server/builtin.test.ts`。
