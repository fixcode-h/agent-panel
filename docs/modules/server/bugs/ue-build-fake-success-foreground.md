# UE 编译走 request_build 假成功、后台被拒，Agent 改在前台硬跑

- 状态：已修复（`server/step-run.test.ts`、`server/bg/sanity.test.ts`、`shared/command-scope.test.ts`「PowerShell 的 & "带空格的路径"」通过）
- 症状：UE 项目里 request_build 报「编译成功，310ms」其实没编，或 200 多毫秒就报 `'\' is not recognized`；Agent 交 run_background 跑 Build.bat 被拒，转到 PowerShell 前台跑编译，整份日志进上下文，10 分钟超时被杀
- 入口：`shared/test-steps.ts` 的 `stepCommand`、`server/merge-build.ts` 的 `runShell`、`server/tasks/run.ts` 的 `runBackground`、`shared/hook-defs.ts` 的 `commandSegments`
- 根因类型：命令套两层 shell 转义对不上；退出码 0 就当成功；拆段丢了带空格路径的开头引号
- 模块：`server`（`server/step-run.ts`、`server/bg/sanity.ts`、`server/background.ts`）、`shared`（`shared/hook-defs.ts`）
- 关键词：request_build、UE 编译、Build.bat、假成功、cmd 横幅、MSYS、Git Bash、PowerShell、run_background 被拒、前台编译

## 现象

用户 2026-11-12 报（任务「编译测试并修复编译报错」，0.29.15）：Agent 用后台命令跑 UE Build.bat 被面板拒绝（128ms），于是改成前台 PowerShell 跑编译，问「为啥不允许后台命令」。

## 根因

1. `stepCommand` 把 cmd 步骤包成 `cmd.exe /d /c "\"…Build.bat\" …"`，`runShell` 再把这一整行交给设置里选的 shell。Git Bash 里 MSYS 把 `/d` `/c` 改写成路径，cmd 没拿到命令，打印版本横幅后以 0 退出，面板报成功；换成 PowerShell 后 `\"` 不是转义，cmd 报 `'\' is not recognized`。
2. 面板只看退出码，cmd 空跑也报「成功」。
3. UE 项目里 `run_background` 收到 Build.bat 一律拒收，指向的正是坏掉的 request_build。
4. 前台长命令守卫本该拦 Build.bat：`commandSegments` 的 `unquote` 把 `"D:\Program Files\…\Build.bat" …` 开头的引号去掉，程序名成了 `program`，`heavySegment` 放行。

## 修复

- 面板跑的测试步骤按步骤标的环境直接起进程（`server/step-run.ts`），只经过一层 shell。
- 退出码 0 但只有 cmd 横幅、或 UE 编译几秒就完且没有 UnrealBuildTool 日志的，按失败推回（`server/bg/sanity.ts`）。
- 拆段时成对的引号不再去掉（`shared/hook-defs.ts`），前台 Build.bat 会被拦下。
- 后台命令重新设计（ADR 0006 补充 2026-11-12）：run_background 收编 UE 编译，转进编译队列或变成向父对话的申请。
