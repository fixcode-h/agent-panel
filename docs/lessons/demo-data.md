---
paths: web/src/lib/demo-*.ts, shared/engine.ts, shared/flow/run*.ts
---

# 在线演示的数据（web/src/lib/demo-*.ts）

界面检查本身的写法在 [ui-check.md](./ui-check.md)。

## 改了执行引擎认哪种任务，同一个提交里把演示数据迁过去、跑一遍界面检查

- 规则：引擎不再执行某种旧数据（例如没有 `flowRun` 的工作流任务直接报「旧版任务」）时，演示数据（`web/src/lib/demo-*.ts`）里按老方式建的同类任务一起改成新结构，并按新结构核对界面检查里依赖它们的前提（运行记录、子对话、运行区）；单测和 e2e 全绿不代表演示没坏，提交前 `npm run build:demo && node scripts/ui-check.mjs` 跑一遍受影响的分片。
- 起因：4304d14 工作流改成独立运行，演示里两条工作流任务没有 `flowRun`，全成了失败、没有运行记录，dev 上 02b / 02c / 02d 三片界面检查一起红，挡住了别的 PR 合主干。
- 防线：`scripts/ui/02d-workflow.mjs`（工作流运行在跑时的卡片）、`02b-subagent.mjs`（子对话里的运行视图）、`02c-element-pick.mjs`（节点与子 Agent）。
