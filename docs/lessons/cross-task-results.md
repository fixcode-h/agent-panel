---
paths: server/tasks/merge.ts, server/tasks/jobs.ts, server/tasks/build-results.ts, server/tasks/drive.ts, shared/build-ask.ts, shared/wrapup-prompt.ts, server/orch-mcp.ts
---

# 对话之间交回的结果

## 跨对话交回的结果由面板记账，不靠模型填参数；推给待收尾的子对话不要叫醒它

- 规则：一个对话替另一个对话做的事（父对话替子对话编译、跑测试），「做完交给谁」记在被服务的那个任务上并落盘（例如 `Task.buildAsk`），结果按记录推回；模型漏填 `children` 这类参数时由面板按记录补上，提示里写的参数名要和工具定义一致。结果推给已经在「待收尾」的子对话时不开新的一轮（开了会作废它的收尾请求），只记一行，改为告诉父对话去 `finish_child`。提示词里的「先等结果再收尾」要配一道面板侧的门禁（`submit_merge` 核对），不能只靠提示词。
- 起因：用户 2026-11-04 报 UE 子对话把编译交给父对话后一直待收尾：结果靠内存里的 `buildFor` 按 `children` 推，父对话漏填、提示写成 `child`、面板重启都会丢；子对话提示又说「申请发出就算完成」，提前交了收尾，两边互相等。
- 防线：`server/tasks/merge.test.ts` 的「UE 共用目录的子对话」「编译通过时子对话已经在等收尾」，`shared/build-ask.test.ts`。
