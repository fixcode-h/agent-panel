# 重试提示只显示原始 JSON，子对话失败汇报只有一句「执行失败了」

- 状态：已修复（`npm run typecheck`、`npm run lint` 通过；`shared/alerts.test.ts`、`shared/plan.test.ts`、`server/exec/parsers.test.ts`、`server/exec/hints.test.ts`、`server/exec/pi-rpc.test.ts` 通过；全量单测与端到端、界面检查随合并由父对话跑）
- 症状：对话框里的「正在重试」原样甩出 500 + litellm 的 JSON，看不出是网关断连、限流还是上下文超长；子对话跑挂后交给父对话的汇报只有「失败：执行失败了」，用户以为是「汇报这个动作失败了」
- 入口：`server/exec/parsers.ts` 的 `notice` / `retry_ok` 解析、`shared/alerts.ts` 的 `alertInfo` / `classifyError`、`shared/task.ts` 的 `childReport`
- 根因类型：错误分类漏掉上游网关断连；失败汇报不带根因；重试成功没有收回「正在重试」
- 模块：`server-exec`（`server/exec/`），配套 `shared/alerts.ts`、`shared/task.ts`、`server/tasks.ts`、`shared/clis/pi.json`、`web/src/components/tasks/PeerMessage.tsx`
- 关键词：正在重试、模型请求失败、502 Bad Gateway、Connection closed、litellm、APIConnectionError、汇报失败、执行失败了、auto_retry_end、retry_ok、gateway、lastFailureNote

## 现象

用户遇到两条，方向相同：

1. 对话里出现「正在重试」卡片，正文是原始报错：

   ```
   模型请求失败，2 秒后第 1/3 次重试：500: {"message":"litellm.APIConnectionError: APIConnectionError: DeepseekException - Connection closed.","type":null,"param":null,"code":"500"}
   ```

   点开只有「Agent 向模型发的请求失败了，它正在自动重试」一句通用说明，用户无法判断该查网络、换接口还是压缩上下文。

2. 父对话收到子对话的失败汇报，卡片是「失败：执行失败了 · 汇报 · 已收到执行发来的消息」，正文第一行就是「失败：执行失败了」，看不到子对话为什么挂。

## 复现与证据

真实数据（`~/.agent-panel/tasks` 下 86 个消息文件）：

- 「正在重试」提示 52 次，没有一条重试耗尽（`retry_failed`），说明重试大多恢复了；这些提示只出现在一轮执行中间，事后无法统计是第几次、什么原因。
- 子对话汇报 152 条，其中失败 5 条（3.3%）。能查到根因的 2 条都是「面板的工具没接上（握手等了 4 秒还没回应 / 列工具等了 3.517 秒还没回应）」，其中一条正是用户截图里的「保证子对话运行时父对话不被回收」。
- 「交回失败」（父对话不存在、写消息失败）0 条，日志里也没有「回报父对话失败」。
- 失败任务上下文 26k–410k / window 1,000,000（`shared/model-catalog.json` 与 litellm 报的 `Max Input Tokens=1000000` 一致），不是上下文超长；面板 RPC 的 `REQUEST_TIMEOUT_MS = 15000` 只用于 `get_state` 这类请求，不参与模型请求，不是本次失败的原因。

错误原文是上游断连：`502 Bad Gateway`、`litellm.APIConnectionError ... Connection closed`、`Response payload is not completed`、`terminated`。

## 根因

1. `classifyError` 不认 502/503/504、「Connection closed」「Response payload is not completed」，这些错误落进「Agent 执行失败」或「网络错误」，与用户自己的网络问题混在一起；`alertInfo` 对「正在重试」只有一句通用说明，不按原因区分。
2. Pi 的 `auto_retry_end` 只映射了 `success: false`（重试失败），成功时什么都不发，那张「正在重试」永远停在对话里；重试事件也不写日志，事后无法统计「总是失败」是哪一类。
3. `childReport` 的失败分支只返回「执行失败了」，父对话收到的汇报、父计划里的等待说明、子对话栏都是这一句，看不到最后一条报错（重试耗尽的上游原文、面板工具没接上、进程被回收）。
4. `messageParent` / `noteParent` 找不到父对话时静默返回，日志里没有痕迹，「子对话自己跑挂了」和「结果交回失败」分不开。

