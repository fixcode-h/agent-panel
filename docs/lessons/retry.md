---
paths: shared/engine.ts, server/orch-mcp.ts, server/tasks/**
---

# 报错后的重试

## 报错重试在原来的子对话、子任务里接着做，不另起一个

- 规则：子对话失败、被中断要重试，父对话用 `send_to_conversation` 交回原来那个子对话（同一个会话接着做）；`create_conversation` 的标题去掉「（重试）」这类标记（`retryBase`）后和一个失败、中断的子对话一样会被拒绝。派出的子任务失败、被终止、中断后，`spawn_agents` 的 `resume` 写它的 id 就在原来那条记录里重试（同一个 id、会话，`reruns` 加一），不新建记录；只有做完的子任务再接着做（复看评审）才新开一条借会话。交回的失败结果、`reportChild` 的失败 / 中断上报都带上这句重试提示。
- 起因：166c50e，用户 2026-10-25 指出对话报错后重试新起了一个对话（例如「子对话子任务挪到总结下面（重试）」），子任务也一样。
- 防线：`server/orchestrator.test.ts` 的「协调 Agent：子对话失败后另建「（重试）」会被拒绝」、`server/engine-steps.test.ts` 的「子任务：失败后 resume 写它的 id，就在原来那个子任务里重试」。
