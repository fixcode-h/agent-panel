# web：React 前端

- status: inferred
- source_paths: `web/`
- entry: `web/src/main.tsx`、`web/src/App.tsx`
- analyzed_at: 2026-10-24

## 职责

- 页面：项目、任务、工作流、Agent、设置、图库、ComfyUI、MCP（`web/src/pages/`），不常用的大页面按需加载。
- 流程图画布：工作流编辑和任务流程图视图（`web/src/components/flow/`，基于 `@xyflow/react`）。
- 对话与任务：实时输出分段、步骤状态、上下文和 Token 用量、右侧文件系统面板（`web/src/components/tasks/`、`web/src/components/files/`）。
- 对话页外壳：`web/src/components/chat/ConversationShell.tsx` 是任务对话（`web/src/components/tasks/TaskView.tsx`）和 UI 设计对话（`web/src/components/design/DesignChat.tsx`）共用的消息流布局：统一宽度和内边距、贴底滚动（`useConversationScroll` 包装 `web/src/lib/useStickToBottom.ts`）、回到底部按钮、输入框停靠区插槽；壳里不判断对话类型，业务内容通过 `children` / `fill` / `overlay` / `dock` 插槽注入。
- 任务页标题栏左上角的项目名（`web/src/components/tasks/ProjectSwitch.tsx`，由 `TaskView.tsx` 的标题栏接入，浮层用 `web/src/components/ui/menu.tsx` 的 `Popover`）：点开列出当前项目下的对话，筛选和排序与侧栏一致（未归档、不含子对话、最近发言在前），每项显示标题和状态文字（状态判定用 `shared/task.ts` 的 `taskState`，文字用 `convStateText`），当前对话高亮；点一项在对话页打开（项目对话 `{ page: 'projects', id: project.id, sub: task.id }`，Chat 用 `{ page: 'chat', id }`）。浮层底部「打开项目」（Chat 模式为「打开聊天」）进项目页 / Chat 首页，原来点项目名直接进项目页的行为换成了这个入口；Chat 模式项目名显示「聊天」，列不属于任何项目的最近聊天。回归验证见 `scripts/ui/02-task.mjs`（点项目名出现列表、点一项打开、键盘上下选择 + Enter、Esc 关闭、点「打开项目」进项目页）。
- 运行区子对话行（`web/src/components/tasks/RunningNow.tsx` 配合 `ToolRow.tsx` 的 `RowShell`）：传了 `rowOpen` 时整段文本（动作名、标题、状态标签、说明、耗时）都能点开右栏的子对话，只有这些行如此，工具行和后台命令行仍是点哪里展开收起，子任务行点标题打开只读窗口；标题按钮只在 `rowOpen` 时用 `openTip` 当 aria-label，别的行保持标题文本作为读屏名；活动文字（正在做什么 / 卡住说明）在行自己够宽（内容宽 >=380px）时显示，靠 `RowShell` 的 `container`（行 div 加 `@container`）做容器查询，不看视口宽度。
- 运行区子任务行（`web/src/components/tasks/RunningNow.tsx` 的 `HelperRow`，数据来自 `shared/task.ts` 的 `helperActive` / `helperRunning` / `stepMs` / `splitStepJobs` 和 `web/src/components/tasks/HelperCards.tsx` 的 `chatHelperIds`）：对话派出的、还没结束的子任务（在跑或排队）和子对话用同一种样式的一行：转圈、「子任务」、标题、角色、执行中 / 排队中、正在做什么、耗时，行尾是终止按钮（`HelperCards.tsx` 的 `StopHelper`）；角色只在不是内置「子任务」角色（`origin !== 'builtin:helper'`）时显示。点标题打开只读的 `HelperWindow`（实时对话流、没有输入框），行本身不整段可点。在跑的排在排队的前面，同一组按派出的顺序。子任务起的后台命令并进这一行（`helperJobs`），一个子任务只占一行，标签写「后台命令 <名字>」或「n 条后台命令」；子任务已经结束、命令还在跑的，才由 `StepJobsRow` 单独列一行（展开看每条命令）。
- 同一段话发给多个子对话合成一行（`web/src/components/tasks/ToolRow.tsx` 的 `ToolRows` 配合 `web/src/lib/tasks.ts` 的 `groupTools`）：相邻、类型和正文都相同的几次 `send_to_conversation` 合成一行，动作名仍是「发送消息」，右侧写「发给 N 个：…」，展开列出每个收件人和回执（没送到标红），收件人能点开对应子对话；别的工具、不同正文各占一行。父对话现在的规则是同一段话只交给一个子对话（`shared/engine.ts` 的 `send_to_conversation` 用 `shared/peer-message.ts` 的 `sentToOther` 拒绝重复，这一轮并行发出的调用也在检查范围内），合成主要兼容旧记录里父对话把同一段话逐个转给多个子对话的写法。回归：`web/src/lib/tasks.test.ts` 的 `groupTools` 用例、`scripts/ui/02-task.mjs` 的「发送消息-同一段话合成一行」。
- 子对话切换下拉（`web/src/components/tasks/ChildSwitcher.tsx`）：列出父对话的全部子对话，排序用 `shared/task.ts` 的 `sortChildren`、分组用本文件的 `childGroups`，列表行 `ChildRowContent` 和输入框上方的 `ChildrenBar` 弹层共用；两个入口，父对话数据都从外层 `ChildListCtx` 拿、`PaneNav.openChild` 表示右栏当前子对话：运行区子对话行左边（按这一行自己的宽度，行内容宽 <=380px 时隐藏、>=380px 时显示，`@max-[380px]` 与活动文字的 `@min-[380px]` 互补，窄行用输入框上方的子对话入口）和右栏子对话标题左边（固定显示，只加 `ml-1`，不跟断点）；菜单 `Content` 上要 `stopPropagation`，否则点菜单项会冒泡到所在 `RowShell` 的整行 onClick，把选择覆盖成那一行自己的子对话。
- 输入框上方状态栏固定三行，顺序是计划 → 子任务 → 子对话（`ChildrenBar` 里 `helpers` 行在 `children` 行之前），每行单独一行不换行。
- 回归：`scripts/ui/02-task.mjs` 覆盖运行区整段文本可点（状态标签、耗时、动作名和键盘 Enter 分别验证）、运行区和右栏标题两处切换下拉（展开、`data-current` 标当前项、Escape 关闭、方向键 + 回车切换，并断言右栏标题换成选中项、选中标记跟着移动；鼠标点选同样核对切换结果）、1024 宽度下行够宽时活动文字和运行区切换按钮都可见，以及状态栏三行顺序。
- 数据访问和状态：`web/src/lib/data.tsx`（路由和数据上下文）、`web/src/lib/api.ts`（接口调用）。
- 页面接收 app-actions 的 ui 事件：`web/src/lib/page-signal.ts` 的 `EventSource('/api/app/events')` 收到 `ui` 事件后交给 `web/src/lib/ui-actions.ts` 的 `runUiAction`，按动作名找处理函数；`web/src/App.tsx` 的 `UiActions` 用 `useUiActions` 登记处理表——`navigate`（只切到 `PAGES` 里有的页面，带 id / sub）、`open_settings`（打开指定栏）、`open_project`（先关再开项目设置弹窗，已经开着时也按这次参数重开，AI 初始化从 `start` 开始）、`reload_settings`（重新拉设置并通知开着的设置窗口用新值重建，免得自动保存写回旧值）。没登记的名字直接忽略（旧页面收到新版本服务的动作）；演示版不接 `/api/app/events`。新建 / 打开 UI 设计最终也是 `navigate` 到 `design` 页。动作本身有哪些、怎么加见 [modules/app-actions](../app-actions/README.md) 和 [ADR 0011](../../adr/0011-app-actions-for-agents.md)，这里只管前端的接收和入口。回归：`scripts/e2e/11-app-actions.mjs` 走完整链路（CLI 调 `app_do` → 动作表 → 面板接口）。
- 设置页（`web/src/pages/SettingsPage.tsx`）的「同时运行的后台命令」取 `Settings.backgroundLimit`（默认 64，范围 1–64）；对话设置弹窗（`web/src/components/tasks/ConversationSettingsDialog.tsx`）管名称、目标、全局规则、子对话用的 Agent / 模型和「停止全部子对话」，没有再放并发数设置（也没有「同时执行的子对话」）。
- 项目设置「AI 初始化」页（`web/src/components/projects/ProjectInitPanel.tsx`、`ProjectSettingsDialog.tsx`）：初始化推荐随项目保存，重开时用 `buildGroups` 的 `same` 判定算差异，「应用推荐（n 项）」只改草稿、点「确认」才保存，无差异时提示「已和当前设置一致」；没有保存过推荐时只提供重新初始化。
- 在线演示：`vite build --mode demo` 时把 API 换成浏览器里的模拟实现（`web/src/lib/demo-*.ts`），正式包里不能有这些内容。

