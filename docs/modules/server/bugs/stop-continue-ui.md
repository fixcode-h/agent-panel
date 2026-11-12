# 停了父对话：按钮不立即变、找不到继续、计划和子任务还在转圈、子任务重派一批新的

- 状态：已修复（`server/tasks/keepalive-endlive.test.ts`、`shared/tasks/stage.test.ts`、`server/engine-steps.test.ts` 通过）
- 症状：点停止后按钮不马上变回来；停下后输入框里没有「继续执行」；计划里等子对话的步骤还在转圈计时；子对话名下被打断的子任务一排在运行区转圈；再继续时子对话不复用被打断的子任务，另派一批「重派」；被停下的子对话还往父对话里发消息
- 入口：`server/tasks/keepalive.ts` 的 `stopTree`、`server/tasks/actions-routes.ts` 的 `/stop`、`web/src/components/tasks/TaskView.tsx`、`web/src/components/tasks/PlanPanel.tsx`、`web/src/components/tasks/RunningNow.tsx`、`shared/engine.ts` 的 `spawn_agents` / `stop_subtask`
- 根因类型：停止的界面全靠下一次推送；「在跑」的显示没看有没有人在推进；只靠提示词约束「不要重派」；停树的顺序和连带停的通知没定清
- 模块：`server`、`shared`、`web`
- 关键词：停止按钮、继续执行、计划转圈、子任务已打断、重派、resume、stop_subtask、stopTree、自上而下、子对话停止通知

## 修复

- 停止自上而下：先停发起的对话，再一层层往下，每层停对话本身（它的子任务和工作流跟着中断，记成「被打断」，继续时接得上）；随父对话停的子对话不再往父对话发「子对话停止」。
- `/stop` 等这个对话停稳（`settleBefore`）再返回，页面用返回值更新，按钮马上变回来。
- 用户亲手停的对话一定显示「继续执行」。
- 对话停下且名下没东西在跑时，计划按暂停画（不转圈、用时停住）；排着的子任务只在对话执行时进运行区，被打断的图标静止。
- `spawn_agents`：还有被打断没做完的子任务时另派新的会被拒绝，要 `resume` 或先 `stop_subtask`；`stop_subtask` 能直接终止被打断的子任务。
