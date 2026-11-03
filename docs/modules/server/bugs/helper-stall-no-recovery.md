# 子任务卡在网关上没人管，父对话一直干等

- 状态：已修复（`shared/helper-summary.test.ts`、`shared/lifecycle.test.ts`、e2e `09-subagent-runtime` 通过）
- 症状：对话派的子任务（Claude Code + `deepseek-v4.1-flash`）交回一个工具结果后 5 分钟没有任何新请求和输出，进程活着；父对话计划在等它，不推也不报；诊断说「输出到一半停了…卡在流式输出里」
- 入口：`server/exec/stall-watch.ts`（原在 `server/exec/runner.ts` 里）、`shared/helper-summary.ts` 的 `runStalled`、`shared/lifecycle.ts` 的 `verdictOf`
- 根因类型：检测范围漏了一类调用（没有响应检测只给对话本身，带 step 的子任务不查）+ 没有恢复路径（子对话有卡住重启，子任务没有）+ 诊断阈值和 runner 不一致
- 模块：`server`（`server/exec/stall-watch.ts`、`server/exec/runner.ts`、`server/exec/parsers.ts`）、`shared`（`shared/helper-summary.ts`、`shared/lifecycle.ts`）
- 关键词：子任务、卡住、没有响应、网关、首字节超时、重试、api_retry、unknown、干等、output-stalled

## 根因

runner 的「没有响应」检测写的是 `chat = !step && …`，子任务都带 step，完全不查；子对话卡住有 `server/tasks/stuck-child.ts` 问状态、重启、换人接手，子任务只剩空闲超时兜底（默认 15 分钟提醒、再 15 分钟停掉按失败交回）。父对话的计划步骤在等它，自驱按设计不推，于是整棵树干等。诊断的输出停住阈值是 120 秒，runner 是 90 秒，runner 已标卡住诊断还说「模型在输出」；最后收到的是工具结果时也说成「卡在流式输出里」。

同一批诊断里子任务一启动约 60 秒就出现「CLI 重试模型请求 error=unknown」：是 Claude Code 自己的首字节超时（`CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`，网关在时限内连响应头都没回就重试一次），面板丢掉了事件里的 `waited_ms`，看不出原因。

## 修复

- 没有响应检测抽到 `server/exec/stall-watch.ts`，子任务也查（按「任务#步骤」记，不和对话互相覆盖）；子任务标卡住后再过 90 秒还没输出就停掉这次调用、返回 `stalled`。
- `runStalled`：接回同一个会话重试，每次在子任务里写一行说明，最多 `CHILD_RESTART_MAX` 次；用完按失败交回父对话，由它按计划处理。
- 诊断：输出停住阈值改成 90 秒，runner 已标卡住的直接报；最后是工具结果时写「工具结果交回 N 秒，模型的下一次请求没回来」。
- 重试卡片带上首字节超时等了多久。

## 防线

- `shared/helper-summary.test.ts`「子任务卡住被 runner 停掉」；`shared/lifecycle.test.ts`「工具结果交回后没了下文」；`server/exec/parsers.test.ts` 的首字节超时；e2e `09-subagent-runtime`「子任务卡住」（fake CLI 的 `HELPER_FREEZE_ONCE`）。
