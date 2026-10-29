---
paths: shared/task.ts, server/task-store.ts, server/tasks.ts, server/run-usage.ts, web/src/components/tasks/ToolRow.tsx, web/src/lib/task-stream.ts
---

# 对话数据的内存和落盘

## 发给页面的对话是轻量版：旧的长工具输出只给开头；常驻的元数据不能截短

- 规则：SSE 的 full 事件和 `GET /tasks/:id?lite=1` 走 `liteMessages`，最后 `LITE_KEEP` 条之前、超过 `LITE_OVER` 字的工具输出只留开头，带 `outputCut`；页面要完整输出时用 `api.toolOutput` 取（`ToolRow` 的 `useFullOutput`），行数用 `outputCut.lines`，不要按截短后的 `output` 算。
- 规则：不要为了省内存截短 `store` 里常驻的任务元数据（`map` 里的 `head`）：`store.updateMeta` 会把内存里那份原样写回任务文件，截短等于把用户原文从磁盘上删掉。
- 起因：内存优化第二轮（2026-10）——160 轮的对话首包从 3.26 MB 减到 1.65 MB；截短元数据那一项移植时发现会经 updateMeta 丢原文、实测只省不到 1 MB，撤掉了。
- 防线：`shared/task-lite.test.ts`、人工（元数据那条）。

## 几 MB 的任务对话文件不要每次更新都重写

- 规则：`store.update` 会被流式输出每秒调用几十次，对话文件可能几 MB。`stampOf` 全量拼指纹、`JSON.stringify` 整个文件、写盘都要按任务节流（`server/task-store.ts` 的 `MSG_GAP`：窗口内只留最后一次，到点写最新的），任务本身的小文件照旧每次写；指纹只在真要写时算，不要每次 update 都拼一遍。改节流时注意三点：`create` 要立即写（不然新建的任务断电就丢）、旧格式迁移要把对话一起写到新文件、`remove` 要清掉窗口里等着写的那份（否则删完又被定时器写回来）。
- 起因：用户反馈 Agent 实时输出时输入卡。实测 609 条 / 2.9MB 的对话：`stampOf` 单次 2.4ms、`JSON.stringify` 13.5ms、写盘 19.5ms；100 次更新旧实现写 336MB，节流后只写 2 次 6.7MB。
- 防线：`server/task-store.test.ts`（窗口内合并不写、窗口后写最后一次、删除后不会被定时器写回）。

## 只要任务本身时不读对话：轮询接口用 peek，不用 get

- 规则：用量、状态、子对话栏这类只看 `usage` / `steps` / `status` 的地方用 `store.peek` 或 `tasksApi().peek`（执行中的取内存，其余取任务文件），不要 `store.get` / `current`——完整对话在内存里只留 `KEEP_FULL` 份（合计字数还受 `KEEP_CHARS` 限，几个超长对话就会挤掉别的），被挤出去后每次 get 都是读盘加校验几 MB 的 JSON。`store.update` 收到带 `messages` 的完整任务时也不再读旧对话。
- 起因：父对话开了十几个子对话后面板卡死：`/run-usage` 执行中每秒为每个子对话 get 一次，同时在跑的对话超过 12 个时每次落盘又互相挤出缓存、重读对话文件。
- 防线：`server/task-store.test.ts` 的「同时在跑的对话超过内存里留的份数」。
