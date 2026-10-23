---
paths: scripts/e2e/**, scripts/e2e.mjs, scripts/fake-cli/**, scripts/ui-check.mjs, server/**/*.test.ts, server/exec/fixtures/**
---

# 测试

## 测试请求要真的走到被测逻辑

- 规则：e2e 请求要满足全局中间件（Host / Origin、JSON 请求体，否则 415），断言具体的错误信息，不只看状态码。
- 起因：3aa0b22，越权测试一直被 415 拦下，越权校验本身从没测到。
- 防线：人工。

## 测试不依赖系统语言

- 规则：断言 `t()` 文案的测试在文件顶部 `setLang('zh')`（见 `server/files.test.ts`）；`shared/i18n.ts` 的语言是模块级全局，`server/lang.ts` 会在导入时按 `process.env.LANG` 改它（例如 `server/files.ts` → `server/settings.ts` → `server/lang.ts`），不要靠「别的文件先设过」或环境变量。e2e 已固定服务端 `LANG=zh_CN`。
- 起因：3ab9a8d 英文系统上单测失败；同一个坑又踩一次——CI 的 `LANG=en_US.UTF-8` 让 11 个单测拿到英文报错文案，本地 Windows 全过。
- 复现：`LANG=en_US.UTF-8 npm run test:unit`。
- 防线：CI。

## 改执行流程时假 CLI 跟着改

- 规则：`scripts/fake-cli` 要模拟真实 CLI 的会话方式（RPC 常驻多轮、插话、中断）；执行流程改了，假 CLI 也补上对应行为，否则 e2e 测的是旧流程。
- 起因：7a875fe、74bc98a，RPC 常驻后假 CLI 只能跑一轮。
- 防线：`npm run test:e2e`。

## 在 Claude Code 里开发时别嵌套跑 claude

- 规则：沙盒里直接跑 `claude` 会继承当前会话的环境和会话 id；Claude 的协议用假 CLI 测。Codex 在沙盒里没装。沙盒设了 `ANTHROPIC_BASE_URL`，会混进 API 配置的断言，跑 e2e 用 `env -u ANTHROPIC_BASE_URL npm run test:e2e`。
- 防线：人工。

## 临时改坏代码验证测试会失败时，还原别用 git checkout

- 规则：为了确认新测试真能挡住 bug，临时把修复去掉跑一遍是对的；但还原时不要用 `git checkout -- <文件>` / `git restore <文件>`——未提交的改动会整份丢掉。先 `cp` 到临时目录或 `git stash push <文件>`，验证完从备份恢复，再用 `git diff --stat` 确认改动还在。
- 起因：修 Pi 面板工具时把 `process.ts` 的兜底临时去掉，证明新加的 `.cmd` 垫片测试会失败；用 `git checkout --` 还原时把那一整份修复抹掉了，只能从 /tmp 的临时备份找回。
- 防线：人工（还原后先看一眼 `git diff --stat`）。

## 在 WSL 里跑 e2e 要用 Linux 装的依赖

- 规则：Windows 的 `node_modules` 里是 win32 原生包，WSL 里跑 e2e 会报「installed for another platform」/「服务没有启动」。worktree 的 `node_modules` 若是指向主仓库的软链接，先删掉软链接，在这个目录里 `NODE_ENV=development npm ci` 装一份自己的，不要在主仓库里装。`.git` 文件里是 Windows 路径，WSL 里跑 `rules-check.mjs`（用到 `git ls-files`）要带上 `GIT_DIR=/mnt/<盘>/…/.git/worktrees/<名称> GIT_WORK_TREE=$PWD`。
- 起因：直接在 `/mnt/e` 里跑 e2e 卡在 esbuild 二进制不匹配；worktree 软链到主仓库时装什么都会落到 Windows 那份上。
- 防线：人工（CI 的 Ubuntu 步骤始终是干净的 Linux 依赖）。

## 自己起服务做验证时清掉面板的环境变量

- 规则：在面板的会话里（托盘启动的） `AGENT_PANEL_TRAY=1` 会传下去，服务进了托盘模式， stdin 一结束就退出，表现成「服务已启动」之后连不上。写验证脚本拉起服务时把 `AGENT_PANEL_TRAY` 和 `AGENT_PANEL_SUPERVISED` 置空；接口都在 `/api` 下（`/api/health`），不是根路径。
- 起因：验证「强制停止」时自己起服务，连试了几次都报「服务没有启动」，实际是服务启动后立即退出了。
- 防线：人工。

## e2e 里起的资源要登记，退出别指望它们自己关

- 规则：`scripts/e2e/harness.mjs`（各分片共用）里起的 `http.createServer`、子进程都用 `onExit()` 登记；关 server 先 `closeAllConnections()` 再 `close()`，只 `close()` 会留下 keep-alive 连接。收尾时 `cleanupAll()` 之后按退出码强制退出，不等事件循环自然清空。
- 起因：`/accounts/api-models` 的 `name` 改成必填后 e2e 报 400，临时 `apiSrv` 没关，进程挂 95 分钟。
- 防线：`npm run test:e2e`（每个分片 10 分钟看门狗 + 收尾后 2 秒强制退出）。

## 假 CLI 的触发词别包含已有的触发词

- 规则：`scripts/fake-cli` 按 `input.includes('关键词')` 决定行为，新加触发词前先 `grep "includes('" scripts/fake-cli/fake-cli.mjs` 看有没有被它包含的旧词（例如 `SLOW` 会让这一轮先等几秒）；用意思明确、不会撞上的词。
- 起因：加「后台命令还在跑」的 e2e 时用了 `BG_SLOW`，命中了旧的 `SLOW` 慢回合，回合拖到后台命令跑完才结束，断言一直失败。
- 防线：人工。

## e2e 按分片并行，共享环境只在 harness 里改

- 规则：`scripts/e2e.mjs` 只是并行 runner，场景在 `scripts/e2e/NN-*.mjs`，每个分片调一次 `runShard()`；临时目录、假 CLI 日志、端口、服务、看门狗、收尾和基础数据（`setupBase()`）都在 `scripts/e2e/harness.mjs`。新用例放进主题相符的分片；分片间不能有依赖，缺前置就在本分片自己建（漏了直接 ReferenceError）。
- 起因：原 82 个 step 串行、单进程，加用例就线性变长。
- 防线：`npm run test:e2e`。

## 等状态用 waitFor，别写固定 sleep

- 规则：`runShard` 提供 `waitFor(条件, { timeout, interval, label })`：等「CLI 被调用」「任务进入 running」这类状态，条件一到就继续，超时才失败。只有「必须过一段时间、时序才会发生」的地方才留固定等待并写注释。假 CLI 的耗时用 `FAKE_TURN_MS` / `FAKE_SLOW_ROUND_MS` / `FAKE_SLOW_ROUNDS` 控制，e2e 默认压到最小。
- 起因：原脚本 54 处固定 `sleep(800)`，慢机器偶发失败、快机器白等。
- 防线：人工。
