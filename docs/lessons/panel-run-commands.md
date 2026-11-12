---
paths: server/step-run.ts, server/bg/sanity.ts, server/merge-build.ts, server/tasks/merge.ts, server/tasks/test-runs.ts, shared/hook-defs.ts
---

# 面板替 Agent 跑的命令

## 面板替 Agent 跑的命令只经过一层 shell，退出码 0 不等于跑了

- 规则：面板自己起的命令（测试步骤、编译）按步骤标的环境直接起那个进程（`server/step-run.ts`），不要先拼成 `cmd.exe /d /c "\"…\""` 字符串再交给设置里的 shell，两层转义规则对不上。后台命令置「成功」前过 `notRunReason`（`server/bg/sanity.ts`）：cmd 只打印横幅、UE 编译几秒就完没有 UBT 日志的按失败算。拆段时成对的引号不去（`shared/hook-defs.ts` 的 `unquote`），带空格路径的程序名才认得出。拦截一条路时，指过去的那条路要先确认真的走得通。
- 起因：用户 2026-11-12 报 Agent 前台硬跑 UE 编译：request_build 在 Git Bash 下假成功、在 PowerShell 下秒失败，run_background 又拒收 Build.bat，前台守卫漏认 `& "D:\Program Files\…\Build.bat"`。见 `docs/modules/server/bugs/ue-build-fake-success-foreground.md`。
- 防线：`server/step-run.test.ts`、`server/bg/sanity.test.ts`、`shared/command-scope.test.ts`「PowerShell 的 & "带空格的路径"」。
