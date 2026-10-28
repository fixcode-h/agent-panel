---
paths: shared/task.ts, server/task-store.ts, server/tasks.ts, web/src/components/tasks/ToolRow.tsx, web/src/lib/task-stream.ts
---

# 内存：发给页面的对话和常驻的元数据

## 发给页面的对话是轻量版：旧的长工具输出只给开头；常驻的元数据不能截短

- 规则：SSE 的 full 事件和 `GET /tasks/:id?lite=1` 走 `liteMessages`，最后 `LITE_KEEP` 条之前、超过 `LITE_OVER` 字的工具输出只留开头，带 `outputCut`；页面要完整输出时用 `api.toolOutput` 取（`ToolRow` 的 `useFullOutput`），行数用 `outputCut.lines`，不要按截短后的 `output` 算。
- 规则：不要为了省内存截短 `store` 里常驻的任务元数据（`map` 里的 `head`）：`store.updateMeta` 会把内存里那份原样写回任务文件，截短等于把用户原文从磁盘上删掉。
- 起因：内存优化第二轮（2026-10）——160 轮的对话首包从 3.26 MB 减到 1.65 MB；截短元数据那一项移植时发现会经 updateMeta 丢原文、实测只省不到 1 MB，撤掉了。
- 防线：`shared/task-lite.test.ts`、人工（元数据那条）。
