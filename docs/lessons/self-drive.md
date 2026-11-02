---
paths: server/tasks/children.ts, server/tasks/merge.ts, shared/drive.ts, shared/turn-rules.ts, shared/helper-batch.ts, server/tasks/inbox-file.ts, server/store.ts
---

# 对话自驱和交给模型的数据（ADR 0041）

## 推进次数只在真推出去时记，每个判断写进对话日志

- 规则：一轮结束时只看还剩不剩次数（`peekNudge`），等 CLI 停稳、复查通过、消息交出去之前才 `takeNudge`；复查没通过（这期间后台结果、消息交进来了）不记次数。进度按 `shared/drive.ts` 的 `planProgressKey`（步骤 id + 状态）算，不按「已完成几步」。用户亲自发消息清零次数。推了、没推、为什么，都 `taskLog` 写「计划推进」「收尾自检」，诊断文件带 `plan` / `nudge`。
- 起因：2026-11-02 诊断文件：连着三条后台结果在这一轮刚结束时交进来，次数白白耗光，之后计划才做 3/7 也不再推；不推的原因只进全局日志，诊断里看不到。
- 防线：`shared/drive.test.ts`、`shared/lifecycle.test.ts`「计划没做完却停下」、e2e `03-chat`「收尾自检」。

## 没有计划不逼着列计划：拿不准时收尾自检一次

- 规则：不需要计划的事这一轮结束就算完成。只在「动手 ≥3 处没计划」或「新输入后第一轮一个工具都没调」时补一句收尾自检，结果看自检那一轮动没动手，不解析文字；同一条输入最多 2 次（零工具的 1 次）。
- 起因：用户 2026-11-02：避免完全靠计划的怪圈，同时「说了要做却没做」不能出现。

## 给模型的内容截断必须留全文指针，指针必须读得到

- 规则：拼进提示词、交回结果的长文本只用 `clipToFile`（`shared/helper-batch.ts`）或 `inboxWithFile`（`server/tasks/inbox-file.ts`）截，写明全文路径；直接 `clip()` 只用于日志和界面摘要。全文存在交接目录，CLI 启动前用 `handoffDirOf` 建好并放行，不能「目录存在才放行」。评审、验收（whole）上限 `WHOLE_OUTPUT`。
- 起因：用户 2026-11-02 报父对话「评审摘要被面板截断，完整结论没拿到」：保活 CLI 启动时交接目录还没有、没放行，之后存的全文读不到；子对话汇报、节点结果还有几处直接 `clip` 不留指针。
- 防线：`server/tasks/inbox-file.test.ts`。
