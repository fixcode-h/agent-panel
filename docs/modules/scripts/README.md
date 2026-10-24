# scripts：端到端测试、界面检查、出包和检查脚本

- status: inferred
- source_paths: `scripts/`
- entry: `scripts/e2e.mjs`、`scripts/ui-check.mjs`、`scripts/package.mjs`、`scripts/rules-check.mjs`
- analyzed_at: 2026-10-24

## 职责

- 端到端测试：`scripts/e2e.mjs` 并行跑 `scripts/e2e/` 下的分片，每个分片自己的临时数据目录、假 CLI 日志、端口和服务；共享环境在 `scripts/e2e/harness.mjs`，启动服务走 `scripts/e2e/spawn-server.mjs`（服务自己 `listen(0)` 报回实际端口、`/health` 回显分片唯一的 instance，端口被残留进程或并行分片占着时明确失败）。服务启动后在 stdout 打一行 `AGENT_PANEL_PORT <实际端口>`，是给测试和脚本解析用的，托盘程序只看 `AGENT_PANEL_READY` / `OPEN` / `FOCUS` / `UPDATE`。
- 模拟 CLI：`scripts/fake-cli/fake-cli.mjs` 按场景输出各 CLI 的结构化事件（含 RPC 多轮），`fake-npm.mjs` 模拟安装 / 卸载。
- 界面检查：`scripts/ui-check.mjs` 用 Playwright 打开在线演示版，检查报错和横向滚动，截图到 `ui-shots/`；分片在 `scripts/ui/`。两个入口启动时都会校验 `dist-demo` 和源码对得上（指纹在 `scripts/lib/demo-build-info.mjs`，`vite build --mode demo` 时写进产物），源码改过却没重新构建时直接失败并列出变了的文件，不拿旧产物跑出假结果。
- 出包：`scripts/package.mjs` 把正式版前端和单文件服务端放进 `release/`，并检查包里没有演示内容；Windows 托盘程序在 `scripts/tray/`，服务安装脚本在 `scripts/service/`。
- 检查：`scripts/rules-check.mjs`（CLI 名字分支、文档路径、教训分片格式、换行和编码等）、`scripts/i18n-check.mjs`（漏翻）、`scripts/lessons.mjs`（按改动文件取教训）、`scripts/release-notes.mjs`（整理更新说明）。
- 真实 CLI 验证：`scripts/real-cli/` 用本机真实 CLI 跑一遍（不是每次都要跑）。

## 入口

- `npm run test:e2e`：端到端；只跑某几个分片 `npm run test:e2e -- 03 07`。
- `npx vite build --mode demo && node scripts/ui-check.mjs`：界面检查（必须先构建，产物旧了会失败）。
- `npm run lint`：oxlint、Prettier 格式检查、规则检查。
- `npm run package`：出包。

## 依赖

Playwright（界面检查）、esbuild（出包）、Node.js 20+。端到端测试需要 macOS / Linux；Windows 上用 `npm run test:e2e:wsl`。

## 回归验证

- 改了端到端：`npm run test:e2e`（CI 里跑同样的命令）。
- 改了界面检查：先 `npx vite build --mode demo`，再 `node scripts/ui-check.mjs`，看 `ui-shots/` 里的截图（改了 `web/src`、`shared` 后没重新构建会被拦下）。
- 改了检查脚本：`npm run lint`；改了出包：`node scripts/package.mjs 0.0.0 --no-archive` 试跑一次。

## 待确认

- 出包和托盘程序的完整验证在 CI 的 Windows job 里（见 `.github/workflows/ci.yml`），本机无法完整复现（待确认）。
