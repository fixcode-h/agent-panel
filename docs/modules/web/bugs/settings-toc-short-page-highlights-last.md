# 修设置小节 tab 高亮错位

- 状态：已修复（`web/src/lib/section-nav.test.ts` 7 条单测通过；`node scripts/ui-check.mjs 05-settings` 39 步通过；`npm run typecheck` 通过）
- 症状：设置 →「关于我与记忆」打开后页面停在顶部（内容从「关于我」开始），但顶部「本页小节」tab 高亮的是「记忆」；期望不滚动时高亮「关于我」。1440×900 下必现，影响所有小节数 ≥2 且内容不满一屏的设置页
- 入口：`web/src/components/settings/section-nav.tsx` 的 `setSectionScroll` → `useSectionAnchor` → `refresh` → `web/src/lib/section-nav.ts` 的 `atBottom` / `activeIndex` → `SectionToc`
- 根因类型：`atBottom` 把「内容比可视区短、根本滚不动」判成「已滚到底」，`refresh` 因此直接选最后一个小节
- 模块：`web`（设置页小节导航：`web/src/lib/section-nav.ts`、`web/src/components/settings/section-nav.tsx`）
- 关键词：设置、本页小节、tab 高亮、关于我与记忆、记忆、短页面、滚不动、atBottom、BOTTOM_SLACK、section-nav

## 现象

设置 →「关于我与记忆」打开后页面停在顶部（内容从「关于我」开始），但顶部「本页小节」tab 高亮的是「记忆」。期望：不滚动时高亮「关于我」。1440×900 下必现；影响所有小节数 ≥2 且内容不满一屏的设置页。

复现：演示版（`npm run build:demo`）+ Playwright 1440×900：设置 →「关于我与记忆」，等 tablist 出现。输出：`body={"scrollTop":0,"clientHeight":713,"scrollHeight":713,"canScroll":false}`；`tabs=[{关于我,false},{记忆,true}]`；`sections=[{关于我,top:0,height:259},{记忆,top:259,height:236}]`。滚到底仍选「记忆」。复现率 100%。

## 根因

`atBottom` 把「内容比可视区短、根本滚不动」也判成「已滚到底」（`section-nav.ts:45-51`）；`refresh` 因此总让 `activeIndex(..., true)` 直接选最后一个小节（`section-nav.ts:39`），短页面一打开就高亮「记忆」。原意只是「长页面滚到底、最后一段很短时也能高亮最后一节」，漏了不可滚动的情况。

证据链：现象（高亮「记忆」）← 复现输出 `clientHeight=713 = scrollHeight=713`、`scrollTop=0` ← `web/src/lib/section-nav.ts:50` `scrollTop + clientHeight >= scrollHeight - slack`（713 ≥ 711）为 true ← `web/src/lib/section-nav.ts:39` `if (bottom) return tops.length - 1` 返回 1 ← `web/src/components/settings/section-nav.tsx:76` `activeIndex(tops, atBottom(container))` ← `SectionToc` 点亮 `items[1]`「记忆」。`tops=[0,259]` 与 DOM 一致。

引入：`6bbca46a`《Agent 面板：设置页代理挪位与右栏分类菜单 — 设置页：网络代理挪位到「连接 › 网络与代理」并加启用开关（真正生效），右侧新增节内小节菜单，常规拆成 6 个小节》2026-10-25。

## 修复

在 `atBottom` 里要求「确实有可滚动距离」才算到底：增加条件 `view.scrollHeight - view.clientHeight > slack`，即滚不动的短页面返回 false；同步改注释说明原意。`section-nav.tsx` 调用处不动。

没选别的修法：只在调用处修正（不把 `atBottom` 判为 bottom）效果相同，但把修正藏在调用处，`atBottom` 的语义陷阱还在，且纯函数测不到组合；重定义高亮口径改动面大、需要重定规则，风险与收益不匹配。

## 防线

- 回归测试：`web/src/lib/section-nav.test.ts` ›「滚到底的判定：贴着底部就算；内容比可视区短、滚不动时不算」、「当前小节：内容不满一屏时算第一个，不是最后一个」；界面检查 `scripts/ui/05-settings.mjs` ›「设置-关于我与记忆：打开时选中『关于我』、点『记忆』后选中『记忆』」。
- 设置页所有节内小节导航（SectionToc）：`node scripts/unit-tests.mjs --files web/src/lib/section-nav.test.ts --no-retry`、`node scripts/ui-check.mjs 05-settings`、复测脚本（Playwright）→ 单测 7 条通过；05-settings 39 步通过（修复后与补守卫后各跑一次）；短页面 713/713 选中「关于我」；常规页 1832/713：顶部「界面」、滚到底「通知与安全」、回顶「界面」。
- 点击小节跳转 `go()`：`node scripts/ui-check.mjs 05-settings`、复测脚本 → 界面检查断言「点记忆后选中记忆」通过；复测脚本点「记忆」后 `selected=[记忆]`。
- 窗口缩放 / 内容高度变化：复测脚本 900→560→900 高，滚动容器顶部/底部/顶部 → 900：713/713 选中「关于我」；560：543/373，顶部「关于我」、滚到底「记忆」、回顶「关于我」；放大回 900：713/713 选中「关于我」。
- 其它调用方：`rg -n "atBottom\(|activeIndex\(" web/src --glob '!*.test.ts'` + `npm run typecheck` → 只有 `web/src/components/settings/section-nav.tsx:76` 调用；typecheck 通过。
- 现有单测：`node scripts/unit-tests.mjs --files web/src/lib/section-nav.test.ts --no-retry` → 7 条全部通过（改写后的「滚不动不算到底」、新增的「内容不满一屏算第一个」，以及长页面到底用例）。
