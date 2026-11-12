# 改「默认 CLI」后已有对话悄悄换成另一个 CLI

- 状态：已修复（`server/tasks/run-pick.test.ts`、`scripts/e2e/05-workflow-edge.mjs` 通过）
- 症状：默认 CLI 从 Claude Code 改成 Codex 后，原来用 Claude Code 的对话下一条消息直接由 Codex 回答（新会话），界面上没有任何提示；改回来后原来用 Codex 的对话又换回 Claude Code
- 入口：`shared/tasks/run.ts` 的 `withTaskModel`，`shared/task.ts` 的 `newTask`，`server/exec/runner.ts` 的 `runAgent`
- 根因类型：对话的 CLI 每轮按「角色 CLI → 默认 CLI」现算，没用上第一次运行时记下的 `sessionCli`；新建对话接口传的 `cli` 对角色对话直接丢掉
- 模块：`shared`（`shared/tasks/run.ts`）
- 关键词：默认 CLI、跟随默认、sessionCli、换 CLI、新会话、withTaskModel、角色对话、实测报告问题 7

## 现象

真实 API 实测：角色 Agent 的 CLI 是「跟随默认」。改了设置里的默认 CLI 之后，所有已有对话的下一轮都换到新 CLI 上开新会话；来回改两次后，原来在 Codex 上的对话换成 Claude Code 后接着压缩抖动失败。用新建对话接口给角色对话传 `cli` 也不生效。

## 根因

`withTaskModel` 只对不用角色的对话看 `task.cli`，用角色的对话直接用角色自己的配置，角色跟随默认时就落到当前的默认 CLI。`sessionCli`（会话是哪个 CLI 开的）只用来判断「换了 CLI 要开新会话」，没用来定这一轮用哪个 CLI。`newTask` 对用角色的对话把 `cli` 清空。

## 修复

- `withTaskModel` 搬到 `shared/tasks/run.ts`：对话定下的 CLI = `task.cli`（新建时选的、在对话里换的）或 `sessionCli`（第一次运行时记下的）。不用角色的对话按它跑；用角色的对话只在角色跟随默认 CLI 时按它跑，角色自己指定了 CLI 仍按角色的（改角色、改「子对话用的 CLI」是用户主动换）。工作流节点照旧固定用默认 CLI 的档位（`nodeAgentRun`，不经过这里）。
- `newTask` 给用角色的对话也记下接口传的 `cli`（模型、强度仍按角色的）。
- 会话真换到另一个 CLI 时（`sessionCli` 和这一轮的 CLI 不同、有旧会话），`runAgent` 在对话里写一行「已从 A 换成 B，之前的会话不再续用，之前的对话会带给新会话。」，预热轮也写。
- 界面上不用角色的对话显示的 CLI（标题、输入框的 CLI 选择、会话栏上下文）同样先看 `task.cli` 再看 `sessionCli`。
