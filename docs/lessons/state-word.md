---
paths: shared/task-word.ts, shared/task-diagnosis.ts, shared/life-next.ts, shared/lifecycle.ts, web/src/components/tasks/head-status.ts, web/src/components/tasks/child-line.ts, web/src/components/tasks/ChildrenBar.tsx, web/src/components/layout/SidebarTasks.tsx, web/src/components/ui/sidebar.tsx, web/src/components/session/StatusCard.tsx
---

# 对话状态的说法

## 状态短词只从 shared/task-word.ts 取，各处不另写一句

- 规则：标题栏胶囊、侧栏行尾、运行区子对话行、子对话栏的提问块、输入框占位、会话栏「状态」、「状态」窗口都从 `shared/task-word.ts` 的 `taskWord` / `childWord`（同一个 `stateWord`）取短词（等你回答、等你确认、阶段待确认、等你操作、子对话等你处理、报告待确认、子对话执行中……），不在组件里另写「等你回复」「等用户选择」；讲清是什么事、要你做什么的长句交给输入框上方的悬浮卡。
- 规则：用自己那份事实算状态的地方（会话栏的 `diagnoseTask` 带计划和子对话列表、服务端 `lifecycleReport`）也要把 `childrenNeeds` / `childrenWorking` 算进去（服务端用 `sc.withLive`），并用同一份事实调 `stateWord`，状态和短词才不会各说各的。
- 起因：分析稿 A8、U2（2026-11-10）：标题栏「子对话等你处理」、侧栏「等你回复」、运行区「请用户选择」、会话栏「这一轮说完了，在等结果推回来」，同一件事五种说法；会话栏的判定漏了 `childrenNeeds`。
- 防线：`web/src/components/tasks/state-word.test.ts` 枚举事实组合断言几处一致；`scripts/ui/02-task.mjs` 的状态窗口断言。
