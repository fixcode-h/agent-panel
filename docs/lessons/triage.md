---
paths: shared/inline-edit.ts, shared/agent-role.ts, shared/dispatch.ts, shared/expose.ts
---

# 父对话分诊和就地微改动

## 父对话只分诊派单，改文件、编译都在子对话里

- 规则：父对话（主理）只收集到模块为止就分派，不开 worktree；唯一能改文件的是护栏内的就地微改动（不用排查、≤ 2 文件 ≤ 20 行，`begin_inline_edit` / `end_inline_edit`，[ADR 0023](../adr/0023-role-layers-and-triage.md)），护栏写在 `shared/inline-edit.ts`，不要只靠提示词放宽，也不要关掉 CLI 的写文件工具（093a41e 之后撤回）。子对话在独立分支里编译测试，`submit_merge` 带 `tests` 请父对话合回（[ADR 0002](../adr/0002-child-merge-on-done.md)）；UE 项目由父对话按申请 `request_build`（[ADR 0004](../adr/0004-ue-build-by-parent.md)）。
- 起因：父对话先把问题查到底、自己动手改，还开 worktree；编译又要合并到父对话那边才跑。
- 防线：`server/orchestrator.test.ts`、`server/role-layers.test.ts`、`scripts/e2e.mjs` 的子对话合并用例。
