# Windows 上 Claude Code 执行失败：The command line is too long

- 状态：已修复（`server/exec/system-prompt.test.ts` 通过）
- 症状：Agent 执行失败「Claude Code 执行失败（退出码 1）」，stderr 是 `The command line is too long.`
- 入口：`shared/clis.ts` 的 Claude Code 定义（`buildArgs`）；`server/exec/invoke.ts` 写角色说明文件
- 根因类型：长文本放进命令行参数，超过 Windows cmd.exe 8191 字的上限
- 模块：`server-exec`（`server/exec/invoke.ts`）、`shared`（`shared/clis.ts`）
- 关键词：command line is too long、命令行太长、append-system-prompt、角色说明、cmd.exe、Windows、退出码 1

## 现象

Windows 上用 Claude Code 跑对话，刚启动就退出码 1，stderr 两行 `The command line is too long.`。

## 根因

1. npm 装的 `claude` 在 Windows 上是 `.cmd` 垫片，启动要经过 cmd.exe，整条命令行最多 8191 字。
2. 角色说明（统筹、工作流节点的规则）经 `--append-system-prompt <文本>` 整段放进参数，长的上万字，超过上限，cmd.exe 直接拒绝。
3. Pi 早就改成写文件传路径（`systemPromptFileFlag`），Claude Code 的定义没跟上。

## 修复

- Claude Code 定义加 `systemPromptFileFlag: '--append-system-prompt-file'`：invoke 把角色说明写进这一轮的临时目录，参数只放路径（`BuildOptions.systemPromptFile` 标明这是路径）。
- 写文件失败时照旧用 `--append-system-prompt` 放文本，这一轮不至于直接跑不起来。

## 防线

- `server/exec/system-prompt.test.ts`「系统提示词通道按 CLI 声明走」里断言 Claude Code 走 `--append-system-prompt-file`，没写成文件时退回 `--append-system-prompt`。
