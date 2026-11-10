---
paths: server/exec/**, server/merge-build.ts, server/background.ts, shared/panel-tools.ts, scripts/fake-cli/**
---

# 启动 CLI 进程和解析输出

## CLI 升级先看变更，再重录样本

- 规则：适配新版本前先读它的 changelog，重点看权限、信任、扩展加载方式；输出格式变了就重录 `server/exec/fixtures/` 并跑 `npm run test:unit`。
- 起因：Pi 1.3 引入「项目信任」，RPC 模式下 `.pi/extensions` 静默不加载，面板注入的工具全部失效（1456578）。
- 防线：`npm run test:unit`（只覆盖输出解析）。

## 用户的补充只交给对话自己的调用

- 规则：执行中的补充（插话、`read_user_notes`、等下一句）在对话里只交给对话自己那次调用（step 为空），不交给它派出的子任务；新加「同一任务里还在跑的调用」时检查 `steerTask` 会不会把用户消息送过去。等子任务时也要能收消息（`helperGate`）。
- 起因：49d7d7e 加子任务后，等子任务时用户发的消息被插话给子任务。
- 防线：`server/orchestrator.test.ts`（等子任务时发消息）。

## Windows 上交给 cmd 的命令行：整行用 shellCommand、参数里不放换行

- 规则：一整行命令（后台命令、测试步骤）用 `server/merge-build.ts` 的 `shellCommand` / `runShell` 启动：整行加引号、`windowsVerbatimArguments` 原样交给 `cmd.exe /d /s /c`，否则 Node 会把 `"` 转成 `\"`，cmd 不认。传给 CLI 的参数里不能带 `\n`：多行文本（角色说明）写进这一轮的临时目录、参数里传路径（CliSpec 的 `systemPromptFileFlag`，Pi 的 `--append-system-prompt` 会读文件内容）。
- 起因：15c1a1d 的后台命令 `node -e "setTimeout(...)"` 参数多了引号、0 秒就报成功；Pi 桥接扩展改成 `-e <文件>`（1456578）后角色说明仍是多行参数，Windows 上 cmd 从第一个换行截断命令行、后面的 `-e` 整段丢失，Pi 只剩 7 个内建工具（没有 `begin_edit`、`create_conversation`、`ask_user`、`set_plan`），Agent 直接改父目录也不开子对话。npm 全局装的 CLI 是 `.cmd` 垫片，cross-spawn 必经 cmd.exe。
- 防线：`server/merge-build.test.ts`、`server/exec/process.test.ts`（真的 `.cmd` 垫片跑一遍）、`server/exec/system-prompt.test.ts`；`runProcess` 在 Windows 上把换行压成空格兜底。

## 按工具名猜类型之前，先认出面板自己的工具

- 规则：`genericTool` 这类按名字正则猜 kind 的解析，先查 `shared/panel-tools.ts` 的面板工具表再猜；新加面板工具时同时登记进这张表，别让面板工具被当成 CLI 自己的读文件、子 Agent。
- 起因：Pi 的桥接扩展（b0a47d2）按裸名字注册面板工具，`wait_agents` 因为名字里有 agent 被当成 CLI 自己的子 Agent，对话里显示成没头没尾的「子任务」。
- 防线：`server/exec/parsers.test.ts`（Pi 面板工具是裸名字）。

## 拷贝 git 暂存区做快照要带上原文件的修改时间

- 规则：用 `GIT_INDEX_FILE` 指向一份拷贝来的暂存区时，拷完把原文件的 atime / mtime 设回去（`server/exec/git.ts` 的 `gitSnapshot`）。git 靠「条目时间不早于暂存区文件时间」认出同一秒里改过的文件再比内容，拷贝的时间是现在，同一秒里改了、大小没变的文件会被当成没改。
- 起因：每轮改动卡片（49e3eb0）的快照在 CI 上偶发拿不到这一轮的改动，`turn-changes.test.ts` 时好时坏。
- 防线：`server/turn-changes.test.ts` 的「快照：和暂存区同一秒里改过、大小没变的文件也算改动」。

## 工具调用带的文件改动等结果成功才记，面板临时目录里的不算

- 规则：CLI 在「调用」事件上报的文件改动（Write、Edit 的 `ev.file`）不能当场记进 `task.changes`：被钩子拦下、执行失败的写入没落盘。走 `server/exec/file-events.ts`，有结果要等的挂着、结果成功再记；面板数据目录和系统临时目录里（又不在项目里）的文件不记。按改动清单做门禁的地方（`submit_merge` 的 Bug 核对）同样先用 `projectChanges` 过滤。
- 起因：2026-11-05 Bug 子对话写面板临时目录的 `build_editor.bat` 被守卫拦下，仍被记成改动，收尾核对说它「不在方案里」反复拒绝，用户只好确认一版多余的方案、再验证一遍。
- 防线：`server/exec/file-events.test.ts`、`server/hooks/guards.test.ts`（临时目录不按方案拦）。

## 工具名属于哪一类只认 CLI 定义里的一份

- 规则：哪个工具名是跑命令、改文件、读文件，只从 CLI 定义的 `hooks.toolNames` 取（`shared/hooks.ts` 的 `toolKindOf`），解析层、审批卡、钩子都不另写名单；判断「问过以后有没有接着做」用 `shared/end-turn.ts` 的 `isCliTool`（面板工具以外都算），不按类别清单数；「做了多少」用 `isActTool`（跑命令、改文件，更新待办不算）。CLI 新出的工具只改定义一处。
- 起因：Windows 上 Claude Code 的 `PowerShell` 工具在解析层和钩子名单里都没登记，解析成 other，收尾自检数不到动作放它停在半路，shell 守卫也管不到（见 `docs/modules/server/bugs/powershell-not-counted.md`）。
- 防线：`server/exec/parsers.test.ts`「CLI 定义里登记了类别的工具名都按类别解析」。
