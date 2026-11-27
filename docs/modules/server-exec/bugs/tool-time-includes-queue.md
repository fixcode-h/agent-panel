# 读取一个小文件显示耗时 5 秒：工具行把排队时间算进了耗时

- 状态：已修复（Claude Code 2.1.332 + 假模型接口实测：排在 5 秒命令后面的读取从 5271ms 变成 45ms）
- 症状：对话里「读取」一个 Lua 文件的工具行显示 5.5s，文件很小，读本身不该这么慢
- 入口：`server/exec/runner.ts` 的 `endTool` / `toolStart`（工具行计时），`server/exec/tool-rows.ts` 的 `started`，`server/hooks/dispatch.ts` 的 `timedHook`
- 根因类型：计时口径错（从报出调用算起，不是从工具开始跑算起）
- 模块：`server-exec`，配套 `server/hooks/dispatch.ts`、`shared/hooks/index.ts`（`toolFields.id`）
- 关键词：耗时、读取慢、Read、排队、并行调用、tool_use_id、PreToolUse、工具行计时

## 根因

工具行的耗时是「面板收到 CLI 报出这个调用」到「收到它的结果」之间的时间。模型在一条回复里连发几个调用时，Claude Code 会排队执行：
能并行的（读文件、只读命令）一起跑，不能并行的（改东西的命令、大部分 MCP 工具）前一个跑完才轮到后面的。
读文件排在一个 5 秒的命令后面时，它的调用一报出来就开始计时，等前面那个命令跑完才真正读，显示的就是 5 秒多；
工具网关的调用记录（设置 → Agent 工具）里同一次读取的 `durMs` 只有几十毫秒。

## 修法

Claude Code 的工具前钩子（PreToolUse）在工具真正开始跑时才触发，输入里带 `tool_use_id`，和输出流里的调用 id 是同一个。
CLI 定义的 `hooks.toolFields.id` 写出这个字段，钩子到了就把这一行的计时起点挪到那一刻（`tool-rows.ts` 的 `started`）。
定义里没写调用 id 的 CLI、这个工具没装钩子时照旧从报出调用时算。
