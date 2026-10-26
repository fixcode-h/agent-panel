---
paths: scripts/e2e/**, scripts/e2e.mjs, scripts/fake-cli/**, scripts/ui-check.mjs, scripts/ui/**, server/**/*.test.ts, server/exec/fixtures/**
---

# 测试

## 测试请求要真的走到被测逻辑

- 规则：e2e 请求要满足全局中间件（Host / Origin、JSON 请求体，否则 415），断言具体错误，不只看状态码。
- 起因：3aa0b22，越权测试被 415 拦下。
- 防线：人工。

## 测试断言不依赖界面语言

- 规则：断言 `t()` 文案时，期望值用同一个 `t()` 生成（见 `server/summary.test.ts`），或只断言状态码、错误码这类稳定字段；确有必要比对中文原文才在文件顶部 `setLang('zh')`（见 `server/files.test.ts`），别靠环境变量——`server/lang.ts` 按 `LANG` 改全局语言，后加载会盖掉 `setLang`。e2e 已固定 `LANG=zh_CN`。
- 防线：给 `shared/locales/en/` 加条目后跑 `LANG=en_US.UTF-8 npm run test:unit`（本机 Windows 同样生效）。
- 起因：3ab9a8d、ded5239c 两次英文环境单测失败；后者是 `summary.test.ts` 写死的中文正则 CI 挂、本机过。

## 改执行流程时假 CLI 跟着改，触发词别撞输入素材

- 规则：`scripts/fake-cli` 要模拟真实会话方式（RPC 常驻多轮、插话、中断）；加触发词前 `grep "includes('" scripts/fake-cli/fake-cli.mjs` 查被包含的旧词（`SLOW` 让这轮等几秒）；`SLOW`、`FAIL`、`FAKE_*` 匹配整段输入（`IMGFAIL` 会混进来），要干净输入的用例自己新建项目。
- 起因：`BG_SLOW` 命中 `SLOW` 慢回合（7a875fe、74bc98a）；2026-10-24 「运行中插话」复用带 `IMGFAIL castle` 的项目，Command Code 那轮被判 failed。
- 防线：`npm run test:e2e`；`06-assist.mjs` 的「设计补充/接续测试」用独立空项目 Steer Probe，跑完删除。

## 跑 e2e / 单测前清掉继承的环境变量

- 规则：沙盒里别嵌套跑 `claude`（继承会话环境和 id）；设了 `ANTHROPIC_BASE_URL` 时用 `env -u ANTHROPIC_BASE_URL npm run test:e2e`。托盘会话的 `AGENT_PANEL_TRAY`、`AGENT_PANEL_SUPERVISED` 会传下去，自己起服务验证时置空，接口在 `/api`（`/api/health`）。给 `rules-check.mjs` 指定仓库用前置形式 `env GIT_DIR=… GIT_WORK_TREE=$PWD node scripts/rules-check.mjs`，不要 export 后接着跑 lint 和测试：测试自建仓库的 git 子进程要去掉 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_COMMON_DIR`（`worktree.test.ts` 的 `gitEnv()`、`harness.mjs` 顶部），共享 `.git/config` 有 `core.worktree` 就删掉。Windows 的 `node_modules` 是 win32 原生包，WSL 跑 e2e 会报平台不匹配：worktree 指向主仓库时先删掉，在本目录 `NODE_ENV=development npm ci` 重装。
- 起因：沙盒的 `ANTHROPIC_BASE_URL` 混进 API 配置断言；验证「强制停止」时几次报「服务没有启动」，实际是启动后就退出；2026-10-24 WSL 里 export 这两个变量后跑 lint 和单测，`worktree.test.ts` 的 `git init` 把 WSL 路径写进主仓库 config 的 `core.worktree`，主目录 git 全报 `fatal: Invalid path '/mnt'`；`/mnt/e` 跑 e2e 卡在 esbuild 二进制不匹配。
- 防线：`scripts/rules-check.mjs` 第 9 条；人工（CI 的 Ubuntu 步骤依赖干净）。

## 临时改坏代码验证测试会失败时，还原别用 git checkout

- 规则：验证测试会失败时可以临时去掉修复，还原别用 `git checkout -- <文件>` / `git restore <文件>`（会整份丢掉未提交改动）；先 `cp` 或 `git stash push <文件>`，验证完恢复，再用 `git diff --stat` 确认改动还在。
- 起因：修 Pi 面板工具时临时去掉 `process.ts` 兜底，`git checkout --` 还原抹掉了整份修复，只能从 /tmp 找回。
- 防线：人工（还原后看 `git diff --stat`）。

## e2e 场景在分片里写，资源和服务都交给 harness

- 规则：`scripts/e2e.mjs` 只是并行 runner，场景放 `scripts/e2e/NN-*.mjs`，每个分片调一次 `runShard()`；临时目录、假 CLI 日志、端口、服务、看门狗、收尾和 `setupBase()` 都在 `harness.mjs`。harness 里的 server、子进程用 `onExit()` 登记，关 server 先 `closeAllConnections()` 再 `close()`，`cleanupAll()` 后按退出码强制退出。分片间不能有依赖，缺前置在本分片建。
- 起因：原 82 个 step 串行单进程，加用例就线性变长；一次 `/accounts/api-models` 报 400 后临时 `apiSrv` 没关，进程挂了 95 分钟。
- 防线：`npm run test:e2e`（每个分片 10 分钟看门狗 + 收尾后 2 秒强制退出）。

## 假 CLI 的输出文件是未跟踪的，合并一律用 mergeTask

- 规则：假 CLI 每轮在工作目录写 `<kind>-output.txt`（名字只在 `scripts/fake-cli/outputs.mjs` 定义）；e2e 合并分支用 `harness.mjs` 的 `mergeTask()`——每次尝试前清、被挡住会重试，别在用例里手工 `rmSync`。负向用例（期望 409）和冲突用例直接发请求拿原始错误，不要套 `mergeTask`。
- 起因：CI run 40309674108 的 `04-subagents` 合并被残留的 `codex-output.txt` 挡住（409），本地过、CI 偶发。
- 防线：`outputs.test.mjs`（清理列表覆盖每种 CLI）、`04-subagents.mjs` 的 codex / pi 残留回归。

## 等状态用 waitFor，不用固定 sleep、「安静一阵」或进程存活窗口

- 规则：用 `runShard` 的 `waitFor` 等状态和假 CLI 写在 `FAKE_CLI_LOG + '.xxx'` 里的记录（状态位早于记录写入，读早了是空）；等对话空闲不能只看一阵没跑（子对话 `submit_merge` 会叫起父对话）。判节点并发用引擎的 `step.startedAt/endedAt`，不用假 CLI 的 `start/end`（进程存活窗口）。否定式断言要临时去掉修复接线跑一遍，旧实现没有可观测差异就是恒真。
- 起因：原脚本 54 处固定 `sleep(800)`；「切到后台不回收」第一版用 `SLOW`，旧实现没有 waiter 也通过。2026-10 dev CI 的 `02-workflow` 并发、`04-subagents` 插话收尾两处也是这一类。
- 防线：`npm run test:e2e`；对照开关在 `docs/modules/scripts/README.md`。

