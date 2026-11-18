---
paths: shared/bug/diagnosis.ts, shared/bug/dropped.ts, shared/bug/quotes.ts, shared/bug/quote-shift.ts, shared/bug/stack-check.ts, shared/bug/diagnosis-schema.ts
---

# Bug 诊断报告：交报告时的核对和退回

## 一次列全问题，schema 丢掉的字段要说出来，行号能校准就校准

- 规则：Agent 交上来的结构化报告，核对不过时把各组问题一次列全（编号），不要只报第一处——连续退回有次数上限，三个独立的小问题各退一次就把额度用完了。schema 为容错写的 `.catch`（数组超上限变 `[]`、字符串超长变 `''`）不能静默：交报告和记档案时用 `shared/bug/dropped.ts` 对一遍原样输入和解析结果，丢了的按路径说清上限，排在最前面；否则后面的编号核对会把锅甩给别的字段。Agent 写的行号（代码、日志）能按原文或关键值在附近找到的就校准过去并告诉它，不退回。
- 起因：用户 2026-11-18 导出的 Bug 对话：codeRefs 写了 8 条被 `.max(6).catch([])` 整组丢掉、hop 写成「S2 → S9」、日志行号按 `sed -n | rg -n` 的相对行号算错，三处各退一次，报告没交上去还被说成「换能力更强的模型」。见 [bugs/diagnosis-rejects-silent-drop](../modules/shared/bugs/diagnosis-rejects-silent-drop.md)。
- 防线：`shared/bug/dropped.test.ts`、`shared/bug/quotes.test.ts`「日志引用行号偏了」。
- 补充（用户 2026-11-18 定）：退回次数只数「问题没变少」的，问题比上次少算在往前改；另设这一段一共 6 次兜底。停下时警告和父对话上报都带最后一次退回原文，不说「换能力更强的模型」。关键代码 codeRefs 不限条数。
