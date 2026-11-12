---
paths: shared/markdown-style.ts, web/src/index.css, web/src/components/settings/MarkdownSection.tsx, web/src/lib/markdown/**
---

# Markdown 样式

## :root 上的 CSS 变量里不要引用只在局部才定义的变量

- 规则：没注册的 CSS 变量里的 `var()` 在声明它的元素上就替换掉。写在 `:root` 的 `--md-*`（`shared/markdown-style.ts` 生成的、`index.css` 的默认值）里引用 `.chat-md` 上才有的 `--md-base`、`--md-k`，到 `:root` 就是无效值，往下继承的也是无效值，用到它的属性回到初始值（`max-height` 变成 `none`），也不报错。这类变量只放纯值（行数、开关），要按字号算的 `calc()` 写在用它的规则里。
- 起因：对话表格「长表限高」第一版把整段 `calc(… var(--md-base) …)` 放进 `--md-table-rows`，设置里怎么调表格都不限高。
- 防线：`scripts/ui/05-settings.mjs` 的「设置-Markdown样式-长表限高」。
