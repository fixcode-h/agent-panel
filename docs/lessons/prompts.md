---
paths: shared/builtin/**, shared/engine.ts, server/tasks/run.ts, shared/assist.ts, shared/agent-*.ts, shared/test-steps.ts, server/agent-params*.ts, docs/agent-test-steps.md
---

# 给 Agent 的提示词

## 改提示词或文案前先搜断言

- 规则：改给 Agent 的提示词、角色设定、界面文案前，先 `grep` 一下 `scripts/e2e/`、`scripts/ui/` 和 `server/*.test.ts` 里有没有断言原句（界面检查常按按钮、分段的名字找元素），一起改；改了界面文字要把用到它的界面分片都复跑，不只跑自己加断言的那片。
- 起因：baffddd、875a11b、ab95653 都是改了提示词、测试还断言旧写法；86dc598c 把角色页分段缩成「基本 · N」，`scripts/ui/06-settings-agent.mjs` 还按 `/^基本角色/` 找，CI 界面检查失败。
- 防线：`npm run test:e2e`、`node scripts/ui-check.mjs`。

## 提示词要求 Agent 在一个回合里做完

- 规则：派工、执行类的提示词写明「本回合内完成，不以计划或『我先读取一下』结束」，派工失败要有兜底说明。
- 起因：d94526a，Agent 说一句「我先读取」就结束了回合。
- 防线：人工。

## 等待写死亡上限，不只写原则

- 规则：提示词里写“不要轮询”没用，要写成可执行的数字：用工具自带的等待 / 后台推送；确实主动等时单次不超 30 秒、同一件事累计不超 2 分钟；超时就必须判阻塞并给出可选做法，等待期间要求做不依赖它的实事。另外要写“自己已验证过的结论不要再等子任务重复验证”。
- 起因：一条只写「`Start-Sleep` 单次不超 60 秒、累计不超 2 分钟」的规则被完整违反：实际连发 `sleep 90/100/120/150/180` 共 640 秒，最后一条被 abort，任务停在半路；期间 307 秒完全空等。
- 防线：`server/core-agents.test.ts`（「通用约束」里必须有这一段）；旧措辞在 `shared/builtin/legacy.ts` 登记为指纹，已装的旧副本启动时自动升级。

## 工具操作期间要保留可见进度

- 规则：连续工具调用前先说明当前目标，完成一组工具后报告阶段结果；模型没有返回思考内容时不编造内部思考，至少输出简短的可见进度。
- 起因：Pi 任务只显示连续工具操作，原始 JSON 没有 `thinking_delta`；用户要求轮内能看到中间进度。
- 防线：`server/core-agents.test.ts`。

## 让 CLI 替用户做选择时，给它判断依据

- 规则：AI 配参数这类「让 CLI 按项目定值」的提示词，每个选项要附上它实际改变什么（`paramEffect` 按取值渲染角色设定取差异）和节点上已有的预设，写明判断顺序「项目事实 → 选项差别 → 默认值」，并告诉它结果要用户确认才生效、不要把取舍拿去问用户。只给标签和一句说明时，CLI 只能把开关原样问回来。
- 起因：c3678e9 的参数提示词只列标签，还要求写「哪些参数需要用户确认」；用户在「通用项目」上看到 AI 把 TDD / 任务记录 / 先识别现场 / 串行全部问回来。
- 防线：`server/agent-params.test.ts`（提示词带取值差异和节点预设）。

## 会话压缩过，「已发过的规则」记录必须作废，不能在这一轮结束后写回去

- 规则：续接只发增量（ADR 0027）的前提是会话里真有那些段落。手动压缩、CLI 自己压缩、上下文骤降都要走 runner 的 `compacted()`：清 `task.promptSent` 和 `task.roleHashes`，并调 `AgentCall.onCompacted` 让调用方清掉手里的记录（`runConversationTurn` 的 `live`、子任务的已发段落）。调用方在一轮结束时写 `promptSent` 之前必须先看这一轮压缩过没有。手动压缩那一轮只发了压缩命令、规则根本没发，同样不能记成已发。
- 起因：压缩后主理不再派子对话、自己动手改：engine 在压缩那一轮结束后把压缩前的 `live` 写回 `promptSent`，下一轮只发增量，委派规则只剩摘要。
- 防线：`shared/prompt-delta.test.ts`（压缩发生在这一轮里，下一轮必须整份重发）。

## 按段落指纹省的提示词：会变的状态单独成段，同一份提示只用一个函数拼，拼的时候读现值

- 规则：`promptDelta` 按 parts 的每个元素记指纹，元素里任何字变了整段重发。随时间或状态变的内容（「N 分钟前」「已 N 分钟」、按改动清单算的步骤）单独放一个元素、带自己的 `##` 标题，不拼进规则段；对父对话没用的逐分钟时间干脆不放，改成跨阈值才变的标记。同一份提示要在几处重拼时（第一轮、保活的 `nextPrompt`）用同一个闭包，可选的位置参数漏传不报错。
- 规则：`nextPrompt` 重拼读的是 `EngineHost` 上的字段，服务端建 host 时会随状态变的字段（`verify.changedFiles`、`policy.answered`、`wrapUp`、`rules`、`goal`）写成 getter 现取，不在对象字面量里求值成快照；中间转一手的（runner 的 `runRealTurn` 把 ctx 抄进 host）也要写 getter，`x: ctx.x` 会在那一刻求值。子对话取父对话的值按「执行位上的 → `store.known` → 这一轮开始时读的」顺序。用户下一条消息不管走保活、模型自己调 `wait_user_message` 还是预热，都经 `nextPrompt`（runner 的 `withState`），不原样交给 CLI。
- 起因：审计发现（df820f2 起）保活的 `nextPrompt` 漏传 `agent`，主理每条多发约 2 千字、子对话被告知「完成标准不再适用」；「现有子对话」带 `timeAgo`、验证段拼着本轮步骤，每轮整段重发。复核又发现 host 上的改动清单、规则、目标是建 host 时的快照，新对话开头没改动时保活的每一条都写着「改动清单为空」；`wait_user_message` 和预热交来的消息原样给模型，没有「## 用户这次的消息」，计划、收件箱停在预热那一刻。
- 防线：`shared/prompt-delta.test.ts` 的保活两条、「改动清单变了只重发本轮步骤」用例（含保活期间改动清单 / 推送回答变了、预热后的第一句）、`server/orchestrator.test.ts` 的 list_conversations 用例。服务端建 host 时写成快照的回归没有单测拦，靠人工。
