---
paths: web/src/index.css, web/src/components/ui/card.tsx
---

# 卡片的边界

## 卡片底和所在区域同色时，卡片靠细线分开

- 规则：一套配色里 `--card` 和 `--window` / `--panel` / `--bg` 有同值的（「Claude Code」配色深浅两套都是），这套配色的 `--shadow`（即 `shadow-card`、`Card` 默认的 `--c-card-shadow`）用 `0 0 0 1px var(--line)` 细线，不用黑投影：同色底上投影只在下沿留一道脏边。自己带 `border` 的浮条走 `--shadow-raised`，不叠两道线。改卡片外观改这几个令牌，不在单个页面上补边框。
- 起因：用户反馈项目设置「必备角色」的折叠卡片和弹窗底色糊在一起（c85b727 引入的配色）。
- 防线：人工（`scripts/ui/07-projects.mjs` 的「项目设置-必备角色」截图，深浅两套都看）。
