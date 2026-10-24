# web：React 前端

- status: inferred
- source_paths: `web/`
- entry: `web/src/main.tsx`、`web/src/App.tsx`
- analyzed_at: 2026-10-24

## 职责

- 页面：项目、任务、工作流、Agent、设置、图库、ComfyUI、MCP（`web/src/pages/`），不常用的大页面按需加载。
- 流程图画布：工作流编辑和任务流程图视图（`web/src/components/flow/`，基于 `@xyflow/react`）。
- 对话与任务：实时输出分段、步骤状态、上下文和 Token 用量、右侧文件系统面板（`web/src/components/tasks/`、`web/src/components/files/`）。
- 运行区子对话行（`web/src/components/tasks/RunningNow.tsx` 配合 `ToolRow.tsx` 的 `RowShell`）：传了 `rowOpen` 时整段文本（动作名、标题、状态标签、说明、耗时）都能点开右栏的子对话，只有这些行如此，工具行、后台命令行和子任务行仍是点哪里展开收起；标题按钮只在 `rowOpen` 时用 `openTip` 当 aria-label，别的行保持标题文本作为读屏名；活动文字（正在做什么 / 卡住说明）在行自己够宽（内容宽 >=380px）时显示，靠 `RowShell` 的 `container`（行 div 加 `@container`）做容器查询，不看视口宽度。
- 子对话切换下拉（`web/src/components/tasks/ChildSwitcher.tsx`）：列出父对话的全部子对话，排序用 `shared/task.ts` 的 `sortChildren`、分组用本文件的 `childGroups`，列表行 `ChildRowContent` 和输入框上方的 `ChildrenBar` 弹层共用；两个入口，父对话数据都从外层 `ChildListCtx` 拿、`PaneNav.openChild` 表示右栏当前子对话：运行区子对话行左边（按这一行自己的宽度，行内容宽 <=380px 时隐藏、>=380px 时显示，`@max-[380px]` 与活动文字的 `@min-[380px]` 互补，窄行用输入框上方的子对话入口）和右栏子对话标题左边（固定显示，只加 `ml-1`，不跟断点）；菜单 `Content` 上要 `stopPropagation`，否则点菜单项会冒泡到所在 `RowShell` 的整行 onClick，把选择覆盖成那一行自己的子对话。
- 输入框上方状态栏固定三行，顺序是计划 → 子任务 → 子对话（`ChildrenBar` 里 `helpers` 行在 `children` 行之前），每行单独一行不换行。
- 回归：`scripts/ui/02-task.mjs` 覆盖运行区整段文本可点（状态标签、耗时、动作名和键盘 Enter 分别验证）、运行区和右栏标题两处切换下拉（展开、`data-current` 标当前项、Escape 关闭、方向键 + 回车切换，并断言右栏标题换成选中项、选中标记跟着移动；鼠标点选同样核对切换结果）、1024 宽度下行够宽时活动文字和运行区切换按钮都可见，以及状态栏三行顺序。
- 数据访问和状态：`web/src/lib/data.tsx`（路由和数据上下文）、`web/src/lib/api.ts`（接口调用）。
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
- 界面细则和踩过的坑见 [docs/lessons/ui.md](../../lessons/ui.md)。

## 待确认

- 需要在真实浏览器里验证的交互（拖线、流式滚动、弹窗定位）目前只有界面检查和端到端测试覆盖一部分，改这类交互时人工确认一遍（待确认）。
