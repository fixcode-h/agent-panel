# 子对话卡在权限确认，父对话和侧栏还显示「执行中」

- 状态：已修复（`shared/child-needs.test.ts` 通过）
- 症状：两个子对话在 `npm test` 上等权限确认 10 分 17 秒，父对话头部写「子对话执行中」、计划写「2 个在等待」、侧栏项目是「1 个执行中」转圈，只有点进子对话才看到「需要你确认」
- 入口：`shared/task.ts` 的 `convState` / `taskFacts`，`server/tasks/children.ts` 的 `childCountsOf`，`server/tasks/list-routes.ts` 的 `GET /tasks`，`web/src/components/tasks/ChildrenBar.tsx`
- 根因类型：「等你处理」只看对话自己的请求和提问，后代对话的待确认没有往上冒泡
- 模块：`shared`（`shared/child-needs.ts`）
- 关键词：子对话、权限确认、等你处理、执行中、冒泡、childrenNeeds、childNeeds、descendantNeeds、允许、拒绝、实测报告问题 1

## 现象

真实 API 实测（Claude Code + deepseek，权限「自动接受改文件」）：主理派出的两个子对话各有一条 `运行命令：npm test 2>&1 | tail -30` 等用户确认。这段时间父对话头部是「子对话执行中」，计划写「2 个在等待」，左侧项目是「1 个执行中」转圈；子对话自己不转圈，所以输入框上方的子对话小块、运行区也都不列它。设置里「子对话多久没动静就问」是 3 分钟，但等权限能解释，不算卡住，也没触发。

## 根因

`convState` 的「等你处理」只看 `requests` / `asking`，都是对话自己的。父对话这边只有 `childrenWorking`（名下还在运行的子对话数，等你处理的子对话也算在运行），于是落进 `pending` → 「等结果」，界面写「子对话执行中」。子对话行的 `childWait` 只写「等用户确认 1 项」，不写确认的是什么；输入框上方只有「请你选择」（`parentAsks`）一枚提示，权限确认没有入口。系统通知只看列表里对话自己的 `requests`，列表又只有顶层对话，子对话的确认永远不通知。

## 修复

- 服务端按整份任务列表算每个对话名下（任意层）在等用户的个数（`shared/child-needs.ts` 的 `descendantNeeds`），作为运行时字段 `Task.childrenNeeds` 随列表、详情和推送带给界面；`convState` 多一项 `childNeeds`，有它就是「等你处理」，排在「执行中」前面。侧栏行、项目行的提醒图标、项目首页分组、页签和标题栏都从这一处跟着变，标题栏写「子对话等你处理」。
- `/children` 每个子对话带上第一条待确认的请求（`pendingRequest`）；输入框上方子对话栏最前面加一行「子对话「X」等你确认：运行命令：…」（`ChildRequestBar`），命令、改文件、工具类的请求直接给「允许 / 拒绝」，提问和节点确认点「去处理」在右栏打开。
- 计划窗口、子对话行、给父对话的上报都写出确认的是哪条命令（`childWaitText` 的 confirm 带标题，`childReport` 的 needs 说明）；子对话行的标签从「等用户选择」改成「等用户确认」。
- 页面在后台时，父对话的 `childrenNeeds` 变多就发一条「子对话需要你确认」的系统通知。

报告里的第 3 条建议（项目「测试步骤」里的命令给子对话自动放行）没有做：权限放行要按 CLI 定义各写一套（Codex、Pi 没有按命令前缀放行的参数），而且是改变用户的权限设置，应由用户在项目设置里明确打开，冒泡显示已经让用户能及时处理。
