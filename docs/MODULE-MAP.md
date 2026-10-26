# 模块地图

按职责划分的顶层模块。改代码前先确认落在哪个模块；跨模块的改动从下表找出受影响的模块一起验证。
状态为 `inferred` 的模块文档是初始化时按代码推断的，发现与实现不符时改文档（并同步本表）。

| 模块        | 路径           | 职责                                                                                         | 入口                                     | 文档                                                 | 状态     |
| ----------- | -------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- | -------- |
| shared      | `shared/`      | 前后端共用的数据结构、CLI 注册表、流程图逻辑、工作流执行引擎、内置角色和工作流、定时计划规则 | `shared/schema.ts`、`shared/clis.ts`     | [modules/shared](modules/shared/README.md)           | inferred |
| server      | `server/`      | 本机 HTTP API、JSON 存储、项目与任务管理、定时计划、CLI 检测与安装、MCP 工具                 | `server/index.ts`                        | [modules/server](modules/server/README.md)           | inferred |
| server-exec | `server/exec/` | 真实执行：拼 CLI 参数、管进程、解析输出、RPC 会话、git 改动统计、子对话 worktree             | `server/exec/runner.ts`                  | [modules/server-exec](modules/server-exec/README.md) | inferred |
| web         | `web/`         | React 前端：项目、任务、工作流、Agent、计划、设置页面，流程图画布和对话输出                  | `web/src/App.tsx`                        | [modules/web](modules/web/README.md)                 | inferred |
| scripts     | `scripts/`     | 端到端测试、界面检查、出包、规则检查和漏翻检查、教训检索、Windows 托盘                       | `scripts/e2e.mjs`、`scripts/package.mjs` | [modules/scripts](modules/scripts/README.md)         | inferred |
| skills      | `skills/`      | 随面板发布的内置 Skill，安装时平铺到用户目录                                                 | `skills/README.md`                       | [modules/skills](modules/skills/README.md)           | inferred |
| extension   | `extension/`   | Chrome MV3 扩展：用本机已登录的 Gemini / ChatGPT 网页生图                                    | `extension/manifest.json`                | [modules/extension](modules/extension/README.md)     | inferred |

## 依赖方向

- `web` 和 `server` 都依赖 `shared`；`shared` 不反过来引用它们（前端通过 Vite 别名 `@shared` 引用）。
- `server` 通过 `server/exec/` 调用真实 CLI；`server/exec/` 只按 `shared/clis` 里的定义执行，不按 CLI 名字分支。
- `scripts` 启动 `server` 和构建 `web` 做端到端与界面检查，是唯一会从外部跑整个应用的地方。
- `skills` 和 `extension` 不参与应用编译，分别由 Agent CLI 和浏览器加载。

## 不容易发现位置的改动

| 要做的事                               | 落在哪                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| 接一种新 CLI、改参数 / 输出解析 / 强度 | `shared/clis/` 的 JSON 定义 + [cli-config.md](cli-config.md)       |
| 改工作流怎么调度、续跑、验收           | `shared/engine.ts`；真实调用在 `server/exec/runner.ts`             |
| 改定时计划的到点规则、下次时间怎么算   | `shared/schedule.ts`；到点启动对话在 `server/schedules.ts`         |
| 改流程图布局、连线规则                 | `shared/flow.ts`；画布交互在 `web/src/components/flow/`            |
| 改界面文案                             | `web/src` 里的 `t('中文')` + `shared/locales/en/`                  |
| 改端到端覆盖                           | `scripts/e2e/` 下按主题分片，模拟 CLI 在 `scripts/fake-cli/`       |
| 改内置角色、工作流模板                 | `shared/builtin/`，判定标准见 [agent-catalog.md](agent-catalog.md) |
