---
paths: shared/review-gate.ts, server/review-gate.test.ts, shared/builtin/agents.ts, shared/verdict.ts, server/orch-mcp.ts
---

# 收尾评审

## 评审只出意见，采不采纳由执行方核实后定，门禁不只认「通过」

- 规则：收尾门禁（`shared/review-gate.ts`）放行的条件是「评审通过」或「执行角色对最近一次评审的每条 🛑 写了处置」（`submit_merge` 的 `review_triage`：fix / reject / defer + 怎么核实的）。不要在提示词里写「不要自己把 🛑 判成不重要」「复看到通过为止」这类把评审当裁判的规则；评审的 🛑 要有门槛（需求要求、用户可见可复现），复看接着上次的会话（`spawn_agents` 的 `resume`）只看增量，有轮数上限。
- 起因：b027ca9 起门禁只认评审的「通过」，执行角色又不许驳回 🛑：一组统计口径被评审连退八次，三个小修复 1h22m 没交付（见 [ADR 0009](../adr/0009-review-findings-triaged.md)）。
- 防线：`server/review-gate.test.ts`（不通过时按处置放行）、`server/core-agents.test.ts`（执行、评审的提示词）。

## 子任务的输出和节点一样，超长存文件，不静默截断

- 规则：`runHelper` 的结果走 `storeOutput`：超过 `MAX_OUTPUT` 时完整内容交给 `saveHandoff` 存文件，交回的结果写明路径。只 `clip` 会把评审后半段的 🛑 / 💭 丢掉，执行方看不到，下一轮又被提一遍。
- 起因：评审输出 3～4 万 token，执行只看到开头 4000 字，h2 还专门说「上次第 8 条被截断」。
- 防线：`server/engine-steps.test.ts` 的「输出超过交接上限时完整内容存成文件」。
