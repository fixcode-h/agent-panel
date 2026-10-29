# 子任务卡死没有输出，点终止却说已经结束了

- 状态：已修复（`server/engine-steps.test.ts`「终止或抛异常的子任务只收它自己」、`server/helper-orphan-stop.test.ts` 通过；用户现场的异常来源没拿到日志，未在真 Pi 上复现）
- 症状：子任务一直转圈、窗口里写「已开始，还没有输出」；点终止提示「这个子任务已经结束了」，状态却不变
- 入口：`shared/engine.ts` 的 `runHelper`；`server/tasks.ts` 的 `POST /:id/subtasks/stop`、一轮执行的 `catch` 收尾
- 根因类型：异常从子任务里冒出去，界面状态和面板里的运行状态对不上
- 模块：`server`（`server/tasks.ts`），配套 `shared/engine.ts`
- 关键词：子任务、卡死、没有输出、已开始还没有输出、终止、已经结束了、409、runHelper、helperStops、异常、settleOrphanHelper

## 现象

对话派出的子任务停在执行中，没有任何输出，也不会因为长时间没输出被自动停下；点终止只弹「这个子任务已经结束了」。

## 根因

1. `runHelper` 只用 `try/finally`：`host.runAgent`（启动 CLI 前读模型目录、写配置、拉进程）一旦抛异常，`finally` 把终止开关从 `helperStops` 删掉，子任务的状态却还停在刚标上的 `running`。
2. 异常继续往上冒：等这批子任务的 `wait` / `settleHelpers` 跟着失败，这一轮执行按「执行出错」收尾，只改了对话状态，名下还标着 running 的子任务没人收口。
3. 界面按 `running` 画转圈；终止走 `stopHelper`，找不到开关返回 false，接口回 409「已经结束了」。CLI 根本没起来，所以也没有输出、没有「没有输出」的超时提醒。

单测里让子任务的 `runAgent` 抛一个错就能复现：子任务停在 `running`，`stopHelper` 返回 false，整轮抛错。

## 修复

- `runHelper` 接住异常：子任务记成失败，原因（「子任务没能执行：…」）写进子任务、交回给派它的对话；整轮照常继续。
- 一轮执行抛错收尾时，把还标着 running 的节点、子任务一起落成失败。
- 终止接口遇到「标着执行中 / 没开始、面板里却没有在跑」的子任务（异常、面板重启、派它的那一轮已经收尾），直接落成已终止并保存，不再回 409。已经有结论的照旧回「已经结束了」。

## 防线

- `server/engine-steps.test.ts`：「终止或抛异常的子任务只收它自己」（抛异常的按失败交回、报错显示在子任务里）。
- `server/helper-orphan-stop.test.ts`：没在跑的执行中 / 正在启动的子任务终止后落成已终止；做完的仍回 409。

## 待确认

- 用户现场抛的是哪个异常没拿到日志（数据目录 `logs/` 里「任务执行出错」或「未处理的 Promise 拒绝」那一条）。修复后同样的情况会在子任务里显示「子任务没能执行：<原因>」，再遇到时按这条原因查。
