---
paths: server/claims.ts, server/claims.test.ts, server/tasks/merge.ts, server/tasks/children.ts, server/tasks/stuck-child.ts
---

# 共用目录的文件认领

## 改了「什么时候算交出去」，挂在旧时间点上的状态要一起挪

- 规则：子对话完成流程的时间点变了（例如「一轮结束」不再等于「交出去」），先 grep 挂在旧时间点上的状态（认领、提醒、去重标记）一起改。共用目录的认领留到 `completeChild` 才放：一轮结束、停下、卡住重启都不放，`submit_merge` 收缩到改过的文件，换人接手转给接手的，删除 / 归档放掉，重启按 `changes` 补回（`server/claims.ts` 的 `holdTurn` / `rebuildClaims`）。碰撞按认领表判（停下等验收的兄弟也算），不按「正在跑」筛，撞了写信给父对话。
- 起因：ADR 0035 把共用目录改成「submit_merge → 父对话验收」后认领还在一轮结束时释放，父对话没验收，兄弟就能认领同一个文件接着改；碰撞提示只写 system 消息，CLI 看不到。
- 防线：`server/claims.test.ts`、`server/tasks/merge.test.ts` 共用目录用例、e2e `04-subagents`「共用目录的认领留到子对话完成」。
