---
paths: shared/bug/diagnosis.ts, shared/bug/phase.ts, shared/bug/diagnosis-md.ts, shared/bug/quotes.ts, shared/bug/cleanup.ts, server/tasks/bug-cleanup.ts, web/src/components/tasks/DiagnosisDialog.tsx
---

# Bug 诊断报告

## 给用户看的「第几版」只在结论被推翻时升，不等于交了几次

- 规则：多份提交的文档（Bug 诊断报告这类）把「交的顺序号」和「给用户看的第几版」分开：顺序号做接口和记号（`Diagnosis.version`），第几版按阶段和用户的决定算（`shared/bug/phase.ts` 的 `nextRev`）——按意见修改、阶段往下走还是同一版，回到更早的阶段或换掉用户确认过的方案才升。界面、提示词、对话里那一行都用 `revOf`，工具返回里另写「报告 #n」给界面认。
- 起因：用户 2026-11-06 报「第 2 版 · 修复方案」：只是按意见改了几句、或者从根因走到方案，版本号就往上加了。
- 补充（用户 2026-11-13 定）：用户提问、补充或不认同后它在同一版里重出的，显示成小版本 N.1、N.2（`verOf`），让用户看得出是针对他的意见新出的；结论推翻才升大版本。
- 防线：`shared/bug/diagnosis.test.ts`「第几版（用户 2026-11-06 定）」。、`shared/bug/diagnosis-ask.test.ts`「小版本」。

## 论证的日志一轮加够：列全假设、每个假设一处、每跳一个路标

- 规则：要 Agent 加临时日志确认根因的提示词，不能只说「在可能分叉的几处加」「可以多轮」：要先沿调用栈列全候选假设，每个待验证的假设至少一处能判真假的日志，每一跳放一处路标，写判定表，让一次复现就能定论；每处都要对应假设或路标，不铺满。再要一轮必须写清上一轮看到了什么、为什么没定论。能核对的放进面板检查（`shared/bug/diagnosis.ts` 的 `evidenceProblem`：至少两个假设、待验证的假设按编号都有日志、又一轮要写 next），规则正文在 `shared/builtin/bug-method.ts` 的 `LOG_SCOPE_TEXT`。
- 起因：用户 2026-11-06 报一个 Bug 来回加了七八轮日志：定位是「这一层排除了才往下一层」、读不下去「换成加日志」，加上检查只要一个假设一处日志，Agent 每轮只在正在读的那一层加一两处。
- 防线：`shared/bug/diagnosis.test.ts`「论证的日志一次加够」。

## 报告里的原文由面板取、逐字核对，不信 Agent 抄的

- 规则：诊断报告里要给用户看的代码、日志、命令输出，Agent 只写位置（文件和行号、第几份日志第几行、原样复制的输出），原文由面板取（`shared/bug/quotes.ts` 的 `resolveSources`）：代码在交报告时读出来存成快照，不在打开弹窗时现读；`marks.text`、日志摘抄、命令输出对不上来源就拒收这一版。行号按 `marks.text` 在附近几行里校准，告诉 Agent 改到了哪一行。验证这一版沿用根因那一版的快照，不重新取（修完那几行已经变了）。
- 起因：用户 2026-11-10 给真实接入实跑 Bug 流程：codeRef 按原文件行号写、面板从加了临时日志的工作区现读，高亮到了错的一行；证据链里的「日志原文」被 `…` 截掉一半、去了前缀；logPlan.print 写的是描述，打出来的日志对不上；构造的数据被当成排除假设的证据。
- 防线：`shared/bug/quotes.test.ts`、`shared/bug/diagnosis.test.ts`「交报告时取代码快照、核对原文」。

## 取消修复：临时日志让 Agent 一处一处删，面板只查不删，核对干净才关闭

- 规则：用户取消修复时，面板只读地查出 `[排查-` 日志列给用户看，确认后交给 Agent 删（连加日志时带进来的空行），这一轮结束后按「加日志之前的快照」核对，通过才关闭报告、收口计划；没过列出还剩什么，由用户选再删一次或自己处理，不悄悄重试。面板不做一键删除，也不拿快照还原文件；删日志期间拦住 `git checkout -- / git restore / p4 revert / svn revert` 整文件还原（共用目录会冲掉文件里别的改动）。
- 起因：用户 2026-11-10 定的做法；实跑时 Agent 用 `git checkout --` 还原了两个文件（F1），父对话收到的是「交付完了」（F4）。
- 防线：`shared/bug/cleanup.test.ts`、`shared/bug/diagnosis.test.ts`「取消时代码里有临时日志」、`server/hooks/guards.test.ts`「取消后删临时日志」。
