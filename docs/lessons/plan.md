---
paths: shared/plan.ts, shared/engine.ts, server/p4-split.ts, server/tasks/peer.ts
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
- 防线：e2e `09-subagent-runtime`「计划做一半就收尾」「父对话被停下后继续」；`shared/task-idle-ask.test.ts`。

## 计划和子对话按标题对应时不按包含关系猜

- 规则：`linkKids` 只认 id、或步骤标题和子对话标题一致（去掉「子对话：」前缀）；只是含着子对话标题的，要 Agent 自己写成等待中、子对话还没做完、也没挂在别的步骤上才认。已完成的子对话只给写成等待中的步骤收口，不把新加的同名字眼步骤当场标完成。
- 起因：审计发现（df820f2 起）已完成的子对话「类型检查」把后加的「合并后跑全量类型检查」直接标完成，跳过了整体验证。
- 防线：`shared/plan.test.ts`「按标题认子对话」。

## 计划挂着等父对话的请求，交出时就要叫醒父对话

- 规则：子对话给步骤挂上 kind `parent` 的等待后，`planStalled`、`reportChild`、idle-ask 都不会再替它推父对话，请求本身（`message_parent` 的 wait_fix）必须在父对话没在执行时 `wakeConv`；用户亲手停下的父对话不叫（落盘的 stopped/user、执行位上刚按停止、子对话跟着父对话停下途中发的）。新加「挂等待 + 发消息」的工具照这条检查。
- 起因：审计发现（df820f2 起）父对话空闲时修复请求只进收件箱，父子互等到用户介入；带了提问标记的还会被并进阶段汇报、永远交不出去。
- 防线：`server/tasks/peer.test.ts`。
