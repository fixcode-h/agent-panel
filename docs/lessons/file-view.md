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

## 虚拟列表按排版尺寸量行高，不用 getBoundingClientRect

- 规则：要存下来、拿去算位置的尺寸（虚拟列表的行高、留白高度、弹窗大小）一律量排版尺寸：`ResizeObserver` 的 `borderBoxSize`（带小数）或 `offsetWidth/offsetHeight`。`getBoundingClientRect` 受 transform 影响，弹窗打开的缩放动画（`anim-dialog` 从 0.96 放大）期间量会小 4%，阅读区 80 行一块就差出三行多，下一块盖到上一块末尾上叠字。`getBoundingClientRect` 只用来和同一时刻的指针坐标、别的元素的屏幕位置比。
- 规则：阅读区每一行也固定高度（`h-[1.6em]`），拼 HTML 时去掉落单的 `\r`，任何一行都撑不高、块的位置只取决于行数。
- 起因：用户 2026-11-14 / 11-15 两次报诊断报告里点开 UE 的 .cpp，跳到的行附近几行文字叠在一起、行号跳三个号。第一次按 `\r` 修（67d017d）没修到根上，真正原因是打开动画中量了行高。`modal-resize.tsx`、`minimized-chat.tsx` 早就踩过同一个坑。
- 防线：`scripts/ui/07-projects.mjs` 打开两百多行的 `src/api/products.ts`，核对第 80、81 行接得上；`web/src/components/files/code-lines-html.test.ts`。
