# 父对话标题栏「收起面板」点了没反应、一直是选中的样子

- 状态：已修复（`node scripts/ui/02-task.mjs` 通过；去掉 `index.css` 的改动后新断言会失败）
- 症状：会话栏开着、右侧文件栏没显示时，点标题栏的会话栏开关，右边仍然有一栏面板；按钮开着时一直有一块底色
- 入口：`web/src/components/tasks/TaskView.tsx` 的 `on.session`；`web/src/components/tasks/header-items.tsx` 的面板开关
- 根因类型：让位的栏在另一栏收起后自动补回；选中态和悬停共用同一块底色
- 模块：`web`（`TaskView.tsx`、`header-items.tsx`、`web/src/components/ui/icon-button.tsx`、`web/src/index.css`），配套 `scripts/ui/02-task.mjs`
- 关键词：会话栏、隐藏会话栏、收起面板、文件栏让位、filesYield、lastRail、选中态、aria-pressed、icon-btn-flat、标题栏按钮

## 现象

一行放不下「对话 + 会话栏 + 文件栏」时（如 1440~1900 宽、文件栏拉宽过），文件栏给会话栏让开、不显示。用户点标题栏的会话栏开关想收起右边的面板：会话栏确实收了，但让位的文件栏立刻补回原位，右边看起来还是一栏面板，等于点了没用。「Claude Code」配色下开着的面板开关一直带一块底色，和悬停一模一样，点完鼠标还停在上面，看不出状态变没变。

## 根因

- `sessionShown` 为假后，`filesYield`（文件栏没收起、只是让位）随之为假，`filesHidden` 变假，文件栏重新显示；`on.session(false)` 只改了会话栏自己的开关。Chat 页右栏同理。
- `index.css` 给 `.icon-btn[aria-pressed='true'] / [aria-expanded='true']` 加了和 `:hover` 相同的底色，标题栏的会话栏、文件栏开关开着就常亮。

## 修复

- 收起会话栏时，若文件栏 / Chat 右栏此刻正给会话栏让位，一并记成收起（`toggleFiles` / `toggleChatRail`）；之后点「显示文件」照常打开。
- `IconButton` 新增 `tone="flat"`：开着不提亮，只有悬停出底色；`index.css` 的选中底色跳过 `.icon-btn-flat`。标题栏的会话栏、文件栏、Chat 右栏、功能面板开关改用它，开没开仍由 `aria-pressed` / `aria-expanded` 告诉读屏。

## 防线

`scripts/ui/02-task.mjs`「任务-会话栏」：1440 宽收起会话栏后文件栏不能出现；会话栏开着、鼠标移开后开关没有底色。
