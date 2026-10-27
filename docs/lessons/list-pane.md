---
paths: web/src/components/layout/ListPane.tsx, web/src/pages/**
---

# 中间列表栏

## 头部按钮多时收成图标，标题不能被挤截断

- 规则：`ListPane` 的头部在 300px 窄栏里放不下「标题 + 计数 + 文字按钮」：超过两个按钮时 `extra` 一律用 `size="icon-sm"` 图标按钮（文字放进 `aria-label` / `title`），并给 `ListPane` 传 `compactNew`。标题被压成半个字比按钮少几个字更难看。
- 起因：用户报角色页标题「角色」被「内置、导入、AI 创建、新建」四个按钮挤成半个字；工作流页同样截断。
- 防线：`scripts/ui/03-library.mjs` 查角色、工作流、Skills 三个列表栏的标题没有截断。
