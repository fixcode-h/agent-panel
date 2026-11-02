# 评审结论交回父对话时被截断，完整结论拿不到

- 状态：已修复（`server/tasks/inbox-file.test.ts` 通过）
- 症状：父对话说「评审摘要被面板截断，完整结论没拿到」，只能让评审子任务把上一轮结论原样重述一遍
- 入口：`shared/engine.ts` 的 `storeOutput` / `settleHelpers`，`shared/helper-batch.ts` 的 `clipToFile`，`server/exec/runner.ts` 放行交接目录（`handoffDirOf`）
- 根因类型：交接文件读不到（保活 CLI 启动时目录还不存在、没放行）+ 多处直接截断不留全文指针
- 模块：`server`（`server/exec/runner.ts`、`server/tasks/inbox-file.ts`）、`shared`（`shared/engine.ts`、`shared/helper-batch.ts`）
- 关键词：评审、截断、摘要、交接文件、全文、add-dir、保活、重述、数据不全

## 根因

子任务输出超 4000 字时只交开头，全文存进交接目录并写明路径；但交接目录只在 CLI 启动时已存在才放行（`existsSync` 后 `--add-dir`），保活的父对话 CLI 启动时还没有子任务交过结果，之后写进去的全文它读不到。另外子对话汇报（2000 字）、节点结果、验收意见等多处直接 `clip`，不说全文在哪。

## 修复（ADR 0041 第 14 节）

- 交接目录在 CLI 启动前建好并放行；评审、验收上限放宽到 2 万字。
- 子对话汇报、节点 / 委派结果、验收和评估意见、计划执行结果、主角色输出、收尾请求、子对话状态摘要超长时都存全文并写明路径（`clipToFile` / `clipWithFile`）。

## 防线

- `server/tasks/inbox-file.test.ts`；教训 `docs/lessons/self-drive.md`「给模型的内容截断必须留全文指针」。
