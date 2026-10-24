---
paths: server/auth.ts, server/run-usage.ts, server/ask-mcp.ts, server/orch-mcp.ts, server/index.ts, server/tasks.ts, server/task-store.ts, server/exec/worktree.ts, shared/task.ts, shared/plan.ts
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

- 规则：`shared/task.ts` 的 `childFlowOf` / `childHolds` 是唯一判定，置 `resolved`、回收独立分支、面板阶段和转圈都读它；任何路径（合并成功、一轮结束、后台命令结束、面板或父对话手动标记完成）都只走 `server/tasks.ts` 的 `advanceChildTo`（第 4 步置完成 → 第 5 步上报父对话 → 第 6 步列表刷新），顺序和幂等由 `shared/task.ts` 的 `advanceChild` 管，不许直接调 `removeWorktree` 或写 `resolved`；条件不满足就保留目录和分支并把 `childHoldText` 的原因显示给用户。用户显式「删除独立分支 / 丢弃」照旧直接删。
- 起因：合并本改动的那次提交（2026-10，子对话 worktree-ed7cb8cc）——用户报「还有后台命令、计划没完成就被标成已完成」，worktree 也跟着被删了；后来用户要求完成状态只能单向流转，父对话不许跳步直接改子对话的最终状态。
- 防线：`shared/child-flow.test.ts`、`shared/task-stage.test.ts`、`server/exec/worktree.test.ts`。

## 几 MB 的任务对话文件不要每次更新都重写

- 规则：`store.update` 会被流式输出每秒调用几十次，对话文件可能几 MB。`stampOf` 全量拼指纹、`JSON.stringify` 整个文件、写盘都要按任务节流（`server/task-store.ts` 的 `MSG_GAP`：窗口内只留最后一次，到点写最新的），任务本身的小文件照旧每次写；指纹只在真要写时算，不要每次 update 都拼一遍。改节流时注意三点：`create` 要立即写（不然新建的任务断电就丢）、旧格式迁移要把对话一起写到新文件、`remove` 要清掉窗口里等着写的那份（否则删完又被定时器写回来）。
- 起因：用户反馈 Agent 实时输出时输入卡。实测 609 条 / 2.9MB 的对话：`stampOf` 单次 2.4ms、`JSON.stringify` 13.5ms、写盘 19.5ms；100 次更新旧实现写 336MB，节流后只写 2 次 6.7MB。
- 防线：`server/task-store.test.ts`（窗口内合并不写、窗口后写最后一次、删除后不会被定时器写回）。

## 只要任务本身时不读对话：轮询接口用 peek，不用 get

- 规则：用量、状态、子对话栏这类只看 `usage` / `steps` / `status` 的地方用 `store.peek` 或 `tasksApi().peek`（执行中的取内存，其余取任务文件），不要 `store.get` / `current`——完整对话在内存里只留 `KEEP_FULL` 份（合计字数还受 `KEEP_CHARS` 限，几个超长对话就会挤掉别的），被挤出去后每次 get 都是读盘加校验几 MB 的 JSON。`store.update` 收到带 `messages` 的完整任务时也不再读旧对话。
- 起因：父对话开了十几个子对话后面板卡死：`/run-usage` 执行中每秒为每个子对话 get 一次，同时在跑的对话超过 12 个时每次落盘又互相挤出缓存、重读对话文件。
- 防线：`server/task-store.test.ts` 的「同时在跑的对话超过内存里留的份数」。

## 子对话的收尾是计划的最后一步，由面板加

- 规则：子对话的收尾（独立分支 `submit_merge` 合回父对话所在的分支；P4 工作区按 [C++]/[XLSX]/[Lua]/[Other] 分进各自的 pending changelist）由 `applyPlan` 的 `wrapUp` 自动放在计划最后（`shared/plan.ts` 的 `ensureWrapUp`），Agent 漏写、删掉、挪到前面都会放回去；合回分支那一步只由面板在合并成功后标完成（`markWrapUp`）。提示词里不要再写「收尾不列进计划」，P4 分桶规则写在对话提示词（`wrapUpPart`）里，不要只靠 project-vcs 技能或「版本控制」角色。
- 起因：用户纠正——以前提示词要求「合回父分支是收尾动作，不写进计划步骤」，子对话改完就停，P4 改动全留在 default 或塞进同一个 changelist。
- 防线：`shared/plan.test.ts` 的收尾用例、`server/engine-steps.test.ts` 的提示词断言。

## 必须照做的规则交给面板执行

- 规则：P4 分 changelist 这类有明确规则的收尾，由面板工具执行（`p4_split_changelists`），Agent 只给描述；只写进提示词时 Agent 会合并成「[C++/Lua] …」。
- 防线：`server/p4-split.test.ts`。
