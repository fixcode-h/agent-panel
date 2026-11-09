# 派出子任务总被拒：resume 少了开头的 @、review 写在顶层

- 状态：已修复
- 症状：主 Agent 调 `spawn_agents` 复看评审时报「resume 写的「chat/sub/h1」不是你派过的子任务」，或报「不认得顶层字段「review」」，要重试一轮才派出去
- 入口：`server/orch-fields.ts` 的 `RESUME_DESC`、`SPAWN_TOP_FIELDS`；`server/orch-mcp.ts` 的 `case 'spawn_agents'`；`shared/engine.ts` 的 `resumeTarget`
- 根因类型：工具说明的示例和真实值不一致；同类字段只开放了一部分写在顶层
- 模块：`server`（`server/orch-mcp.ts`），配套 `shared/engine.ts`
- 关键词：spawn_agents、resume、review、顶层字段、@chat、子任务 id、评审交接单、复看

## 根因

1. 对话里派出的子任务 id 是 `@chat/sub/h1`（`shared/engine.ts` 的 `CHAT_STEP = '@chat'`），但 `resume` 字段的说明举例写成「例如 chat/sub/h1」。模型照着说明写，`resumeTarget` 先全等比、再按 `/<id>` 结尾比，`@chat/sub/h1` 两样都对不上，整批被拒。报错里列出的候选是 `@chat/sub/h1｜标题`，模型下一轮能改对，但白费一轮。
2. `spawn_agents` 顶层允许写 `agent`、`tier`、`resume`、`params` 当整批默认值，`review`（评审交接单）却只在 `tasks[i]` 里。模型派评审时把 `agent: "评审"` 和 `review` 并排写在顶层很自然，顶层字段检查把它拒掉。

两处都是工具设计让模型容易写错，不是模型乱写。

## 修复

- `RESUME_DESC` 的示例改成真实形式（`@chat/sub/h1`、`n1/sub/h2`），并说明照返回的原样写。
- `resumeTarget` 比较前两边都去掉开头的 `@`：`chat/sub/h1` 也能对上 `@chat/sub/h1`；能对上多条时仍然不猜。
- `review` 加进顶层字段和 schema，作为整批默认的交接单，任务里自己写了以任务里的为准。
- 单测：`server/orch-mcp.test.ts` 里顶层 review 派第一次评审、不带 `@` 的 resume 复看都能接上原来的评审会话。
