---
paths: web/src/components/ui/sidebar.tsx, web/src/components/layout/Sidebar*.tsx
---

# 侧栏列表行的选中态

## 选中底只用 sidebar.tsx 里的常量，不另写 bg-card

- 规则：侧栏列表里「这一行被选中」只用 `components/ui/sidebar.tsx` 的 `SIDEBAR_ROW_ON`（`bg-sel`）、`SIDEBAR_BLOCK_ROW_ON` / `SIDEBAR_CHAT_ROW_ON`（`bg-conv` + `shadow-conv`），不在组件里另写 `bg-card`：默认「Claude Code」配色里卡片底和侧栏底同色（深色都是 `#1f1f1f`），`--conv-sel` 才是每套配色单独调过的选中底。
- 起因：4a82a39 的 Chat 列表选中行用了 `bg-card`，用户 2026-11-13 报 Chat 模式点了没有选中状态。
- 防线：`scripts/ui/01-composer.mjs`「Chat 选中」浅色、深色各比一次选中行和侧栏的底色。
