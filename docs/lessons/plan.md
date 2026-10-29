---
paths: shared/plan.ts, shared/engine.ts, server/p4-split.ts
---

# 执行计划

## 子对话的收尾是计划的最后一步，由面板加

- 规则：子对话的收尾（独立分支 `submit_merge` 合回父对话所在的分支；P4 工作区按 [C++]/[XLSX]/[Lua]/[Other] 分进各自的 pending changelist）由 `applyPlan` 的 `wrapUp` 自动放在计划最后（`shared/plan.ts` 的 `ensureWrapUp`），Agent 漏写、删掉、挪到前面都会放回去；合回分支那一步只由面板在合并成功后标完成（`markWrapUp`）。提示词里不要再写「收尾不列进计划」，P4 分桶规则写在对话提示词（`wrapUpPart`）里，不要只靠 project-vcs 技能或「版本控制」角色。
- 起因：用户纠正——以前提示词要求「合回父分支是收尾动作，不写进计划步骤」，子对话改完就停，P4 改动全留在 default 或塞进同一个 changelist。
- 防线：`shared/plan.test.ts` 的收尾用例、`server/engine-steps.test.ts` 的提示词断言。

## 必须照做的规则交给面板执行

- 规则：P4 分 changelist 这类有明确规则的收尾，由面板工具执行（`p4_split_changelists`），Agent 只给描述；只写进提示词时 Agent 会合并成「[C++/Lua] …」。
- 防线：`server/p4-split.test.ts`。
