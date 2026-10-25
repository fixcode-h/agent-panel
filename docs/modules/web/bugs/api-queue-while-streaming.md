# 对话还在输出，状态行却显示「排队等 API 名额」

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit` 通过）
- 模块：`web`（`web/src/components/tasks/TaskView.tsx` 的 `RunPhase`）+ `server-exec`（`server/exec/runner.ts` 的 `takeApiSlot`、`server/api-slots.ts` 的 `ApiSlot`）
- 关键词：排队、等 API 名额、apiWait、并发上限、token/s、状态行自相矛盾、让出名额、yield、drop、名额泄漏

## 现象

用户报：「这个对话还在输出怎么会显示这个排队」。

截图里同一行同时出现两个互相矛盾的信息：

- 左边转圈 +「排队等 API「OpenDesign」空出并发名额 · 下一个就是这里」
- 右边「⚡ 188.7 token/s　↑51.64M ↓243.7k」

  188.7 token/s 说明这一轮正在出 token，却同时标成在排队。

## 根因

三条叠加，缺一条都不会出现这个画面：

1. **`apiWait` 会残留，而且跨任务结束都存在。** 本机数据目录里有 8 条任务带着 `apiWait={"api":"OpenDesign","ahead":0}`，其中 4 条 `status=done`，还有一条 `awaitingUser=true`（在等下一句、CLI 空闲）。`server/tasks.ts` 收尾里的兜底清理在对话保活路径下跑不到（`run()` 根本不返回），字段跟着快照一起落盘。

2. **`apiWait` 的语义和「在出 token」并不互斥。** 它只由 `takeApiSlot(ctx, undefined, ...)` 写，而 `waitNext` / `yieldApiSlot` 都是「先 `slot.drop()` 让出名额，等完再 `takeApiSlot` 拿回」——让出停止的是**占名额**，不是 CLI 进程，让出期间 CLI 可能还在输出。拿回时如果名额被别人占着就会排队并写上标记。旧实现里清不清由闭包变量 `queued`（本次有没有排过队）决定，而 `ApiSlot.take` 会复用 `slot.pending`：复用别处已经在排的队时 `onQueue` 不会再回调、`queued` 为假，写进去的标记就没人清。

3. **`ApiSlot.drop()` 在排队中不撤销排队。** 探针实测旧实现：`drop while pending` 是静默 no-op，`pump` 之后名额被放行给一个已弃置的 slot、永远不还（`{used:1, queued:1}` → 名额泄漏）。这会让 `free()` 长期为 false，后续调用更频繁排队。

4. **显示层无条件优先。** `RunPhase` 里只要 `task.apiWait` 存在就直接返回排队文案，压过下面「正在回复」。而右边的 `token/s` 来自 `LiveStats` → `tpsNow()`，是另一套按 Agent 记的实时值，跟 `apiWait` 之间没有任何一致性约束，两套数据打架时界面必然自相矛盾。

## 修复

- **`server/api-slots.ts`**：`ApiSlot` 在排队期间持有内部 `AbortController`，`drop()` 能撤销排队；并保证「放行的名额与持有者一一对应」——刚被放行（名额已算到名下）就放弃的，立刻 `releaseApi` 还回去。用代数（`gen`）防止上一代排队的 `finally` 误清新一代：`drop()` 后马上重新排队时，上一代的收尾跑得比新一代晚，`pending` 和 `waiting` **两个字段都**要比代数后才清——只保护 `pending` 的话，新一代的撤销句柄被清掉，再 `drop()` 就撤销不了排队，同一个泄漏换了个入口（review 发现的 R1，已有用例覆盖）。
- **`server/exec/api-wait.ts`（新）**：把排队标记的读写抽成可测的 `markApiWait` / `clearApiWait`。
- **`server/exec/runner.ts`**：`takeApiSlot` 用 `try/finally` 无条件清标记，不再依赖「本次排过队」；新增 `reason` 参数，`yieldApiSlot` 和 `waitNext` 的「让出后拿回」传 `'yield'`，开跑前排队仍是 `'start'`。`waitNext` 里**按「让出前手里有没有名额」判断**（`slot.holding`）：预热（prewarm）对话等用户第一句时这一轮从没出过 token，是真空排队，必须按 `'start'` 显示——不能只看「走的是 `waitNext`」就写 `'yield'`（review 发现的 R2）。
- **`shared/schema.ts`**：`ApiWait` 加 `reason: 'start' | 'yield'`，旧快照没有这个字段时默认 `'start'`（当时确实都是开跑前排队）。**实测确认不会报校验错**：任务级和步骤级各用一份「有 `apiWait`、无 `reason`」的 JSON 跑 `Task.safeParse`，都通过并自动补成 `'start'`；新格式 `reason: 'yield'` 也正常保留。
- **`server/task-store.ts`**：`parseTask` 读快照时丢掉 `apiWait`（任务和步骤都丢）——这 5 行的作用不是兼容 schema（兼容由前面的 `.default('start')` 负责），而是**清掉内存态的临时标记**：进程重启后不可能还在排队，旧版本漏清留下的陈旧标记（磁盘上有 8 条，含 4 条 `status=done`）也会在下次加载时被抹掉，不用手工改 JSON。
- **`web/src/lib/tasks.ts` + `TaskView.tsx` + `RunningNow.tsx`**：判定抽成 `apiQueueWait(task, streaming)`，只对 `'start'` 且没在出 token 时显示排队；`HelperRow` 的「排队等 API」标签同样只认 `'start'`。`RunPhase` 判断「在出 token」用的 `agentIds` 必须和同一行 `LiveStats` 一致（chat 分支是 `[task.agentId]`），否则「别人在输出、这一轮自己在排队」会被当成在输出，反而把真排队遮掉（review 发现的 R3）。

## 防线

- `server/api-slots.test.ts`：「ApiSlot：排队中放弃要撤销排队，放行的名额不能丢在没人持有时」「ApiSlot：放弃后马上重新排队，旧的排队收尾不能清掉新一代的撤销句柄」（R1）「ApiSlot：holding 能区分「这一轮跑过没有」，预热首句和让出后拿回不会混成一种」（R2）。
- `server/exec/api-wait.test.ts`：标记记下就清干净、清完再清不重复推送；让出后拿回不改步骤状态、开跑前排队才改成排队中；拿回带 `yield` 来源，拿到名额或被停止都清掉。
- `web/src/lib/tasks.test.ts`：「让出名额后拿回的排队不显示成「排队等名额」」「开跑前真的在排队时照常显示」「已经在出 token 时不当成在排队」「没有标记时什么都不显示」。
- **对照验证**：把 `server/api-slots.ts` 换回 HEAD 版跑新用例，明确失败（`Error: 等超时：排队没有撤销`）；R1 的用例在当前实现（只有 `pending` 比代数）下也失败，补上 `waiting` 的代数判断后通过。
- **端到端（`npm run test:e2e:wsl`，10 个分片全过，总 1m 5s）**：`chat`（18 步）、`subagents`（24 步）、`test-steps`、`workflow-edge`、`local`（26 步）全绿。改 `ApiWait` 结构后 `local` 分片里原有的 `deepEqual(queued.apiWait, { api, ahead })` 必须同步加 `reason: 'start'`（第一次跑确实因它失败，已修）——这条断言同时也验证了「真排队时来源就是 `start`」。
- **覆盖分工**：端到端覆盖「名额满了→第二个对话排队→前面停了往前挪→排队时能停止」和「对话让出名额给两个子任务、名额是 1 时子任务一个一个跑」；**「让出→拿回」的两代交错、`drop()` 撤销排队不泄漏名额这些毫秒级时序由单测覆盖**，端到端不赌这种时序。
- **界面检查（`node scripts/ui-check.mjs 02`，先 `vite build --mode demo`）**：`task` 分片通过，涵盖运行区与状态栏用例。
