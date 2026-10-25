# 点发送的一瞬间运行区整块消失，AI 开口才回来

- 状态：已修复（回归 `web/src/lib/latest-turn.test.ts` 8 条用例全过；界面检查 `scripts/ui/02-task.mjs` 的「任务-发送消息时运行区不消失」）
- 模块：`web`（`web/src/components/tasks/TaskView.tsx` 的 `latest` 判定、`web/src/components/tasks/Messages.tsx` 的 `ChatReply` / `RunningFooter`，新增 `web/src/lib/latest-turn.ts`）
- 关键词：运行区、子对话行、发送消息、闪没、最新一轮、`latest`、`last`、`toBlocks`、`msg` 段、`latestTurnIndex`

## 现象

用户在父对话里点发送，输入框上方那几行子对话状态（截图 `attachments/截图-235345.png`：每行「⟳ 子对话　标题　计划 4/8 执行中　还在后台跑: …　4m 37.5s」，共 5 行）在**点发送的一瞬间整块消失**，等 AI 开始输出又重新出现，闪一下。用户原话：「在用户发送消息的一瞬间这个会消失，然后 AI 输出又会显示出来，固定一下吧，只要有项这里就一直显示吧」。

## 复现

1. 打开一个有子对话在跑的父对话（演示数据里「购物车右上角」那个对话就有 5 个子对话）。
2. 在输入框里写一句、按 Enter。
3. 这一瞬间消息流里的运行区（`aria-label="运行中"` 那组，子对话行、后台命令行都在里面）整个不渲染；AI 说出第一句话之后又出现。

## 根因

截图里那 5 行不是输入框上方的子对话卡片（`ChildrenBar`），而是消息流里的运行区行（`RunningNow.tsx` 的 `rows`，数据是 `shared/task.ts` 的 `visibleChildren`）。链路：

- `TaskView.tsx` 给 `ChatTurn` 传 `latest={i + hidden === blocks.length - 1}`，也就是「最后一个 block」。
- `Messages.tsx` 的 `ChatReply`：`const kids = !!latest && isTail`，`jobs = isTail && (isLive ? !!latest : !!last)`。
- `runningRows({ kids: false, jobs: false })` 列不出子对话行和后台命令行，`rows.empty` 为真；`planRunShown` 也不成立 → `RunningFooter` 返回 `null`，整块（连分割线）不画。

而 `TaskView.tsx` 的 `toBlocks` 会把「没有节点的用户消息」单独 push 成一个 `{kind:'msg'}` 段。所以发送前后：

| 时刻 | blocks | 最后一个 block | `latest` | 运行区 |
| --- | --- | --- | --- | --- |
| 发送前 | `[..., turn]` | `turn` | 真 | 显示 |
| 刚发出（回复还没开始） | `[..., turn, msg]` | `msg` | 假 | **消失** |
| AI 开始输出 | `[..., turn, msg, turn]` | 新 `turn` | 真 | 又显示 |

完全对应用户说的「发送瞬间消失、AI 输出又显示」。同一处还让后台命令行一起闪：`jobs` 在对话停着时看 `last`（同样是「最后一段」），尾部多一个用户消息就和 `kids` 分叉。

`last` 的语义（对话停着 + 最后一段）本身没错，它管操作按钮常显和 `foldStats`；错在把「最新的一轮」也用它/最后一根 block 来算。

### 排查时排除的几种假设

- **`task?.id` 短暂为空导致 `setChildren([])`**：不成立。发送走 `api.sendMessage` → `apply(keepLiveFields(...))`，返回的任务必带 id；`children` 数组在发送过程中没有被清空，输入框上方的 `ChildrenBar`（按 `children.length > 0` 渲染）也没消失——用户看到闪的是消息流里的运行区。
- **`loadChildren` 返回空数组覆盖**：同上，不是这次的现象来源，`children` 一直是 5 条。
- **`TaskView` 重挂载**：`key` 按 `taskId`，发送不改变它，没有重挂。

## 修复

- 新增纯函数 `web/src/lib/latest-turn.ts` 的 `latestTurnIndex(blocks)`：从尾部往前跳过连续的 `msg` 段，停在遇到的第一轮 `turn` 上；遇到 `steps` / `run` 段返回 -1（不把运行区挂到早就结束的旧轮下面）。
- `TaskView.tsx` 用 `useMemo` 算 `latestTurn = latestTurnIndex(blocks)`，`latest` 改传 `i + hidden === latestTurn`；`live` / `last` 保持原语义不动（不动「思考中…」、操作按钮常显这些行为）。
- `Messages.tsx`：`jobs` 归到和 `kids` 同一个 `latest`，两行不再分叉；`planRunShown` 收 `newest = last || latest`，工作流那一行也不会在发送瞬间消失。辅助对话（`AssistDialog.tsx`）和设计对话（`DesignChat.tsx`）不传 `latest`，仍然只按 `last` 判。
- 没动 `children` 的加载与清空逻辑：那条线上没有 Bug，改了反而会影响「子对话真的删光要消失」「切换对话要重新加载」这些正确行为。

## 回归

- `web/src/lib/latest-turn.test.ts`：最后一段就是那一轮、尾随一条用户消息、尾随连着几条用户消息、AI 已开口后新的一轮、尾随节点段返回 -1、尾随工作流运行卡片返回 -1、只有用户消息、空对话。
- `scripts/ui/02-task.mjs` 的「任务-发送消息时运行区不消失」：进入有子对话的父对话，先确认运行区里至少有 2 行子对话；在发送**之前**装 `MutationObserver` 采样运行区子对话行数的最小值；写消息、按 Enter 后等「消息出现在 `[data-conversation-scroll="messages"]` 里」这个可观测状态（不靠 `waitForTimeout` 赌时序，见教训 `lmvnpbhxfu1yg`）；最后断言最小值不小于发送前的行数、发送后仍保持。采样器一次都没跑到也算失败，避免用例没测到东西却通过。

## 防复发

- 「最新的一轮」是一个独立概念，不等于「最后一个 block」，也不等于 `last`：尾部刚发出的用户消息会额外占一个 `msg` 段。判断运行区该挂在哪一轮，走 `latestTurnIndex`，不要自己写 `blocks.length - 1`。
- 新加挂在「最新一轮」下面、会按 `latest` / `last` 判空的东西（后台命令、工作流行、以后可能还有别的）时，判空口径要和子对话行用同一个值，否则尾部多一段就会有一处闪、一处不闪。
