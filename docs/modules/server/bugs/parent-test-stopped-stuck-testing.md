# 父对话测试命令被停掉后，子对话永远卡在「待收尾 · 已合回，等父对话跑测试」

- 状态：已修复（`server/parent-tests.test.ts`「父对话测试命令被停止：把结论交回子对话……」、`server/background.test.ts`「父对话测试命令被停止也要把结果交回去……」通过）
- 症状：子对话合并后一直停在「待收尾 · 已合回，等父对话跑测试」；任务里 `wrapRequest.state` 是 `testing`、`testRuns` 是空的，排在后面的步骤不起来；再让它 `finish_child`，面板回「正在你的目录里跑它的测试步骤」，但实际没有任何命令在跑，只能重启面板
- 入口：`server/background.ts` 的 `settle` / `stopOne` / `stop`；`server/tasks/jobs.ts` 的后台命令结束回调；`server/parent-tests.ts` 的 `finishJob`；`server/tasks/test-runs.ts` 的 `startParentTests`
- 根因类型：主动停掉的命令不进结果回调，等在它后面的状态机没人推进
- 模块：`server`（`server/background.ts`、`server/tasks/jobs.ts`、`server/parent-tests.ts`、`server/tasks/test-runs.ts`）
- 关键词：父对话测试、stop_background、被停止、stopped、testing、等父对话跑测试、卡住、onDone、finishJob、notifyOnStop

## 现象

用户报：子对话合回后一直「等父对话跑测试」，不会自己完成。触发条件是父对话用 `stop_background` 停掉一条正在跑的父对话测试命令（那次是「父对话测试：行内代码与文字垂直居中 · 单元测试」跑了 12 分钟卡住被停）。

停命令是面板给父对话的正当能力（提示词里就要求停卡住的命令），停完却没有任何复位路径，进程活着的时候 `recoverParentTests` 也不会再跑，只能重启面板。

## 根因

1. 后台命令结束时只有 `onDone` 会把结果交给调用方，而 `exec` 里被停止的命令故意不调 `onDone`（用户主动停的普通命令不该把结果推回对话，把刚停下的对话又拉起一轮）。`stopOne` 的排队分支、`armKillGrace` 到点置终态同样只置记录、不回调。
2. 父对话测试队列唯一的推进入口就是 `onDone` 里的 `sc.parentTests.finishJob`（`server/tasks/jobs.ts`）。这条回调一断，批次既不算通过（`deps.pass`）也不算失败（`deps.fail`）：`wrapRequest.state` 留在 `testing`，`testRuns` 不记，后面的步骤不起来。
3. `parentTesting` 按任务上的 `testing` 判断，合并门禁据此拦住不收尾；`recoverParentTests` 只在面板启动时把 `testing` 的重新排队，进程活着时没有别的复位路径 → 死锁。

## 修复

- `server/background.ts` 加 `BgJob.notifyOnStop`（`start` 的同名参数）：带它的命令被停止时也把结果交回发起方。新增 `settle(j, state, info)` 收口所有置终态的地方（进程结束、停止兑底、排队中被停、`stop(taskId)`、启动失败），`stopped` 且不带标记的命令照旧不推回。
- `server/tasks/test-runs.ts` 起父对话测试命令时带 `notifyOnStop: true`：这类命令是面板代子对话跑的，必须有个结论。
- 只有「用户 / 对话明确停这一条」（`stopOne`，记到 `BgJob.stopRequested`）才回传：面板退出（`stopAll`）时不回调，重启后 `recoverParentTests` 把还在 `testing` 的批次重排；用户停止 / 归档 / 删除父对话（`endBackground`）不是退出，`parentTests.abortByParent` 把**正在跑的**和**队里排着**的批次一起按未通过退回子对话（分支保留、可以重新 `submit_merge`），两种都不会留下永久卡住的 `testing`。
- `server/tasks/jobs.ts` 回传 `stopped: job.state === 'stopped'`；`server/parent-tests.ts` 的 `finishJob` 把它带进 `ParentTestFail`，失败文案写明「这条命令被停止了（不是自己跑完的），结论按未通过处理」，让子对话知道不是测试真的跑过。
- 结果：命令被停 → `deps.fail` → `wrapRequest.state = 'test-failed'`、计划收尾步骤退回进行中、独立分支保留，子对话可以按说明修好重跑并再次 `submit_merge`；合并时这些步骤全部重跑。

## 防线

- `server/background.test.ts`：「父对话测试命令被停止也要把结果交回去；普通命令照旧不推回」——带标记的（跑着的、还在独占队里排着的）被 `stop_background` 停后回调一次且状态是 `stopped`；不带标记的停止后不回调；带标记的但走生命周期停（`stop(taskId)`）也不回调。
- `server/parent-tests.test.ts`：
  - 「父对话测试命令被停止：把结论交回子对话，不会永远停在「等父对话测试」」：按 `jobs.ts` 的接线把后台队列和队列接起来，断言 `fail` 收到第 1 步、`stopped` 标记、没有 `pass`、队列不再占着这个子对话、后面的步骤没跟着跑。
  - 「父对话被停止 / 归档：正在跑的那批按未通过退回子对话，不留到重启」：断言退回的那步带 `stopped`、队列不再占着它、不继续起下一步、别的父对话不受影响。
  - 「父对话被停止时队里排着的批次一起退回」：断言跑着的和排着的都退回、只起过第一批命令（`finish` 结尾的 `advance` 不会把下一批起起来）。
