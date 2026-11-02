# 计划没做完，面板推了一次就再也不推，对话停在等下一句

- 状态：已修复（`shared/drive.test.ts`、e2e `09-subagent-runtime` 通过）
- 症状：项目里的对话（Claude Code + `deepseek-v4.1-flash`）计划才做一部分，面板只推过一次「接着做」，之后几轮结束都没再推，停在等下一句；诊断文件里看不出为什么没推
- 入口：`server/tasks/drive.ts` 的 `nudgePlan`（原在 `server/tasks/children.ts`），`shared/drive.ts` 的 `DriveBudget`
- 根因类型：计数时机错误（刚结束就记次数，复查没通过也算一次）+ 进度键太粗（只看已完成几步）+ 决策不写对话日志
- 模块：`server`（`server/tasks/drive.ts`）、`shared`（`shared/drive.ts`）
- 关键词：推进、nudge、计划没做完、停住、等下一句、后台结果、推满、诊断、task.send、继续

## 根因

一轮刚结束就 `takeNudge` 记一次，2 秒后复查：这时连着交进来的后台命令结果让 CLI 又在跑，复查不通过就静默返回，次数白白用掉。key 是「计划 id:已完成几步」，几轮下来同一个 key 推满 3 次，之后同一进度永远不推；只写全局日志，诊断文件里没有。中间两条「继续」是另一个对话用 `task.send`「以用户的身份」发的，日志里没有来源。

## 修复（ADR 0041）

- 只在真推出去时记次数；进度按步骤 id + 状态算；同一条输入总共最多 10 次；用户发消息清零；计划变了重新判断一次。
- 每个判断写对话日志「计划推进」，诊断带计划进度和推进次数。
- `task.send` 带发件对话，记成「同项目对话发来」。

## 防线

- `shared/drive.test.ts`「推进账本」；`shared/lifecycle.test.ts`「计划没做完却停下」。
