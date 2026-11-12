# 子对话停在「合回」前没人推，整棵对话树停住

- 状态：已修复（`shared/tasks/idle-ask.test.ts` 的 `turnSettled`、`nextMergeStall` 用例通过）
- 症状：子对话说「现在收尾」就结束这一轮，没调用 `submit_merge`；之后面板不提醒，父对话也不再收到上报，父子两边都停在「等下一句」
- 入口：`server/tasks/children.ts` 的 `nudgeMerge`、`reportChild`；`shared/merge-stall.ts`
- 根因类型：提醒只认进程退出（status done），保活的 CLI 永远不满足；上报按「状态没变」去重，再停一次被吞掉
- 模块：`server`（`server/tasks/children.ts`、`shared/merge-stall.ts`）
- 关键词：子对话、合回、submit_merge、收尾、保活、等下一句、去重、整棵树停住、Claude Code

## 现象

真实 API 实测（Claude Code + `deepseek-v4.1-flash`）：calc 子对话说「现在收尾」后结束这一轮。面板日志只有两条「对话计划没做完就收尾，已推它接着做」，之后再没有推动；父对话只收到一次「只剩合回父对话的分支」，父对话交回后子对话又停在同一处，再无下文，一直停到面板重启。

## 根因

1. `nudgeMerge` 要求 `child.status === 'done'`。Claude Code 保活时一轮结束后进程还在等下一句，`status` 一直是 `running`，这条「请父对话收尾」的提醒永远发不出去；只有进程退出（非保活）才会提醒。
2. `planStalled` 把「只剩合回」排除在外（归上面那条提醒管），`nudgePlan` 也不推。
3. `reportChild` 按 `reportKey` 去重，「未完成」的键是计划进度：父对话交回一次、子对话再停在同一处，状态和上次一样，上报被吞掉，父对话不会再知道。

## 修复

- `nudgeMerge` 改看 `turnSettled`（这一轮已说完：不在处理、进程退出或保活挂着），进程挂着时派出的子任务、工作流还在跑的不提醒。
- 只剩合回又停下时每停一轮（按 `turnDoneAt`）记一次（`nextMergeStall`），去重键带上次数，上报写明「第 N 次停在这里」；最多报 `MERGE_STALL_REPORTS`（3）次，最后一次让父对话去问用户，免得父子来回互相催。

## 没做

- 实测报告建议的「子对话多久没动静就问也覆盖一轮结束、计划没完的情况」：`childIdleAsk` / 卡住重启（ADR 0036）只管执行中没输出的，扩到空闲的要改判定和重启语义，留给后续。

## 防线

- `shared/tasks/idle-ask.test.ts`：`turnSettled`（保活时 running 也算说完、失败停下不算）、`nextMergeStall`（同一轮不多记、换轮加一、进度变了重数）。
