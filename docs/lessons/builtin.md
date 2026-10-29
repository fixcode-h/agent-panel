---
paths: shared/builtin/**, skills/**, server/builtin*.ts, server/bundled-skills.ts, server/agent-params*.ts, docs/agent-catalog.md
---

# 内置角色、工作流和 Skill

提示词怎么写在 [prompts.md](./prompts.md)。

## 按能力块加角色，不按动作拆

- 规则：增删合并内置 Agent 前对照 `docs/agent-catalog.md`；测试、构建、编译、回归都归 `tester`，差别放参数和 `Project.testSteps`。合并掉的记进 `MERGED_AGENTS`。引用的 Skill 名必须在 `skills/` 里存在。
- 起因：c3678e9 把「编译 / 单测 / 验收」等切碎的角色收回成能力块。
- 防线：`server/agent-params.test.ts`（通用测试 Agent 只能有一个）、`server/builtin.test.ts`（Skill 名存在）。

## 改内置定义要带升级

- 规则：内置角色启动时直接按定义同步，改定义不用登记旧版本，别改参数 key。内置工作流靠副本的 `builtinHash` 判断没改过，改定义时旧流程仍追加进 `LEGACY_WORKFLOWS`。升级要幂等并补测试。**不要再写「和历史版本逐字一致才升级」**：漏登记一版就永远卡住。
- 起因：5edc8a2；2026-10-25 四个内置角色卡在没登记的 10-21 版（ADR 0015）。
- 防线：`server/builtin.test.ts`。

## 自制 Skill 改名或合并后要清用户目录的旧副本

- 规则：内置 Skill 改名、合并或删除时，把旧目录名和旧版每个文件的 sha256 记进 `server/bundled-skills.ts` 的 `RETIRED_BUNDLED`；`ensureBundled` 只补缺的不删多的，不登记就会在 `~/.agents/skills` 里同时留着新旧两个入口。只删内容和旧版完全一致的，用户改过或自己加过文件的保留。
- 起因：project-workflow / git-workflow / p4-workflow 合并成 project-vcs。
- 防线：`server/builtin.test.ts` 里 retireBundled 的单测。

## 改参数默认值要升级已装的副本

- 规则：角色参数的取值存在副本的 `default` 里，只改内置定义不会影响已装的副本（分不清用户关掉的和旧默认）。改必备角色的参数默认值时，在 `shared/builtin/core.ts` 的 `DEFAULT_CHANGES` 加一条，启动时只升级一次并记进 `upgrades`。
- 起因：89dbf5a 把文档角色「写 Bug 记录」改成默认开，用户界面上还是关的。
- 防线：`server/builtin.test.ts`。
