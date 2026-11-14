---
paths: web/src/index.css, web/src/components/summary/**, web/src/components/ui/rail-scrollbar.tsx, web/src/components/session/SessionBar.tsx, web/src/components/chat/ConversationShell.tsx, scripts/ui/scroll-pair.mjs
---

# 滚动条

## 互斥只做在用户点名的两块上

- 规则：用户说「滚动条只显示一个」时，互斥只做在点名的区域上（现在只有对话正文和会话栏：`web/src/components/ui/rail-scrollbar.tsx`，鼠标在哪块显示哪块，不自动隐藏）；里面嵌套的滚动区（MCP 工具列表等）照常显示自己的滚动条，不做全局「同一时间只一条、停下自动隐藏」。
- 起因：4c69897 把全站滚动条改成只显示正在滚的那一条并自动隐藏，用户 2026-11-09 纠正：右侧滚动条不要隐藏，只让对话正文和会话面板互斥，正文里其他滚动条正常显示。
- 防线：`scripts/ui/scroll-pair.mjs`（02-task 分片调用）。

## 自定义滚动条要连角落一起定

- 规则：写了 `::-webkit-scrollbar` 就要同时给 `::-webkit-scrollbar-corner` 定底色（全局已在 `web/src/index.css` 设成透明），不然横竖滚动条交汇的那一格是白块，深色主题下特别明显；局部再改滚动条样式时不要把角落改回实色。
- 起因：用户反馈表格 / xlsx 预览右下角等多处出现白块。
- 防线：`scripts/rules-check.mjs` 第 23 条核对全局规则还在。

## 页面的滚动区要带 relative

- 规则：宽屏下整页不滚、由内层 `overflow-y-auto` 的区域滚的页面，滚动区本身要加 `relative`。不然里面的 `sr-only`（绝对定位）找不到定位祖先、按视口定位，不被滚动区裁掉，把整个文档撑高；拖选文字到滚动区底部时浏览器接着滚整页，顶栏和标题被推出视口，看起来像被拉回去了。
- 起因：用户 2026-11-14 报工作总结拖选整份报告时往下拖又被拉上去，根因是候选教训草稿区的 `sr-only` 撑高了文档（本次提交）。
- 防线：`scripts/ui/08-misc.mjs`「工作总结-报告」断言文档没有被撑高。
