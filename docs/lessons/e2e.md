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
