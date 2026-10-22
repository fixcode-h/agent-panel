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

## 让 CLI 替用户做选择时，给它判断依据

- 规则：AI 配参数这类「让 CLI 按项目定值」的提示词，每个选项要附上它实际改变什么（`paramEffect` 按取值渲染角色设定取差异）和节点上已有的预设，写明判断顺序「项目事实 → 选项差别 → 默认值」，并告诉它结果要用户确认才生效、不要把取舍拿去问用户。只给标签和一句说明时，CLI 只能把开关原样问回来。
- 起因：c3678e9 的参数提示词只列标签，还要求写「哪些参数需要用户确认」；用户在「通用项目」上看到 AI 把 TDD / 任务记录 / 先识别现场 / 串行全部问回来。
- 防线：`server/agent-params.test.ts`（提示词带取值差异和节点预设）。
