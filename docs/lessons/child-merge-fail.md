---
paths: server/tasks/merge.ts, server/exec/worktree-integrate.ts, server/tasks/worktree-routes.ts
---

# 子对话合回失败退回给谁

## 合回失败按谁能修交回：子对话能修的才退回它，父对话目录的问题留给父对话

- 规则：`integrateBranch` 的失败带 `kind`；只有 `conflict` 记 `failed` 并叫醒子对话。`blocked` / `branch` / `error`（父对话目录的暂存区、未提交改动、换了分支、提交出错）不叫醒子对话、`wrapRequest` 留 `requested`，说法写给父对话：目录、具体文件 / 分支、怎么处理、不是自己改的不要动，处理完直接再 `finish_child`。新加失败分支先定收件人；界面「用 AI 合并」也只看 `conflict`。
- 起因：审计 F2（2026-11，dev `7f9e492d`）：挡路也退回子对话，子对话被告知「不是你的问题，等父对话」、父对话被告知「它处理好会再请你」，两边互等；被叫醒的子对话开新一轮清掉收尾请求、再 submit_merge 来回空转。暂存区那条还被 `split('\n')[0]` 截得只剩冒号。
- 防线：`server/tasks/merge.test.ts` 的「父对话目录挡路」用例（五种挡路，rig 直接调真 `integrateBranch`）。
