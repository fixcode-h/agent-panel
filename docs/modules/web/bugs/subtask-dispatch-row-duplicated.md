# 重试同一个子任务后，对话里出现两行「派子任务」

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:affected` 通过）
- 症状：同一个「派子任务：xxx」出现两行，都显示执行中，一行带分诊说明、一行没有；强制更新面板后继续对话出现
- 入口：`web/src/lib/fold-dispatch.ts` 的 `dispatchesOf`、`shared/engine/index.ts` 的 spawn_agents 重试分支
- 根因类型：同一对象被派两次，界面按派单记录逐条画行，没有按对象去重
- 模块：`web`（`web/src/lib/fold-dispatch.ts`）
- 关键词：派子任务、两行、重复、重试、resume、在原来的子任务里重试、面板重启、spawned、派单行

## 根因

面板重启会把正在跑的子任务标成被中断。继续对话时协调者用 spawn_agents 的 resume 接着做，引擎「在原来的子任务里重试」：沿用同一个步骤 id，再记一条带 `spawned` 的系统消息。`dispatchesOf` 把两条系统消息各认成一次派单，两行指向同一个步骤，所以都显示「执行中」；分诊说明只对上第一次那行。

## 修复

`dispatchesOf` 收尾时按步骤 id 去重：同一个子任务只由最近派它的那次代表，前面那次去掉这个 id，去空了整行不画（和交回子对话只让最近一次跟着状态走同一个思路）。第一次派单时记的分诊会对到接替它的那次上。

## 防线

`web/src/lib/fold-dispatch.test.ts`：「dispatchesOf：在原来的子任务里重试时，同一个子任务只由最近那次派单代表」。
