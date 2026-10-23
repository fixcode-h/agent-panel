---
paths: server/auth.ts, server/ask-mcp.ts, server/orch-mcp.ts, server/index.ts, server/tasks.ts, server/exec/worktree.ts, shared/task.ts
---

# 服务端接口和访问控制

## 给 CLI 调的面板地址要穿过访问令牌，连不上要显示

- 规则：CLI 调的接口（`/api/mcp/*`）没有 Cookie，在 `tokenGuard` 放行、由接口自己核对地址里的随机令牌；桥接（Pi 扩展）连不上面板时报给面板显示，不能只写 stderr。
- 起因：打开「访问令牌」后 `/api/mcp/ask` 一律 401，Pi 一个面板工具都没有，只有模型自己说「没挂上」。
- 防线：`server/auth.test.ts`。

## 对话的独立分支不推远端，标记完成就删

- 规则：子对话的 worktree 里给 CLI 和后台命令都带 `noPushEnv`（`pushInsteadOf` 指向不存在的协议），用户明确要求才由父对话推当前分支；子对话标记完成时删掉它的 worktree 和分支，还有没合回的改动就拒绝，其余条件见下一条。
- 起因：用户要求「对话的 worktree 不能推送到远端」「子对话标记完成就删除对应的 worktree」。
- 防线：`server/no-push.test.ts`、`scripts/e2e.mjs`。

## 合并成功不等于做完了：置完成和删 worktree 必须过同一套「彻底完成」判定

- 规则：`shared/task.ts` 的 `childHoldsOf` 是唯一判定，置 `resolved`、回收独立分支、面板阶段和转圈都读它；任何自动路径（合并成功、一轮结束、后台命令结束、手动标记完成）都只走 `server/tasks.ts` 的 `releaseChild`，不许直接调 `removeWorktree` 或写 `resolved`；条件不满足就保留目录和分支并把 `childHoldText` 的原因显示给用户。用户显式「删除独立分支 / 丢弃」照旧直接删。
- 起因：合并本改动的那次提交（2026-10，子对话 worktree-ed7cb8cc）——用户报「还有后台命令、计划没完成就被标成已完成」，worktree 也跟着被删了。
- 防线：`shared/task-stage.test.ts`、`server/exec/worktree.test.ts`。
