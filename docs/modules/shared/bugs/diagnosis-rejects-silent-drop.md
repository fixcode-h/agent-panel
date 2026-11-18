# 诊断报告连续 3 次没通过面板核对就停下，三次退回都是面板自己的问题

- 状态：已修复（`shared/bug/dropped.test.ts`、`shared/bug/quotes.test.ts` 通过）
- 症状：Bug 子对话根因已查清，交诊断报告连着被退回三次（stack 里的 C 编号在 codeRefs 里没有 → hop 编号在 stack 里没有 → Q4 原文里没有 PreDestroyTargetTask），面板让它停下报「没做完就停下了」，报告没进弹窗
- 入口：`shared/bug/diagnosis.ts` 的 `submitOnce`；`shared/bug/diagnosis-schema.ts` 的 `.catch`；`shared/bug/quotes.ts` 的 `resolveFileQuote`
- 根因类型：schema 容错把超上限的数组整组悄悄丢掉、核对只报第一处问题、日志引用行号不校准
- 模块：`shared`（`shared/bug/`）
- 关键词：诊断报告、submit_diagnosis、核对、退回、连续 3 次、codeRefs、最多 6 条、catch、hop、S2 → S9、highlight、相对行号、sed -n、rg -n、PreDestroyTargetTask

## 现象

用户导出的对话「111016 重追踪后库拉蒂跟随与显示失效」（2026-11-18）：Agent 交 cause 报告，面板三次退回：

1. `stack 里挂的这些编号在 quotes、codeRefs、logPlan、hypotheses 里没有：C2、C5、C1、C3、C7、C8。`
2. `options.hops、hypotheses.hop、logPlan.hop 里这些编号在 stack 里没有：S2 → S9、S10 → S12。`
3. `Q4 的原文里没有「PreDestroyTargetTask」` ——连续第 3 次，面板让它 `end_turn(blocked)`，建议「换能力更强的模型」。

## 根因（证据链）

1. 第 1 次：Agent 写了 C1~C8 共 8 段 codeRefs ← `BugCase.codeRefs` 是 `z.array(CodeRef).max(6).catch([])`，超了 6 条整组变成 `[]`，不报错 ← 后面的编号核对拿着空数组说「C1 在 codeRefs 里没有」，Agent 以为是 stack 的 refs 写错了，把 C 编号换成 H 编号（证据反而少了）。证据链 `chain.refs` 里的 C1~C3 也会因此被退，只是排在后面没报出来。
2. 第 2 次：hop 写成了「S2 → S9」这样的范围，退回的话只说「在 stack 里没有」，没说错在写法。
3. 第 3 次：Agent 用 `sed -n '110650,111530p' 日志 | rg -n` 读大日志，rg 打的是相对行号，换算时算错 34 行（写成 110680，实际 110714）；关键代码有按 `marks.text` 校准行号，日志引用没有。
4. 三处都是独立的小问题，但 `submitOnce` 每次只返回第一处，三次退回额度被三个不同的问题各用掉一次。

## 修复

- `shared/bug/dropped.ts`：交报告、记档案时把 Agent 原样交的值和解析后的值对一遍，被 `.catch` 丢掉的数组 / 字符串按路径列出上限和原因（例如「codeRefs：最多 6 条，交了 8 条，整组没收下」）；记档案时不记，免得冲掉原来那一组。
- `submitOnce`：丢掉的字段、结构和阶段要求、原文核对、调用栈位置四组问题一次列全（编号），丢掉的字段排最前面。
- `shared/bug/quote-shift.ts`：日志引用（自己读的文件、用户贴的）那几行对不上原文或 highlight 时，在 ±2000 行里找离原位置最近、都对得上的一段挪过去，回执里告诉 Agent 挪到了哪、提醒相对行号。
- `stack-check.ts`：hop 写成范围 / 箭头时退回的话说清「一项只写一个编号」，refs 和 hops 的问题一起报。
