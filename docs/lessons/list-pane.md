---
paths: web/src/components/layout/ListPane.tsx, web/src/components/layout/Detail.tsx, web/src/pages/**
---

# 中间列表栏

## 头部按钮多时收成图标，标题不能被挤截断

- 规则：`ListPane` 的头部在 300px 窄栏里放不下「标题 + 计数 + 文字按钮」：超过两个按钮时 `extra` 一律用 `size="icon-sm"` 图标按钮（文字放进 `aria-label` / `title`），并给 `ListPane` 传 `compactNew`。标题被压成半个字比按钮少几个字更难看。
- 起因：用户报角色页标题「角色」被「内置、导入、AI 创建、新建」四个按钮挤成半个字；工作流页同样截断。
- 防线：`scripts/ui/03-library.mjs` 查角色、工作流、Skills 三个列表栏的标题没有截断。

## 改版先用现有的字号、圆角和部件，只是大小不同就给部件加参数

- 规则：字号、圆角用 `index.css` 已有的阶梯（`text-caption`…`text-title`、`rounded-sm`…`3xl`），不另立一套；同一部件只差大小时加 `size` 参数或 Context（整片表单切到 sm 用 `FieldSizeContext`），不复制新部件。列表头多个「添加」入口用 `ListPane` 的 `newMenu`，详情头次要操作用 `DetailHeader` 的 `more`，就绪问题用 `IssueBar`（只在有问题时出现）。
- 起因：2026-10-31 角色、技能页的设计文档另起了一套字号，用户要求「之前定好的字号就用已有的」「已有组件只是大小调整就加参数复用」。
- 防线：`scripts/rules-check.mjs` 6c 拦手写字号和圆角；新部件登记在设置 → 组件（`ComponentsSection.tsx`）。
