---
paths: web/src/components/tasks/TaskView.tsx, web/src/components/tasks/HelperCards.tsx, scripts/ui/02-task.mjs
---

# 输入框上方的状态栏

## 状态栏固定三行，小块按宽度收成「+N」

- 规则：输入框上方固定计划 / 子对话 / 子任务三行，每行 `flex-nowrap` + `min-w-0`、只占一行，没有内容的行不占位置；关闭子对话的按钮跟子对话那一行右端，不单独占一行。
- 规则：子对话小块（`w-56`）按中间容器实测的宽度决定显示几个（回调 ref + `ResizeObserver`，节点挂上再量），放不下的收成「+N」、紧跟最后一块，N 是实际隐藏数，窗口宽窄变化时跟着变；卡片、间距和「+N」的预留宽度都按根字号（rem）算，设置里改字号也准；不写死个数，也不 `flex-wrap`。
- 规则：卡片容器至少留 2.5rem（`min-w-10`）给「+N」：它是 `flex-1`（basis 0），窄屏下「请你选择」占满行时会被挤成 0 宽，里面的数字被 `overflow-hidden` 整个裁掉；断言要量容器和「+N」的实际矩形，只读 `textContent` 抓不到不可见。
- 起因：用户要求「后面的子对话只能一行展示，展示不下就用数字代表还有几个」，计划、子对话、子任务分三行。
- 防线：`scripts/ui/02-task.mjs` 的「状态栏-三行」。
