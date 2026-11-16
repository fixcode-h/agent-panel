# 项目里打开了 UE 插件，「技能与 MCP」页却标它的 MCP「没打开」

- 状态：已修复（`npm run typecheck`、`npm run lint`、`caps-items.test.ts` 通过）
- 症状：项目「技能与 MCP」页「从全局继承」里列着「UE（插件）MCP · 面板插件」，右边徽标却是「没打开」
- 入口：`web/src/components/projects/caps/ProjectCapsPage.tsx` 的 `Overview`、`caps-items.ts` 的 `itemOn`
- 根因类型：显示层用错判断依据（插件开关在 capabilities.plugins，却拿显示名去 capabilities.mcp 里找）
- 模块：`web`
- 关键词：技能与 MCP、没打开、UE 插件、按项目、activation、capabilities.plugins、插件 MCP、全局 / 本项目

## 现象

用户报：「看下为什么没打开，不应该在那个项目启动这个插件就应该对那个项目打开 MCP 么」。截图是项目「技能与 MCP」页的一行：
「UE（插件） MCP …… 面板插件　没打开」。

## 根因

只是显示错，对话里实际是挂上的：服务端每轮挂插件工具走 `server/plugins/project-gate.ts` 的 `pluginGate`，
按项目的 `capabilities.plugins` 判断（`pluginOnFor`），项目里打开了 UE 就会挂。

页面这边：插件 MCP 条目先按 `pluginOnFor` 过滤（能列出来就说明这个项目打开了），但 `scope` 设成 `project` 后，
徽标走通用的 `itemOn`——它去 `capabilities.mcp` 名单里按条目名找，条目名是显示用的「UE（插件）」，永远找不到，于是恒为「没打开」。
侧栏「技能与 MCP」后面的数字也没把插件 MCP 算进去，和页面的「从全局继承」对不上。

## 修复

- `CapItem` 加 `on`：插件 MCP 的开没开在拼条目时按 `pluginOnFor` 算好，`itemOn` 优先用它；拼条目收进 `caps-items.ts` 的 `pluginMcpItems`，页面和侧栏数字共用。
- 只读处的徽标改成「本项目已打开 / 本项目没打开」，和标「全局」的条目分开。
- 设置 →「MCP」的插件来源卡片和来源页写生效范围：全局写「所有项目」，按项目的列出打开了它的项目，还没有项目打开时标黄并说在哪打开（`CatalogSource.activation / projects`）。
