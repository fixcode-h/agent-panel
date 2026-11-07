---
paths: web/src/components/files/**, web/src/lib/file-highlight*.ts, web/src/lib/file-search.ts, web/src/lib/md-math.ts
---

# 文件弹窗：大文件和超长行

## 按文件大小想清楚每一步的复杂度，拿上百 KB、整表一行的文件试

- 规则：文件弹窗里处理整份内容的循环（拆行、高亮、Markdown 扩展的 `start`）必须是线性的：在循环里对「剩下的整段」做 `indexOf` / 正则搜索就是平方级，要把找到的位置缓存起来，或只搜到能影响结果的范围为止（段落到空行就结束）。
- 规则：只做看得见的部分：阅读区是虚拟列表（`CodeLines`，块绝对定位、行高按画出来的量），编辑区是 CodeMirror（`CodeEditor`，只给可见行上色）；整份高亮在后台线程（`highlight.worker.ts`）算并缓存。超过 `LONG_LINE` 的行不上色，几万个 `<span>` 挤在一行浏览器排版要好几秒。
- 规则：屏幕外的行不在 DOM 里，浏览器自带的查找搜不到：弹窗里的搜索一律走 `FileSearchBar`（代码按文字找、Markdown 用 `::highlight`），别加依赖整份 DOM 的功能。
- 规则：按行定位用量出来的行高，不用 CSS 行高：排版按 1/64 像素取整，滚到一千多行就差出一整行。
- 起因：用户 2026-11-07 报打开 167 KB 的 lua 浏览器卡死：`splitHtmlLines` 遇到超长行是平方级，编辑时 `FileViewDialog` 每敲一个字还整份重新高亮。
- 防线：`web/src/lib/file-highlight.test.ts`、`web/src/lib/file-search.test.ts`、`web/src/lib/md-math.test.ts`；`scripts/ui/07-projects.mjs` 的「文件窗口-搜索」。
