---
paths: web/src/lib/fold.ts, web/src/lib/fold-roles.ts, web/src/lib/fold-dispatch.ts, web/src/lib/fold-state.ts, web/src/components/tasks/FoldedRun.tsx, web/src/components/tasks/DispatchRow.tsx, web/src/components/tasks/route-context.tsx, shared/panel-tools.ts
---

# 回复的折叠和派单行

## 回复的总结一律留在折叠外面

- 规则：一轮回复收尾折叠时，总结整段留在外面，父对话、子对话都一样。总结按工具种类认，不按位置凑：「最后一次干活（读、搜、改、跑命令这类 `work` 调用）之后的第一段话」就是总结；之后的派单、收尾、提问都不能把它挤进折叠，总结和结尾之间的话收进协调小行。面板工具的种类写在 `shared/panel-tools.ts` 的 `PANEL_TOOL_ROLE`（work / dispatch / wrap / ask），新加面板工具必须在那里归类（类型会拦）。还没办完的派单（子对话、子任务、就地微改动）留在原位，不进任何折叠。
- 起因：用户 2026-10-30 要求「对话的总结不要折叠，父对话、子对话都要记住」；之前按 `WRAP_TOOLS` 白名单往前找，总结后接着派子任务、建子对话时总结又被折了进去（用户 2026-11-09 报，设计稿「回复折叠与派单行重设计」）。
- 防线：`web/src/lib/fold.test.ts`（总结后派单、只有收尾动作、没有总结、wait_agents 算干活）和 `fold-dispatch.test.ts`；`scripts/ui/02b-subagent.mjs` 的派单行断言。

## 子对话、子任务的派单行做完了也不折

- 规则：新开 / 交回子对话、派子任务这几种派单行一直留在原位，做完了只把行尾胶囊换成「已完成」，不收进折叠（`fold-dispatch.ts` 的 `staysOut`）；后台命令、就地微改动还是办完才收。调用本身失败、旧记录里合成一行的群发照常收进去。
- 起因：8a6e9a0 按设计稿让做完的派单跟着折叠收起，用户 2026-11-09 要求「完成也显示在那个地方不折叠」。
- 防线：`web/src/lib/fold-dispatch.test.ts` 的 staysOut 用例，`scripts/ui/02b-subagent.mjs` 的「派单行-做完不折」。

## 运行中的子对话、子任务固定列在运行区

- 规则：还在跑、等你处理的子对话和子任务一律在输入框上方的运行区（`RunningNow`）固定列一行，带实时状态、去操作、终止；派单行在原位只写派单本身和状态胶囊，不把运行区那一行搬过去，运行区也不因为「原位已经画了」就跳过。
- 起因：8a6e9a0 让最新一轮的派单行就地画现场行、运行区跳过它们；派单行一被滚上去或回复后面接了别的卡片，底部只剩「等待你的下一条消息」，用户 2026-11-09 要求「运行中的子对话子任务还是需要在这个下面固定显示，参照原来的逻辑」。
- 防线：`runningRows`（`web/src/components/tasks/RunningNow.tsx`）不再接受跳过名单；`scripts/ui/02b-subagent.mjs` 的「父对话在跑时运行区列出子对话」。
