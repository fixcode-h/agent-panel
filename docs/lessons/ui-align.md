---
paths: scripts/ui/harness.mjs, web/src/index.css, scripts/ui/02-task.mjs
---

# 界面检查里的对齐断言（scripts/ui/harness.mjs）

定位要 exact、提示挡按钮、按坐标拖动这些通用坑在 [ui-check.md](./ui-check.md)。

## 对齐断言量排版盒，不量字形墨迹

- 规则：判断「垂直居中 / 对齐」时，用 `getBoundingClientRect()`、单字符 `Range` 矩形这类**排版盒**，不要用 canvas 的 `actualBoundingBox*` / `fontBoundingBox*` 量字形墨迹：墨迹上下沿完全由这个环境解析到的字体决定（13px 的「件」在 Windows 雅黑 UI 下 ascent 11px、CI 的文泉驿 12px），同一条断言差 0.5px（1.05 对 1.55，容差也是 1.5），本地全绿也会在 CI 变红。
- 规则：盒口径只是「对字体不敏感」，不是无关：行内盒高度就是字体 em 框，Windows 上换字体栈实测还在 0.55~1.05 之间变。容差留在注释里时写清两端实测值（补偿默认 / 补偿置 0）和「置 0 会报几条」，换字体栈、改字号、改补偿值后两端复跑并更新，不要为了过 CI 直接把数字调大。
- 例外：页签那条（文字 vs 固定高度条）仍量墨迹：默认值 Windows −0.03 / WSL 0.47，补偿置 0 后 Windows −1.58（报出）、WSL −1.08（在容差内报不出）；换成盒中心是 0.97 → −0.58，两端都报不出，所以不换。它在 Linux 字体下对补偿失效是漏的，已知项。
- 起因：PR #190 新增的行内标签对齐断言在 CI 的 `ui (a)` 报 5 条 1.55px（Windows 本地 1.05px）；标签换成行内盒口径后两端都是 1.05、补偿置 0 两端都是 1.92。
- 防线：`node scripts/ui/02-task.mjs`；把 `--chip-lift` 置 0 应报 5 条 1.92px（两端一致），页签置 0 只在 Windows 报 −1.58。
