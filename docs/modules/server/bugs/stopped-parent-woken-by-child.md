# 停止父对话后，父对话又自己跑起来

- 状态：已修复（`server/tasks/child-messages.test.ts` 通过）
- 症状：停止父对话，父对话和名下子对话都停了，过一会儿父对话自己又开了一轮，收到的是子对话「已中断」的状态，接着又把子对话叫起来
- 入口：`server/tasks/actions-routes.ts` 的 `/:id/stop` → `keepalive.ts` 的 `stopTask` → `children.ts` 的 `closeChildren` / `reportChild` → `child-messages.ts` 的 `noteParent`
- 根因类型：「用户停下的父对话不叫起」只看父对话自己的状态，父对话已答完时停下记成 done，判定漏过
- 模块：`server`（`server/tasks/child-messages.ts`、`shared/engine.ts` 的 `finish`）
- 关键词：停止、暂停、父对话自己跑、重新运行、子对话已中断、叫起、wakeConv、stopReason parent

## 现象

用户报：「停止父对话后，子对话和父类对话都停止了，但是父类对话又自己跑起来了」。

## 根因

1. 父对话派完子对话、这一轮已经答完（`turnDoneAt` 已记），停在等下一句或进程已退出，计划里有一步在等子对话。
2. 用户按停止：`stopTask(父, 'user')` 先 `closeChildren`，子对话按 `parent` 停下。父对话这一轮已经答完，`finish` 按 `answered` 记成 `done`，不记 `stopReason`（进程已退出时更是什么都不改）。
3. 子对话这一轮收尾 `reportChild` 报「已中断」，`noteParent` 收口父计划那一步（`settleWait` 有命中），再看 `userStopped`：要求父对话 `status === 'stopped' && stopReason === 'user'`，父对话是 `done`，判定不成立，于是 `wakeConv` 给父对话开了新的一轮。
4. 父对话正在执行时被停下也有窗口：子对话先收尾、父对话还没写成 `stopped` 或执行位还占着，同样漏过。

## 修复

`noteParent` 另看子对话自己：上报的状态是 `stopped`、且子对话的 `stopReason` 是 `parent`（只有用户停止、归档父对话时 `closeChildren` 才这样记），就不叫起父对话，上报照旧记进父对话的消息和收件箱，用户继续时一起处理。不依赖父对话当时的状态，两种时机都覆盖。

## 防线

- `server/tasks/child-messages.test.ts`：「父对话这一轮已答完时被用户停下（记成 done）……不把父对话叫起来」；对照用例「子对话自己被停下……照旧叫起父对话」。
