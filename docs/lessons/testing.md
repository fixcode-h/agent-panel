---
paths: scripts/e2e/**, scripts/e2e.mjs, scripts/fake-cli/**, scripts/ui-check.mjs, scripts/ui/**, server/**/*.test.ts, server/exec/fixtures/**
---

# 测试

## 测试请求要真的走到被测逻辑

- 规则：e2e 请求要满足全局中间件（Host / Origin、JSON 请求体，否则 415），断言具体错误，不只看状态码。
- 起因：3aa0b22，越权测试一直被 415 拦下。
- 防线：人工。

## 测试断言不依赖界面语言

- 规则：断言 `t()` 文案时，期望值用同一个 `t()` 生成（见 `server/summary.test.ts`），或只断言状态码、错误码这类稳定字段；确有必要比对中文原文才在文件顶部 `setLang('zh')`（见 `server/files.test.ts`），别靠环境变量——`server/lang.ts` 按 `process.env.LANG` 改全局语言，依赖链里后加载它会盖掉 `setLang`。e2e 已固定 `LANG=zh_CN`。
- 防线：给 `shared/locales/en/` 加条目后跑 `LANG=en_US.UTF-8 npm run test:unit`（本机 Windows 同样生效）。
- 起因：3ab9a8d、ded5239c 两次英文环境单测失败；后者是给「未知的 Agent：{cli}」补英文后，`server/summary.test.ts` 写死的中文正则 CI 挂、本机过。

## 改执行流程时假 CLI 跟着改，触发词别撞输入素材

- 规则：`scripts/fake-cli` 要模拟真实会话方式（RPC 常驻多轮、插话、中断），流程改了也补上；加触发词前 `grep "includes('" scripts/fake-cli/fake-cli.mjs` 查被包含的旧词（`SLOW` 让这轮等几秒）；`SLOW`、`FAIL`、`FAKE_*` 匹配整段输入，别的用例的 `IMGFAIL` 会随提示词混进来，要干净输入的用例自己新建项目（或数据目录）。
- 起因：`BG_SLOW` 命中 `SLOW` 慢回合（7a875fe、74bc98a）；2026-10-24 「运行中插话」复用带 `IMGFAIL castle` 的项目，Command Code 那轮被判 failed。
- 防线：`npm run test:e2e`；`scripts/e2e/06-assist.mjs` 的「设计补充测试 / 设计接续测试」用独立空项目 Steer Probe，跑完删除。

## 跑 e2e 前准备环境：清掉继承的变量，用 WSL 自己的依赖

- 规则：沙盒里别嵌套跑 `claude`（继承会话环境和 id，协议用假 CLI 测）；设了 `ANTHROPIC_BASE_URL` 时跑 e2e 用 `env -u ANTHROPIC_BASE_URL npm run test:e2e`。托盘会话的 `AGENT_PANEL_TRAY`、`AGENT_PANEL_SUPERVISED` 会传下去，服务进托盘模式、stdin 一结束就退出，自己起服务验证时把它们置空，接口在 `/api`（`/api/health`）。Windows 的 `node_modules` 是 win32 原生包，WSL 跑 e2e 报「installed for another platform」；worktree 的 `node_modules` 指向主仓库时先删掉，在本目录 `NODE_ENV=development npm ci` 装自己的。
- 起因：沙盒的 `ANTHROPIC_BASE_URL` 混进 API 配置断言；验证「强制停止」时几次报「服务没有启动」，实际是启动后就退出。`/mnt/e` 跑 e2e 卡在 esbuild 二进制不匹配，worktree 软链到主仓库时装什么都会落到 Windows 那份上。
- 防线：人工（CI 的 Ubuntu 步骤依赖干净）。

## 临时改坏代码验证测试会失败时，还原别用 git checkout

- 规则：验证测试会失败时可以临时去掉修复，还原别用 `git checkout -- <文件>` / `git restore <文件>`（会整份丢掉未提交改动）；先 `cp` 到临时目录或 `git stash push <文件>`，验证完恢复，再用 `git diff --stat` 确认改动还在。
- 起因：修 Pi 面板工具时临时去掉 `process.ts` 兜底，证明 `.cmd` 垫片测试会失败；`git checkout --` 还原抹掉了整份修复，只能从 /tmp 找回。
- 防线：人工（还原后看 `git diff --stat`）。

## e2e 场景在分片里写，资源和服务都交给 harness

- 规则：`scripts/e2e.mjs` 只是并行 runner，场景放 `scripts/e2e/NN-*.mjs`，每个分片调一次 `runShard()`；临时目录、假 CLI 日志、端口、服务、看门狗、收尾和 `setupBase()` 都在 `scripts/e2e/harness.mjs`。harness 里的 `http.createServer`、子进程用 `onExit()` 登记；关 server 先 `closeAllConnections()` 再 `close()`（只 `close()` 会留 keep-alive）；`cleanupAll()` 后按退出码强制退出。分片间不能有依赖，缺前置在本分片建。
- 起因：原 82 个 step 串行单进程，加用例就线性变长；一次 `/accounts/api-models` 报 400 后临时 `apiSrv` 没关，进程挂了 95 分钟。
- 防线：`npm run test:e2e`（每个分片 10 分钟看门狗 + 收尾后 2 秒强制退出）。

## 等状态用 waitFor，不用固定 sleep、「安静一阵」或进程存活窗口

- 规则：用 `runShard` 的 `waitFor` 等状态和假 CLI 写在 `FAKE_CLI_LOG + '.xxx'` 里的记录（状态位早于记录写入，读早了是空）；等对话空闲不能只看一阵没跑（子对话 `submit_merge` 会叫起父对话）。判节点并发用引擎的 `step.startedAt/endedAt`（调度窗口），不用假 CLI 的 `start/end`（进程存活窗口）。
- 反向验证：否定式断言临时去掉修复接线跑一遍，确认会失败再恢复；旧实现没有可观测差异就是恒真。
- 起因：原脚本 54 处固定 `sleep(800)`；「切到后台不回收」第一版用 `SLOW`，旧实现没有 waiter 也通过。2026-10 dev CI 的 `02-workflow` 并发、`04-subagents` 插话收尾两处也是这一类。
- 防线：`npm run test:e2e`；对照开关在 `docs/modules/scripts/README.md`。

## GIT_DIR/GIT_WORK_TREE 只给需要它的那一条命令

- 规则：WSL 里给 `rules-check.mjs` 指定仓库用前置形式 `env GIT_DIR=… GIT_WORK_TREE=$PWD node scripts/rules-check.mjs`，不要 export 后接着跑 lint 和测试；测试自建仓库的 git 子进程去掉 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_COMMON_DIR`（`worktree.test.ts` 的 `gitEnv()`）。共享 `.git/config` 有 `core.worktree` 就删掉，别改 `core.bare`。
- 起因：2026-10-24 WSL 里 export 这两个变量后跑 lint 和单测，`worktree.test.ts` 的 `git init` 把 WSL 路径写进主仓库 config 的 `core.worktree`，主目录 git 全报 `fatal: Invalid path '/mnt'`。
- 防线：`scripts/rules-check.mjs` 第 9 条。
