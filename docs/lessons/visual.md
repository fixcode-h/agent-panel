---
paths: web/src/index.css, web/src/components/ui/**, web/src/components/settings/ComponentsSection.tsx, web/src/components/tasks/ConversationTabs.tsx
---

# 视觉：部件、底色和字重

## 边界靠底色分，字不能细

- 规则：分区、选中、次要按钮、小标签靠底色深浅区分，不描边、不加阴影；只有输入框、工具行、弹窗这类必须看出边界的地方留一圈细线。差异照 Claude Code 只用底色（`components/ui/diff-tone.ts`）。
- 规则：常规字重 450（`--font-weight-normal`，Maple Mono 的 400 偏细），不用 `font-light` / `font-thin`；主次用颜色（fg / muted / subtle）和字号分，500 / 600 只给名字和标题。
- 规则：页面只用 `components/ui` 的部件拼，新加或改了部件在设置 → 组件（`ComponentsSection.tsx`）里加一格，换配色时一眼能看全。
- 起因：界面重设计时用户指出「不要加乱七八糟的描边」「字体不要太细」。
- 防线：`scripts/rules-check.mjs` 拦细字重；`scripts/ui/05-settings.mjs` 检查组件页。
