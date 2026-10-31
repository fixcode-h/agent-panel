---
paths: shared/plan.ts, shared/engine.ts, server/p4-split.ts
---

# 执行计划

## 子对话的收尾是计划的最后一步，由面板加

- 规则：子对话的收尾（独立分支 `submit_merge` 合回父对话所在的分支；P4 工作区按 [C++]/[XLSX]/[Lua]/[Other] 分进各自的 pending changelist 再请验收；共用目录、没有版本管理时直接请验收）由 `applyPlan` 的 `wrapUp` 自动放在计划最后（`shared/plan.ts` 的 `ensureWrapUp`），Agent 漏写、删掉、挪到前面都会放回去；这三种收尾（`PANEL_WRAPS`）都只由面板在父对话收下后标完成（`markChildWrapUp`），Agent 自己标不算。提示词里不要再写「收尾不列进计划」，P4 分桶规则写在对话提示词（`wrapUpPart`）里，不要只靠 project-vcs 技能或「版本控制」角色。
- 起因：用户纠正——以前提示词要求「合回父分支是收尾动作，不写进计划步骤」，子对话改完就停，P4 改动全留在 default 或塞进同一个 changelist。
- 防线：`shared/plan.test.ts` 的收尾用例、`server/engine-steps.test.ts` 的提示词断言。

## 必须照做的规则交给面板执行

- 规则：P4 分 changelist 这类有明确规则的收尾，由面板工具执行（`p4_split_changelists`），Agent 只给描述；只写进提示词时 Agent 会合并成「[C++/Lua] …」。
- 防线：`server/p4-split.test.ts`。

## 对话能不能走完不靠模型自觉：一轮结束时按计划状态推

- 规则：一轮正常结束时计划没做完、也没在等任何结果（`planStalled`），面板推它接着做（`nudgePlan`），同一进度只推一次；判定只看计划状态，不按回复文字猜。父子之间「未完成」不发消息，推过仍停住才报一次；继续执行时被连带打断的子对话由面板拉起来，父对话交回原来的子对话，起不来才另建。见 ADR 0032。
- 起因：80dbe4c 只给子对话加了推进，父对话同样「我跑 test:failed」后停住；父对话 20 分钟收到 13 条「未完成」，看子对话没动静又另建子对话重做。
- 防线：e2e `04-subagents`「计划做一半就收尾」「父对话被停下后继续」；`shared/task-idle-ask.test.ts`。
