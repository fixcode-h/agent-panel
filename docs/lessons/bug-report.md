---
paths: shared/bug-diagnosis.ts, shared/bug-phase.ts, shared/bug-diagnosis-md.ts, web/src/components/tasks/DiagnosisDialog.tsx
---

# Bug 诊断报告

## 给用户看的「第几版」只在结论被推翻时升，不等于交了几次

- 规则：多份提交的文档（Bug 诊断报告这类）把「交的顺序号」和「给用户看的第几版」分开：顺序号做接口和记号（`Diagnosis.version`），第几版按阶段和用户的决定算（`shared/bug-phase.ts` 的 `nextRev`）——按意见修改、阶段往下走还是同一版，回到更早的阶段或换掉用户确认过的方案才升。界面、提示词、对话里那一行都用 `revOf`，工具返回里另写「报告 #n」给界面认。
- 起因：用户 2026-11-06 报「第 2 版 · 修复方案」：只是按意见改了几句、或者从根因走到方案，版本号就往上加了。
- 防线：`shared/bug-diagnosis.test.ts`「第几版（用户 2026-11-06 定）」。

## 论证的日志一轮加够：列全假设、每个假设一处、每跳一个路标

- 规则：要 Agent 加临时日志确认根因的提示词，不能只说「在可能分叉的几处加」「可以多轮」：要先沿调用栈列全候选假设，每个待验证的假设至少一处能判真假的日志，每一跳放一处路标，写判定表，让一次复现就能定论；每处都要对应假设或路标，不铺满。再要一轮必须写清上一轮看到了什么、为什么没定论。能核对的放进面板检查（`shared/bug-diagnosis.ts` 的 `evidenceProblem`：至少两个假设、待验证的假设按编号都有日志、又一轮要写 next），规则正文在 `shared/builtin/bug-method.ts` 的 `LOG_SCOPE_TEXT`。
- 起因：用户 2026-11-06 报一个 Bug 来回加了七八轮日志：定位是「这一层排除了才往下一层」、读不下去「换成加日志」，加上检查只要一个假设一处日志，Agent 每轮只在正在读的那一层加一两处。
- 防线：`shared/bug-diagnosis.test.ts`「论证的日志一次加够」。
