---
paths: scripts/e2e/**, scripts/e2e.mjs, scripts/fake-cli/**, scripts/ui-check.mjs, scripts/ui/**, server/**/*.test.ts, server/exec/fixtures/**
---

# 测试

## 测试请求要真的走到被测逻辑

- 规则：e2e 请求要满足全局中间件（Host / Origin、JSON 请求体，否则 415），断言具体错误，不只看状态码。
- 起因：3aa0b22，越权测试一直被 415 拦下。
- 防线：人工。

## 测试不依赖系统语言

- 规则：断言 `t()` 文案的测试在文件顶部 `setLang('zh')`（见 `server/files.test.ts`）；`shared/i18n.ts` 的语言是模块级全局，`server/lang.ts` 会按 `process.env.LANG` 在导入时改它，不要靠别的文件或环境变量。e2e 已固定 `LANG=zh_CN`。
- 起因：3ab9a8d 英文系统上单测失败；CI 的 `LANG=en_US.UTF-8` 又让 11 个单测拿到英文报错文案。
- 防线：CI。

## 改执行流程时假 CLI 跟着改，触发词别撞输入素材

- 规则：`scripts/fake-cli` 要模拟真实 CLI 的会话方式（RPC 常驻多轮、插话、中断），执行流程改了也补上对应行为，否则 e2e 测的是旧流程；加触发词前先 `grep "includes('" scripts/fake-cli/fake-cli.mjs` 看有没有被包含的旧词（`SLOW` 会让这一轮先等几秒），用不会撞上的词。`SLOW`、`FAIL`、`FAKE_*` 匹配整段输入，别的用例留下的 `IMGFAIL` 会随项目提示词和其他设计的图片描述混进来判成失败，要干净输入的用例自己新建项目（或单独数据目录）。
- 起因：7a875fe、74bc98a 后假 CLI 只能跑一轮；`BG_SLOW` 命中 `SLOW` 慢回合。2026-10-24 设计对话「运行中插话」e2e 复用了带 `IMGFAIL castle` 图片的 UI 项目，它进了提示词，Command Code 那一轮被判成 failed。
- 防线：`npm run test:e2e`；`scripts/e2e/06-assist.mjs` 的「设计补充测试 / 设计接续测试」用独立空项目 Steer Probe，跑完删除。

## 在 Claude Code 里别嵌套跑 claude

- 规则：沙盒里直接跑 `claude` 会继承当前会话的环境和 id；Claude 的协议用假 CLI 测。Codex 在沙盒里没装。沙盒设了 `ANTHROPIC_BASE_URL`，会混进 API 配置的断言，跑 e2e 用 `env -u ANTHROPIC_BASE_URL npm run test:e2e`。
- 防线：人工。

## 临时改坏代码验证测试会失败时，还原别用 git checkout

- 规则：验证测试会失败时可以临时去掉修复；还原不要用 `git checkout -- <文件>` / `git restore <文件>`（未提交的改动会整份丢掉），先 `cp` 到临时目录或 `git stash push <文件>`，验证完从备份恢复，再用 `git diff --stat` 确认改动还在。
- 起因：修 Pi 面板工具时临时去掉 `process.ts` 的兜底，证明 `.cmd` 垫片测试会失败；用 `git checkout --` 还原时抹掉了整份修复，只能从 /tmp 的备份找回。
- 防线：人工（还原后先看一眼 `git diff --stat`）。

## 在 WSL 里跑 e2e 要用 Linux 装的依赖

- 规则：Windows 的 `node_modules` 是 win32 原生包，WSL 跑 e2e 报「installed for another platform」。worktree 的 `node_modules` 指向主仓库软链时先删掉，在本目录 `NODE_ENV=development npm ci` 装自己的。`.git` 是 Windows 路径，跑 `rules-check.mjs` 要带 `GIT_DIR=/mnt/<盘>/…/.git/worktrees/<名称> GIT_WORK_TREE=$PWD`。
- 起因：在 `/mnt/e` 跑 e2e 卡在 esbuild 二进制不匹配；worktree 软链到主仓库时装什么都会落到 Windows 那份上。
- 防线：人工（CI 的 Ubuntu 步骤始终是干净的 Linux 依赖）。

## 自己起服务做验证时清掉面板的环境变量

- 规则：托盘启动的面板会话里 `AGENT_PANEL_TRAY=1` 会传下去，服务进托盘模式，stdin 一结束就退出，表现成「服务已启动」后连不上。验证脚本拉起服务时把 `AGENT_PANEL_TRAY`、`AGENT_PANEL_SUPERVISED` 置空；接口在 `/api` 下（`/api/health`）。
- 起因：验证「强制停止」时自己起服务，几次都报「服务没有启动」，实际是启动后立即退出了。
- 防线：人工。

## e2e 里起的资源要登记，退出别指望自动关

- 规则：`scripts/e2e/harness.mjs` 里起的 `http.createServer`、子进程都用 `onExit()` 登记；关 server 先 `closeAllConnections()` 再 `close()`，只 `close()` 会留下 keep-alive 连接。收尾 `cleanupAll()` 后按退出码强制退出，不等事件循环。
- 起因：一次 `/accounts/api-models` 报 400 后临时 `apiSrv` 没关，进程挂了 95 分钟。
- 防线：`npm run test:e2e`（每个分片 10 分钟看门狗 + 收尾后 2 秒强制退出）。

## e2e 按分片并行，共享环境只在 harness 里改

- 规则：`scripts/e2e.mjs` 只是并行 runner，场景在 `scripts/e2e/NN-*.mjs`，每个分片调一次 `runShard()`；临时目录、假 CLI 日志、端口、服务、看门狗、收尾和 `setupBase()` 都在 `scripts/e2e/harness.mjs`。新用例放进主题相符的分片；分片间不能有依赖，缺前置在本分片建（漏了 ReferenceError）。
- 起因：原 82 个 step 串行、单进程，加用例就线性变长。
- 防线：`npm run test:e2e`。

## 等状态用 waitFor，别写固定 sleep 或「安静一阵」

- 规则：`runShard` 的 `waitFor(条件, { timeout, interval, label })` 等状态和假 CLI 写在 `FAKE_CLI_LOG + '.xxx'` 里的调用记录（状态置位早于日志写入，读早了是空）；只有「必须过一段时间」才留固定等待并写注释。等对话空闲不能只看一阵没在跑（子对话 `submit_merge` 会叫起父对话），要用 `waitFor` 等断言条件。
- 反向验证：否定式断言（不被回收/不被停）要临时去掉修复接线跑一遍，确认会失败再恢复；旧实现下要有可观测差异（取消要有 waiter、停进程要有进程、回收要有计时器），没差异就是恒真，换构造。
- 起因：原脚本 54 处固定 `sleep(800)`；「切到后台不回收运行中的对话」第一版用例用 `SLOW` 切后台，旧实现没有 waiter，照样通过，改成「停在等后台命令结果」后才有区分度。
- 防线：`npm run test:e2e`。
