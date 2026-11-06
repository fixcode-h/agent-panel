---
paths: shared/bug-diagnosis.ts, shared/bug-phase.ts, shared/bug-diagnosis-md.ts, web/src/components/tasks/DiagnosisDialog.tsx
---

# Bug 诊断报告

## 给用户看的「第几版」只在结论被推翻时升，不等于交了几次

- 规则：多份提交的文档（Bug 诊断报告这类）把「交的顺序号」和「给用户看的第几版」分开：顺序号做接口和记号（`Diagnosis.version`），第几版按阶段和用户的决定算（`shared/bug-phase.ts` 的 `nextRev`）——按意见修改、阶段往下走还是同一版，回到更早的阶段或换掉用户确认过的方案才升。界面、提示词、对话里那一行都用 `revOf`，工具返回里另写「报告 #n」给界面认。
- 起因：用户 2026-11-06 报「第 2 版 · 修复方案」：只是按意见改了几句、或者从根因走到方案，版本号就往上加了。
- 防线：`shared/bug-diagnosis.test.ts`「第几版（用户 2026-11-06 定）」。
