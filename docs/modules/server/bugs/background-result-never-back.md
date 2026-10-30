# 后台命令没启动或结果赶上一轮刚结束：对话收不到结果，一直卡着

- 状态：已修复（`server/background.test.ts`「命令没能启动……」通过）
- 症状：对话交出一条后台命令后一直在等，计划那一步一直「等待中」，后台命令一行一直转圈或者结果始终没回来
- 入口：`server/background.ts` 的 `run`；`server/exec/runner.ts` 的 `flushHeld`；`server/tasks.ts` 后台命令结束回调的重试
- 根因类型：异步任务发出去不收错；排队消息只在整次执行结束时处理，保活进程不结束
- 模块：`server`（`server/background.ts`、`server/exec/runner.ts`、`server/tasks.ts`）
- 关键词：后台命令、run_background、没启动、结果没回来、卡住、等待中、held、保活、重复结果

## 现象

用户报：后台命令出错导致后台命令没启动，对话接收不到后台命令的结果，就卡在那里。

## 根因

1. `background.ts` 用 `void run(j)` 启动命令。跑命令之前（读 shell 设置、选 shell、拼命令行）一旦抛错，`exec` 里 `j.state` 已经是 `running`，却既不收口也不推回结果。
2. 结果推回时如果刚好碰上这一轮刚结束、CLI 还没停到等下一句上，`deliver` 把消息排进「这一轮结束后处理」（held）。排着的消息只在整次执行结束时处理，可保活的进程不会结束，于是一直排着。
3. 第一次推回失败时 `wakeConv` 已经把消息记进对话，重试和兜底又各记一遍，对话里出现两三条一样的结果。

## 修复

- `run` 收住抛错：置 `failed`，输出里写「面板没能启动这条命令：原因」，照常推回对话。
- CLI 停到等下一句上时（runner 的 `listen`），排着的消息马上交给它（已记在对话里的只交给 CLI，不再记一遍）。
- 重试前撤掉第一次已记进对话的那条，兜底同样。

## 防线

- `server/background.test.ts`：「命令没能启动（跑命令之前就抛错）……」。
