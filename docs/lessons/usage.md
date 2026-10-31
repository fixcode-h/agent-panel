---
paths: shared/run-usage.ts, server/run-usage.ts, server/exec/parsers.ts, server/exec/parsers.test.ts, web/src/lib/tasks.ts, web/src/lib/useRunUsage.ts, web/src/components/tasks/TaskMeta.tsx, web/src/components/tasks/LiveStats.tsx
---

# 用量和速度的统计口径

## 速度只算正在输出的，分层不要各自回退 lastTps

- 规则：`Task.usage.agents[id].tps` 是实时速度（CLI 那边 1.5 秒没有新输出就清零），`lastTps` 是「这一轮最后一次的速度」，只能在明确标成「上次」时显示。分层显示的速度（本对话 / 子任务与子对话 / 整体）一律用 `tpsNow`（`shared/run-usage.ts`），不要某一层回退 `lastTps`：各层回退的时机不一样（父对话每轮把 lastTps 清零、子对话留着上一轮的值），加起来就对不上，还会出现「什么都没在输出，浮层里还有 2041.7 token/s」。没在输出时界面写「空闲」。
- 规则（往下再一层）：分层按 Agent 归属，但**不要反过来只按步骤里的 agentId 反推**：对话自己那一轮的 Agent 不一定挂在任何节点上（对话的步骤里往往只有 `slot: 'sub'` 的子任务），只认「自己步骤用到的 Agent」会把本对话的速度整个丢掉。本对话 = 不在子任务里独有的角色，子任务那层 = 只在 `slot: 'sub'` 节点里出现的角色，两边都有的算本对话。
- 起因：Token 浮层第一版按层各自回退 `lastTps`，子任务那行显示残留的 2041.7 token/s、本对话那行却是 0，用户报过来（父对话速度按 0 统计、子对话还带着旧速度）；改成只算实时后，又因为只按步骤反推，父对话在写时本对话那行还是 0。
- 防线：`shared/run-usage.test.ts` 里「速度：」开头的用例（全都空闲、混着 lastTps、只有父对话在写、只有子对话在写、对话自己的 Agent 没挂在节点上）；`scripts/ui-check.mjs` 造这两种数据各截一张，并断言浮层里不出现残留速度。

## 常驻多轮时，result 的累计字段按差值记

- 规则：CLI 开了保活（`RpcAdapter.next`）后同一进程连跑多轮，解析器要分清两种口径：`result` 里明确是「会话累计」的字段（Claude Code 的 `total_cost_usd`，`--output-format stream-json` 常驻时每轮重述 running total）按和上次的差值记，不能直接 `+=`；「本轮」口径的 `usage` 在每轮 `result` 后把流式累计清零，否则下一轮的兜底补差会被上一轮已上报的量抵成 0。
- 起因：给 Claude Code 开保活后，`claudeParser` 的 `addCost: o.total_cost_usd` 每轮把会话累计值再加一遍，费用越聊越高（评审 R1）。
- 防线：`server/exec/parsers.test.ts` 的「stream-json 的文字、思考、工具、待办和用量」末尾的跨轮断言。
