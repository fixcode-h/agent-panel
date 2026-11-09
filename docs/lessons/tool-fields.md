---
paths: server/orch-fields.ts, server/orch-mcp.ts
---

# 面板工具的字段说明和参数解析

## 工具说明里的示例照真实值写，能当整批默认值的字段都认顶层

- 规则：工具字段描述里举的 id、路径示例要和工具实际返回的一字不差（对话里子任务的 id 是 `@chat/sub/h1`，不是 `chat/sub/h1`）；按 id 找东西时顺带容忍模型常见的改写（丢掉开头的 `@`、只写结尾几段）。一个字段如果在某一层能写在顶层当整批默认值，同类的字段（`agent`、`tier`、`params`、`review`）也都认顶层，不要只开一部分让模型照猫画虎被拒。
- 起因：用户 2026-11-09 报「派出子任务总是出错」：`resume` 的说明举例写成 `chat/sub/h1`（6861f62 起），模型照抄被拒；`review` 只认 `tasks[i]` 里，模型照顶层 `agent` 的写法写在顶层被拒，各白费一轮。
- 防线：`server/orch-mcp.test.ts`「resume：不写 agent 沿用原任务的角色…」（顶层 review、不带 @ 的 resume）和「顶层 agent / tier 也当默认值」那段。
