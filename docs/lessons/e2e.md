---
paths: scripts/e2e/**, scripts/e2e.mjs, scripts/fake-cli/**, server/exec/worktree-test-kit.ts
---

# 端到端测试和假 CLI

## 假 CLI 与 e2e 分片：场景写进分片，资源和合并走 harness

- 规则：场景放 `scripts/e2e/NN-*.mjs`、每片调一次 `runShard()`；临时目录、端口、服务、看门狗在 `harness.mjs` 的 `setupBase()`，服务用 `onExit()` 登记，分片间不能有依赖。
- 规则：合并分支用 `mergeTask()`（每次尝试前清、被挡住会重试），别手工 `rmSync` 假 CLI 写的 `<kind>-output.txt`；负向用例（期望 409）拿原始错误。加触发词前先 `grep "includes('" scripts/fake-cli/fake-cli.mjs` 查会包含它的旧词（`SLOW`、`FAIL` 匹配整段输入）。
- 规则：改了交给 CLI 的方式（参数、文件、只发增量）同一提交改假 CLI 的读法和 e2e 断言；触发词不能依赖会被增量省掉的规则段落。
- 起因：`BG_SLOW` 命中 `SLOW`（7a875fe）；角色改走 `--append-system-prompt-file` 后假 CLI 认不出评审，3 片红（fc1c744）。
- 规则：用例发给对话的触发词（`FINISH_CHILD:` 这类）假 CLI 要在本轮 input 和插话（`takeSteer`）两条路上都认：对话正被子对话的上报、后台命令结果叫起来时，用户消息会插进这一轮，真的 CLI 会处理，只认 input 的假 CLI 就永远不动。复现办法是直接 `node scripts/e2e/<分片>.mjs`（不经总入口时序不同，更容易撞上）。
- 起因：出包 CI 在「计划没做完时父对话收尾仍被拦」等 finish_child 超时（286465b），PR 上的检查是过的。
- 防线：`test:e2e`（看门狗）、`outputs.test.mjs`。

## 跑 e2e / 单测前清掉继承的环境变量

- 规则：别嵌套跑 `claude`；`ANTHROPIC_BASE_URL` 用 `env -u` 去掉；`AGENT_PANEL_TRAY`、`AGENT_PANEL_SUPERVISED` 会传下去，起服务验证时置空；`rules-check.mjs` 指定仓库用 `env GIT_DIR=… node …` 前置形式，测试自建仓库的 git 子进程要清掉 `GIT_*` 一类变量；WSL 里 `node_modules` 平台不匹配时重装。
- 起因：`ANTHROPIC_BASE_URL` 混进断言；WSL 里 export 后 `git init` 写坏主仓库 `core.worktree`（`fatal: Invalid path '/mnt'`）。
- 防线：`rules-check.mjs` 第 9 条；人工。

## 等状态用 waitFor，不用固定 sleep 或进程存活窗口

- 规则：用 `runShard` 的 `waitFor` 等状态和假 CLI 写的记录文件（状态位早于记录写入，读早了是空），一次性断言带 `label`；跨轮次等待的超时收敛成文件顶部常量（`WAIT_CLI_ROUND_MS = 60000`）。等对话空闲不能只看一阵没跑（子对话 `submit_merge` 会叫起父对话）；判节点并发用 `step.startedAt/endedAt`。否定式断言要临时去掉修复接线跑一遍。
- 起因：原脚本 54 处固定 `sleep(800)`；「切到后台不回收」第一版用 `SLOW`，旧实现没有 waiter 也通过。
- 防线：`test:e2e`；对照开关在 `docs/modules/scripts/README.md`。

## 数「启动了几个 CLI 进程」按对话自己的日志，不按假 CLI 日志的时间窗口

- 规则：断言某个对话启动了几个进程时，用面板给这个对话记的 `[CLI 进程启动] pid=`（`GET /tasks/:id/lifecycle` 的日志），不要拿假 CLI 日志「这段时间新增的 pid」：假 CLI 的日志不分对话，前面几步的对话可能正好被收尾自检、计划推进拉起来。面板记的 pid 是启动脚本那一层，和假 CLI 自己写的 `process.pid` 对不上，要看输入就按这次发的那句话去假 CLI 日志里找。触发词还要避开已有的宽词（`HANG` 会匹配 `HELPER_HANG_ONCE`）。
- 起因：ADR 0041 加了收尾自检（ea58e52c）后，`07-local`「回来发消息复用同一个 CLI」在 CI 和本机时好时坏（2 !== 1，多出来的是上一步对话的「（收尾自检）」进程）。
- 防线：`scripts/e2e/07-local.mjs` 的 `taskPidsOf`。

## 新用例别让父对话的 input 带上场景标记；改动后分片失败先和改动前对照，不当成偶发

- 规则：假 CLI 按 input 里的场景标记（`COMMIT`、`SUBMIT_MERGE`、`REVIEW_BLOCK`……）行动，父对话的 input 里列着子对话标题，标题带标记时父对话也会照着在项目目录里提交、写文件。新加的父子用例单开一个父对话，子对话的标题（取 prompt 开头）不带标记；不要为了绕开父对话那一轮的崩溃去改假 CLI 的行为——崩溃原本挡住了后面的场景动作，改掉它会让父对话在共用目录里留下改动，污染后面的用例。改动之后某个分片失败（哪怕重跑过了），先在改动前的提交上用同样的方式（全量并行）跑一次对照，对照通过就是这次改出来的，不按偶发放过。
- 起因：20b671c 给 04-subagents 加用例时把假 CLI 的 COMMIT 改成「没东西可提交就跳过」，父对话继续往下按 SUBMIT_MERGE 在项目目录写文件，CI 上「共用目录的子对话也过评审门禁」连续失败；本机第一次全量时就失败过，被当成偶发。
- 防线：04-subagents「父对话收到收尾请求却没合回」单开父对话；CI 全量 e2e。
