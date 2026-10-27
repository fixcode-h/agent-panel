# ADR 0022：评审门禁留显式放行出口，记录谁、什么时候、为什么

状态：已接受 · 2026-10-28

## 背景

评审门禁（[ADR 0009](./0009-review-findings-triaged.md)）要求子对话合回父对话分支前必须：计划里有标 `review` 的评审步骤并已完成、真的派过评审、评审写了验收结论，评审列了高级 / 中级时还要对每条写 `review_triage` 处置。这些条件全部满足才放行，`server/tasks.ts` 的 `submitMerge` 里 `!ok` 直接拒绝——**是硬拦截，不是提醒**。

拦截本身是对的，但它把「没有评审记录」和「评审留下了已知问题」都变成了死路：用户明确说「这版先合，问题下一版补」时，执行角色只能伪造处置（写 `defer` 之类的空理由蒙过关）、或者一直复看。门禁越严，越容易把人推向编理由，而不是推向「说清为什么要带着问题合并」。

用户的要求是两条一起：门禁要真的拦住，但**用户显式放行时要能合，而且留下谁、什么时候、为什么**——不能是一个谁都能踢开的静默开关。

## 决策

**门禁保持硬拦截，另开一条只有「用户 / 父对话明确要求」才能走的出口，放行本身成为一条记录。**

1. `shared/review-gate.ts` 的 `reviewGate` 加第五个参数 `override: { by: 'user' | 'parent', reason }`：
   - **只在门禁真的拦下时生效**；本来就能过时忽略它，也不记放行（记录只对应确实绕过的那一次）；
   - 来源只有 `user` / `parent` 两种，执行角色自己判断「问题不大」不构成来源；
   - `reason` 短于 12 字当没写（要写清带着什么问题合并、什么时候补）；
   - 放行时返回 `bypass`，带上「原本拦住什么」（门禁拒绝原因的第一句）。
2. **时间由面板记**：`submit_merge` 只传 `by` 和 `reason`，`server/tasks.ts` 在接收时取 `new Date().toISOString()` 写进 `Task.reviewOverride`——时间不能由调用方自报，否则可以伪造一个过去的时间。
3. **留痕的三个去处**：任务详情输入框下方的小块（`web/src/components/tasks/ReviewOverrideChip.tsx`，显示谁 / 什么时候 / 为什么 / 原本拦住什么）、给父对话的收尾请求消息、交接摘要的「评审门禁的显式放行」一节。父对话合并就是验收（[ADR 0005](./0005-conversation-states.md)），放行理由站不住时可以打回。
4. 门禁的每条拒绝信息后面都附 `OVERRIDE_TIP`，说清出口存在、怎么传、不要自己判断「问题不大」就放行；内置执行角色的收尾提示词同步写一句。

候选方案：

- **在界面上做一个「允许绕过评审」的开关**：没选。开关是给用户点的，但 `submit_merge` 是 Agent 调的，Agent 读不到界面状态；要做成「用户点了才允许」，就得引入一次人工确认流程，比记录本身更重，也会挡住「用户在对话里已经明确说了」的常见情形。
- **让 `review_triage` 兼任放行**：没选。处置和放行是两件事：处置回答「这条意见我核实后决定怎么办」，放行回答「这次不按门禁的要求做完也合」。混在一起会让 `defer` 变成万能钥匙。
- **放行后仍要求先派一次评审**：没选。用户要求「已知问题也合并」时常见的就是评审还没跑或没写完结论，强制先跑一遍等于把用户的话改成「先审完再合」。

## 与现有实现的关系

- `shared/review-gate.ts`：`ReviewOverride` / `ReviewOverrideNote` / `OVERRIDE_BY` / `OVERRIDE_TIP` / `overrideInput` / `overrideText`；`reviewGate` 拆成「门禁本身」（`gate`）和「放行处理」，拒绝结果带上 `blocked`。
- `shared/schema.ts`：`Task.reviewOverride`（`by` / `at` / `reason` / `blocked`），旧任务没有这个字段，按没有放行读。
- `server/tasks.ts`：`submitMerge` 多一个参数，门禁结果带 `bypass` 时写 `tk.reviewOverride`，收尾消息和 `handoffText` 带上放行段。
- `server/orch-mcp.ts`：`submit_merge` 加 `review_override`（`by` 用 enum 限制），`overrideInput` 解析；`shared/engine.ts` 的 `submitMerge` 签名同步。
- `shared/handoff.ts`：`handoffText` 加可选的 `override` 段。

## 风险与代价

- 执行角色可能滥用：用户没要求也自己放行。防线：理由字数下限 + 来源只能是 user / parent + 记录随收尾消息给父对话 + 内置提示词明说「不要自己判断问题不大就放行」。真要防死只能加人工确认，那是另一种交互成本，眼下不做。
- 放行记录只保留最近一次：正常合回时清掉（`reviewGate` 不再返回 `bypass`），避免旧放行挂在任务上让人误以为这次也是放行的。
- 放行不写进评审步骤的完成状态：计划里那一步仍然是没做完 / 没派过，之后再看计划能看出当时是绕过门禁合的。

## 开放问题

- 要不要在「放行」时同时要求记录「承诺什么时候补上」的字段（期限）？眼下写在 `reason` 里，没做成独立字段。
