# server：本机 API、JSON 存储、项目和任务管理

- status: inferred
- source_paths: `server/`
- entry: `server/index.ts`
- analyzed_at: 2026-10-24

## 职责

- 本机 HTTP API：Hono + `@hono/node-server`，只监听 `127.0.0.1`（因为会启动本机 CLI、读写项目目录），同时提供前端静态文件。
- 数据存储：用户数据是数据目录（默认 `~/.agent-panel`）下的 JSON 文件，读写集中在 `server/store.ts`，任务单独存在 `server/task-store.ts`。
- 项目与任务：项目扫描和分类（配合 `shared/project-scan.ts`）、任务创建、排队、停止、续跑、任务快照（`server/tasks.ts`、`server/task-store.ts`）。
- CLI 相关：检测本机 CLI、读取模型列表、一键安装 / 更新 / 卸载（`server/detect.ts`、`server/models.ts`、`server/cli-packages.ts`、`server/install.ts`）。
- 面板能力给 Agent 用：进程内 MCP 工具，编排（`server/orch-mcp.ts`）、向用户提问（`server/ask-mcp.ts`）、UI 设计（`server/design-mcp.ts`）。
- 其他：附件和上传、文件系统接口、AI 创建 / 优化的提示词组装（`server/assist.ts`）、项目教训、导出、版本更新。

## 入口

- `server/index.ts`：路由登记和启动；第一行先加载 `server/lang.ts` 定界面语言。
- `server/exec/`：真实调用 CLI 的部分单独成模块，见 [server-exec](../server-exec/README.md)。

## 依赖

`shared/` 的数据结构和 CLI 定义、`hono`、`zod`、`cross-spawn`（Windows 上调用 npm 安装的 `.cmd`）。

## 回归验证

- `npm run typecheck`
- `npm run test:unit`（`server/**/*.test.ts`，每个模块基本都有同名测试）
- 动了任务执行、项目、设置等跨界面流程时跑 `npm run test:e2e`（Windows 上在 WSL 里）

## 待确认

- `server/` 下文件较多（API 路由集中在 `server/index.ts`），新增接口前先确认应该加在路由里还是拆成独立模块（待确认）。
