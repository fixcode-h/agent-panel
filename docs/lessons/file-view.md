---
paths: web/src/components/files/**, web/src/lib/file-highlight.ts, web/src/lib/md-math.ts
---

# 文件弹窗：大文件和超长行

## 按文件大小想清楚每一步的复杂度，拿上百 KB、整表一行的文件试

- 规则：文件弹窗里处理整份内容的循环（拆行、高亮、Markdown 扩展的 `start`）必须是线性的：在循环里对「剩下的整段」做 `indexOf` / 正则搜索就是平方级，要把找到的位置缓存起来，或只搜到能影响结果的范围为止（段落到空行就结束）。
- 规则：随输入变化的计算只做看得见的部分：阅读代码时才拆行、高亮（编辑时不算）；编辑区底图只高亮可见的几十行（`FileEditor` 的 `BLOCK` / `CONTEXT`），不每敲一个字整份重算；阅读区按块拼 HTML、用 `content-visibility: auto`（`CodeLines`），不逐行建 React 元素。超过 `LONG_LINE` 的行不上色，几万个 `<span>` 挤在一行浏览器排版要好几秒。
- 规则：叠在输入框下面的底图按「输入框内容总高 ÷ 行数」算行高，不用 CSS 行高：排版按 1/64 像素取整，滚到一千多行就差出一整行。
- 起因：用户 2026-11-07 报打开 167 KB 的 lua 浏览器卡死：`splitHtmlLines` 遇到超长行是平方级，编辑时 `FileViewDialog` 每敲一个字还整份重新高亮。
- 防线：`web/src/lib/file-highlight.test.ts`（超长行拆分限时、超长行不上色）、`web/src/lib/md-math.test.ts`。
