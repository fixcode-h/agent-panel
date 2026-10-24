---
paths: shared/review-gate.ts, server/review-gate.test.ts, shared/builtin/agents.ts, shared/verdict.ts, server/orch-mcp.ts, server/exec/git.ts
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

## 评审花的是回合数：通过就收尾，别为建议再开一轮，评审只看代码

- 规则：意见分高级 / 中级 / 低级 / 建议：高级、中级逐条处置；评审通过后只顺手改不改变行为的低级，改行为 / 布局的低级和建议记进交接的「遗留和后续」。局部修复补了断言、亲手确认改前失败改后通过的不复看。评审只做代码层面的审查（用户要求）：不跑测试、不搭测试环境、不写测试或复现脚本，改动由面板一次附进提示词（`reviewDiff`，复看只附增量），怀疑从代码推导写成失败场景，复现交给执行者；所以它的结论不当真，执行者对每条要改的意见重新评估真假、级别和改法再动手（[ADR 0010](../adr/0010-review-code-only.md)）。
- 起因：2026-10-24「状态栏拆三行」第 1 轮已通过，执行去落 5 条 💭，其中一条（+N 移进卡片容器）改出窄屏被裁的 🛑，又多两轮；三轮共 20 分钟，工具本身只用了约 4 分钟，其余是评审每轮重跑 typecheck / lint / 演示构建 / 界面检查、摸索本机 Playwright 路径的来回。
- 防线：`server/core-agents.test.ts`（执行、评审的提示词）。
