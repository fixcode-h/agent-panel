# CLI 被外部杀掉后，失败原因被写成 stderr 里的常驻提示

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:affected` 通过）
- 症状：`kill -9` 子对话的 Claude Code 后，面板报「Claude Code 没有完成这一轮就退出了，stderr 最后几行：`[claude-code:unrecognized_model] …`」，父对话据此说子对话「因模型识别问题中途退出」
- 入口：`server/exec/invoke.ts` 的常驻协议收尾；`server/exec/runner.ts` 的失败分支
- 根因类型：失败原因只取 stderr 尾巴，没写退出信号；CLI 每次都打的无害提示被当成原因
- 模块：`server-exec`（`server/exec/process.ts`、`server/exec/invoke.ts`、`server/exec/runner.ts`），配套 `shared/cli-spec.ts`、`shared/clis/claude.json`
- 关键词：SIGKILL、kill -9、退出信号、exitSignal、unrecognized_model、stderrNoise、没有完成这一轮就退出了、模型识别问题

## 现象

真实 API 实测（第三方模型 deepseek）里手动 `kill -9` 一个子对话的 Claude Code 进程，子对话失败卡只写了 stderr 最后几行，
而那一行是 Claude Code 对不在自己模型表里的模型名的提示，每次启动都有。父对话读到后把原因转述成「模型识别问题」。

## 根因

- `runProcess` 只把退出码交回，被信号结束时退出码是 `null`，信号丢了；失败卡和 runner 的「执行失败（退出码…）」都看不出进程是被杀的。
- 失败原因直接取 stderr 最后几行，不区分 CLI 的常驻提示和真的报错。

## 修复

- `ProcessResult` 带上 `exitSignal`；`exitReason` 把「进程被外部结束，信号 SIGKILL」/「退出码 N」写在失败原因最前面（`earlyExitError`、runner 的失败标题）。
- CLI 定义新增 `stderrNoise`（`[{ pattern, why }]`，按行匹配的正则），`stderrTail` 取尾巴时去掉这些行；Claude Code 登记了 `[claude-code:unrecognized_model]`。只剩提示行时不附 stderr 尾巴。
- 错误照常写进对话（`cli_exit` 警告行），只是原因写对了；完整 stderr 仍在日志里。

## 防线

`server/exec/process.test.ts` 的「进程被信号结束：结果里带上信号，失败原因先写它」「stderr 尾巴去掉 CLI 定义里登记的无害提示行，真的报错照样保留」。
