# web：React 前端

- status: inferred
- source_paths: `web/`
- entry: `web/src/main.tsx`、`web/src/App.tsx`
- analyzed_at: 2026-10-25（2026-10-27 按代码复核「打开对话页的加载链路」一节：首屏 `limit=50` 与往前翻页、SSE 按版本补发增量、子对话轮询按状态分档；同日补上下文卡的「最近一次压缩」一行，实现核对自 `web/src/lib/tasks.ts`、`web/src/components/tasks/TaskMeta.tsx`）

## 职责

- 页面：项目、任务、工作流、Agent、计划、设置、图库、ComfyUI、MCP、工作总结（`web/src/pages/`，左侧报告树 + 右侧提炼面板 / 报告，见 [pages.md](pages.md)），不常用的大页面按需加载。

这份 README 只放概览和入口，各块的细节在同目录的子页面里（2026-10-31 从这份 README 原样拆出，原来全在「职责」一节）：

| 子页面                                         | 内容                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [组件库、提示与界面基础](ui-kit.md)            | `web/src/components/ui/` 的组件和写法、全局提示（toast）                                                         |
| [设置页与项目设置](settings.md)                | 设置页的搜索、内容区写法、用量统计、回收站、节内导航、可用模型、网络代理，项目设置的「AI 初始化」                |
| [角色、计划、Skills、工作总结与演示](pages.md) | 角色页、计划页、Skills 页、工作总结、角色和工作流的导出导入、在线演示                                            |
| [流程图画布](flow.md)                          | 工作流编辑器和任务流程图视图：浮动面板、节点卡片                                                                 |
| [对话页：输出、输入框与附件](conversation.md)  | 回复显示、输入框下的信息条、提问开关、总结卡、右栏文件面板、Chat 页、发送与继续执行、元素引用、附件              |
| [运行区、执行计划与子对话](run-area.md)        | 运行区各行（工作流、最新一轮、子对话、子任务、后台命令、状态行）、执行计划面板、子任务窗口、子对话切换和独立分支 |
| [浮条、弹窗与 AI 分析](windows.md)             | 看对话的大窗口、最小化浮条、转成弹窗、AI 分析的归属和右侧功能面板、排查结论                                      |
| [侧栏与 UI 设计项目页](sidebar.md)             | 侧栏的项目行和对话行、UI 设计侧栏、UI 项目主页                                                                   |
| [对话页加载链路、字体与样式](loading.md)       | 打开对话页的加载链路和实测、加载日志、字体、Markdown 渲染与配色                                                  |
| [bugs.md](bugs.md)                             | 本模块用户报过的 Bug 索引（生成物，详情在 `bugs/`）                                                              |

## 数据访问

- 数据访问和状态：`web/src/lib/data.tsx`（路由和数据上下文）、`web/src/lib/api.ts`（接口调用）。
- 页面接收 app-actions 的 ui 事件：`web/src/lib/page-signal.ts` 的 `EventSource('/api/app/events')` 收到 `ui` 事件后交给 `web/src/lib/ui-actions.ts` 的 `runUiAction`，按动作名找处理函数；`web/src/App.tsx` 的 `UiActions` 用 `useUiActions` 登记处理表——`navigate`（只切到 `PAGES` 里有的页面，带 id / sub）、`open_settings`（打开指定栏）、`open_project`（先关再开项目设置弹窗，已经开着时也按这次参数重开，AI 初始化从 `start` 开始）、`reload_settings`（重新拉设置并通知开着的设置窗口用新值重建，免得自动保存写回旧值）。没登记的名字直接忽略（旧页面收到新版本服务的动作）；演示版不接 `/api/app/events`。新建 / 打开 UI 设计最终也是 `navigate` 到 `design` 页。动作本身有哪些、怎么加见 [modules/app-actions](../app-actions/README.md) 和 [ADR 0011](../../adr/0011-app-actions-for-agents.md)，这里只管前端的接收和入口。回归：`scripts/e2e/11-app-actions.mjs` 走完整链路（CLI 调 `app_do` → 动作表 → 面板接口）。

## 入口

- `web/src/App.tsx`：路由登记、侧栏、命令面板、通知；新增页面先在这里登记。
- `web/src/index.css`：主题颜色 token 和 Tailwind v4 入口。

## 依赖

React 19、Vite、Tailwind CSS v4、Radix UI、`@xyflow/react`、lucide 图标；`shared/` 通过别名 `@shared` 引用。

## 回归验证

- `npm run typecheck`：类型检查 + 漏翻检查（界面文案用 `t('中文原文')`，英文写进 `shared/locales/en/`）。
- `npm run test:unit`：`web/src/**/*.test.ts` 只测不和浏览器打交道的纯逻辑。
- 改了界面：`npx vite build --mode demo && node scripts/ui-check.mjs`，截图在 `ui-shots/`。
- 技能页（左列表 + 右详情、文件结构）：`web/src/lib/library-tree.test.ts`（10 条：空目录、深层嵌套、父目录没单列时补目录、折叠、文件计数、旧后端只有扁平 `files` 时也能还原）；界面检查走 `scripts/ui/03-library.mjs` 的「Skill详情」「Skill详情-保存」「Skill详情-文件树」「Skill详情-目录收起」「Skill详情-附加文件」「Skill详情-附加文件保存」「Skill-AI优化」「命令详情」（Windows 上自带 chromium 启动报 `spawn EFTYPE` 时用 `CHROMIUM_PATH` 指向系统 Chrome 再跑）。
- 任务对话和设计对话的消息区按 `[data-conversation-scroll="messages"]` 定位（`scripts/ui/02-task.mjs`、`scripts/ui/04-design.mjs`），不再依赖具体的类名组合。
- 界面细则和踩过的坑见 [docs/lessons/ui.md](../../lessons/ui.md)。
- 本模块的 Bug 索引 `bugs.md` 是生成物：只新增 / 修改 `bugs/<bug-id>.md` 的元数据头，再跑 `npm run docs:bugs` 重写索引，不要手工编辑那张表（细则见 [skills/docs/project-documentation](../../../skills/docs/project-documentation/SKILL.md)「Bug 索引的生成」）。

## 待确认

- 需要在真实浏览器里验证的交互（拖线、流式滚动、弹窗定位）目前只有界面检查和端到端测试覆盖一部分，改这类交互时人工确认一遍（待确认）。
