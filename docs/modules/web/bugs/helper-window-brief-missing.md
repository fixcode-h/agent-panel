# 子任务窗口最上面不显示派给它的要求

- 状态：已修复
- 症状：子任务只读窗口最上面不显示派给它的要求，看不到这个子任务要做什么
- 入口：`web/src/components/tasks/HelperBriefCard.tsx`、`web/src/lib/helper-brief.ts`
- 根因类型：`HelperWindow` 没读 `TaskStep.brief`，只渲染对话流
- 模块：`web`（`web/src/components/tasks/HelperBriefCard.tsx`、`web/src/lib/helper-brief.ts`，接在 `HelperCards.tsx` 的 `HelperWindow` 里）
- 关键词：子任务窗口、初始信息、派给它的要求、brief、只读窗口、验收标准、旧记录降级

## 现象

点开子任务列表里的一项，只读窗口（`HelperWindow`）从对话流开始，最上面没有任何「这个子任务被要求做什么」的信息。
用户报的是「现在子任务最上面不会展示任何初始信息，修改下吧，展示下初始发送过来的信息」。

## 根因

- `TaskStep.brief` 早就落了盘（`shared/engine.ts` 的 `spawn`：`instructions` + 评审交接单），但前端只在导出报告 / AI 分析里用它（`shared/task-export.ts` 的 `helperReport`），
  `HelperWindow` 的滚动区只渲染 `Msgs` 或一行空态文字，从来没读 `step.brief`。
- 另一头 `brief` 是拼接出来的结构化文本（`##` 小节、评审交接单的 `###` 子节、重试时追加的 `## 重试时补充`），直接丢进界面会是一大坨原文，看不出哪段是要求、哪段是验收标准，
  所以只把字段读出来不够，还要按内容规范化排版。

## 修复

- 新增 `web/src/lib/helper-brief.ts` 的 `helperBriefView`：按 `##` 切小节、`###` 留在块内（评审交接单的 `###` 各自成块，「要达成什么、验收标准」标重点），
  代码块里的 `##` 不切；常见小节重排成「要做的事 → 用户原话 → 验收标准 → …→ 重试补充」，不认识的小节排后面但不丢；没有小节时按空行分段。
  正文完全不改写，只做排版切分。
- 新增 `web/src/components/tasks/HelperBriefCard.tsx`：窗口最上面一张卡片，标题「派给它的要求」+ 摘要一句（只在收起时显示，展开时正文里就有这段）+「补充过 N 次」徽标（只数真正的「重试时补充」块，不能用 `reruns`：整体重跑也会加它但不追加要求），
  展开后按小节分块显示（重点节标题 `text-accent` + 加重左侧竖线），正文复用 `Markdown`（`compact`），正文区 `max-h-[min(38vh,320px)]` 自己滚。
  放在 `Msgs` 之前，并且**收起时 `sticky top-0` 吸顶**：窗口打开会无条件贴底看最新输出（`useStickToBottom`），不吸顶就会被推出视野（用户报的「看不到初始信息」）；有对话流时默认收起，展开时取消吸顶（块高，吸着会盖住对话流）。
  点展开时先 `unpin()` 再 `scrollIntoView({ block: 'start' })`、收起时 `pin()`：否则卡片去掉 sticky、高度又变高时，贴底会把刚展开的正文顶到视野之上（看起来像点了没反应）。
- 旧记录降级：`brief` 为空或缺字段（schema 加这个字段之前的 step、演示版旧 localStorage）时整块返回 `null`，窗口从对话流开始，不崩也不留空壳。

## 防线

- `web/src/lib/helper-brief.test.ts`：空值 / 纯文字 / 小节排序 / 关键节 tone / 交接单子节 / 多次重试补充 / 代码块里的 `##` 和 `###` / 提示语剔除 / `added` 只数补充块 / 摘要口径共 19 条。
- `scripts/ui/02-task.mjs` 的「子任务-窗口-初始要求」「-展开」：有对话流时默认收起、贴底时吸顶仍在视野内（用户一眼能看到）、展开后**卡片仍在视野内**（用 `getBoundingClientRect` 比对，`check()` 的 visible 不判视口）、小节顺序（要做的事在验收标准之前）和两节内容、再收起只剩摘要。
