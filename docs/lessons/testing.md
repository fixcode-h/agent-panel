---
paths: scripts/e2e.mjs, scripts/fake-cli/**, scripts/ui-check.mjs, server/**/*.test.ts, server/exec/fixtures/**
---

# 测试

## 测试请求要真的走到被测逻辑

- 规则：e2e 请求要满足全局中间件（Host / Origin、JSON 请求体，否则 415），断言具体的错误信息，不只看状态码。
- 起因：3aa0b22，越权测试一直被 415 拦下，越权校验本身从没测到。
- 防线：人工。

## 测试不依赖系统语言

- 规则：断言中文文案的测试先固定语言；e2e 已固定服务端 `LANG=zh_CN`。
- 起因：3ab9a8d，英文系统上单测失败。
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

- 规则：Windows 上 `node_modules` 是 Windows 装的，esbuild / rollup 的原生二进制在 WSL 里跑不起来（报 installed for another platform，接着是「服务没有启动」）。要在 WSL 里验证时，先把仓库复制一份到 Linux 文件系统里 `npm ci` 再跑，不要直接对 `/mnt/e` 这份 `npm ci`——它会把 Windows 的依赖换成 Linux 的，本机开发就跑不了了。
- 起因：这次改完想按项目步骤跑 e2e，直接在 `/mnt/e` 里跑，卡在 esbuild 二进制不匹配。
- 补充：在 worktree 里跑时不用复制整个仓库（worktree 的 `node_modules` 是指向主仓库的软链接，装什么都会落到 Windows 那份上）：在 WSL 里 `npm i --prefix /tmp/esb @esbuild/linux-x64@<和仓库相同的版本>`，再 `ESBUILD_BINARY_PATH=/tmp/esb/node_modules/@esbuild/linux-x64/bin/esbuild npm run test:e2e`，就只换 esbuild 的二进制。
- 防线：人工（CI 的 Ubuntu 步骤始终是干净的 Linux 依赖）。

## 自己起服务做验证时清掉面板的环境变量

- 规则：在面板的会话里（托盘启动的） `AGENT_PANEL_TRAY=1` 会传下去，服务进了托盘模式， stdin 一结束就退出，表现成「服务已启动」之后连不上。写验证脚本拉起服务时把 `AGENT_PANEL_TRAY` 和 `AGENT_PANEL_SUPERVISED` 置空；接口都在 `/api` 下（`/api/health`），不是根路径。
- 起因：验证「强制停止」时自己起服务，连试了几次都报「服务没有启动」，实际是服务启动后立即退出了。
- 防线：人工。
