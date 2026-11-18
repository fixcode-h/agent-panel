---
paths: shared/markdown-style.ts, web/src/index.css, web/src/components/settings/MarkdownSection.tsx, web/src/lib/markdown/**
---

# Markdown 样式

## :root 上的 CSS 变量里不要引用只在局部才定义的变量

- 规则：没注册的 CSS 变量里的 `var()` 在声明它的元素上就替换掉。写在 `:root` 的 `--md-*`（`shared/markdown-style.ts` 生成的、`index.css` 的默认值）里引用 `.chat-md` 上才有的 `--md-base`、`--md-k`，到 `:root` 就是无效值，往下继承的也是无效值，用到它的属性回到初始值（`max-height` 变成 `none`），也不报错。这类变量只放纯值（行数、开关），要按字号算的 `calc()` 写在用它的规则里。
- 起因：对话表格「长表限高」第一版把整段 `calc(… var(--md-base) …)` 放进 `--md-table-rows`，设置里怎么调表格都不限高。
- 防线：`scripts/ui/05-settings.mjs` 的「设置-Markdown样式-长表限高」。

## 挂在 body 上的浮层要防着 Radix 弹窗

- 规则：自己 `document.body.append` 的浮层（Mermaid 全屏这类），所在内容可能开在 Radix Dialog 里：弹窗打开时 body 是 `pointer-events: none`、焦点被锁在弹窗里、Esc 在 document 捕获阶段被弹窗先收走。浮层自己加 `pointer-events-auto`，Esc 在 window 捕获阶段收并 `stopImmediatePropagation`，`pointerdown` / `focusin` / `focusout` 在浮层上 `stopPropagation`，免得弹窗以为点到了外面而关掉。能用 React 的就直接用 `Modal` / Radix 的 Portal。
- 起因：用户 2026-11-18 反馈诊断报告里的时序图点「全屏」后退不出去。
- 防线：`scripts/ui/02k-bug-structure.mjs` 的「全屏看图」（在诊断报告弹窗里开全屏、切源码、Esc 和「关闭」退出）。
