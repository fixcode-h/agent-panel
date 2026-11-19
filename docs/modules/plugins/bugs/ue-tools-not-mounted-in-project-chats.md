# 项目里的对话和子对话没有挂上 UE 工具

- 状态：已修复（`shared/conv-mode.test.ts`「交给插件的模式」一条通过）
- 症状：项目里的 Agent 对话、Bug 子对话说「当前对话没有挂载 ue_* 工具」，只能退回 sed、python 读文件核对蓝图资产；设置 →「MCP」的自检却显示父对话、子对话都挂得上
- 入口：`server/exec/plugin-run.ts` 交给插件的 `PluginRun.mode`；UE 插件 `ue/server/index.ts` 的 `tools(run)`
- 根因类型：字段含义没对上（插件接口说 mode 是 agent / chat / workflow，面板却原样交出存盘的 `task.mode`，项目对话和子对话存的都是 chat）
- 模块：`plugins`（`server/exec/plugin-run.ts`、`shared/conv-mode.ts`）
- 关键词：UE、ue_*、MCP、子对话、项目对话、没有挂载、mode、chat、agent、自检对不上

## 现象

UE 插件按设计「Chat 页的对话不挂」，判断写的是 `run.mode === 'chat'`。项目里的对话、子对话在面板里存的 `task.mode` 也是 `chat`（`TaskMode` 只分对话和工作流），面板原样交出去，UE 插件就把所有项目对话都当成 Chat 页的对话跳过了，只有工作流节点挂得上。

设置 →「MCP」的自检给父对话、子对话交的是 `workflow`，所以自检显示「挂上」，和真跑对不上，一直没被发现。

## 修复

- 面板：`shared/conv-mode.ts` 的 `pluginRunMode` 按 `isChatMode` 换算，只有 Chat 页（没有项目的顶层对话）交 `chat`，项目里的对话和子对话交 `agent`，工作流交 `workflow`；自检的父对话、子对话也交 `agent`，和真跑同一个口径。
- UE 插件 0.35.1：`mode === 'chat'` 且没有项目时才跳过，旧面板上也能挂。
