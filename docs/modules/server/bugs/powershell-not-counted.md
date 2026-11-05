# Windows 上 PowerShell 跑命令不算动手，收尾自检问过后放它停在半路

- 状态：已修复（`server/tasks/before-end.test.ts`、`server/exec/parsers.test.ts`、`shared/hook-defs.test.ts` 通过）
- 症状：没列计划的对话被问过「做完了吗」后，接着用 PowerShell 跑了 3 条命令，说「我再确认下 atBottom 的判定」就结束了这一轮，面板没再问
- 入口：`server/tasks/before-end.ts` 的 `workSince`；`server/exec/parsers.ts` 的 `claudeTool`
- 根因类型：同一份「工具名 → 类别」对照写了几处（CLI 定义的 `toolNames`、解析层写死的 `case 'Bash'`、审批卡写死的名单），新工具只进了其中一处都没进
- 模块：`server`（`server/tasks/before-end.ts`、`server/exec/parsers.ts`、`server/exec/rpc/claude.ts`）
- 关键词：收尾自检、结束前钩子、PowerShell、Windows、other、toolNames、check-resumed、small、守卫、cmd /c、wsl

## 现象

用户导出的对话「截图选区应指向记忆页面」（2026-11-05，版本 0.28.2630，已含 check-resumed 修复）：16:43:36 第二次收尾自检后，模型用 PowerShell 跑了 3 条命令扫截图像素（它要用 .NET 的 System.Drawing），16:43:53 回复「我再确认下 atBottom 的判定和它的使用位置」后没调工具就结束，16:44:06 这一轮收掉。

## 根因（证据链）

1. 钩子按 `small` 放行 ← `workSince` 问过以后只数 run / edit / read / search，3 条命令的 kind 是 `other`，算成 0 次，`check-resumed`（`w.checked && w.tools > 0`）没触发。
2. kind 是 `other` ← `server/exec/parsers.ts` 的 `claudeTool` 写死 `case 'Bash'`，Claude Code 在 Windows 上的 `PowerShell` 工具落到 `otherTool`。
3. 同一个名单还有两处：`shared/clis/claude.json` 的 `hooks.toolNames.shell` 只有 `Bash`（钩子 matcher 不含 PowerShell，拦推送、只读角色这些 shell 守卫管不到）；`server/exec/rpc/claude.ts` 的审批卡也只认 `Bash`。加名单的单测顺带查出 `LS`（定义里登记在 read）在解析层也落到 other。
4. 面板设置里的「命令行环境」只管面板自己跑的命令（后台命令、合并编译），管不到 CLI 自带工具：用哪个由模型选，所以不能假设命令一定走 Bash（用户 2026-11-05 定：默认认它，不禁用）。

## 修复

- 工具名到类别只认 CLI 定义的 `hooks.toolNames`（`shared/hooks.ts` 的 `toolKindOf`）：解析层、审批卡、钩子共用；`PowerShell` 加进 shell，解析层补上 `LS`。
- 「动手」只有一个判断（`shared/end-turn.ts` 的 `isActTool`）：只读（读文件、搜索、看网页）和面板自己的工具以外都算，收尾自检和一轮结束后的补问（`turn-info.ts`）共用，清单外的新工具不会再被当成什么都没做。
- 命令前缀匹配前剥掉外壳（`shared/shell-command.ts` 的 `unwrapShell`，和 Codex 显示命令共用一份）：`cmd /c`、`wsl -e`、`powershell -Command`、`bash -c`、`&`。
- 防线：`server/exec/parsers.test.ts`「CLI 定义里登记了类别的工具名都按类别解析」、`server/tasks/before-end.test.ts`「问过以后跑的是没登记类别的命令工具也算接着做」、`shared/hook-defs.test.ts`「命令按段比之前剥掉外壳」。
