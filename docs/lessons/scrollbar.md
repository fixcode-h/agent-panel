---
paths: web/src/index.css, web/src/components/ui/rail-scrollbar.tsx, web/src/components/session/SessionBar.tsx, web/src/components/chat/ConversationShell.tsx, scripts/ui/scroll-pair.mjs
---

# 滚动条

## 互斥只做在用户点名的两块上

- 规则：用户说「滚动条只显示一个」时，互斥只做在点名的区域上（现在只有对话正文和会话栏：`web/src/components/ui/rail-scrollbar.tsx`，鼠标在哪块显示哪块，不自动隐藏）；里面嵌套的滚动区（MCP 工具列表等）照常显示自己的滚动条，不做全局「同一时间只一条、停下自动隐藏」。
- 起因：4c69897 把全站滚动条改成只显示正在滚的那一条并自动隐藏，用户 2026-11-09 纠正：右侧滚动条不要隐藏，只让对话正文和会话面板互斥，正文里其他滚动条正常显示。
- 防线：`scripts/ui/scroll-pair.mjs`（02-task 分片调用）。
