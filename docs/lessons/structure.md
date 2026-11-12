---
paths: server/**, shared/**, web/src/**, scripts/structure-check.mjs, scripts/structure-caps.json
---

# 代码结构：新代码不许再往乱处堆

2026-11-12 梳理结构时发现的问题（千行闭包、113 个字段的 Task、七份 git 包装、界面自己拼状态……）都是一次加一点攒出来的。下面这些在 6a2801a 记了基线，只许变好。

## 能量化的都由结构检查拦，按报错提示放到对的地方

- 规则：`npm run lint` 跑 `scripts/structure-check.mjs`（rules-check 第 21 条），现状记在 `scripts/structure-caps.json`，只许变好：函数超过 300 行（已有的超长函数不许再变长）；往 `server/`、`shared/`、`web/src/lib/` 顶层加新文件；`TaskData` 顶层加字段；新加 `z.preprocess`；在 `server/orch-mcp.ts` 里直接写工具定义；`Orchestra` / `EngineHost` 或 `shared/host/` 里的小接口（`ConversationHost`、`OrchPlan` 这些）加成员；`server/exec/git.ts` 以外直接调 git；模块顶层加 let / new Map；组件里直接读对话的 `status`、`working`、`cliAlive` 这类字段；新加 `setInterval`。报错会说该放哪。
- 规则：变好了（拆了函数、挪走了文件）跑 `node scripts/structure-check.mjs --update` 收紧基线，和改动一起提交。不许为了过检查手改基线放宽；确实要放宽时提交说明写清楚原因，并在回复里告诉用户。
- 规则：不许用改名、换写法来绕开检查（比如把 `task.cliAlive` 改成 `const { cliAlive } = task`、把函数拆成两个仍然共享同一批外层变量的闭包）。检查只是量出来的数字，它背后的规则才是要遵守的。
- 防线：`scripts/rules-check.mjs` 第 21 条。

## 拆大函数按阶段拆，共享状态显式传

- 规则：碰到超长函数（尤其是 `runAgent`、`createRun`、`makeOrchestra` 这种闭包）时，新逻辑写成独立函数放进新文件，入参写清楚需要什么，不要读写外层闭包的变量。要动闭包本身时，先在模块文档里列出共享变量（谁读、谁写），收进一个显式的上下文对象再拆。拆的提交里不夹功能改动。
- 防线：结构检查（函数长度）；人工。

## Task 只放存盘的数据，运行时状态和列表摘要不往上加

- 规则：只在运行时算出来、不存盘的状态（CLI 活着没有、名下在跑的子对话数、后台命令……）不要再加成 Task 的字段；某个功能专属的数据放进这个功能自己的子对象（比如 `task.bug.*`），不在顶层平铺。界面上的对话状态只从 `convState` 派生，缺什么显示就在 `shared/task.ts` 或 `web/src/lib/` 的工具函数里加，不在组件里自己拼。
- 防线：结构检查（`TaskData` 字段数、组件读运行时字段）。

## 改数据格式写一次性迁移，不挂读时迁移

- 规则：改存盘格式时写成一次性迁移：迁完写回磁盘，迁之前先备份；不要在 zod schema 上挂 `z.preprocess`，那样每次读都要再迁一遍，旧格式永远删不掉。旧格式的兼容代码要写清楚哪个版本以后可以删。
- 防线：结构检查（`z.preprocess` 数）；人工。

## 一类事只有一个出口

- 规则：同一类操作只用一个公共入口，缺功能就补进那个入口，不在调用的地方另写一份包装：git 走 `server/exec/git.ts`；起子进程走 `server/exec/process.ts`；面板 MCP 工具一个工具一个文件（定义、给不给的条件、用法说明、处理函数放在一起，参照 `server/end-turn-tool.ts`），`server/orch-mcp.ts` 只负责接线；提示只用 `web/src/lib/toast.ts`。新加一类公共操作时先找有没有现成的入口。
- 防线：结构检查（git、内联工具）；rules-check 第 12 条（toast）。

## 前后端接口有契约，演示后端不另写一套业务逻辑

- 规则：新加或修改接口时，在 `shared/api-contract/<模块>.ts` 里写一条 `endpoint`（请求和响应的 zod 契约，写法见 `define.ts`，ADR 0062）。服务端路由用契约里的 `body` 校验入参；前端用 `web/src/lib/api/call.ts` 的 `call(ep, …)` 调，不再新写 `request<T>`；把它加进 `shared/api-contract/probe.ts`，正式后端（`scripts/e2e/17-contracts.mjs`）和演示后端（`web/src/lib/demo-contract.test.ts`）都会按它查返回形状。演示后端（`web/src/lib/demo-*.ts`）里的状态判定、计划推进这些逻辑调用 `shared/` 里和服务端同一份函数，不在演示里再写一遍。
- 防线：`demo-contract.test.ts`、`server/task-api-contract.test.ts`、e2e `17-contracts`；人工。

## 前端拿实时数据用推送，不再加轮询

- 规则：界面要跟着服务端变化时，用已有的推送（`web/src/lib/task-stream.ts`、服务端的 `onTaskChange`），没有合适的就扩展推送，不在组件里加 `setInterval` 拉接口。走表用 `web/src/lib/useNow.ts`。确实只能定时的（比如外部进程没有事件），在那一行写 `interval-ok: 原因`。
- 防线：结构检查（`setInterval` 数）。
