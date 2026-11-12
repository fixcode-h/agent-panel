# 会话栏「已使用」在对话和子任务的占用之间来回跳

- 状态：已修复（`server/exec/usage-record.test.ts` 通过）
- 症状：对话的会话栏「上下文」一会儿显示已使用 8%（87.7k / 1.00M），一会儿显示 20% 多，来回跳
- 入口：`server/exec/runner.ts` 的 `au()`（用量事件、上下文细分快照）；`web/src/components/session/SessionContext.tsx` 的 `sessionUsage`
- 根因类型：两个会话写同一条按角色记的记录；界面按「最后一条回复的角色」选记录，子任务的回复也算进去
- 模块：`server-exec`（`server/exec/runner.ts`、`server/exec/usage-record.ts`）、`web`（`SessionContext.tsx`、`TaskMeta.tsx`）
- 关键词：上下文、已使用、百分比、跳动、子任务、spawn_agents、usage.agents、snapshot、会话栏、圆环

## 现象

用户 2026-11-12 报：会话栏的上下文百分比一会儿百分之几，一会儿百分之二十几。截图是 Claude Code 报的细分（消息 58k、自动压缩余量 300k），87.7k / 1.00M = 8.8%。

## 根因（证据链）

1. 会话栏读 `Task.usage.agents[角色]` ← `Task.usage.agents` 只按角色 id 记，一个会话一条的假设不成立。
2. 对话派出的子任务（`spawn_agents` 的节点，`sessionKey` 是节点 id）和对话本身常常是同一个角色，两个 CLI 会话同时在跑：runner 的 `au()` 不分会话，每次 `message_start` 的用量、每轮结束的 `get_context_usage` 快照都写进同一条，于是 `context` 在对话的 87k 和子任务的 200k 多之间轮流被覆盖。
3. 子任务换了档位、用了别的模型时，runner 开头「中途换了模型」那一行还会把角色那一条的 `window` 改成子任务模型的窗口，分母也跟着变。
4. 角色不同时也会跳：`sessionUsage`（和输入框下圆环的 `TaskMeta`）按「最后一条带 agentId 的回复」选记录，子任务的回复（带 `step`）也在 `task.messages` 里，选中的角色在对话和子任务之间来回换。
5. 顺带的副作用：对话下一轮的「上下文骤降 = CLI 悄悄压缩过」（`compactedSilently`）拿子任务写进去的大数比较，会误判成压缩、整份重发规则；面板自己压缩的 CLI（Pi）按这一条判断是否到了自动压缩线，也会被误触发。

## 修复

- `server/exec/usage-record.ts` 的 `contextUsage`：对话里的子任务（`ownContext`）上下文、窗口、模型、快照、面板工具只记在这次调用自己的一份上（节点的 `usage` 照旧由 runner 抄过去），不再写角色那一条；速度、累计输出仍按角色记。工作流的节点没有「对话本身」，会话栏按节点找角色，保持原样。
- 「中途换了模型」只在不是对话子任务时改角色那一条的模型和窗口。
- `sessionUsage`、`TaskMeta` 的当前角色只看对话自己的回复（没有 `step` 的）。

回归：`server/exec/usage-record.test.ts`。
