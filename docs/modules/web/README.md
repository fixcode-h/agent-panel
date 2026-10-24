# web：React 前端

- status: inferred
- source_paths: `web/`
- entry: `web/src/main.tsx`、`web/src/App.tsx`
- analyzed_at: 2026-10-24

## 职责

- 页面：项目、任务、工作流、Agent、设置、图库、ComfyUI、MCP（`web/src/pages/`），不常用的大页面按需加载。
- 流程图画布：工作流编辑和任务流程图视图（`web/src/components/flow/`，基于 `@xyflow/react`）。
- 对话与任务：实时输出分段、步骤状态、上下文和 Token 用量、右侧文件系统面板（`web/src/components/tasks/`、`web/src/components/files/`）。
- 数据访问和状态：`web/src/lib/data.tsx`（路由和数据上下文）、`web/src/lib/api.ts`（接口调用）。
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
