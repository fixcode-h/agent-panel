---
paths: web/src/components/chat/ChatMessage.tsx, web/src/components/tasks/Messages.tsx, web/src/components/tasks/SystemNote.tsx, web/src/components/tasks/TaskView.tsx, web/src/components/tasks/ToolRow.tsx, web/src/components/tasks/PeerMessage.tsx, web/src/components/tasks/RunningNow.tsx, web/src/lib/tasks.ts, web/src/lib/file-path.ts, web/src/lib/useStickToBottom.ts, server/orch-mcp.ts
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

- 规则：行内代码要带目录（`src/a.ts`、`./a.ts`、盘符路径）才画成文件标记，单独的文件名和函数名、字段一样按行内代码显示（`linkPaths` 的 `hasDir`）；面板自己拼给用户看的 Markdown（诊断报告的位置、要改的文件）写全路径，显示时标记只露文件名。Agent 没加反引号的报告文字由 `shared/bug/terms.ts` 补上。
- 规则：认行内代码是不是文件路径用 `web/src/lib/file-path.ts` 的 `parsePath` / `linkPaths`，别另写正则；字符集用 `\p{L}\p{N}`（带 `u`），不用 `\w`（只认 ASCII）；扩展名白名单带图片格式；不误判靠「按段校验 + 白名单 + 拒绝 URL 和命令参数」，不收紧字符集。
- 起因：`ui-shots/107-对话-图片气泡.png` 这类中文路径点不开。
- 防线：`web/src/lib/file-path.test.ts`、`scripts/ui/01-composer.mjs` 的「对话-路径可点」。

## 跟随到底部按滚动方向判断，不按离底部多远

- 规则：`useStickToBottom` 贴底时只有 `scrollTop` 变小（用户往上滚）才松开（`stillPinned`）。内容变高后浏览器补发的 scroll 事件里 `scrollTop` 没变、离底部却变远了，按距离判断会误以为用户滚走。
- 起因：用户 2026-10-23 反馈对话进行中偶发不回到底部。
- 防线：`web/src/lib/useStickToBottom.test.ts` 的 `stillPinned` 用例。

## 消息下面的时间和操作一直显示，不做悬停才出现

- 规则：用户消息、AI 回复下面的时间、复制、引用、「⋯」都常显（`MessageMeta` 不加透明度、不按 hover 显隐）；嫌图标多就把次要操作收进「⋯」，不用藏起来减负。
- 起因：4135aa1 按用户要求改成常显；0752fae 按设计稿又改成用户消息悬停才出现，用户要求「下面的工具和时间一直显示不用隐藏」。
- 防线：`scripts/ui/02c-element-pick.mjs` 的「用户消息-更多操作」断言鼠标不在消息上时操作行 opacity 为 1。

## 思考过程保持原样，不并进过程行

- 规则：对话里的「思考过程」是一行小字按钮（Brain 图标 + 用时）加展开后左侧竖线的正文，不改成过程行（RowShell）样式；统一部件时先问这一块。
- 起因：90e8f53 把它改成过程行，用户要求「思考过程用原有的」。

## 过程行默认带浅底，行间不画分隔线

- 规则：工具 / 过程行（`RowShell`）每行一块默认浅底的圆角块（`bg-fg/[0.035]`），悬停再深一点；相邻行靠 4px 间距分开，不画分隔线（`index.css` 的 `proc-list`）。
- 起因：dc23450 照设计稿改成「无底、行间细线、悬停才出底」，用户要求「工具不加分割线，背景默认显示」。

## 挂在回复体外面的块要缩进到正文竖线上

- 规则：对话流里不在 `.reply-body` 里的块（报错 / 警告卡片、工作流卡片、收到的消息）用 `reply-indent` 缩进到和回复正文同一条竖线，左右都不超出正文；报错卡片用 `NoteMessage` / `SystemNote` 的 `indent`。只有居中的一行说明、用户气泡不缩进。
- 起因：用户 2026-11-07 报「没做完就停下了」卡片比正文往左多伸出一截（对话页、设计页的报错卡片都是）。
- 防线：`scripts/ui/01-composer.mjs` 的「Chat 报错卡片」对齐断言。