## 入口

- `web/src/App.tsx`：路由登记、侧栏、命令面板、通知；新增页面先在这里登记。
- `web/src/index.css`：主题颜色 token 和 Tailwind v4 入口。

## 依赖

React 19、Vite、Tailwind CSS v4、Radix UI、`@xyflow/react`、lucide 图标；`shared/` 通过别名 `@shared` 引用。

## 回归验证

- `npm run typecheck`：类型检查 + 漏翻检查（界面文案用 `t('中文原文')`，英文写进 `shared/locales/en/`）。
- `npm run test:unit`：`web/src/**/*.test.ts` 只测不和浏览器打交道的纯逻辑。
- 改了界面：`npx vite build --mode demo && node scripts/ui-check.mjs`，截图在 `ui-shots/`。
- 任务对话和设计对话的消息区按 `[data-conversation-scroll="messages"]` 定位（`scripts/ui/02-task.mjs`、`scripts/ui/04-design.mjs`），不再依赖具体的类名组合。
- 界面细则和踩过的坑见 [docs/lessons/ui.md](../../lessons/ui.md)。

## 待确认

- 需要在真实浏览器里验证的交互（拖线、流式滚动、弹窗定位）目前只有界面检查和端到端测试覆盖一部分，改这类交互时人工确认一遍（待确认）。
