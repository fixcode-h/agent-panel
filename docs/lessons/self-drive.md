---
paths: server/tasks/children.ts, server/tasks/merge.ts, server/tasks/drive.ts, shared/drive.ts, shared/turn-rules.ts, shared/helper-batch.ts, server/tasks/inbox-file.ts, server/store.ts
---

# 对话自驱和交给模型的数据（ADR 0041）

## 状态只认工具调用，绝不按 Agent 回复里的字判定

- 规则：完成没有、通过没有、走哪条分支，只看结构化信号（`submit_verdict` 记在 `TaskStep.submitted` 上、CLI 协议事件、面板自己写的字段），不用正则从模型回复里找「验收结论：通过」「## 总结」这类字眼；没交就补问一次，再没有按出错显示，**不默认通过 / 做完**。回复文字只用来展示和交接。
- 起因：用户 2026-11-02：「绝对不能依靠 Agent 的输出包含什么就任务处于什么状态」；排查出 7 处按文字判状态，其中验收、分支、主角色决定读不到时默认按通过 / 继续。
- 防线：`scripts/rules-check.mjs` 第 19 条；`server/review-gate.test.ts`「只认 submit_verdict」、`server/engine-steps.test.ts`「验收没交 submit_verdict」、`shared/helper-summary.test.ts`。

## 推进次数只在真推出去时记，每个判断写进对话日志

- 规则：一轮结束时只看还剩不剩次数（`peekNudge`），等 CLI 停稳、复查通过、消息交出去之前才 `takeNudge`；复查没通过（这期间后台结果、消息交进来了）不记次数。进度按 `shared/drive.ts` 的 `planProgressKey`（步骤 id + 状态）算，不按「已完成几步」。用户亲自发消息清零次数。推了、没推、为什么，都 `taskLog` 写「计划推进」「收尾自检」，诊断文件带 `plan` / `nudge`。
- 起因：2026-11-02 诊断文件：连着三条后台结果在这一轮刚结束时交进来，次数白白耗光，之后计划才做 3/7 也不再推；不推的原因只进全局日志，诊断里看不到。
- 防线：`shared/drive.test.ts`、`shared/lifecycle.test.ts`「计划没做完却停下」、e2e `03-chat`「收尾自检」。

## 子对话和顶层对话一样自驱，推满了才报父对话

- 规则：`nudgeMax` 只按 Chat / Agent 分（Agent 模式按设置 `nudgeMax`，默认 6 次、0 表示不自动推；Chat 页 1 次），不按是不是子对话分。父对话只在子对话推满（`stuckAfterNudge` 读推满时才记的 `planNudged`）时收到一次「卡住」，信里写明不要只发「继续」；父对话交代新任务（peer parent + task）给子对话一次新机会。0 只是不推模型（也不留「推了几次」的警告），子对话卡住仍要在 `nudgePlan` 的 `can !== 'ok'` 分支上报父对话，否则父计划会一直挂着。
- 起因：用户 2026-11-02：自驱属于对话自己，不是父对话检测到再来推，外部消息只改变计划。
- 防线：e2e `09-subagent-runtime`「子对话自己推满 3 次仍不动，才上报父对话一次」（这一片把设置 `nudgeMax` 调成 3，省时间并覆盖设置生效）；默认值和范围在 `shared/settings.test.ts`。

## 没有计划不逼着列计划：拿不准时收尾自检一次

- 规则：不需要计划的事这一轮结束就算完成。只在「动手 ≥3 处没计划」或「新输入后第一轮一个工具都没调」时补一句收尾自检，结果看自检那一轮动没动手，不解析文字；同一条输入最多 2 次（零工具的 1 次）。
- 起因：用户 2026-11-02：避免完全靠计划的怪圈，同时「说了要做却没做」不能出现。

## 给模型的内容截断必须留全文指针，指针必须读得到

- 规则：拼进提示词、交回结果的长文本只用 `clipToFile`（`shared/helper-batch.ts`）或 `inboxWithFile`（`server/tasks/inbox-file.ts`）截，写明全文路径；直接 `clip()` 只用于日志和界面摘要。全文存在交接目录，CLI 启动前用 `handoffDirOf` 建好并放行，不能「目录存在才放行」。评审、验收（whole）上限 `WHOLE_OUTPUT`。
- 起因：用户 2026-11-02 报父对话「评审摘要被面板截断，完整结论没拿到」：保活 CLI 启动时交接目录还没有、没放行，之后存的全文读不到；子对话汇报、节点结果还有几处直接 `clip` 不留指针。
- 防线：`server/tasks/inbox-file.test.ts`。

## 互相等的两侧都要有兜底：子对话等父对话收尾时，父对话那一步不算「在等别人」

- 规则：给一侧加了「只说不做时推一次」（子对话的 `nudgeMerge`）之后，检查对面那一侧：父对话计划里「等子对话」的步骤，在子对话已请求收尾（`wrapUpPending`）时等的是父对话自己的 `finish_child`，一轮结束时由 `nudgeWrapUp` 推它；判断只在 `shared/task.ts` 一处，状态诊断（`wrapup-unhandled`）共用它。
- 起因：用户 2026-11-03 报父对话回「现在合回」就结束了这一轮，`planStalled` 见计划有等待中的步骤就不推，父子一直互相等。
- 防线：e2e `04-subagents`「父对话收到收尾请求却没合回」、`shared/lifecycle.test.ts`、`shared/tasks/idle-ask.test.ts`。