## 修复

- `shared/alerts.ts`：新增 `AlertKind` 的 `gateway`（502/503/504、`Connection closed`、`Response payload is not completed`、upstream error/timeout、connection reset）；`isGatewayError()` 是唯一判定，`classifyError` 与 `server/exec/runner.ts` 的网络断流判定（`isNetError`，续接也按它走）共用。`alertInfo(kind, detail)` 让「正在重试」按原因细分说明和下一步：网关断连 / 限流 / 上下文接近上限（提示把自动压缩调到 70%）。英文同步 `shared/locales/en/alerts.ts`。
- `shared/clis/pi.json` + `server/exec/parsers.ts`：新增 `retry_ok` 事件（Pi 的 `auto_retry_end success: true`，字段 `attempt`，事件形状见 Pi 包里的 JSON 事件文档（`@earendil-works/pi-coding-agent` 的 `json.md`）），解析成 `{ type: 'retry_ok', text, attempt }`；`notice` 的 `retry` / `retry_failed` 带上 `kind`、`attempt`、`maxAttempts`、`error`。
- `server/exec/runner.ts`：`settleRetryNotes()` 把前面所有未恢复的「正在重试」收成「已恢复」；`retry_ok` 不额外占一行提示（保持「重试成功不再提示」的既有约定）；每次重试、重试失败、恢复都写 agent 日志（task、step、cli、kind、attempt、maxAttempts、error），事后可统计。
- `shared/task.ts`：`lastFailureNote()` 取最后一条未恢复的 error 级报错（工具行上是 CLI 报的，消息行上是面板写的），`childReport` 的失败分支变成 `执行失败了（根因）`。父对话收到的汇报、父计划等待说明、子对话栏读的是同一份结论。
- `server/tasks.ts`：`messageParent` / `noteParent` 找不到父对话时写 warn 日志，`messageParent` 回给子对话的 info 也说明没交回去。界面上「子对话自己跑挂了」是带失败的「汇报」卡片，「交回失败」是「消息没有送到」类警告或只有日志，两者不再是同一种样子。
- `web/src/components/tasks/PeerMessage.tsx`：失败汇报的副标题改成「子对话自己这一轮失败」；`AlertRow.tsx` 把 `alert.detail` 传给 `alertInfo`。

## 验证

- `npm run typecheck`、`npm run lint`（含 prettier、rules-check、secret-check）通过。
- `shared/alerts.test.ts`：「上游网关断开单列一类」「重试提示按原因给出不同的下一步」「重试的原因看不出时给通用说明」。
- `server/exec/parsers.test.ts`：「Pi 的重试事件：带上次数和原因，重试成功后算恢复而不是失败」。
- `server/exec/pi-rpc.test.ts` 的既有用例「Pi RPC：自动重试显示在回复里，不当成失败」保持通过：`retry_ok` 不能多出一行提示，只用来收掉前面那张卡。
- `shared/plan.test.ts`：「子对话执行失败：上报带上这次失败的原因」——重试耗尽、面板工具没接上、进程被回收三种根因都会出现在汇报里；已恢复的报错不算。

## 顺带发现（不是本次根因，未改）

派「文档」子任务时撞到一次「get_state 没有响应（已等 15s）· 进程还在运行 · stderr 没有输出」。这是面板向 Pi 发 `get_state` 的 RPC 超时（`server/exec/rpc/session.ts` 的 `REQUEST_TIMEOUT_MS = 15000`），当时本机正在跑全量单测（高负载），Pi 冷启动加扩展加载超过了 15 秒的预算；和 500 断连不是同一类：500 是 Pi 已经开始请求模型后上游断连，会走 `auto_retry`；这里是 Pi 还没回 RPC。单独记为已知问题，不在这次修复范围。
