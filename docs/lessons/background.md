---
paths: server/background.ts, server/background-tools.ts, server/exec/parsers.ts, web/src/lib/tasks.ts, server/orch-mcp.ts, server/hooks/guards.ts, shared/command-scope.ts
---

# 后台命令

## 后台命令交出去不等于做完：没结果就一直转圈

- 规则：后台命令那一行按输出里「还没拿到结果的编号」（`bgPendingIds`，不锚定开头）判断转圈，结果段带编号接在后面（`settleJobRow`）；跑得久、没输出要提醒对话；推送失败重试并留在对话里。命令一律静默跑，不新开窗口。见 ADR 0006。
- 起因：带前缀的工具名被当成「运行命令」0.09 秒完成；Command Code 在结果前插 `<repair_note>`，锚定开头的匹配认不出编号，又显示完成；模型 `start cmd` 弹窗跑测试。
- 防线：`server/background.test.ts`「那一行收口」「监管」；`web/src/lib/tasks.test.ts`。

## 后台命令的名字要能显示出来

- 规则：带 `command` 的输入被解析层存成命令原文（`parsers.ts` 的 `inputText`），标题要用名字或命令第一行兜底（`true` 这类 JSON 字面量也算命令）；名字不能带换行，否则推回结果行显示时会截掉「成功 / 失败」。
- 起因：后台命令折叠行只剩动作名和耗时，用户要求显示命令。
- 防线：`web/src/lib/tasks.test.ts`、`server/orch-mcp.test.ts`、ui-check。

## 异步发出去的事要收住错误，排着的消息要有人送

- 规则：`void someAsync()` 发出去的后台命令、消息投递，抛错时也要把记录置终态并把结果推回；排进「下一轮」的消息在 CLI 停到等下一句时就要送（`runner.ts` 的 `flushHeld`），保活进程不会结束这一轮；重试前撤掉第一次已记进对话的那条。
- 起因：后台命令跑之前抛错，记录一直「运行中」，对话一直等结果（ADR 0032）。
- 防线：`server/background.test.ts`「命令没能启动」。

## 后台命令只收长命令，守卫按「真正在跑的程序」判断

- 规则：按命令判断的守卫和用途检查都走 `shared/command-scope.ts`：先去掉 heredoc / here-string 正文再拆段，每段只看开头的程序名，快命令（读写文件、查找、git 本地操作）的参数里出现 `e2e`、`--watch` 不算。`run_background` 拒收写文件和几秒就完的命令，命令先过和 CLI 命令工具同一套守卫（`commandGuard`）；开发服务器、监听按常驻服务（`service`）跑，不催、不算对话在等它（`awaitedJob`）。新加「让 Agent 改用某个工具」的拦截时，先确认匹配的是在跑的程序，不是命令里的字样。
- 起因：用户 2026-11-05 报「写文件命令怎么也用后台命令了」：长命令守卫把 heredoc 正文、`git commit -m '修复 e2e'`、`grep e2e` 都当成在跑完整测试拦下，让 Agent 改用 `run_background`；后台命令又不过任何守卫，成了绕过推送授权、只读角色的路。
- 防线：`shared/command-scope.test.ts`、`server/hooks/guards.test.ts`「只看真正运行的程序」、`server/orch-mcp.test.ts`「后台命令只收长命令」、`server/background.test.ts`「常驻服务」。

## 全项目的 grep -r 是长命令，不是快命令

- 规则：grep、findstr、find 在快命令清单里，但 `grep -r`、`findstr /s`、`find … | xargs grep`、`gci -Recurse | sls` 从项目根（或更上层）起扫时不读 .gitignore、也不认项目的搜索排除目录（那份清单只经 `RIPGREP_CONFIG_PATH` 交给 rg），长命令守卫按 `shared/wide-search.ts` 的起点判断拦下，让它放后台或改用 rg 限定子目录。往快命令清单加程序时，想一下它扫全项目时还快不快；拆段要认引号（grep 模式常写成 `"a\|b"`）。
- 起因：用户 2026-11-07 报 Agent 前台跑 `grep -rl … "G:/…/Project"` 扫整个 UE 项目 2 分钟，没用后台命令：守卫把 grep 当快命令放过，面板工具说明也只把编译、测试、安装、下载列成长命令。
- 防线：`shared/wide-search.test.ts`、`server/hooks/guards.test.ts`「全项目 grep -r」。

## 推回结果的提示只要求「结束时」总结，不要求「收到就总结」

- 规则：推回给 Agent 的结果、提醒里，要它写总结、汇报的话一律限定在「要结束这一轮时」，并先说「接着做」；不写「处理完这个结果后重新总结」这类会让模型先发一条纯文字回复的要求——没有工具调用的回复会直接结束这一轮（同 `shared/turn-rules.ts` 的说明）。
- 起因：92c4bc0 加的推回结果尾句「处理完这个结果后，重新总结整段工作」；用户 2026-11-06 报结束前钩子反复拦住，13 次里 6 次紧跟在推回结果之后：模型一收到结果先写总结和「接着做 X」，随即停下。
- 防线：`scripts/e2e/09-subagent-runtime.mjs`「后台命令：说完时还在跑的列在任务上」断言新句子。
