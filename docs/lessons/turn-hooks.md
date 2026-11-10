---
paths: server/tasks/run.ts, server/tasks/experience.ts, server/experience-learn.ts
---

# 一轮结束时要做的事挂在哪

## 「每轮结束都要做」的事挂 onTurnEnd，不挂 run 的收尾处

- 规则：对话每一轮结束都该做的事（学经验、核用量、推它接着做计划）挂在 `server/tasks/run.ts` 的 `onTurnEnd` 上；run 的收尾处（`finally` 那一段）只在进程真的退出时才到。保活的 CLI（CLI 定义 `keepAlive: true`，且对话页开着）回复完停在等下一句，run 一直不返回，挂在收尾处的事要等闲置回收才做，等到的往往已经不是「已完成」了。收尾处留一份只是为了接住不保活的 CLI 和工作流，排的动作要能重复调用（去抖、幂等）。
- 起因：53774d0 把经验学习改成「对话完成就学」，排的位置仍在 run 收尾处，保活的对话做完了一直不学（用户 2026-11-05 报）。
- 防线：e2e `03-chat`「保活的对话一轮结束就学经验，不等进程退出」。测保活路径要先报 `/presence`（有页面在看），否则进程不保活、测不出来。
