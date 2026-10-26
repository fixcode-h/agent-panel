# 子任务窗口的「派给它的要求」吸顶悬浮，盖住下面的对话流

- 状态：已修复
- 症状：子任务窗口最上面那张「派给它的要求」卡片吸顶悬浮，下面的「评审 · CLI 名 · 模型」和思考过程被它压住一半
- 入口：`web/src/components/tasks/HelperBriefCard.tsx`、`web/src/components/tasks/HelperCards.tsx`（`HelperWindow`）
- 根因类型：为了「打开时看得到要求」用了 `sticky top-0`，把卡片做成了浮在内容上的悬浮层
- 模块：`web`（`web/src/components/tasks/HelperBriefCard.tsx`、`web/src/lib/useStickToBottom.ts`）
- 关键词：子任务窗口、派给它的要求、吸顶、sticky、悬浮、遮挡、滚动位置

## 现象

用户截图（子任务「复看 R1-R4 的修复」）：卡片「📋 派给它的要求」固定在滚动区顶部，卡片下边缘正好压在「评审 · Pi（默认）高档 · …」这一行的上半截和「思考过程 21.3s」上。
用户原话：「子任务这个初始信息不要悬浮在那放到最上面就行」。

## 根因

上一版为了修「子任务窗口最上面不显示派给它的要求」（见 [helper-window-brief-missing.md](./helper-window-brief-missing.md)），
给收起态的卡片加了 `sticky top-0 z-10`：因为窗口打开时会无条件贴底（`useStickToBottom` 的 `useLayoutEffect` 里
`pinned = true` + `stick()`），普通块放在滚动区最前会被滚到视野之外。

`sticky` 解决了「看得到」，代价是它变成悬浮层：`z-10` + 不透明底色，滚动时下面的内容从它背后穿过、被压住。
两个需求的冲突点在于「打开时能看到要求」被做成了「任何时候都浮在最上面」，而用户要的只是前者。

## 修复

两件事分开：

- 卡片回归普通块：`HelperBriefCard` 只按展开/收起换底色（`bg-card` / `bg-field/40`），不再有 `sticky top-0 z-10`，跟着内容一起滚、不遮挡任何东西。
- 「打开时能看到要求」改由滚动位置保证：`useStickToBottom` 新增 `startAt: 'bottom' | 'top'`（默认 `'bottom'`，对话页、工具弹窗、运行卡片、本地图像的行为不变）。
  `HelperWindow` 在有要求时传 `'top'`：打开时 `scrollTop = 0` 停在顶部、`pinned = false` 不贴底
  （否则新输出进来会把用户正在读的要求顶走）；用户自己滚到底部附近后，`onScroll` 的 `stillPinned` 照旧恢复跟随。
  **没有要求时（`helperBriefView(...).empty`）仍用 `'bottom'`**：卡片整块不渲染，滚动区第一块就是对话流，
  停顶部没意义、还会让最新结果要自己滚下去才看得到（这一条是评审 R1 指出、核实后修的）。
- 展开/收起逻辑保留：展开时仍 `unpin()` + `scrollIntoView({ block: 'start' })`。这块和 sticky 无关——展开后块变高，
  `ResizeObserver` 仍会在跟着底部时把 `scrollTop` 拉到新底部，刚展开的正文会留在视野之上（看起来像点了没反应）。
  收起时 `pin()` 也保留：收起就是「看回最新输出」。
- 停顶部时 `markAway(true)`（离底部远，显示「回到底部」），不把这种情况判成「用户翻上去了」以外的语义。

## 防线

- `scripts/ui/02-task.mjs` 的「子任务-窗口-初始要求 / -展开」重写：打开时卡片在视野内且 `scrollTop` 在 0 附近（贴底会把它推上去）、
  卡片矩形和它下面那块内容不相交（`cover <= 1`，撞上就是又在遮挡）、展开后同样两条、再收起只剩摘要，
  最后滚到底部确认仍恢复跟随（停在顶部不能变成「再也不跟」）。
- 「子任务-窗口-初始要求-不吸顶」：把窗口压矮造出可滚动，滚到底后卡片必须已经滚出视野。
  这条是拦回退的关键——内容不足一屏时 `scrollTop` 恒为 0，上面几条在 `sticky` 和普通块下都成立，
  只有「滚到底部后卡片该走了」能区分两者（实测：加回 `sticky top-0` 时这条失败）。
- 「子任务-窗口-无要求仍贴底」：清空 `brief` 模拟旧记录，窗口不画卡片、仍停在最新输出。
  拦「把 `startAt: 'top'` 无条件套到没有卡片的窗口上」这种回退。
- `web/src/lib/useStickToBottom.test.ts` 的 `nearBottom` / `stillPinned` 用例继续覆盖恢复跟随的判定。
