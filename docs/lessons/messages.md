---
paths: web/src/components/tasks/Messages.tsx, web/src/components/tasks/ToolRow.tsx, web/src/components/tasks/PeerMessage.tsx, web/src/components/tasks/RunningNow.tsx, web/src/lib/tasks.ts, web/src/lib/file-path.ts, web/src/lib/useStickToBottom.ts, server/orch-mcp.ts
---

# 对话里的消息和条目

## 面板的产物不冒充用户、不另起居中提示

- 规则：面板推给 CLI 的内容（后台命令、合并编译、子任务结果）记成 `TaskMessage.panel`，画成 AI 回复的一行；面板工具调用按「做了什么 + 对象名」显示（`toolView` / `panelTool`，新工具要进 `shared/panel-tools.ts` 的 `PANEL_TOOL_NAMES`），不另记居中提示，也不插提示截断回复。子对话汇报只给父对话 AI，提问是父对话的卡片（`panel: 'child'` / `'ask'`）。
- 起因：15c1a1d 把后台命令结果当用户消息推回、新建子对话另记居中提示；之后「要改文件了…」截断回复。
- 防线：`server/orch-mcp.test.ts`、`server/orchestrator.test.ts`、`scripts/e2e/04-subagents.mjs`（开分支不记提示、提问卡片）。

## 对话里一行一个的条目整行可点

- 规则：对话里一行一个的条目用 `RowShell`：整行是入口的传 `rowOpen`（行尾 `action` 如终止要自己 `stopPropagation`）；没传的只有标题开窗口，动作名和箭头是展开收起。
- 起因：子任务行只有标题能点，用户要求整行可点（参考子对话行）。
- 防线：`scripts/ui/02-task.mjs` 的「子对话-整段文本可点」「子任务-整行可点」「子任务-终止按钮不打开窗口」。

## 行内代码里的文件路径按段校验，字符集用 Unicode 属性

- 规则：认行内代码是不是文件路径用 `web/src/lib/file-path.ts` 的 `parsePath` / `linkPaths`，别另写正则；字符集用 `\p{L}\p{N}`（带 `u`），不用 `\w`（只认 ASCII）；扩展名白名单带图片格式；不误判靠「按段校验 + 白名单 + 拒绝 URL 和命令参数」，不收紧字符集。
- 起因：`ui-shots/107-对话-图片气泡.png` 这类中文路径点不开。
- 防线：`web/src/lib/file-path.test.ts`、`scripts/ui/01-composer.mjs` 的「对话-路径可点」。

## 跟随到底部按滚动方向判断，不按离底部多远

- 规则：`useStickToBottom` 贴底时只有 `scrollTop` 变小（用户往上滚）才松开（`stillPinned`）。内容变高后浏览器补发的 scroll 事件里 `scrollTop` 没变、离底部却变远了，按距离判断会误以为用户滚走。
- 起因：用户 2026-10-23 反馈对话进行中偶发不回到底部。
- 防线：`web/src/lib/useStickToBottom.test.ts` 的 `stillPinned` 用例。

## 回复的总结一律留在折叠外面

- 规则：一轮回复收尾折叠时，总结整段留在外面，父对话、子对话都一样。AI 写完总结常再调收尾动作（`suggest_next_step`、`submit_merge`、`set_plan` 这类）再补一句「已提交」，`summaryStart`（`web/src/lib/fold.ts`）把中间只隔着这些动作的几段话都算作总结；新的收尾类面板工具要加进 `WRAP_TOOLS`。
- 起因：用户 2026-10-30 要求「对话的总结不要折叠，父对话、子对话都要记住」；之前只留最后一条带正文的消息，真正的总结被算成「n 段说明」收了进去。
- 防线：`web/src/lib/fold.test.ts` 的 summaryStart 用例。
