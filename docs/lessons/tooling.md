---
paths: shared/engine.ts, shared/panel-tools.ts, server/p4-split.ts, server/ask-mcp.ts, shared/clis/**, server/exec/invoke.ts, docs/lessons/**
---

# 面板工具通道（MCP）和 AI 的用法

## MCP 握手的 capability 值必须是对象

- 规则：`initialize` 返回的 `capabilities.experimental.orchestration` 写 `{ enabled: boolean }`，不要写布尔值。MCP 规范里 `experimental` 是 `Record<string, object>`，Claude Code 2.1.226 起按 zod 校验，写成 `true` 会让整条连接判 `failed`、所有 `mcp__panel__*` 工具一个都不注册；错误只在 CLI 自己的 debug 日志里（`Invalid input`），面板侧看不出来。
- 起因：2026-10-27 用户反馈 Claude Code 执行工具时对话像卡住；查 init 事件是 `mcp_servers: [{name:"panel", status:"failed"}]`，根因是握手字段写成了布尔值。
- 防线：`server/ask-mcp.test.ts` 的握手断言；改握手后用真实 CLI 连一次，看 stream-json init 里的 `mcp_servers` 是否 `connected`。

## 长命令交给后台工具，别在前台挡着对话

- 规则：完整测试、端到端、构建、超过一分钟的检查一律交给面板的后台工具（`run_background`），带上计划步骤；不要用前台命令跑——前台跑着时用户发来的消息只能等它跑完，对话看起来就是卡住。交出去后做不依赖它的实事，没有别的事就结束这一轮等结果推回。
- 起因：2026-10-27 用户指出「长命令用对应的后台工具来执行啊」：用前台 Bash 跑完整单测一两分钟，用户执行中发来的消息全被挡到跑完才处理。
- 防线：提示词已在 `shared/engine.ts` 的「长命令放到后台」一节；人工。

## 输出格式的硬要求在工具里卡住，不只写进提示词

- 规则：P4 changelist 描述的长度由 `p4_split_changelists` 检查（`server/p4-split.ts` 的 `P4_DESC_MAX`，25 字，英文数字算半个），超长一个文件都不动、退回让 Agent 改短；提示词、技能、工具说明写同一个数。
- 起因：提示词里写了「约 40 字内」，Agent 仍把原因、函数名、步骤写进描述，用户要求「Description 短一些，描述清楚就行」。
- 防线：`server/p4-split.test.ts`、`server/core-agents.test.ts`。
