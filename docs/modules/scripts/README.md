# scripts：端到端测试、界面检查、出包和检查脚本

- status: inferred
- source_paths: `scripts/`
- entry: `scripts/e2e.mjs`、`scripts/ui-check.mjs`、`scripts/package.mjs`、`scripts/rules-check.mjs`
- analyzed_at: 2026-10-24

## 职责

- 端到端测试：`scripts/e2e.mjs` 并行跑 `scripts/e2e/` 下的分片，每个分片自己的临时数据目录、假 CLI 日志、端口和服务；共享环境在 `scripts/e2e/harness.mjs`，启动服务走 `scripts/e2e/spawn-server.mjs`（服务自己 `listen(0)` 报回实际端口、`/health` 回显分片唯一的 instance，端口被残留进程或并行分片占着时明确失败）。服务启动后在 stdout 打一行 `AGENT_PANEL_PORT <实际端口>`，是给测试和脚本解析用的，托盘程序只看 `AGENT_PANEL_READY` / `OPEN` / `FOCUS` / `UPDATE`。
- 模拟 CLI：`scripts/fake-cli/fake-cli.mjs` 按场景输出各 CLI 的结构化事件（含 RPC 多轮），`fake-npm.mjs` 模拟安装 / 卸载。
  - 插话契约：假 CLI 收到插话（Codex 和 Command Code 的 `turn/steer`、Pi 的 `steer`、Claude Code 执行中写进来的 user 消息）时，不能只记进 `steered` 就完事，要像真 CLI 一样当场把插话里的【收尾请求】办掉：`takeSteer()` 先用 `wrapRequestIds(text)`（`scripts/fake-cli/wrap-request.mjs`）按 id 去重取出子对话 id，逐个 `panelCall('finish_child', { id })`，结果追加到 `${FAKE_CLI_LOG}.finish`（带 `via: 'steer'`，本轮 input 那条路写 `via: 'input'`，用例据此分清哪条路办的）；`tookWrap` 按**轮**去重（每处开始新一轮时 `tookWrap.clear()`，因为保活的进程会接着跑很多轮，按进程记的话子对话被退回后第二次请收尾会被静默跳过），原 input 和插话都带同一个请求时只合一次。原因：父对话正在跑一轮时，子对话的 `submit_merge` 经 `server/tasks.ts` 的 `noteParent → steerTask` 以插话进入那一轮，不会再另开一轮；假 CLI 只 push 不处理的话 `finish_child` 永远不会被调用，子对话一直停在收尾请求待处理，e2e 里等 `resolved && worktree.state === 'merged'` 的步骤只能等到超时（并行分片时父对话常被前一个子对话的上报叫起，必现）。这是测试替身失真（真 CLI 收到插话会照做），不是产品 bug，别用调大超时绕过。用例要这条路径时给父对话发 `HOLD_STEER`：这一轮一直挂到真的收到插话才收尾，不靠 `SLOW` 那段固定时长（那个窗口常被子对话开分支、派评审的链路超过，收尾请求会退化成普通新一轮 input，让用例假通过）。`HOLD_STEER` 等待期间必须一直有输出（用 thinking 事件模拟，间隔 1 秒）：面板按「交出消息后多久没有任何输出」判卡住（`AGENT_PANEL_NO_RESPONSE_MS`，e2e 里 2 秒），静默等会被判成卡住，之后来的消息改走 `restartStalled` 停掉这一轮重开，收尾请求就不再是插话了。
- 界面检查：`scripts/ui-check.mjs` 用 Playwright 打开在线演示版，检查报错和横向滚动，截图到 `ui-shots/`；分片在 `scripts/ui/`。两个入口启动时都会校验 `dist-demo` 和源码对得上（指纹在 `scripts/lib/demo-build-info.mjs`，`vite build --mode demo` 时写进产物），源码改过却没重新构建时直接失败并列出变了的文件，不拿旧产物跑出假结果。
- 出包：`scripts/package.mjs` 把正式版前端和单文件服务端放进 `release/`，并检查包里没有演示内容；Windows 托盘程序在 `scripts/tray/`，服务安装脚本在 `scripts/service/`。
- 检查：`scripts/rules-check.mjs`（CLI 名字分支、文档路径、教训分片格式、换行和编码等）、`scripts/i18n-check.mjs`（漏翻）、`scripts/lessons.mjs`（按改动文件取教训）、`scripts/release-notes.mjs`（整理更新说明）。
- 模块文档一致性：`scripts/lib/doc-modules.mjs` 解析 `docs/MODULE-MAP.md` 的模块表，检查模块表与 `docs/modules/*` 双向对得上（缺文档、模块删了还留目录）；`scripts/rules-check.mjs` 调用它，用例在 `scripts/doc-modules.test.mjs`。
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
- 改了假 CLI 的插话或收尾处理（`fake-cli.mjs` 的 `takeSteer()`、`wrapRequestIds()`）：`npm run test:e2e -- 04`，其中「父对话正在跑一轮时子对话请收尾：收尾请求以插话进来，父对话照样合回」一步专门覆盖插话里带【收尾请求】的路径：给父对话发 `HOLD_STEER` 让它真的一直跑到插话进来，断言子对话在 60s 内 `resolved && worktree.state === 'merged'`、`.finish` 里那条记录 `via === 'steer'`（只写 `via: 'input'` 就说明收尾请求退化成普通新一轮，插话路径没被覆盖）、`.hold` 记了 `held: true`（那一轮真的等到插话，不是静默被当成卡住）。把 `takeSteer()` 里处理收尾请求的部分去掉，这一步会以 `超时：done` 失败。
- 改了界面检查：先 `npx vite build --mode demo`，再 `node scripts/ui-check.mjs`，看 `ui-shots/` 里的截图（改了 `web/src`、`shared` 后没重新构建会被拦下）。
- 改了检查脚本：`npm run lint`；改了出包：`node scripts/package.mjs 0.0.0 --no-archive` 试跑一次。

## 待确认

- 出包和托盘程序的完整验证在 CI 的 Windows job 里（见 `.github/workflows/ci.yml`），本机无法完整复现（待确认）。
