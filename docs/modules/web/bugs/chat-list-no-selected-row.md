# Chat 模式的聊天列表点开一条后没有选中状态

- 状态：已修复（`npm run typecheck`、`npm run lint`、`scripts/ui/01-composer.mjs` 通过，新增「Chat 选中」浅色 / 深色断言）
- 症状：Chat 模式左栏的聊天列表点开一条聊天后，那一行和别的行看起来一样，没有选中底（默认「Claude Code」配色深色下完全看不出，浅色下也几乎看不出）
- 入口：`web/src/components/layout/SidebarTasks.tsx` 的 `TaskRow`（`plain` 分支）、`web/src/components/ui/sidebar.tsx` 的 `SIDEBAR_CHAT_ROW_ON`
- 根因类型：选中底用了 `bg-card`，而默认配色里卡片底和侧栏底同色
- 模块：`web`
- 关键词：Chat 列表、聊天列表、选中、高亮、aria-current、bg-card、--conv-sel、Claude Code 配色、侧栏

## 根因

Chat 列表的行（`TaskRow` 的 `plain` 分支）选中时用的是组件里自己写的 `bg-card font-medium`。「Claude Code」配色（默认）里 `--card` 和 `--rail` 深色都是 `#1f1f1f`、浅色是 `#ffffff` 对 `#fafafa`，所以选中了和没选中一样。项目下的对话行用的是 `--conv-sel`，这个 token 在「Claude Code」配色里单独指向 `--sel`，其他配色是比卡片亮一档的底，所以 Agent 模式那边看得出来。

## 修复

`components/ui/sidebar.tsx` 新增 `SIDEBAR_CHAT_ROW_ON`（`bg-conv` + `shadow-conv`，字重 500），Chat 列表选中行改用它，和项目下的对话行同一套选中底。

## 防线

`scripts/ui/01-composer.mjs` 点开一条聊天后，浅色、深色各比一次 `[aria-current="true"]` 行的底色和侧栏底色，一样就报错，并截图 `Chat-选中行-浅色/深色`。
