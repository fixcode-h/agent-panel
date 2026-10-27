# Pi 高负载时 get_state 超时，一轮直接判失败（现在自动重试一次）

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit` 通过）
- 症状：子任务卡片写着「Pi 执行失败：get_state 没有响应（已等 15s）· 进程还在运行 · stderr 没有输出」
- 入口：`server/exec/rpc/session.ts` 的 `createRpcSession`（请求超时）；`server/exec/runner.ts` 的失败分支
- 根因类型：环境性超时被当成任务失败，且失败前没有重试
- 相关：同一份诊断链里的上游断连和不带根因的失败汇报见 [pi-retry-upstream-diagnosis.md](pi-retry-upstream-diagnosis.md)；桥接扩展加载预算与 15 秒余量的来历见 [pi-bridge-tools-timeout.md](pi-bridge-tools-timeout.md)
- 模块：`server-exec`（`server/exec/rpc/session.ts`、`server/exec/runner.ts`、`server/exec/invoke.ts`、`server/exec/rpc/index.ts`），配套 `shared/clis/pi.json`
- 关键词：get_state 没有响应、进程还在运行、stderr 没有输出、REQUEST_TIMEOUT_MS、15s、环境性失败、自动重试、envStall、loadBudget

## 现象

用户报子任务失败，卡片上是：

```
Pi 执行失败：
get_state 没有响应（已等 15s）
进程还在运行
stderr 没有输出
```

条件：本机同时跑着多个子对话和面板的全量测试（高负载）。同一台机器上「执行别的任务」本身是好的，
只有冷启动那一轮被这条超时判死；用户重试后往往就过了。

## 根因

- 面板向 Pi 发的第一个请求是 `get_state`（`shared/clis/pi.json` 的 `rpc.handshake`），等不到回复按 `REQUEST_TIMEOUT_MS = 15_000` 判失败。
- 15 秒不是拍出来的：桥接扩展加载预算 10 秒 + 5 秒给 Pi 冷启动、读 stdin 和回包（见 `pi-bridge-tools-timeout.md`）。
  高负载时这段预算会被挤爆，`get_state` 还没回来就超时。
- 超时之前面板做得很对（错误里带了「进程还在运行」「stderr 没有输出」），但**没有任何一层会重试**：
  - 模型请求层的 `auto_retry` 是 Pi 自己的重试，只覆盖模型请求，管不到 RPC 握手；
  - 工作流节点的「接着完成本节点」是节点级续跑，对话轮和子任务没有；
  - runner 里已有的自动续接（`MAX_NET_RETRIES`）只认断流类报错，`failureHints` 也把它归到「没有响应」。
- 结果：一次纯环境性的慢启动被写成「执行失败」，用户看到的是一次白跑的失败，而机器其实只需要多等一会。

## 修复

只在**环境性失败**上自动重试一次（内容性失败不重试）：

1. **判定放在 session 层**（`server/exec/rpc/session.ts`）：只有这一层同时看得见「请求超时」「进程还活着（`diagnose.alive`）」
   「stderr 一个字都没有」。三者同时成立、并且**这一轮还没有过任何响应**（没 emit 过事件、也没有别的请求回过包）
   才置 `stalled`，并在 `finish` 产出的 `result` 事件上带 `envStall: true`。
   `CliEvent` 的 `result` 因此多了一个可选字段（`server/exec/parsers.ts`）。
   最后一条是评审时补上的：Pi 的收尾请求（`after` 里的 `get_session_stats` / `get_fork_messages`、`exit`、插话）都在这一轮已经有输出之后才发，它们超时时进程同样活着、stderr 同样干净，但那一轮模型可能已经报错、已经改过文件——按环境性失败重跑会重做已完成的部分，正是需求里明确不能重试的内容性失败。
   进程已经退出、或 stderr 里已经有报错，都不算环境性失败：那不是面板没等够。
2. **重试在 runner 失败分支**（`server/exec/runner.ts`）：`shouldRetryEnvStall` 只在
   `envStall && !prewarm && !aborted && budget > 0 && envStalls < MAX_ENV_RETRIES` 时成立，`MAX_ENV_RETRIES = 1`。
   `budget` 是该 CLI 的桥接扩展加载预算（`mcp.vars.loadBudget`），没有它的 CLI（codex / claude / commandcode）
   不重试：放宽不了等待，原样重跑一遍既没用、留痕里的「放宽到」也会说谎。
   重试走 `runAgent` 同一条递归路径，和已有续接的写法一致；这时上一轮的进程已经退出（`invokeCli` 返回前 `runProcess` 就结束了），
   不会留孤儿进程。所有递归重跑（断流续接、上下文降级、空回合、unsent handoff）都要把 `envStalls` / `envStallNotes`
   接着传：漏传会让「只重试一次」失效（计数归零），也会让重试成功后那张红卡收不掉。
3. **重试轮放宽等待**：`envStallTimeout(cliId) = REQUEST_TIMEOUT_MS + mcp.vars.loadBudget`（Pi 是 15s + 10s = 25s，
   再留一整份扩展加载预算），经 `invokeCli` 的 `requestTimeoutMs` → `rpcSessionFor` → `createRpcSession` 传下去。
   不写死 60 秒：60 秒会让一个真的卡住的进程白等一分钟。
4. **放宽值只有一处来源**：`LOAD_BUDGET_MS` 从桥接扩展模板里的字面量改成 `{loadBudget}` 占位符，生产值进
   `shared/clis/pi.json` 的 `mcp.vars.loadBudget`（10000）。扩展生成出来的脚本一模一样，代码却能从 CLI 定义里读到这个预算，
   不用在 runner 里再写一份。
5. **对话里留痕**：重试前先写一条 system 消息（失败卡 + 「这一轮没有响应，已自动重试 1 次（等待放宽到 25s）…」，
   次数按 `MAX_ENV_RETRIES` 现算、不写死在文案里，alert kind 是 `no_response`）；重试成功由 `settleEnvStallNotes` 收成普通说明
   （「已自动重试 1 次，这一轮继续做完了。」），不会留一张永远红着的失败卡。
   两次都没等到响应时，失败卡追加「已自动重试 1 次，仍然没有响应。」，用户看得出面板已经试过。

不改的：`shared/clis/pi.json` 的 `LOAD_BUDGET_MS = 10000` / `STEP_TIMEOUT_MS` 数值不变（只挪进 vars），
Pi 自己的 `auto_retry` 不动。空回合兜底、保活续轮、`endTurn` 只发一次回调这些既有语义没有改动：
环境性重试发生在失败分支，和保活不在同一条路径上。用量由每次 `usage` 事件自然累计，重试轮的 token 不会漏。

## 验证

- `server/exec/pi-rpc.test.ts`：
  - 「进程活着但没有输出就超时，结果事件标成环境性卡住（runner 据此重试一次）」；
  - 「这一轮已经有过响应，收尾请求超时不算环境性卡住（内容性失败不能整轮重跑）」——评审 R1 的回归，去掉「这一轮没响应过」的判定就会红；
  - 「stderr 里已经有报错时，超时不算环境性卡住」；
  - 「进程已经退出时，超时不算环境性卡住（重试也白搭）」；
  - 「正常结束的一轮不带环境性标记」；
  - 既有用例「Pi 扩展最坏的加载时长要留在 get_state 默认超时之内」改为从 `mcp.vars.loadBudget` 读预算（模板里已经是占位符）。
- `server/exec/hints.test.ts`：
  - 「环境性失败（进程活着、没有任何输出的超时）自动重试一次」；
  - 「环境性失败只重试一次：重试也超时就不再重试，失败卡片写明已重试过」；
  - 「内容性失败不重试：模型明确报错、用户停止、预热轮都没有环境性标记」；
  - 「重试轮的超时按扩展加载预算推导，说明里写清没有响应、已重试 1 次」；
  - 「环境性失败重试成功：那张「没有响应」的卡收成普通说明」。
- 这组用例在改前的实现上会失败（缺 `envStall` 标记、缺导出的判定/文案），改后通过。

## 防复发

- 判定只看 `envStall` 标记，不按错误文案匹配：界面语言切换后按中文报错匹配会失效。
- 「这一轮有没有响应过」只有 `session.ts` 里的 `responded` 一处判定：任何请求回过包、或 emit 过事件都置真。
  以后给 RPC 加新的收尾请求时不需要额外开关，它天然不参与环境性判定。
- 递归重跑的尾参数（`envStalls` / `envStallNotes`）漏传由 `hints.test.ts` 的源码断言守着：
  新增递归调用时它会直接红，不用等用户在对话里看见红卡收不掉。
- 「只重试一次」由 `MAX_ENV_RETRIES` 一处控制，和 `MAX_NET_RETRIES` / `MAX_EMPTY_RETRIES` 并列；
  新加环境性失败类型时改这里，不要在别处再写一个计数器。
- 扩展加载预算改了（`mcp.vars.loadBudget`）时重试轮的超时自动跟着变；那条既有断言
  （单步超时 × 次数 ≤ 总预算、总预算 + 余量 < 默认请求超时）仍然守着两边的余量。
