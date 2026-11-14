# 工作总结拖选整份报告时，往下拖页面被拉上去

- 状态：已修复（Playwright 演示版复现前后对比，`scripts/ui-check.mjs 08` 通过）
- 症状：报告生成后从头按住鼠标往下拖选整份报告，拖到底部时整页（顶栏、标题、报告列表）一起往上跑，像被拉回去
- 入口：`web/src/components/summary/ReportView.tsx`、`web/src/components/summary/SummaryComposer.tsx` 的滚动区 `main`
- 根因类型：绝对定位元素逃出滚动区裁剪、撑高文档
- 模块：`web`（`web/src/components/summary/`），配套 `scripts/ui/08-misc.mjs`
- 关键词：工作总结、日报、拖选、复制、页面跳、被拉上去、sr-only、relative、包含块、overflow、文档撑高

## 现象

宽屏下工作总结页整页不滚，报告区自己滚。拖选文字到报告区底部，报告区先滚到底，接着整个页面开始往上滚（顶栏、报告头部被推出视口），松手后也停在那里。

## 根因

报告下方「候选教训草稿」卡片里有一段读屏用的 `sr-only` 文字（`LessonDrafts.tsx`，`position: absolute`）。滚动区 `main` 没有定位（`position: static`），往上也没有带定位的祖先，所以这段文字按视口定位、停在它在报告正文末尾的位置，并且不被 `main` 的 `overflow-y-auto` 裁掉（裁剪只管包含块在滚动区之内的后代）。结果文档的可滚动高度被撑到和报告一样长（900 高的窗口下多出约 440px）。拖选时浏览器的自动滚动先滚报告区，滚到底后接着滚外层可滚的文档，整页就被推了上去。

用 Playwright 在演示版复现：1280×800 窗口，从报告开头拖到窗口底部，改前报告区滚到底后文档又滚了 443px，改后文档滚动为 0。

## 修复

两个滚动区 `main` 加 `relative`，让它们当绝对定位后代的包含块，`sr-only` 被滚动区裁住，不再撑高文档。

## 防线

`scripts/ui/08-misc.mjs`「工作总结-报告」之后断言 `document.documentElement.scrollHeight` 不超过视口高度。教训记在 `docs/lessons/scrollbar.md`「页面的滚动区要带 relative」。
