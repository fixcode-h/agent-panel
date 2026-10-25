# app-actions：操控软件的动作表

- status: verified
- source_paths: `server/app-actions/`、`web/src/lib/ui-actions.ts`
- entry: `server/app-actions/index.ts`
- analyzed_at: 2026-10-25

为什么这么定见 [ADR 0011](../../adr/0011-app-actions-for-agents.md)。这里只写现在怎么工作、怎么加。

## 入口

| 文件                             | 做什么                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `server/app-actions/registry.ts` | `defineAction`、`createRegistry`（校验、执行、日志）、`catalogText`、进程内调接口 `callApi` |
| `server/app-actions/index.ts`    | 汇总各组成 `appActions`；`setActionHost`；HTTP 入口 `/api/actions`                          |
| `server/app-actions/mcp.ts`      | 对 Agent 的两个工具 `app_actions`、`app_do` 和附在输入后的用法 `APP_HINT`                   |
| `server/app-actions/<组>.ts`     | `tasks`、`projects`、`settings`、`ui`、`designs` 各组动作                                   |
| `web/src/lib/ui-actions.ts`      | 页面收 `ui` 事件后的处理表；处理函数在 `web/src/App.tsx` 的 `UiActions` 里登记              |

## 链路

1. `server/exec/runner.ts` 给对话（不含派出的子任务）的调用带上 `app`（调用者的对话 id、项目 id、父对话 id）。
2. `server/exec/invoke.ts` 把它交给 `openAskBridge`，面板 MCP 的工具列表多出 `app_actions`、`app_do`，输入后附 `APP_HINT`。
3. `app_do` → `runAppAction`：zod 校验参数 → 动作的 `run`。
4. 改数据的动作用 `ctx.api` 进程内调 `/api/*`（和界面按钮同一段代码）；界面操作用 `ctx.ui` 经 `/api/app/events` 推给页面。

## 加一个动作

1. 在对应组的文件里加一项 `defineAction`：`name` 写成 `<组>.<动词>`，`level` 按 read / write / danger 选，`input` 用 zod 写并给每个参数 `.describe()`。新的组要在 `index.ts` 里加一行。
2. 优先复用界面已有的接口；接口没有就先在服务端补接口（界面以后也能用），再写动作。
3. 界面操作：动作里 `pushUi(ctx, '<名字>', args)`，再在 `App.tsx` 的 `UiActions` 里加同名处理函数。
4. 单测写在 `server/app-actions/app-actions.test.ts`（假宿主断言调了哪个接口）；走完整链路的写进 `scripts/e2e/11-app-actions.mjs`（假 CLI 认 `APP_DO:<JSON>`）。

## 规则

- `danger` 只在用户明确要求时执行；说明里写清会丢什么。
- 不能停、不能删调用者自己和它的父对话。
- 设置里的 `apis`、`clis`、`remoteAccess`、`requireToken` 不读不写（`HIDDEN_SETTINGS`）。
- 不提供推送、建 PR、发布、P4 提交。

## 回归验证

- `server/app-actions/app-actions.test.ts`：假宿主断言每个动作调了哪个接口、`danger` 和不可停自身 / 父对话的限制。
- `scripts/e2e/11-app-actions.mjs`：假 CLI 发 `APP_DO:<JSON>` 走完整链路（CLI → `app_do` → 动作 → 面板接口）。
- 前端接收侧（`web/src/lib/ui-actions.ts`、`App.tsx` 的 `UiActions`）没有界面检查覆盖（`scripts/ui/` 里没有相关用例），改了要手工开页面点一遍。
