# 设置页右侧内容太长，没有分类也不知道滚到哪

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run build`、WSL 里的 `npm run test:e2e` 均通过；界面检查 `scripts/ui-check.mjs` 暂无覆盖设置页小节菜单的分片）
- 症状：设置页右侧内容太长了，没有分类也不知道滚到哪
- 入口：`web/src/components/settings/section-nav.tsx`、`web/src/components/settings/parts.tsx` 的 `Group`
- 根因类型：右侧只有一个长滚动列表，没有任何节内导航
- 模块：`web`（`web/src/components/settings/section-nav.tsx`、`web/src/lib/section-nav.ts`、`web/src/components/settings/parts.tsx` 的 `Group`、`web/src/pages/SettingsPage.tsx` 的 `setSectionScroll`）
- 关键词：设置、右侧太长、没有分类、小节菜单、锚点跳转、滚动高亮、Group、section-nav

## 现象

用户原话：「网页的代理开关那里去了，然后右边的设置页也分下类吧，给个小分类菜单」。

截图里的设置页：左栏已经有一级分类（通用 / 项目 / Agent 与 AI / 连接 / 生图 / 系统），右边「常规」这一节是一整列几十项、滚很长，没有任何页内导航——不知道这一节里有几组设置、当前滚到哪一组，想找某一项只能整列翻一遍。

## 根因

右侧内容区只有一个滚动容器（`SettingsPage.tsx` 的 `overflow-y-auto` 那层），组和组之间只有一行小标题，没有锚点、没有当前小节提示；左栏的一级导航只解决「换到哪一节」，解决不了「这一节里跳到哪一组」。内容多的那几节（尤其「常规」）因此完全靠手动滚动。

## 修复

- 新增 `web/src/components/settings/section-nav.tsx`：**不用 Provider**，状态放在模块级变量里（`entries` / `container` / `snapshot` / `listeners`），对外只有 `setSectionScroll`（回调 ref）、`useSectionAnchor(label)`（给 `Group` 注册小节）、`SectionToc`（菜单本体）三个东西；`SectionToc` 用 `useSyncExternalStore(subscribe, () => snapshot)` 订阅模块状态，`subscribe` 的 cleanup 返回 `void`（不能把 `Set.delete` 的 boolean 直接返回出去）。不套 Provider 是因为套上要把那一整列内容的缩进重排一遍（一个文件里上千行缩进变化），会掩盖真正的改动；设置弹窗同时只有一个实例，模块级状态不会串。
- 判定逻辑拆成纯函数放 `web/src/lib/section-nav.ts`：`activeIndex` / `atBottom` / `jumpTop`（含 `SCROLL_GAP = 12`、`BOTTOM_SLACK = 2`），`.tsx` 只负责 DOM 和状态，这样边界能直接单测。
- `Group`（`web/src/components/settings/parts.tsx`）有 `title` 时自动成为一个小节：`section` 上挂锚点 id，标题文字就是菜单文字；`useSectionAnchor` 在挂载时把自己登记进 `entries`、卸载时移除。别的分节（CLI、生图等）本来就用 `Group title`，一并生效；不在设置页里用的 `Group`（弹窗里复用）仍会登记进 `entries`，但没有滚动容器时 `refresh` 直接返回、不算高亮，也看不到菜单（`SectionToc` 只在设置页挂一处），行为上就是只渲染标题。
- 内容区滚动容器把 `setSectionScroll` 当回调 ref 直接挂在滚动 div 上（`<div ref={setSectionScroll} className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 md:px-8">`），跳转和「当前小节」都按它的滚动算。
- `SectionToc` 挂在设置页 header 下面、滚动容器上面：它在滚动容器之外，所以一直可见（不靠 CSS sticky），一条横栏 `overflow-x-auto` 横向一行，窄屏不额外占竖直空间、不浮在内容上遮挡。
- 高亮：按每个小节 `section` 的 `getBoundingClientRect().top` 相对容器顶部算（`SCROLL_GAP = 12` 容差）；滚到容器最底部时强制高亮最后一个（`BOTTOM_SLACK = 2`），否则最后一段内容比一屏短时永远高亮不到。点击用 `container.scrollTo({ behavior: 'smooth' })` 跳到「小节顶部 - `SCROLL_GAP`」，留出标题的视线空间。
- 只有两个以上小节才显示这条菜单，只有一组设置的页不多一条横栏。
- 视觉上刻意和左栏一级导航区分：只有文字没有图标、`text-[0.75rem]`、选中态是底部一条 2px 圆角高亮线（`after:bg-accent`）；左栏那套是 `bg-sel` 底色 + 图标，避免看成第二个一级导航。
- 「常规」按内容拆成 6 个 `Group title`：执行与超时 / 会话保活 / 后台命令 / 界面与启动 / 输入与文件 / 提示与通知，顺序即渲染顺序。

## 防线

- `web/src/lib/section-nav.test.ts`（4 条）：当前小节取已经越过容差线的最后一个、滚到底算最后一个（短内容也不落下，无小节时返回 -1）、`atBottom` 的到底判定（比可视区矮也算到底）、`jumpTop` 头部留白且不滚成负数。改判定逻辑先跑它。
- `npm run typecheck`：漏翻检查覆盖新文案（`本页小节` 等）。
- 键盘可用性靠 `button` + `aria-current`：菜单项是原生按钮，Tab 可达、Enter / 空格触发，读屏能读出当前小节。
- 界面检查（`scripts/ui-check.mjs`）暂未覆盖这一页的小节菜单（跳转、滚动高亮、窄屏横滚），以后加分片时补。
