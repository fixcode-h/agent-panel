---
paths: web/src/lib/fold.ts, web/src/lib/fold-roles.ts, web/src/lib/fold-dispatch.ts, web/src/lib/fold-state.ts, web/src/components/tasks/FoldedRun.tsx, web/src/components/tasks/DispatchRow.tsx, web/src/components/tasks/route-context.tsx, shared/panel-tools.ts
---

# 回复的折叠和派单行

## 回复的总结一律留在折叠外面

- 规则：一轮回复收尾折叠时，总结整段留在外面，父对话、子对话都一样。总结按工具种类认，不按位置凑：「最后一次干活（读、搜、改、跑命令这类 `work` 调用）之后的第一段话」就是总结；之后的派单、收尾、提问都不能把它挤进折叠，总结和结尾之间的话收进协调小行。面板工具的种类写在 `shared/panel-tools.ts` 的 `PANEL_TOOL_ROLE`（work / dispatch / wrap / ask），新加面板工具必须在那里归类（类型会拦）。还没办完的派单（子对话、子任务、就地微改动）留在原位，不进任何折叠。
- 起因：用户 2026-10-30 要求「对话的总结不要折叠，父对话、子对话都要记住」；之前按 `WRAP_TOOLS` 白名单往前找，总结后接着派子任务、建子对话时总结又被折了进去（用户 2026-11-09 报，设计稿「回复折叠与派单行重设计」）。
- 防线：`web/src/lib/fold.test.ts`（总结后派单、只有收尾动作、没有总结、wait_agents 算干活）和 `fold-dispatch.test.ts`；`scripts/ui/02b-subagent.mjs` 的派单行断言。
