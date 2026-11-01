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

## 能力正文的推送规则只引用「授权情况」，按调用者不同的做法靠参数派出

- 规则：能力和通用角色的正文会被父对话就地、非统筹的顶层对话、子对话、派出的子 Agent、工作流节点同时读到，模板分不出调用者，角色名也靠不住（项目默认角色设成「执行」时顶层对话读到「你是子对话」）。推送、PR、合并主干、submit 推不推、问不问，正文只写「看提示词里『授权情况』那段」，不按身份分支、不写无条件的「不推送 / 不 submit」；每种调用者的授权段由 engine 给（对话 `policyPart`，子任务、「版本控制」子任务、顶层工作流节点在 `shared/sub-policy.ts`），新的调用者不能落到父对话那份（它带「比角色设定优先」）。派出的子 Agent 不能问用户（会被自动回答成直接继续），要确认的交回派它的一方，resume 时由派它的一方贴回确认的内容。角色的不同做法（「测试验收」的 task 这类）派出时用 spawn_agents 的 `params` 点名，正文和挂载规则写明 params 怎么写，否则子任务按默认值渲染。临时文件按「截图和临时文件放哪」放对话目录。
- 起因：审计发现（df820f2 起）「版本控制」写死「你不执行」，父对话就地用时和授权段打架；75e52882 按身份分开写后，顶层工作流节点和非统筹顶层对话仍读到互相打架的两段，「清理用例」的子 Agent 分支也因为派单带不了参数根本走不到。
- 防线：`server/engine-steps.test.ts`「推送由父对话决定」（真实内置角色拼完整提示，按调用者断言授权段）和「resume 接着之前那个子任务的会话」（params 交给 runner、resume 沿用、写错报错）；`server/core-agents.test.ts`（版本控制 git / p4 / svn / 自动 × 两种提交方式没有无条件禁令）。
