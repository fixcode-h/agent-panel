---
paths: shared/prompt-delta.ts, shared/engine.ts, shared/chat-prompt.ts, server/tasks/run.ts, server/exec/runner.ts
---

# 续接只发增量的提示词

从 prompts.md 拆出（超过 6 KB）：续接会话按段落指纹只发变了的段落（ADR 0027 / 0028）相关的几条。

## 会话压缩过，「已发过的规则」记录必须作废，不能在这一轮结束后写回去

- 规则：续接只发增量（ADR 0027）的前提是会话里真有那些段落。手动压缩、CLI 自己压缩、上下文骤降都要走 runner 的 `compacted()`：清 `task.promptSent` 和 `task.roleHashes`，并调 `AgentCall.onCompacted` 让调用方清掉手里的记录（`runConversationTurn` 的 `live`、子任务的已发段落）。调用方在一轮结束时写 `promptSent` 之前必须先看这一轮压缩过没有。手动压缩那一轮只发了压缩命令、规则根本没发，同样不能记成已发。
- 起因：压缩后协调器不再派子对话、自己动手改：engine 在压缩那一轮结束后把压缩前的 `live` 写回 `promptSent`，下一轮只发增量，委派规则只剩摘要。
- 防线：`shared/prompt-delta.test.ts`（压缩发生在这一轮里，下一轮必须整份重发）。

## 按段落指纹省的提示词：会变的状态单独成段，同一份提示只用一个函数拼，拼的时候读现值

- 规则：`promptDelta` 按 parts 的每个元素记指纹，元素里任何字变了整段重发。随时间或状态变的内容（「N 分钟前」「已 N 分钟」、按改动清单算的步骤）单独放一个元素、带自己的 `##` 标题，不拼进规则段；对父对话没用的逐分钟时间干脆不放，改成跨阈值才变的标记。同一份提示要在几处重拼时（第一轮、保活的 `nextPrompt`）用同一个闭包，可选的位置参数漏传不报错。
- 规则：`nextPrompt` 重拼读的是 `EngineHost` 上的字段，服务端建 host 时会随状态变的字段（`verify.changedFiles`、`policy.answered`、`wrapUp`、`rules`、`goal`）写成 getter 现取，不在对象字面量里求值成快照；中间转一手的（runner 的 `runRealTurn` 把 ctx 抄进 host）也要写 getter，`x: ctx.x` 会在那一刻求值。子对话取父对话的值按「执行位上的 → `store.known` → 这一轮开始时读的」顺序。用户下一条消息不管走保活、模型自己调 `wait_user_message` 还是预热，都经 `nextPrompt`（runner 的 `withState`），不原样交给 CLI。
- 起因：审计发现（df820f2 起）保活的 `nextPrompt` 漏传 `agent`，协调器每条多发约 2 千字、子对话被告知「完成标准不再适用」；「现有子对话」带 `timeAgo`、验证段拼着本轮步骤，每轮整段重发。复核又发现 host 上的改动清单、规则、目标是建 host 时的快照，新对话开头没改动时保活的每一条都写着「改动清单为空」；`wait_user_message` 和预热交来的消息原样给模型，没有「## 用户这次的消息」，计划、收件箱停在预热那一刻。
- 防线：`shared/prompt-delta.test.ts` 的保活两条、「改动清单变了只重发本轮步骤」用例（含保活期间改动清单 / 推送回答变了、预热后的第一句）、`server/orchestrator.test.ts` 的 list_conversations 用例。服务端建 host 时写成快照的回归没有单测拦，靠人工。
