---
paths: shared/web-layout.ts, shared/web-layout.fixtures.ts, shared/web-layout.test.ts, scripts/ui/11-umg-layout.mjs, scripts/ui/umg-layout/**
---

# 网页设计的排版回读和对照夹具

## 对照夹具里，固定尺寸控件别排在估算尺寸之后

- 规则：`11-umg-layout` 这类「算出来的位置 vs 浏览器画出来」的夹具，固定尺寸的控件（Picture、写了宽高的 Frame）不要排在靠文字 / 按钮 / 输入框等估算尺寸的控件后面。比对时固定尺寸控件只按自己的宽高给容差（`max(8, 15%)`），上游估算的误差会整个累加到它的 x；放在行首或独立一行，位置就不再依赖字体度量。est 控件之间互相推着排没问题。
- 规则：Chrome 的默认输入框宽是「size=20 个字符的内容宽 + 内边距 + 边框」，内容宽跟着字体的平均字宽变；`shared/web-layout.ts` 按 12.7em 内容宽再 +16 内边距 +2 边框估成 195.8px。同样 14px，`font-family: inherit` 实测总宽 173px、显式 Times New Roman 188px（本机内容宽约 11.1em，比假设窄）。别只调 12.7 系数或换字体去凑，浏览器对照只能接受 est 控件之间的差，不能让它给固定尺寸控件定 x。
- 起因：2026-11-02 两个子对话跑全量界面检查都在「网页文字和控件」失败（`Pic 画布 302.5,144.0 64.0×48.0，算出 321.3,144.0`）：`Pic` 排在按钮和输入框后面，上游误差 -18.7px 超过它自己的 9.6px 容差；本次提交把 `Pic` 挪到行首。
- 防线：`node scripts/ui-check.mjs 11-umg-layout`；`shared/web-layout.test.ts` 断言 `Pic` 在 `[24, 144, 64, 48]`，挪回去直接失败。
