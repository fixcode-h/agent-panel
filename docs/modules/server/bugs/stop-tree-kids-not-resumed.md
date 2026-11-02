# 停父对话后子对话不停、再启动起不来；回收了的子对话还在转圈；父对话总在「等待模型」

- 状态：已修复（`server/tasks/keepalive-endlive.test.ts`、`web/src/components/tasks/child-line.test.ts`、`server/exec/parsers.test.ts` 通过）
- 症状：父对话长时间「等待模型」，子对话交回的消息不处理；子对话 Agent 进程已回收，父对话里那一行还在转圈；停止父对话后子对话看着没停，子对话有子任务在跑时停了父对话再继续，子对话起不来
- 入口：`server/tasks/keepalive.ts` 的 `stopTree` / `watchStop`、`server/tasks/conversation-routes.ts` 的 `resumeKids`、`shared/task.ts` 的 `childIcon`、`server/exec/parsers.ts` 的 `claudeParser`
- 根因类型：连带停没有记停止原因；图标判定没看进程；CLI 自己的重试事件没有映射
- 模块：`server`、`shared`、`web`
- 关键词：等待模型、api_retry、重试、子对话不停、子对话起不来、resumeKids、stopTree、cancelWait、stopReason、parent、user、转圈、cliAlive、unfinished、Agent 进程已回收

## 根因

- 网关报错时 Claude Code 自己重试（最多 10 次、间隔递增），stream-json 里逐次输出 `{"type":"system","subtype":"api_retry",...}`，面板没接这个事件，界面只写「等待模型」，插进来的消息要等重试完。
- `childIcon` 把 `unfinished`（计划没做完）一律画成转圈，不看进程；停止父对话也改不了它们的状态，看着像没停。
- `stopTree` 对停在等下一句 / 等子任务的子对话只取消等待：等子任务的其实没停，也没记原因；收口时兜底原因写成 `user`，父对话继续时 `resumeKids` 把它当成用户停的，不拉起。`resumeKids` 等子对话停稳只等 5 秒，晚收完的被漏掉。

## 修复

- Claude Code 的 `api_retry` 画成「模型请求失败，n 秒后第 k/10 次重试」，模型回应开始后收成已恢复。
- `unfinished` 只在 CLI 还活着时转圈，否则静止并提示「Agent 进程已回收，继续会重新拉起」；重启迁移按状态判断，不受影响。
- `stopTree`：在执行、在等子任务的子对话一律按 `parent` 停；停在等下一句的只取消等待。收口兜底原因写 `parent`；`resumeKids` 用 `settleBefore` 等子对话停稳。
