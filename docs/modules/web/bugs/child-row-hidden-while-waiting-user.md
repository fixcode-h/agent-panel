# 子对话在提问 / 等用户操作时，父对话的子对话列表里没有它

- 状态：已修复（纯逻辑回归 `web/src/components/tasks/child-line.test.ts` 的「子对话在提问 / 等你操作：父对话运行区也列这一行」；界面检查 `scripts/ui/02-task.mjs` 的「子对话-运行区左对齐」、`scripts/ui/02b-subagent.mjs` 的「子对话-父对话在跑时仍列出」）
- 症状：子对话弹层里那个子对话在「需要你处理 · 等用户操作」，父对话消息下面的子对话行（运行区）却没有它；等你处理的子对话也不转圈
- 入口：`web/src/components/tasks/child-line.ts` 的 `listedChildren`；`RunningNow.tsx`、`ChildrenBar.tsx` 的子对话行和小块
- 根因类型：运行区只列转圈的子对话（`visibleChildren`），等你处理的状态是 `needs`、图标是 `waiting`，只补了诊断报告和阶段确认两种特例
- 关键词：等用户操作、去操作、request_user_action、提问、等你处理、needs、listedChildren、childNeedsYou、运行区、子对话行、转圈

## 现象

用户 2026-11-07 报：子对话调用 `request_user_action` 等用户去重启编辑器复现，弹层「全部」里它在「需要你处理」组、标着「等用户操作」，
父对话（协调器）消息下面本该列子对话行的地方什么都没有。随后补充「等我处理的子对话也转圈圈」。

## 根因

- `convState` 遇到 `requests / asking / childNeeds / action` 返回 `needs`，`childIcon` 画成 `waiting`，不转圈。
- 运行区、输入框上方的小块、弹层「运行中」页签都读 `listedChildren`：转圈的那批（`visibleChildren`）加上 `reportAsking`（诊断报告等确认又提问）和 `stageConfirm`（工作流阶段等确认）两种特例。普通的提问、等你操作、权限确认不在其中，所以整行消失。
- 等你操作的子对话在父对话页只在弹层里有「去操作」，消息流里没有任何入口。

## 修复

- 新增 `childNeedsYou`：图标是 `waiting`、没停下、没收起、没解决；`listedChildren` 把它也列进来（停下 / 收起 / 已解决的照旧不列）。
- 运行区和小块里这类行用提醒色转圈，和「阶段待确认」「报告待确认」一致；等你操作的行尾给「去操作」，行窄时只留手势图标，宽度先让给状态标签。
- 小块里只在提问的子对话不重复放：左边已经有「「X」请你选择」按钮。

## 防线

见状态行列出的单测和两处界面检查（运行区要列 7 行，含等你操作和提问的两行，且有「去操作」按钮；运行区与弹层「需要你处理」+「执行中」两组逐项对上）。
