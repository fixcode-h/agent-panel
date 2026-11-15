# ADR 0069：节点确认改成阶段报告：决策可勾选，改了就重出一版

状态：已接受 · 2026-11-15

## 背景

- 工作流节点勾了「完成后等我确认」时，审阅弹窗（ADR 0045 之前的阶段确认，见 `web/src/components/tasks/ReviewDialog.tsx`）直接渲染节点的全部文字输出。
- 全部文字输出是 CLI 这一轮所有回复段落拼起来的（`server/exec/run-finish.ts` 的 `texts.join`），里面混着 Agent 边做边说的话（「最后确认一下…再写压测结论」）、决策点、方案正文，用户反馈「很乱」。
- 决策点只是 grilling 格式的一段 ❓ / ➡️ 文字。用户想改某个决策，只能选中文字写标注，Agent 也只能从意见里猜改了哪个。
- 「提问」开关默认关着，Agent 会自己做决定（长对话实测报告提过），这些决定散在正文里，用户看不出哪些是它自己定的。
- 用户 2026-11-15 要求：决策改成「提问 + 选项勾选」，AI 选的那项预先勾上，用户可以改，改后点确认，Agent 能读到改了哪里；报告的内容和排版要规划；改了决策就重出一份报告，有版本号，参照诊断报告。

## 决策

1. **新面板工具 `submit_report`**（`server/panel-tools/submit-tools.ts`），只给勾了「完成后等我确认」的节点（`OrchOpts.report`）。参数：`summary` 结论、`decisions`（编号、标题、问题、2–4 个选项、`pick`、理由，按规则自己定的标 `self`）、`details` 方案详情、`next` 确认后还要接着做的。
   - 准入（ADR 0067）：CLI 没法把决策画成能勾选的卡片，也拿不回用户改了哪项；并不进 `submit_verdict`（那是通过 / 不通过）。
   - 节点提示词加「交给用户确认」一段（`REPORT_PART`），要求把自己定的决策也列进去，用户在确认时能看到、能改。
2. **一次一版**：报告记在节点的 `submitted.reports`，每版带用户的 `picks` 和 `result`（`confirmed` / `changed` / `revised` / `next`）。确认请求带上全部版本（`TaskRequest.reports`），弹窗能切版本、和上一版对比（复用诊断报告的 `compareReports` 和 `ReportCompare`）。
3. **确认之后**（`settleReport`，`shared/flow/stage-report.ts`）：
   - 一项都没改、也没有 `next`：照常往下走，交给下游的结果换成「结论 + 最终决策 + 方案详情」，不再是边做边说的话。
   - 改了决策：把「Q2 你推荐 A，用户改选 B」逐条交回 Agent，按用户的选择重出一版，再等确认。
   - 有 `next`（grilling 的下一轮）：确认后回到 Agent 接着做，同样出新的一版。
   - 退回修改：意见里附上改了的决策。
4. **弹窗排版**（`StageReport.tsx`）：结论 → 需要你决定 → 我按规则定的 → 确认后接着 → 方案详情 → 过程记录。前五块不折叠（项目约定：总结和汇报不折叠），过程记录是 Agent 做事时说的话，默认收起。没交报告的旧节点照旧整段渲染。

## 后果

- 状态只认工具：要不要回到 Agent 只看用户的选择和 `submit_report` 交的 `next`，不看回复文字（ADR 0041 第 16 节）。
- 节点角色要多调一次工具；没调时弹窗退回旧样子，不拦。
- 面板工具多一个，`node` 身份的清单上限在 `server/panel-tools/registry.test.ts` 核对。
