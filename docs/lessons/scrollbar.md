---
paths: web/src/index.css, web/src/components/ui/rail-scrollbar.tsx, web/src/components/ui/web-frame.tsx, shared/web-view/scrollbar.ts, server/web-view/sandbox.ts
---

# 滚动条

## 滚动条全站一套，不按区域另写

- 规则：滚动条只在 `web/src/index.css` 的全局 `::-webkit-scrollbar` 写一次，宽度、颜色读 `--c-scrollbar-*`（设置 → 控件样式 →「滚动条」）；不再给侧栏、弹窗、某个列表单独写一套。要藏滚动条用 `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`，其余不写标准的 `scrollbar-width: thin` / `scrollbar-color`：Chromium 121 起元素上有这两个属性就不认 `::-webkit-scrollbar`，画回系统原生的（Windows 上带箭头和竖分隔线）。iframe 里面板自己发的页面靠 `shared/web-view/scrollbar.ts` 插同款样式。
- 起因：用户 2026-11-18（5100d15）截图指出还有带上下箭头、带竖分隔线的旧式滚动条，要求全站统一成 Claude Code 的样子。
- 防线：人工（headless 截图要去掉 `--hide-scrollbars` 才看得到滚动条）。
