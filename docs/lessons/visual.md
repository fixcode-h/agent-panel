---
paths: web/src/index.css, web/src/components/ui/**, web/src/components/layout/**, web/src/pages/**, web/src/components/settings/ComponentsSection.tsx, web/src/components/tasks/ConversationTabs.tsx
---

# 视觉：部件、底色和字重

## 边界靠底色分，字不能细

- 规则：分区、选中、次要按钮、小标签靠底色深浅区分，不描边、不加阴影；只有输入框、工具行、弹窗这类必须看出边界的地方留一圈细线。差异照 Claude Code 只用底色（`components/ui/diff-tone.ts`）。
- 规则：常规字重 450（`--font-weight-normal`，Maple Mono 的 400 偏细），不用 `font-light` / `font-thin`；主次用颜色（fg / muted / subtle）和字号分，500 / 600 只给名字和标题。
- 规则：页面只用 `components/ui` 的部件拼，新加或改了部件在设置 → 组件（`ComponentsSection.tsx`）里加一格，换配色时一眼能看全。
- 起因：界面重设计时用户指出「不要加乱七八糟的描边」「字体不要太细」。
- 防线：`scripts/rules-check.mjs` 拦细字重；`scripts/ui/05-settings.mjs` 检查组件页。

## 吸顶元素要贴住滚动区顶边

- 规则：滚动区有上内边距时 `sticky top-0` 会留缝露出背后内容，写 `-top-<n> -mt-<n>` 并把内边距补回自己的 `pt`。防线：`scripts/ui/harness.mjs` 的 `stickyLeakProblems`（起因：设置左栏标题上方露出「快捷键」）。

## 深色下分段切换要认得出选中项

- 规则：分段切换（模式切换、`Segmented`）用 `seg-track` / `seg-thumb`，不手写 `bg-sel` + `bg-card`：深色下两者只差几个色阶，选中项认不出来；未选中文字用 `text-muted`。防线：`scripts/ui/harness.mjs` 的 `segmentedContrastProblems`（起因：用户反馈侧栏「Agent / Chat / 设计」深色下看不清）。
