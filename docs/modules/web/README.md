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
- 子任务窗口的「AI 分析」（`HelperCards.tsx` 的 `HelperWindow` 头部按钮 → `Evolution.tsx` 的 `AnalyzeDialog` → `web/src/lib/task-transfer.ts` 的 `startAnalysis` → `shared/task-export.ts` 的 `helperReport` / `helperPrompt`）：和执行记录整体分析**共用同一个弹窗和同一条流程**（同样的 focus 输入、「开始分析」、建完跳到新对话），只是给 `AnalyzeDialog` 传了 `scope: { stepId }` 和 `subtitle`，`analysisReport` / `analysisPrompt` 按范围把报告收窄到这一步：只带这个子任务自己的消息（`m.step === id || m.step.startsWith(id + '/')`，和取 msgs 同一个口径）、它的耗时 / 等待 / token、所属角色**拼好后的实际生效设定**（`composeRole`：自身设定 + 引入的 Agent 如「通用约束」+ 参数 + Skill，只看 `instructions` 字段会漏掉执行纪律、安全边界这些能判定越界的段落）、派给它的要求原文（`TaskStep.brief`，由 `shared/engine.ts` 的 `spawn` 落盘；为空时报告同时写明两种原因——旧记录没保存、或派它时只写了标题没写要求，并指出下面那段标题列表不是发给它的要求）、同批一起派出的兄弟子任务、它交回的结果和改过的文件；提示词换成「耗时 / 是否符合角色 / 优化空间 / 面板框架」四类问题，不要求工作流修改建议块（那个只属于整体分析）。子任务还在跑时也能分析，提示词里写明记录是快照。不传 `scope` 时整体分析的行为完全不变。回归：`server/task-export-helper.test.ts`、`scripts/ui/02-task.mjs` 的「子任务-窗口-分析弹窗 / 分析结果」。
- 同一段话发给多个子对话合成一行（`web/src/components/tasks/ToolRow.tsx` 的 `ToolRows` 配合 `web/src/lib/tasks.ts` 的 `groupTools`）：相邻、类型和正文都相同的几次 `send_to_conversation` 合成一行，动作名仍是「发送消息」，右侧写「发给 N 个：…」，展开列出每个收件人和回执（没送到标红），收件人能点开对应子对话；别的工具、不同正文各占一行。父对话现在的规则是同一段话只交给一个子对话（`shared/engine.ts` 的 `send_to_conversation` 用 `shared/peer-message.ts` 的 `sentToOther` 拒绝重复，这一轮并行发出的调用也在检查范围内），合成主要兼容旧记录里父对话把同一段话逐个转给多个子对话的写法。回归：`web/src/lib/tasks.test.ts` 的 `groupTools` 用例、`scripts/ui/02-task.mjs` 的「发送消息-同一段话合成一行」。
- 子对话切换下拉（`web/src/components/tasks/ChildSwitcher.tsx`）：列出父对话的全部子对话，排序用 `shared/task.ts` 的 `sortChildren`、分组用本文件的 `childGroups`，列表行 `ChildRowContent` 和输入框上方的 `ChildrenBar` 弹层共用；两个入口，父对话数据都从外层 `ChildListCtx` 拿、`PaneNav.openChild` 表示右栏当前子对话：运行区子对话行左边（按这一行自己的宽度，行内容宽 <=380px 时隐藏、>=380px 时显示，`@max-[380px]` 与活动文字的 `@min-[380px]` 互补，窄行用输入框上方的子对话入口）和右栏子对话标题左边（固定显示，只加 `ml-1`，不跟断点）；菜单 `Content` 上要 `stopPropagation`，否则点菜单项会冒泡到所在 `RowShell` 的整行 onClick，把选择覆盖成那一行自己的子对话。
- 输入框上方状态栏固定三行，顺序是计划 → 子任务 → 子对话（`ChildrenBar` 里 `helpers` 行在 `children` 行之前），每行单独一行不换行。
- 回归：`scripts/ui/02-task.mjs` 覆盖运行区整段文本可点（状态标签、耗时、动作名和键盘 Enter 分别验证）、运行区和右栏标题两处切换下拉（展开、`data-current` 标当前项、Escape 关闭、方向键 + 回车切换，并断言右栏标题换成选中项、选中标记跟着移动；鼠标点选同样核对切换结果）、1024 宽度下行够宽时活动文字和运行区切换按钮都可见，以及状态栏三行顺序。
- 开发者模式的「抓取界面元素」（设置 → 常规 →「开发者模式」，`Settings.developerMode`，默认关）：打开后对话输入框（`ChatComposer`）和新建任务输入框（`TaskComposer`）左下角多一个按钮（`web/src/components/chat/ElementPicker.tsx` 的 `ElementPickButton`），点了进入抓取模式：鼠标框住元素、浮标显示标签 / 组件 / 尺寸，左键点中把元素写成引用卡片放进这个输入框并退出，Esc、右键或再点按钮退出；抓取期间在捕获阶段吞掉鼠标事件和 Esc，不触发页面按钮、也不触发对话页的「Esc 停止」。源码位置靠构建插件 `scripts/lib/source-loc.mjs`：给 `web/src` 下每个 `.tsx` 的原生标签写 `data-src="相对 web/src 的路径:行号:组件名"`（开发和正式包都有，约多 3% 的 JS），组件层级是抓取时沿 React fiber 往上收集的各层 `data-src`（portal 里的弹窗也能接上原组件）。引用文字由 `web/src/lib/element-ref.ts` 的 `formatElementRef` 拼：第一行摘要（卡片上显示），然后源码位置、组件层级、元素属性、文字、class、选择器、计算样式（字号附 rem）、页面；在 UI 设计画布里（外层有 `data-wid`）写控件 id，让 AI 用设计工具改。回归：`scripts/ui/01-composer.mjs` 的「元素抓取」、`web/src/lib/element-ref.test.ts`、`scripts/lib/source-loc.test.mjs`。
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
