# 继续父对话时子对话没被拉起来，父对话另建子对话重做

- 状态：已修复（e2e `09-subagent-runtime`「父对话被停下后继续……」、`shared/task-stage.test.ts`「继续执行的续接说明……」、`server/task-restart.test.ts` 通过）
- 症状：父对话被停下（或面板重启）后点「继续执行」，名下一起被打断的子对话没动；父对话看子对话没动静，自己手写「被中断后恢复」逐个转发，或另建一个子对话重做
- 入口：`server/tasks.ts` 的 `/:id/resume`（`resumeKids`、`resumePrompt`）、启动迁移 `ready`、`sendToChild`；`shared/task.ts` 的 `resumeNote`；`shared/engine.ts` 的 `create_conversation`
- 根因类型：继续执行只管自己，不管一起被打断的子对话、子任务、工作流
- 模块：`server`（`server/tasks.ts`、`shared/task.ts`、`shared/engine.ts`）
- 关键词：继续执行、中断、恢复、子对话没继续、另建子对话、重做、面板重启、工作流运行、合并中

## 现象

用户报：「确保父对话继续执行可以正确激活子对话、子任务还有工作流」「继续对话不要看之前的子对话没有继续就不继续了，换一个新的对话来继续之前的，尽量使用原来的子对话」「如果子对话确实启动不了需要报错，然后再启动新的子对话继续之前的任务」。

## 根因

1. `/:id/resume` 只把最后一条用户消息原样再交一遍，不碰名下子对话；交给 CLI 的话里也没有「这是续接、中断时还有什么没跑完」。
2. 子任务、工作流运行挂在上一次执行的宿主上，继续时宿主是新的，它们不会自己跑；硬崩后工作流运行一直标 `running`。
3. `sendToChild` 交给没在跑的子对话时发出去就回「已交给」，子对话起不来父对话不知道。
4. 合并到一半面板退出，`merging` 落盘后没人清，`finish_child`、`submit_merge` 都按它拒绝。

## 修复

- 继续顶层对话时先拉起被连带打断的子对话（`parent` / `restart` / `stalled`），拉不起来写告警。
- 续接的话前面加 `resumeNote`：为什么被打断、已经拉起来的子对话、没跑完的子任务（`spawn_agents` 带 `resume`）和工作流（`start_plan`）。
- `sendToChild` 等子对话开起来再回话，起不来把错误交回。
- `create_conversation` 的 `step` 还在等一个没做完、没失败的子对话时拒绝，提示交回原来的；父对话提示词同样写明。
- 启动迁移：残留 `running` 的工作流运行置 `stopped`、计划那一步标失败；`merging` 退回 `requested` 并告诉父对话重新 `finish_child`。

## 防线

- `scripts/e2e/09-subagent-runtime.mjs`：「父对话被停下后继续：一起被打断的子对话由面板连带拉起来，续接提示写清是续接」。
- `shared/task-stage.test.ts`：「继续执行的续接说明……」。
- `server/task-restart.test.ts`：「重启前没走完的工作流运行和合并到一半的子对话……」。
